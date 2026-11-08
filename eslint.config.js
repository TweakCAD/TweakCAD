/**
 * ESLint flat config for the CAD app.
 *
 * Self-contained on purpose: this repo is published standalone, so it can't
 * rely on the `eslint.config.js` that sits in the dev workspace root (which
 * was never runnable anyway — eslint was in no package.json until now).
 *
 * Type-aware rules are deliberately NOT enabled (`strictTypeChecked` /
 * `projectService`). `tsc --noEmit` already runs over the same sources in
 * `pnpm build` and `pnpm typecheck`, so the type-aware lint pass would mostly
 * duplicate it at several times the runtime. This config exists to catch what
 * the compiler doesn't: unused code, `any` creeping in, stray `console.log`,
 * `eval`, `var`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const root = path.dirname(fileURLToPath(import.meta.url));

// The version-1 tree. These paths no longer exist, and nothing may import them
// again: version-2 code uses the underlying libraries (planegcs, occt-wasm)
// directly and ports any logic worth keeping. Paths are relative to the repo
// root, without extensions.
const v1Directories = ['lib/core', 'lib/testing', 'src/layout', 'src/sketch/solver', 'src/components/ComponentsPanel'];
const v1Files = new Set(
  Object.entries({
    'lib/viewport/src': ['ConstructionPlaneLayer', 'MeshRegistry', 'ViewportController', 'displayMode', 'selectionHighlight', 'topologyLookup'],
    src: ['App', 'appInit', 'rebuildScheduler'],
    'src/ai': ['agentLoop', 'bodyArtifacts', 'browserToolHost', 'mcpBridgeClient', 'transactionBalance', 'viewportRegistry', 'viewportSync'],
    'src/components': [
      'ChatPanel', 'ComponentDialog', 'ConstructionPlaneDialog', 'ExtrudeDialog', 'HistoryPanel', 'HoleDialog', 'MeasurePanel',
      'ParametersDialog', 'PrimitiveDialog', 'ProjectTree', 'SaveAsPicker', 'SaveStatus',
    ],
    'src/hooks': ['useDisplayContext', 'useDocumentStore', 'useSketchStore', 'useViewportStore'],
    'src/sketch': [
      'DimensionsOverlay', 'OffsetDistanceInput', 'SketchBrowser', 'SketchEditor', 'SketchEditorStore', 'SketchPalette',
      'SketchPlanePicker', 'SketchSceneManager', 'SketchViewer', 'TextToolPanel', 'curveTessellation', 'index',
      'sketchConstraints', 'sketchDispatch', 'sketchDof', 'sketchHydration', 'sketchTools', 'sketchToolsExt', 'sketchView',
    ],
    'src/storage': ['autoExport', 'autosave', 'boot', 'cloudAdapter', 'diskAdapter', 'fileOps', 'index', 'localStore'],
  }).flatMap(([dir, names]) => names.map((name) => `${dir}/${name}`)),
);

const under = (p, dir) => p === dir || p.startsWith(`${dir}/`);

/** True when a repo-relative, extensionless path is part of the version-1 tree. */
function isVersion1(p) {
  if (v1Directories.some((dir) => under(p, dir))) return true;
  // The worker outside its v2 tree, and the kernel outside the naming modules.
  if (under(p, 'lib/worker') && !under(p, 'lib/worker/src/v2')) return p !== 'lib/worker' && p !== 'lib/worker/src';
  if (under(p, 'lib/kernel') && !p.startsWith('lib/kernel/src/naming')) return p !== 'lib/kernel' && p !== 'lib/kernel/src';
  return v1Files.has(p) || v1Files.has(`${p}/index`);
}

/** The repo-relative, extensionless path an import names, or null for a package. */
function importedPath(spec, filename) {
  const bare = spec.replace(/\?.*$/, '');
  let abs;
  if (bare.startsWith('.')) abs = path.resolve(path.dirname(filename), bare);
  else {
    const m = /^@tweakcad\/([^/]+)(\/.*)?$/.exec(bare);
    if (!m) return null;
    abs = path.join(root, 'lib', m[1], m[2] ? m[2].slice(1) : 'src/index');
  }
  return path.relative(root, abs).replaceAll('\\', '/').replace(/\.(d\.ts|tsx?|jsx?|mjs)$/, '');
}

const noVersion1 = {
  meta: {
    type: 'problem',
    messages: {
      v1: '{{path}} is version-1 code, which is deleted. Use the library directly or port the logic into version-2 code.',
    },
    schema: [],
  },
  create(context) {
    const check = (node) => {
      if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return;
      const p = importedPath(node.value, context.filename);
      if (p !== null && isVersion1(p)) context.report({ node, messageId: 'v1', data: { path: p } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.argument?.literal ?? node.argument),
      // `new Worker(new URL('./x.ts', import.meta.url))` and asset URLs.
      NewExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'URL') check(node.arguments[0]);
      },
    };
  },
};

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  // The codebase already carries eslint-disable-next-line comments for these
  // rules, written before eslint was ever installed.
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Version 1 is gone: no file may import a path of the version-1 tree.
    files: ['src/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    plugins: { tweakcad: { rules: { 'no-version-1': noVersion1 } } },
    rules: {
      'tweakcad/no-version-1': 'error',
    },
  },
  {
    // Tests legitimately reach for non-null assertions on fixtures they just
    // built, and log diagnostics while a gap is being chased down.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', '**/*.js', '**/*.cjs', '**/*.mjs'],
  },
);
