/// <reference types="vite/client" />

// Vite's ambient types declare the `?url`, `?worker`, `?raw` asset-import
// suffixes and `import.meta.env`. Needed so `tsc --noEmit` (run by the `build`
// script) accepts e.g. `import wasmUrl from '....wasm?url'` in planegcsLoader.
