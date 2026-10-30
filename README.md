# TweakCAD

A local-first, browser-based, parametric CAD application. Simpler than
Fusion 360, more capable than Tinkercad — sketch on a plane, dimension and
constrain it, extrude/cut/fillet into solids, and edit a rebuildable feature
timeline. Everything runs in the browser; no account required.

> **Status:** pre-1.0, in active development. There are no persisted user files
> yet, so the on-disk `.cadjson` format may still change without migration shims.

## Features

- **Sketcher** with a full constraint solver ([planegcs](https://github.com/Salusoft89/planegcs),
  compiled to WASM) — coincident, horizontal/vertical, parallel, perpendicular,
  tangent, equal, symmetric, concentric, midpoint, angle, and dimensional
  constraints. Rectangle / polygon / slot tools spawn lines + constraints (no
  composite shape entities).
- **Features** — extrude (new body / join / cut), revolve, loft, sweep, fillet,
  chamfer, hole, shell, mirror, and pattern — over an [OpenCascade](https://www.opencascade.com/)
  (OCCT) geometry kernel running in a Web Worker.
- **Editable feature timeline** — reorder, suppress, delete, and edit
  parameters; the document rebuilds deterministically from the canonical
  `.cadjson` source of truth.
- **3D viewport** — Three.js rendering with orbit/pan/zoom, a view cube, and
  stable topology selection (faces / edges / vertices) that survives rebuilds.
- **Local-first storage** — documents live in the browser (IndexedDB); optional
  cloud sync via pluggable storage providers.
- **Import / export** — STL and STEP (read + write); partial FreeCAD `.FCStd`
  import.
- **MCP bridge** — drive the editor from any MCP client via the companion
  `@tweakcad/mcp-bridge` npm package (a separate, pure-relay CLI).

## How it works

The UI never touches the kernel directly. Every document mutation is a
serializable command:

```text
CommandBus → DocumentStore → RebuildScheduler → Worker → Kernel → Artifacts → Viewport
```

`.cadjson` is the source of truth; generated meshes and kernel shapes are a
disposable cache. React renders the panels, Three.js renders the viewport, and
the OCCT kernel lives entirely inside the worker.

## Quick start

Requires Node 24 (see `engines`) and [pnpm](https://pnpm.io/) — `corepack
enable` picks up the pinned version from `packageManager`.

```bash
pnpm install
pnpm dev     # Vite dev server — open the printed local URL
```

Both WASM modules (the OCCT kernel and the planegcs solver) are imported
from `node_modules` and emitted as hashed assets by Vite. There is no
copy-into-`public/` step.

Static build:

```bash
pnpm build      # tsc --noEmit + vite build
pnpm preview    # serve the build locally
```

## Project layout

The editor plus the libraries only it uses. The shared contract libs are
vendored in-tree under `lib/` (no external package deps): `lib/cad-tools` (the
CAD tool catalogue) and `lib/api-types` (a client-safe subset of the SaaS
API types). All `@tweakcad/*` specifiers resolve to `lib/` via tsconfig paths +
vite aliases.

| Path | What |
|---|---|
| `src/` | The React app — editor shell, panels, viewport, sketch UI, MCP client. |
| `lib/core/` | Document model, command bus, sketch operations, constraint pipeline. |
| `lib/kernel/` | OCCT (occt-wasm) wrapper and the rebuild ops. |
| `lib/worker/` | The Web Worker that owns kernel handles. |
| `lib/viewport/` | Three.js scene, picking, and rendering. |
| `lib/api-client`, `lib/cloud-providers`, `lib/fcstd-import` | Cloud + import glue. |
| `lib/cad-tools`, `lib/api-types` | Vendored shared contract libs. |

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test:unit   # vitest — runs the real solver and kernel WASM, no browser
pnpm lint        # eslint src/ lib/
```

Tests are co-located (`name.test.ts` next to the source they cover). CI runs
typecheck, the unit suite and the build on every push; `lint` runs too but is
advisory for now (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

Contributions welcome — start with [CONTRIBUTING.md](./CONTRIBUTING.md). To
report a security issue, see [SECURITY.md](./SECURITY.md) rather than opening
an issue.

## License

Application code is licensed under the **GNU Affero General Public License,
version 3 or later** ([AGPL-3.0-or-later](./LICENSE)).
Copyright © 2026 HumanHub / TweakCAD.

Bundled third-party components keep their own licenses — notably OpenCascade
(LGPL-2.1) and the permissively-licensed React, Three.js, and planegcs.
