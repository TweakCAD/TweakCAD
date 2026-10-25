import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

// The CAD-only libraries are folded into ./lib/* (not separate packages).
// These aliases keep the existing `@tweakcad/<lib>/...` import specifiers
// working — mirrors the tsconfig.json "paths". core/kernel/viewport/worker
// have no index (deep-import only); api-client/cloud-providers/fcstd-import
// also resolve a bare root. api-types + cad-tools are vendored into ./lib too
// (api-types is a client-safe subset of the server API contract; cad-tools is
// canonical here) and resolve as bare roots — no more common/ file: deps.
const lib = (name: string) => resolve(__dirname, 'lib', name);
const rootEntry = (name: string) => resolve(__dirname, 'lib', name, 'src/index.ts');
const alias = [
  { find: /^@tweakcad\/core\/(.*)$/, replacement: `${lib('core')}/$1` },
  { find: /^@tweakcad\/kernel\/(.*)$/, replacement: `${lib('kernel')}/$1` },
  { find: /^@tweakcad\/viewport\/(.*)$/, replacement: `${lib('viewport')}/$1` },
  { find: /^@tweakcad\/worker\/(.*)$/, replacement: `${lib('worker')}/$1` },
  { find: /^@tweakcad\/api-client\/(.*)$/, replacement: `${lib('api-client')}/$1` },
  { find: /^@tweakcad\/api-client$/, replacement: rootEntry('api-client') },
  { find: /^@tweakcad\/cloud-providers\/(.*)$/, replacement: `${lib('cloud-providers')}/$1` },
  { find: /^@tweakcad\/cloud-providers$/, replacement: rootEntry('cloud-providers') },
  { find: /^@tweakcad\/fcstd-import\/(.*)$/, replacement: `${lib('fcstd-import')}/$1` },
  { find: /^@tweakcad\/fcstd-import$/, replacement: rootEntry('fcstd-import') },
  // Test-only: shared sketch fixtures. Tests import these by package
  // specifier like everything else, so the path does not change with the
  // importing file's depth.
  { find: /^@tweakcad\/testing\/(.*)$/, replacement: `${lib('testing')}/$1` },
  { find: /^@tweakcad\/api-types$/, replacement: rootEntry('api-types') },
  { find: /^@tweakcad\/cad-tools$/, replacement: rootEntry('cad-tools') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    // The root `vitest run` is what `pnpm test:unit` invokes. Tests live both
    // under src/ (the app) and lib/* (the folded-in packages). lib/core's bus
    // and sketch tests need a live planegcs solver attached before any test
    // runs — that wiring is in lib/core/src/testSetup.ts. We scope it to a
    // dedicated `core` project (instead of a global setupFiles) so the other
    // ~33 test files don't each pay the WASM load. Both projects `extends:
    // true` to inherit the resolve aliases + wasm/top-level-await plugins
    // above, which lib/core tests rely on for their `@tweakcad/*` imports.
    projects: [
      {
        extends: true,
        test: {
          name: 'app',
          include: ['src/**/*.test.{ts,tsx}', 'lib/**/*.test.{ts,tsx}'],
          exclude: ['lib/core/**', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'core',
          include: ['lib/core/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          setupFiles: ['./lib/core/src/testSetup.ts'],
        },
      },
    ],
  },
  // In prod the CAD bundle is served from /cad/* by the host site
  // (the "/cad" embedding strategy). The standalone offline-CAD Docker
  // image serves the editor at the domain root, so it builds with CAD_BASE=/.
  base: process.env.CAD_BASE ?? (isProd ? '/cad/' : '/'),
  plugins: [react(), wasm(), topLevelAwait()],
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  optimizeDeps: {
    // occt-wasm colocates its .wasm next to the JS glue and resolves it via
    // `import.meta.url`. Pre-bundling under `.vite/deps/` breaks that lookup,
    // so we let Vite serve it directly from node_modules instead.
    exclude: ['occt-wasm'],
  },
  assetsInclude: ['**/*.wasm'],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Same-origin proxy to the SaaS API. Cookies set by Better Auth on
    // localhost:3000 are also valid for localhost:5173 (browsers share
    // cookies across ports on the same hostname), so this keeps session-
    // aware requests transparent in dev.
    proxy: {
      '/api/v1': {
        target: apiTarget,
        changeOrigin: false,
        secure: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
