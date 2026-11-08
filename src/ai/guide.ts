/**
 * The workflow guide the `cad_help` tool returns: the model of the
 * document, how handles and references work, units and frames, worked
 * examples and what fails. Tool names here are the catalogue's.
 */
export const CAD_WORKFLOW_GUIDE = `# TweakCAD tools: workflow guide

## The document

- A **document** holds **parts**. A part has a **timeline** of features, in
  order; each feature has a \`type\` (core.sketch, core.extrude, core.fillet, …)
  and \`inputs\`. The part shows the result of its timeline, up to its rollback
  marker when one is set. New features go in at the marker.
- Every number, flag and choice is a **value object**
  \`{id: "val_…", name?, def: {expr: {text}}}\`. Expressions are text in
  millimetres and degrees ("10 mm", "width / 2", "d1 * 2"); a bare number takes
  the field's unit. Named values (sketch dimensions d1, d2, …, parameters) can
  be used in later expressions, so a design stays parametric.
- A **sketch** is a feature with rows: points (\`pt_…\`), curves (\`crv_…\`:
  line, circle, arc, ellipse, spline, point) on those points, and constraints
  (\`con_…\`). Curves sharing a point are joined: coincidence is a shared point.
  Closed loops of curves make **regions**, the profiles extrudes and revolves use.
- Ids come from the tools: \`list_features\` (feature ids), \`get_sketch\`
  (rows), \`get_document\` (value ids). Never invent one.

## Handles

The rebuilt model (bodies, faces, edges, vertices, sketch regions, sketch
curves and points, construction geometry) is listed with **handles** such as
\`b:1\`, \`f:4\`, \`e:7\`, \`r:2\`. Feature tools take handles; each handle
carries a reference by name, so it keeps working after later edits while the
entity still exists. The same entity listed again has the same handle.
Standard planes are \`xy\`, \`xz\`, \`yz\` and standard axes \`x\`, \`y\`, \`z\`.

- Bodies: \`list_bodies\`. Faces of a body: \`list_faces(body, surface?, normal?)\`.
  Edges: \`list_edges(body, face?, between?, curve?, parallel?, …)\`.
  Vertices: \`list_vertices\`. Regions, curves, points: \`get_sketch\`.
  Construction: \`list_construction\`.
- A handle that no longer names one entity (it was removed, or split) is
  refused with a message: list again.

## Coordinates

- Part coordinates are millimetres, Y up.
- Sketch coordinates are 2D in the sketch plane. Standard planes:
  xy: x = +X, y = +Y, normal +Z; xz (the ground): x = +X, y = −Z, normal +Y;
  yz: x = −Z, y = +Y, normal +X. \`sketch_create\` returns the plane's frame
  (origin, x, y, normal in part coordinates) for any support, a face included.
- An extrude grows along the sketch normal unless \`reversed\`.

## Order of work

1. \`list_features\` to see the parts and features (and \`get_document\` for inputs).
2. \`begin_transaction("…")\` for a change of several steps, so the user undoes
   it at once; \`end_transaction\` at the end, always.
3. Sketch: \`sketch_create\`, \`sketch_draw_*\`, then \`sketch_constrain\` with
   dimensions so the sketch is defined (\`dof\` 0) and parametric. Shape the
   curves with \`sketch_trim\`, \`sketch_extend\`, \`sketch_fillet\`,
   \`sketch_offset\` and \`sketch_mirror\` (\`sketch_pick_geometry\` names the
   curve at a position); bring model edges in with \`sketch_project\`, so the
   sketch follows them.
4. Features: \`feature_extrude\`, \`feature_revolve\`, \`feature_fillet\`, … Each
   returns \`status\`: \`ok\`, or \`paused\` with why (\`blocked\` when an
   earlier pause stops it, \`notBuilt\` when it is suppressed or after the
   rollback marker). A paused feature changes nothing downstream: read the
   message, fix it (\`set_value\`, \`run_command\` removeFeature) before going on.
5. \`get_diagnostics\` for what is paused anywhere; \`view_fit_all\` and
   \`view_screenshot\` to look.

## Examples

### A plate 60 × 30 × 5 mm
\`\`\`
sketch_create {on: "xy"}                         → {sketch: S}
sketch_draw_rectangle {sketch: S, from: [0, 0], to: [60, 30]}  → {curves: [c1, c2, c3, c4]}
sketch_constrain {sketch: S, kind: "dimension", entities: [c1], value: 60}
sketch_constrain {sketch: S, kind: "dimension", entities: [c2], value: 30}
feature_extrude {sketch: S, distance: 5}         → {feature, status: "ok"}
\`\`\`
The corner at [0, 0] is held at the sketch origin, so with the two dimensions
the sketch is fully defined.

### Holes through the plate
Either a sketch with circles cut through:
\`\`\`
list_bodies → b:1;  list_faces {body: "b:1", normal: [0, 0, 1]} → the top face f:6
sketch_create {on: "f:6"}  → {sketch: T, frame}
sketch_draw_circle {sketch: T, center: [10, 10], radius: 3}   (× each hole)
feature_extrude {sketch: T, extent: "throughAll", operation: "cut", reversed: true}
\`\`\`
or \`feature_hole {face: "f:6", positions: [[10, 10], [50, 10]], diameter: 6, throughAll: true}\`,
with positions in the face frame the tool describes (it returns it).

A circle inside a rectangle in one sketch makes two regions: the plate with a
hole, and the disc. \`feature_extrude\` with no \`profiles\` takes both and fills
the hole; pass \`profiles\` with only the outer region's handle (from
\`get_sketch\`) to keep the hole open.

### Round the top edges
\`\`\`
list_edges {body: "b:1", face: "f:6"}            → e:… (the four top edges)
feature_fillet {edges: [...], radius: 2}
\`\`\`
A face handle in \`edges\` stands for its sharp edges.

### A turned part
Sketch the half profile on xy beside the y axis, then
\`feature_revolve {sketch: S, axis: "y", angle: 180}\`, or \`extent: "full"\` for a
whole turn.

### A loft or a sweep
\`feature_loft {sections: [r:1, r:2]}\` runs a solid through regions of two
sketches, in the order given. \`feature_sweep {sketch: S, path: [c:4, c:5]}\` runs
the regions of S along curves joined end to end; S stands across the path
where it starts, and corners are mitred.

### Parametric change
\`set_parameter {name: "width", expression: 60}\`, then use \`width\` in a dimension
(\`sketch_constrain … value: "width"\`) or a feature input. Changing the parameter
later resizes everything that uses it. \`set_value\` changes one value object.

### An assembly
Parts are placed as instances and joined; the pose solve moves them.
\`\`\`
assembly_create {parts: [base]}                  → {assembly: A, instances: [Base:1, grounded]}
assembly_insert {part: arm, position: [100, 0, 0]} → {instance: I}
list_bodies {part: base}; list_faces {body: …, normal: [0, 0, 1]} → the base top f:3
list_bodies {part: arm};  list_faces {body: …, normal: [0, 0, -1]} → the arm underside f:9
assembly_joint {kind: "revolute", a: {instance: <Base:1>, at: "f:3"}, b: {instance: I, at: "f:9"}}
assembly_drive {joint: J, values: {rz: 90}}
\`\`\`
Joint ends are face or round-edge handles listed from the instance's own part.
\`assembly_set_joint\` renames a joint, and locks it where it stands (a locked
joint is not driven; unlock it first) or unlocks it.
\`assembly_position\` saves and restores poses; \`assembly_exploded_view\` spreads
instances out without changing the pose. \`feature_derive\` copies another part's
bodies into a part. \`assembly_hole_through\` drills one hole through several
parts; their contexts keep the holes aligned, and \`assembly_update_contexts\`
brings a context that \`get_assembly\` reports out of date up to date.
\`assembly_pattern\`, \`assembly_mirror\` and \`assembly_replicate\` place copies
of instances that follow their originals; a replicate puts a copy at each
target face or round edge as the originals sit at the seed (a bolt per hole).

### Keeping a result as it is
\`feature_freeze {feature: F}\` stores what F built, so edits before it no
longer change it; \`feature_freeze {feature: F, frozen: false}\` makes it live
again. A frozen feature is not edited; unfreeze it first.

## What fails, and why

- An extrude of a sketch with no closed loop: the sketch has no region. Check
  \`get_sketch\` regions; join curves by sharing points (give point ids, or
  coordinates within \`tolerance\`).
- A constraint that over-constrains the sketch is refused and changes nothing.
- A fillet or chamfer larger than the faces beside the edge pauses.
- A cut that removes nothing, a revolve whose axis crosses the profile, or a
  face that is not flat for a sketch or hole, pause or are refused with the reason.
- A sweep whose section lies along the path or runs into itself, and a loft
  whose sections twist against each other, pause. Rails, end tangency and a
  twist are not built yet and pause.
- While the user has a feature panel open in the app, edits are refused: ask
  them to finish it.
- Undo is the user's: group your work with transactions and they can undo it.
`;
