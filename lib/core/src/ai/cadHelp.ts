/**
 * Workflow guide returned by the `cad_help` tool.
 *
 * Single-file source of truth — kept as a TS string constant rather
 * than a sibling .md file because the consumers (the in-app chat panel,
 * the MCP bridge running on Node, the server-side tool loop) all bundle
 * differently. A const works everywhere; a .md file would need three
 * different loaders.
 *
 * The client calls `cad_help` once at the start of a non-trivial session
 * and gets this back. Keep it tight, action-oriented, and concrete —
 * the client has limited attention for guidance docs. Cross-reference
 * tool names exactly as they appear in `tools.ts` so the names map
 * cleanly to calls.
 */

export const CAD_WORKFLOW_GUIDE = `# TweakCAD — Agent Workflow Guide

You are driving a parametric CAD application via a tool catalogue. This
guide tells you the **canonical ordering** of tool calls, the **shapes
that exist**, and the **gotchas** that bit previous agents. Read it once
before modeling anything more complex than a single mutation.

---

## The shape of the world

- **Project** — the whole document. Has \`parts\`, \`parameters\`, \`metadata\`.
- **Part** — one timeline of features. Usually one part per project.
  Has its own \`transform\`, \`parameters\`, and default planes (XY / XZ / YZ).
- **Feature** — one timeline entry. Types: \`sketch\`, \`extrude\`,
  \`revolve\`, \`fillet\`, \`chamfer\`, \`hole\`, \`pattern\`, \`mirror\`, etc.
- **Body** — a solid produced by a feature.
- **Face / Edge** — sub-elements of a body. Kernel-generated;
  needed for downstream ops like fillet or sketch-on-face.

Every level has a stable id (\`partId\`, \`featureId\`, \`bodyId\`,
\`faceId\`, \`edgeId\`). **Always use real ids. Never invent them.**
Get them from the appropriate \`get_*\` or \`list_*\` tool.

---

## Canonical workflow

1. **\`get_document\`** — read current state at the start of every turn.
2. **\`begin_transaction(label)\`** — open one transaction per user
   request. Mutations inside collapse into a single undo step.
   Always pair with \`end_transaction\`.
3. **Mutations.** Use the highest-level tool that exists:
   - Sketches: \`sketch_create\`, \`sketch_draw_rectangle\`,
     \`sketch_draw_circle\`, \`sketch_draw_line\`, \`sketch_draw_slot\`,
     \`sketch_draw_arc\`.
   - Solids from a sketch: \`feature_extrude\`, \`feature_revolve\`,
     \`feature_loft\`, \`feature_sweep\`.
   - Edge / face mods (need ids from \`list_edges\` / \`list_faces\`
     or the filtered \`find_edges\` / \`find_face\`):
     \`feature_fillet\`, \`feature_chamfer\`, \`feature_hole\`,
     \`feature_shell\`.
   - Body replication: \`feature_mirror\`, \`feature_pattern\`.
   - Fallback: \`dispatch_command\` with a CadCommand from
     \`commands/types.ts\`. Avoid when a wrapped tool exists.
4. **\`end_transaction\`** — close it. Forgetting this breaks undo.
5. **\`wait_for_rebuild\`** — call this once after any geometry-creating
   mutation (extrude, fillet, hole, pattern, mirror, shell, etc.) before
   you trust the results of \`get_diagnostics\` / \`list_bodies\` /
   \`list_faces\` / \`list_edges\`. Those reads come from the viewport
   store which is updated only after the worker thread settles. Without
   this wait you may see stale state (or worse, an empty list when the
   body has actually been built).
6. **Verify** with \`get_diagnostics\`. A \`failed\` status means your
   model is wrong — **stop chaining** until you investigate. Use
   \`view_fit_all\` + \`view_screenshot\` for visual confirmation.

---

## Discovering IDs

| What you need | How to discover |
|---|---|
| \`partId\` | \`get_document().parts\` keys |
| \`featureId\` | \`query_features(partId)\` (compact) or \`get_document\` |
| \`sketchId\` | Returned by \`sketch_create\` |
| \`entityId\` (sketch shape) | Returned by \`sketch_draw_*\` |
| \`bodyId\` | \`list_bodies(partId)\` |
| \`faceId\` | \`list_faces(bodyId)\` |
| \`edgeId\` | \`list_edges(bodyId)\` |
| Sketch region (profile) | \`list_sketch_regions(sketchId)\` — usually omit \`profiles\` in \`feature_extrude\` and let it auto-detect |
| Parameter name | \`get_document().parameters\` keys |
| Edge between two faces | \`find_edges(bodyId, { betweenFaces: [a, b] })\` — single-edge lookup for fillet/chamfer |
| Faces touching an edge | \`find_face(bodyId, { adjacentToEdgeIds: [id] })\` |

**Never invent an id.** Models that confidently dispatch with
hallucinated ids get \`NOT_FOUND\` errors. Cheaper to \`list_*\` first.

---

## Coordinate system & units

- Distances are in **millimeters** unless stated otherwise.
- World is Y-up. Default planes and their sketch axes (sketch x, sketch y,
  normal), each right-handed and seen from the +normal side so sketch x
  reads right and sketch y reads up:
  - \`XY\` (front): x = +X, y = +Y, normal +Z.
  - \`XZ\` (ground): x = +X, y = −Z, normal +Y.
  - \`YZ\` (side): x = −Z, y = +Y, normal +X.
  An extrude grows along +normal unless its direction is reversed.
- Sketch coords are 2D in sketch-plane local coordinates.
- Pass numbers (e.g. \`5\`) where schemas say \`type: number\`; the
  wrapper handles Expression-string conversion for the underlying
  CadCommand.

---

## Common patterns

### Pattern A: simple extruded plate (60×30×5 mm)

\`\`\`
1. get_document → partId
2. begin_transaction("Create plate")
3. sketch_create(partId, "XY") → { sketchId }
4. sketch_draw_rectangle(sketchId, [0,0], 60, 30) → { entityId }
5. feature_extrude(sketchId, 5)        // profiles auto-detected
6. end_transaction
7. wait_for_rebuild                    // <-- gate the read on worker settling
8. get_diagnostics → confirm success
9. view_fit_all + view_screenshot     // optional visual confirm
\`\`\`

### Pattern B: plate with a hole

\`\`\`
1. get_document → partId
2. begin_transaction("Plate with hole")
3. sketch_create(partId, "XY") → { sketchId }
4. sketch_draw_rectangle(sketchId, [0,0], 60, 30)
5. sketch_draw_circle(sketchId, [30, 15], 3)
6. list_sketch_regions(sketchId) → 2 regions:
     the plate ring { wireEntityIds: [4 line ids], holeEntityIds: [<circleId>] }
     the inner disc { wireEntityIds: [<circleId>] }
7. feature_extrude(sketchId, 5,
     profiles=[{ wireEntityIds: <ring's wireEntityIds> }])
   // the ring alone → plate with a through hole. Omitting \`profiles\`
   // extrudes every region, ring + disc, which fills the hole back in.
8. end_transaction
9. get_diagnostics; view_screenshot
\`\`\`

### Pattern B2: boss with an insert hole (tube in one extrude)

\`\`\`
1. sketch_create(partId, "XY") → { sketchId }
2. sketch_draw_circle(sketchId, [0,0], 4) → { entityId: outer }
3. sketch_draw_circle(sketchId, [0,0], 2) → { entityId: inner }
4. feature_extrude(sketchId, 10, profiles=[{ wireEntityIds: [outer, inner] }])
   // [outer] alone names the same ring. [inner] alone is the insert disc;
   // [outer] + [inner] as two profiles is the solid boss.
\`\`\`

### Pattern D: stadium-shaped slot cut through a plate

A slot that goes all the way through (M-shape mounting slot, the
classic case). \`sketch_draw_slot\` looks tempting but **doesn't
form an extrudable region yet** — see "active landmines" above.
Build it as a rectangle + 2 circles instead:

\`\`\`
1. sketch_create(partId, "XY") → { sketchId: slotSketch }
2. sketch_draw_rectangle(slotSketch, [-15, -3], 30, 6) // strip between caps
3. sketch_draw_circle(slotSketch, [-15, 0], 3)        // left end-cap
4. sketch_draw_circle(slotSketch, [+15, 0], 3)        // right end-cap
5. list_sketch_regions(slotSketch)
   → finds the merged stadium region (the planar graph walker
     unions the rect with the two circles).
6. feature_extrude(slotSketch, throughDistance, operation='cut',
                   profiles=[stadiumRegion])
7. wait_for_rebuild → get_diagnostics
\`\`\`

If the kernel chokes with \`makeArcEdge: WebAssembly.Exception\`,
your rectangle is exactly tangent to the circles. Nudge the
rectangle by 1e-3 mm to break exact tangency.

### Pattern C: extrude failed — what now?

\`\`\`
1. get_diagnostics(partId)
2. Read the message. Common causes:
   - "no profile references" → sketch has no closed regions.
     list_sketch_regions(sketchId) to confirm; check for unjoined endpoints.
   - "Sketch output not found for <id>" → wrong sketchId.
     query_features to re-check.
3. dispatch_command DeleteFeature on the broken extrude.
4. Fix the cause, then retry.
\`\`\`

---

## Mandatory ordering rules

1. **\`get_document\` first** every turn (unless you've already read it
   this turn AND nothing changed).
2. **\`begin_transaction\` before multi-step changes.** Even one
   \`sketch_create\` + \`sketch_draw_*\` pair benefits.
3. **\`end_transaction\` always pairs.** Even if you bail on error.
4. **\`wait_for_rebuild\` after geometry-creating mutations**, *before*
   \`get_diagnostics\` / \`list_*\`. Reads from the viewport store can
   be one rebuild stale.
5. **\`get_diagnostics\` after geometry-creating mutations.** Don't
   trust silence.
6. **\`view_fit_all\` before \`view_screenshot\`.** Otherwise the
   screenshot shows whatever the user was looking at.

---

## What's NOT supported yet — and active landmines

These will bite. Read them.

- **Arc entities are invisible to the region detector.** A sketch
  containing a closed loop of lines + \`sketch_draw_arc\` returns 0
  detected regions; \`feature_extrude\` will fail with "no closed
  profile." Arcs round-trip through the document fine (the UI editor
  sees them), but they don't yet form extrudable wires. Until the
  planar graph walker grows arc support, use ALL-LINE profiles for
  extrudes. Use arcs only for visual reference (\`construction: true\`).
- **Slot entities are invisible to the region detector.** Same story.
  \`sketch_draw_slot\` produces a stadium-shaped entity but it can't be
  extruded. Workaround: build the slot manually as
  \`sketch_draw_rectangle\` (between the end-cap centers) +
  \`sketch_draw_circle\` × 2 (at the end-cap centers). The planar
  graph walker merges them into one stadium region.
- **\`list_faces\` doesn't return per-face metadata yet** — no kind /
  area / centroid / normal. The topology layer hasn't grown those
  fields. Pick faces by stableFaceId convention (extrude origin XY
  produces top/bottom + 4 sides; the top is usually the last planar
  face) or use \`find_face({ adjacentToEdgeIds: [id] })\`.
- **Tangent or near-tangent geometry can crash the kernel.** A
  rectangle + tangent circle that share an exact-edge contact point
  triggers a WebAssembly exception in \`makeArcEdge\`. Workaround:
  add a tiny offset (1e-3 mm) so the contact is "near-tangent"
  not exact.
- **Chamfer setbacks ≥ adjacent face dimension crash the kernel.**
  A 5 mm chamfer on a 5 mm-thick plate's top edge triggers a WASM
  exception. Use a slightly smaller setback (4.99 mm) or design
  around the limit.
- **Sketch constraints (coincident, distance, parallel, etc.) as
  first-class tools.** Pending solver integration. Lay out sketches
  by exact coordinates and rely on the coincident-merge tolerance
  to share corners.
- **Direct face/edge picking by visual location.** No
  \`pick_face_at(x,y)\` — use \`list_faces\` / \`list_edges\` and
  pick by ID.
- **Undo / redo from the agent.** User-only. You group via
  \`begin_transaction\`; the user does the undo.
- **File I/O, selection mutation, view-driven write ops.**
  Deliberately user-only.

---

## Gotchas previous agents hit

- **\`plane\`** for \`sketch_create\` is one of \`'XY' | 'XZ' | 'YZ'\` —
  not a PlaneRef object. The tool builds the ref for you.
- **\`operation\`** for \`feature_extrude\` is \`'newBody' | 'join' |
  'cut'\` — **not** Fusion's \`'new' | 'add' | 'subtract'\`. The schema
  enum is the truth.
- **\`distance\`** is a plain number (mm). Wrapper handles the
  Expression-string translation.
- **Sketches need closed loops** to extrude. Four \`sketch_draw_line\`
  calls forming a quad work **only** if endpoints match exactly. Prefer
  \`sketch_draw_rectangle\` when you want a rectangle.
- **Don't use \`dispatch_command CreateExtrude\` directly.** The nested
  shape (\`inputs.extent.value\` as Expression string, \`direction\` as
  discriminated union, etc.) is non-obvious. \`feature_extrude\` has a
  flat schema and does the translation.
`;
