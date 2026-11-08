# Contributing to TweakCAD

Thanks for looking. This is a pre-1.0 project under active development, so the
most useful thing you can do before writing code is **open an issue first** —
especially for anything touching the document schema, the command bus, or the
kernel. A lot of the design is written down (see "Where the design lives"), and
a change that contradicts it will get sent back no matter how good the code is.

## Getting set up

Node 24 (see `engines`) and pnpm — `corepack enable` picks up the pinned
version from `packageManager`.

```bash
pnpm install
pnpm dev         # Vite dev server
pnpm typecheck   # tsc --noEmit
pnpm test:unit   # vitest
```

There is no WASM copy step: both the OCCT kernel and the planegcs solver are
imported out of `node_modules` and emitted as hashed assets.

The unit suite runs the **real** solver and kernel — no mocks at the boundary,
no browser needed. If WASM fails to load, tests fail loudly rather than
silently falling back.

## What gets merged

**A test that fails without your change.** Not "a test that passes". This repo
has a documented history of assertions that pass whatever the code does — a
test asserting the wrong property and a too-narrow fix mask each other, and the
green run looks identical either way. The cheap check: break your fix on
purpose and watch the test go red. If it doesn't, the test isn't testing it.

**Behaviour that is not built yet is marked `it.fails`**, with `ROADMAP:` or
`GAP:` in the title, rather than left red or deleted. That keeps `pnpm
test:unit` green so a real regression is visible.

**Tests live next to their source** (`foo.ts` → `foo.test.ts`). No `__tests__/`
directories.

**Exact dependency versions.** No `^`, no `~`. New dependencies need a reason
in the PR description; the bar is higher than "it would be convenient".

## The invariants

The ones that most often trip up a first PR:

- **`.cadjson` is the source of truth.** Meshes and kernel shapes are a
  disposable cache, never canonical state.
- **The UI never calls the kernel.** Everything goes
  `Editor → DocumentStore → RebuildScheduler → Worker → Kernel → Viewport`.
- **Every document mutation is a serializable command.** No closures, no class
  instances crossing a boundary.
- **Workers own kernel handles.** The main thread sees meshes, ids and
  diagnostics — never a shape.
- **Sketch shapes are not entities.** A rectangle is four lines plus
  constraints; there is no `SketchRectangleEntity`. The "shape tools" are UI
  shortcuts that spawn primitives.

## Keep the docs in step

**If your change makes a README, this file or a code comment wrong, fix it in
the same PR.** A stale description is worse than none, because it misleads the
next reader into building on something that is not there. The triggers: new or
removed commands, schema fields, constraint types, kernel methods, or any
behavioural change in the solver, kernel, undo, rebuild or persistence.

If something **is not built**, say so where it is described rather than
describing it in the present tense.

## Commits and PRs

Commit subjects say what changed or which problem was fixed. No filler, no
test-count summaries, no tool or model attribution. PR descriptions are short:
what changed, why, and what you ran. Not a narrative of how the work went.

## CI

Every push runs typecheck, the unit suite, the build and `pnpm lint`. All
four must be green. Lint errors fail the run; warnings are reported but don't.

## Where the design lives

The `.cadjson` document format is specified in [docs/format.md](./docs/format.md);
code comments cite its sections by number. The rest of the design is described
in the code. If you need a design decision explained and can't see the
rationale there, ask in an issue.

## Security

Don't open a public issue for a vulnerability. See [SECURITY.md](./SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[AGPL-3.0-or-later](./LICENSE), the same terms as the project.
