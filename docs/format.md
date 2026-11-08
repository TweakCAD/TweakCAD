# TweakCAD document format, version 2

This document specifies the `.cadjson` document format, version 2, as
TweakCAD reads and writes it. Section and subsection numbers are stable: the
source code cites them (for example "(7.3)", "9.6", "appendix A"), so
sections are never renumbered, and the reserved chapters 5 and 17 keep their
numbers. This specification is licensed under the same terms as the
repository, the GNU Affero General Public License, version 3 or later
(AGPL-3.0-or-later).

This is the single normative specification of the version-2 `.cadjson`
format. It separates the **core** (chapters 1–20: encoding, identity, values,
timeline, references, evaluation, versioning) from the **feature catalogue**
(appendix A), which grows by additions: each feature type's inputs are
specified when that feature is built, under the core's rules.

Version 1 of the format is not read.

## 1. Principles

1. **A document stores intent, not results.** Shapes are recomputed. The one
   exception is geometry the user chose to keep as it is (an import, a frozen
   feature, a captured context), stored as an asset with its names.
2. **No code in documents.**
3. **One meaning and one encoding per value.** No meaning in absence, key
   order, naming conventions or code outside the format.
4. **One mechanism per concern**: one value object, one reference record, one
   override mechanism, one attribute mechanism, one library mechanism, one
   versioning rule.
5. **Additions never change existing data** (chapter 19).
6. **Unknown content is kept**; unknown content that could change geometry
   stops what depends on it (chapter 18).
7. **Identity is stable and global.** Collaboration, when built, is a
   server-ordered log of commands on ids; the format defines no merge.
8. **Order is explicit**: build order is the timeline, evaluation order is
   chapter 10, and a value is usable only after it exists.
9. **History decides what a reference means.** Geometry may only break a tie
   between candidates history cannot tell apart, and only when one matches
   exactly; otherwise the user decides.

## 2. Encoding

### 2.1 Files and numbers

- UTF-8 JSON. `.cadjson` documents; `.cadcomponent` for a document published
  as a component (same format). Whitespace is not significant.
- Numbers are finite IEEE-754 doubles; no `NaN`, no infinities.
- Integers are JSON numbers with an integral value (written without a
  fraction or exponent), within ±2⁵³.

### 2.2 Collections

| Shape | Encoding | Order |
| --- | --- | --- |
| Ordered list | JSON array | meaningful |
| Set | `{"set": [...]}` | members sorted by the byte order of their canonical UTF-8 serialization; no duplicates |
| Counted set | `{"set": [{"item": …, "count": n}]}` | sorted by the canonical serialization of `item`; items unique; `count` an integer ≥ 1 |
| Table | JSON array of objects each with a unique `id` | display order |
| Map | JSON object keyed by a registry name or user name | none |
| Content-addressed table | JSON object keyed by hash | none |

### 2.3 Tagged unions

A value that can take several shapes is an object with exactly one key, the
tag, whose value is an object holding that shape's fields (`{}` when it has
none). A reader rejects zero or several keys. Nothing sits beside the tag;
`extensions` goes inside the payload.

### 2.4 Hashes and identifiers

- **Canonical form**: RFC 8785 (JSON Canonicalization Scheme).
- **Content hash** (assets): SHA-256 of the bytes, 64 lower-case hex digits.
- **Name hash** (names, library content hashes): the first 16 bytes of SHA-256 of the
  canonical form, as 26 characters of RFC 4648 §6 base32, lower case, no
  padding; the last character's two unused bits are zero.
- **Ids**: `<kind>_<26 characters>`, 128 random bits encoded the same way
  (last character's unused bits zero). Kinds in use: `doc part asm feat cmd pt
  crv con reg txt tbl par val inst jor jnt rel grp set fld attr view note
  pos exp cfg ctx sec hp lib stp`; new kinds are additions. Where this text
  writes a field's kind (`part_…`), an id of another kind there is an
  integrity error; otherwise a kind is a label for readers. Never reused within a document, never derived from
  content, position or time. Ids inside an embedded document are scoped by it.
- **Id fields** are one of four classes: **definition** (a table row's own
  `id`), **must exist** (dangling is an integrity error), **reference** (the
  chapter 9 forms; the target may be gone), or **label** (`cmd_…`, catalogue
  ids, file entity ids: opaque provenance, never resolved). An id field that
  is not a row's own `id`, not inside a chapter 9 reference and not named a
  label is must-exist, with three exceptions that are reference-class (resolved
  per build; when unresolved they pause what uses them, never refuse the
  file): **ids that point into another document** (override targets and
  `published` refs into an inserted component, whose content a configuration
  or a library update can change), and **instance paths** wherever they
  appear (joint origins, rigid groups, contact sets, exploded views, a
  context's `at`, a captured instance), and the `jnt_…` keys of a saved
  position.

### 2.5 Optional fields

`null` is never written. Every optional field states its meaning when
absent, where it is defined; for settings, absence means the registry
default.

### 2.6 Quantities and units

- The **quantity registry** lists every quantity with its stored unit, which
  is always its unit in the **coherent base** mm, t (tonne), s, deg: length
  mm, angle deg, area mm², volume mm³, mass t, density t/mm³, force N (t·mm/s²),
  torque N·mm, pressure MPa (N/mm²), time s, lead mm/deg (travel per turn of
  a screw or rack), ratio (dimensionless; counts are ratios held by `integer`
  values). New quantities are additions, stored in
  the same base.
- Every stored number is in its quantity's registry unit, so reading a stored
  value never converts it and storing a result never rounds it again. Only a
  literal with a unit converts, once (appendix B). A density times a volume
  yields a mass in t; the editor shows grams.
- Display units are a user preference; `displayUnits` (4.2) is the document's
  suggested default.

### 2.7 Geometry conventions

- Right-handed coordinates.
- A **placement** is rigid: it maps a local point `p` to `R · p + T`,
  rotation `R` then translation `T`. Composing: a child's placement is applied
  first, then its parent's; a composition of rigid placements is rigid, so
  every composed placement is representable. Scaling is never a placement; it
  is a feature on geometry (`core.scale`, a `transformChain` scale step).
- A **rotation** is stored as a unit quaternion `[x, y, z, w]` (Hamilton),
  canonical sign: `w ≥ 0`, and when `w = 0` the first non-zero component
  positive; not unit within 1e-9 refuses the document.
- Numeric placements (solver results, captured contexts) are written as
  `{"position": [x,y,z], "rotation": [x,y,z,w]}`. User-set placements are
  values (6.3) of type `placement`.
- **Solver state** (sketch point coordinates, joint `state`, instance
  placements) is plain numbers the solver writes: the starting state of the
  next solve. It is not a value object and cannot be overridden; users change
  it only by solving or dragging.

## 3. Top level

```json
{
  "format": "tweakcad.document",
  "schemaVersion": 2,
  "namingRules": 1,
  "id": "doc_…",
  "metadata": {}, "properties": {}, "settings": {},
  "parameters": [], "parts": [], "assemblies": [],
  "root": {"part": {"id": "part_…"}},
  "folders": [], "views": [],
  "library": [], "assets": {}, "names": {}
}
```

| Field | Meaning |
| --- | --- |
| `format` | always `"tweakcad.document"` |
| `schemaVersion` | integer, read first |
| `id` | document id |
| `metadata` | 3.1 |
| `properties` | map of user properties (16.4) |
| `settings` | map (3.2) |
| `parameters` | list of parameter tables (chapter 6) |
| `parts` | table of parts (chapter 7) |
| `assemblies` | table of assemblies (chapter 12) |
| `root` | `{"part": {"id"}}`, `{"assembly": {"id"}}` (must exist) or `{"parameters": {}}` (a document holding only parameter tables) |
| `folders` | table of `{id: fld_…, name, members: ordered list of part, assembly or library ids (must exist), parent: {"top": {}} \| {"folder": {"id"}} (must exist; no cycles)}` |
| `views` | table of saved views (16.3) |
| `library` | embedded definitions (chapter 11) |
| `assets` | every asset of this document and of every document in its library (chapter 13) |
| `names` | the name table: the hashes the document uses (9.8) |
| `namingRules` | the newest naming-rules version the writer applied (9.3) |

Every field is written; empty collections are written empty. The same holds
for every metadata field and a parameter's `description` (empty strings
allowed).

### 3.1 Metadata

`name` (for a document stored by a hosting service, the service's project
name is authoritative and written here on save), `description`, `createdAt`,
`updatedAt` (RFC 3339 UTC), `writer` (`{"app", "version"}`, informational),
`origin` (`{"original": {}}`, `{"derived": {"document": doc_… (label),
"revision": string}}` for a remix or Save As, or `{"imported": 13.3}`).

### 3.2 Settings

A map against the **settings registry** (name, type, quantity, default,
version introduced); an absent setting takes its default. Settings are
**presentational only**: nothing that changes geometry, mass or a measured
value may be a setting, so an unknown setting is safely ignored. Initial
entries: `displayUnits` (unit set, metric) and `checks` (wall-thickness and
overhang thresholds for the print checks). A print tolerance is an ordinary
document parameter; sheet-metal rules are an input of sheet-metal features;
a part's material is an attribute.

## 4. Outputs and bodies

Features produce **outputs** of a kind from the **output-kind registry**,
which states for each kind whether it is a body and which stored
representation (13.2) it uses. Initial kinds: `solid`, `surface`, `wire`,
`compound` (bodies, `brep`), `mesh` (body, `mesh`), `subd` (body, `subd`),
`plane`, `axis`, `point`, `frame` (construction). A part's **body list** is
computed: every body output that the timeline creates and does not remove.
Evaluation always runs the whole timeline; `rollback` (7.1) is the editor's
view and insertion point only. A body keeps
its identity while later features modify it; each modification is a new
state. A reference made by a feature denotes the entity in the state current
just before that feature. A new output kind is an addition.

## 5. (reserved)

## 6. Parameters, values and expressions

### 6.1 Parameter tables

`{id: tbl_…, name, parameters: table}`. The document, each part and each
assembly have a list of tables. A table shared between documents is a library
document whose `root` is `{"parameters": {}}`.

### 6.2 Parameters

`{id: par_…, name, type, quantity, value, options, range, public, published,
description}`:
- `name`: `^[A-Za-z_][A-Za-z0-9_]*$`, unique in its scope, not a reserved
  word (appendix B).
- `type`: from the **value-type registry**, which gives each type's literal
  encoding (used by frozen values). Initial types:
  `number`, `integer`, `boolean`, `text`, `choice`, `vector`, `placement`,
  `date` (RFC 3339 text), `library` (a library entry id: a material,
  appearance or component, so configurations can swap them). New types (a
  colour, a list) are additions.
  `quantity` for `number` and `vector` (2.6); `options` (ordered list of
  strings) for `choice` only; `range` `{"unbounded": {}}` or `{"between":
  {"min": value object, "max": value object}}`.
- `value`: a value object (6.3). A value outside `range` is an error that
  pauses what uses it.
- `public`: settable from outside (overrides when inserted); `published`:
  readable from outside. An insertion may override only `public` parameters
  and named values marked `public` (a value object's optional `public` flag,
  absent: false). An insertion that overrides anything else pauses, with a
  message naming the value that is not public; it is not an integrity error,
  since the inserted document can change apart from its host (a
  source-linked component).

### 6.3 Value objects

**Every** number, integer, boolean, text, choice, vector and placement a user
can set (in a parameter, a feature input, a sketch dimension, an instance, a
joint, an attribute property) is a value object:

```json
{"id": "val_…", "name": "d12",
 "def": {"expr": {"text": "width * 2 + d7", "grammar": 1,
                  "refs": {"width": {"parameter": {"id": "par_…"}},
                           "d7": {"value": {"id": "val_…"}}}}}}
```

- `id` (always), `name` (optional; absent: not usable by name), `public` and `published` (optional flags, absent: false; as in 6.2).
- `def` is a tagged union:
  - `{"expr": {text, grammar, refs}}`: `refs` maps every name in `text` to
    `{"parameter": {"id"}}`, `{"value": {"id"}}`, `{"table": {"asset": hash}}`
    (a lookup table), `{"library": {"id": lib_…}}` (only in values of type
    `library`) or `{"published": {"instance": instance path, "id":
    par_… or val_…}}`. `refs` is authoritative: a name in `text` missing from
    `refs` is an integrity error. Renaming rewrites `text` and re-keys the
    `refs` entry, keeping its target.
  - `{"measure": {"kind": distance | length | area | volume | angle | radius,
    "of": ordered list of references}}`: measured from geometry: `distance`,
    the minimum distance between the two referenced entities (0 where they
    touch); `length`, the summed length of the referenced edges or curves;
    `area`, of the faces or regions; `volume`, of the bodies; `angle`,
    between the directions of two lines, axes or planar faces (a face's
    normal), from 0 to 180 deg; `radius`, of one circle, arc, cylinder or
    sphere. A straight edge's direction runs from its end at the vertex with
    the lower finest name (the kernel's edge direction can flip between
    builds); a sketch line's from `start` to `end`. Any other count or kind
    of referenced entity is an error that pauses what uses it, never the
    feature holding the value. A reference whose level-0 `feature` is the
    measuring feature itself names one of its outputs and resolves after its
    build; every other reference resolves before it. New measure
    kinds are additions; a measure depends on geometry only, never on
    attributes, so material and mass never feed a value. A feature's `expr`
    values may not use that feature's own `measure` values (they exist only
    after its build); doing so is an integrity error.
- **Every enumerated option and every flag a user can set** (an operation
  kind, a hole kind, `construction`, a constraint's `active`, `reversed`, an
  attachment mode) is a value object of type `choice` or `boolean`, written in
  this text as *choice value (a, b, c)* or *flag*, so configurations can
  override it. The only bare strings are registry names that select a schema
  (`type`, a curve's or constraint's `kind`, `representation`) and the
  `policy` of library entries and contexts, which no configuration changes.
- A tagged union whose branches carry different fields (an extent, a layout)
  is structure, not a value; a configuration replaces it with an `input`
  override (7.3).
- A value inside an `input` override's `with` has no `name`, so nothing
  outside the selected row can depend on it.
- Reserved words (appendix B) are never names in `refs`. Value names are
  unique within their scope (a part's timeline, or an assembly with its
  instances, joints and attributes) and distinct from every parameter name in
  scope.

### 6.4 Visibility of values

- **Table parameters** may use only table parameters of their own or an outer
  scope (part or assembly, then document) and lookup tables. They may not be
  `measure` values.
- A feature's **named values** are visible to that feature's own other values
  and to every later feature in the same timeline; never earlier. An
  assembly's timeline is scoped as a part's is (12.1).
- An instance's **published values** are visible after the feature that
  places it (in a part); in an assembly, the dependency graph alone decides
  (instances have no order).
- A **configuration override** is evaluated in the scope of its target (a
  feature value's scope is that feature's).
- An **insertion override** (11.1, 12.1) is evaluated in the host's scope at
  the point of insertion. Insertion overrides apply **before** the inserted
  document's row selection, so a host selects a configuration by overriding
  its `input` parameter; a target an insertion overrides is untouched by the
  inserted document's configuration rows.

## 7. Parts, the timeline and configurations

### 7.1 Part

`{id: part_…, name, parameters, timeline, rollback, groups, sets,
contexts, attributes, configurations, notes, properties}`:
- `timeline`: ordered list of features.
- `rollback`: `{"end": {}}` or `{"before": {"id": feat_… (must exist)}}`.
  The part is shown, and references made in that view are written, as it
  stands just before that feature.
- `groups`: table of `{id: grp_…, name, members: ordered list of feat_…
  (must exist)}`; a feature is in at most one group. A group holds at least
  one feature, and its members stand next to each other in `timeline`,
  listed in timeline order; anything else
  is refused. An editor keeps that true as features come and go: a feature
  added or moved between two members of a group joins it, a member moved
  away from the others leaves it, and a group whose last member is removed
  goes with it.
- `sets`: table of `{id: set_…, name, members: set of references}`.
- `contexts`: table of captured contexts (12.4).

A part has no placement.

### 7.2 Feature

`{id: feat_…, type, typeVersion, name, suppressed, frozen, command, inputs,
children}`:
- `type`: namespaced (`core.extrude`; a third party uses its own namespace).
- `typeVersion`: integer, the version of the type's inputs **and** of what it
  builds from them. Changing either is a new `typeVersion`, with a pure-JSON
  migration where the old behaviour is expressible in the new inputs, and the
  old behaviour kept for that version otherwise. Adding an optional input
  whose absence keeps the old behaviour is not a new `typeVersion`; a reader
  that does not know it pauses the feature (chapter 18).
- `suppressed`: a boolean value object. It may use table parameters and
  earlier features' values only, never its own feature's values (it is
  evaluated first).
- `frozen`: `{"live": {}}` or `{"frozen": {"effects": ordered list of
  effects, "construction": ordered list as in 12.4, "values": map from val_…
  to a typed literal}}`: the feature's whole effect as last built. An effect
  is `{"create": {"ladder": ordered list of hashes, "branch", "stored": stored
  shape (13.2)}}` (a new body, with the identity it had when built),
  `{"modify": {"body": body key, "stored": stored shape, "input": the content
  hash (13.2) of the stored shape of the body as it entered the feature, one
  root compound holding that body (optional; absent: not checked)}}`
  (when the body now entering differs from `input`, an earlier edit changed
  it and the frozen feature is reported stale, still replaying its stored
  shape) or `{"remove":
  {"body": body key}}`. A **body key** is `{"hash": the finest level hash of
  the body's ladder when frozen, "branch": its branch}`; it matches the body
  in the state before the feature whose ladder contains the hash and whose
  branch equals the key's; none, or several, pauses the feature. A **typed
  literal** is `{"type", "quantity" (numbers and vectors), "value"}`, the
  value's last result in its stored unit (a number, boolean, string,
  `[x, y, z]`, `{"position", "rotation"}` or a `lib_…` id), so later
  expressions keep working even when the original grammar or measure kind is
  unknown. A frozen feature evaluates only
  `suppressed`; a suppressed frozen feature replays nothing and supplies no
  values, otherwise its `values` replace those values' results. Sketches,
  `core.measure` and assembly features cannot be frozen; a frozen one
  pauses. A frozen feature of a type the reader does not know still replays
  its stored effect. Each stored shape holds exactly one body, whose ladder
  and branch are its `create`'s, or whose ladder contains its `modify` key's
  hash with the key's branch; otherwise, or when two effects match one body,
  the feature pauses. A body that shares a shape with others is divided off
  before its effect applies.
  **Writing a frozen effect**: the bodies just before and just after the
  feature's build are compared by body key. A body whose solid is unchanged
  gets no effect; a body after whose key matches a body before is a
  `modify`; any other body after is a `create` with its own ladder and
  branch (so the pieces of a split are `create`s); a body before whose key
  matches none after is a `remove`. Effects are written as all `modify`s,
  then all `create`s, then all `remove`s, each group sorted by the canonical
  bytes of the body key. Each shape map is written from the state after the
  feature, so every entry carries the identity the build gave it. `values`
  holds every named value of the feature as a typed literal; `construction`
  its construction output. An optional `outputs`, an ordered list, keeps the
  feature's other outputs: `{"thread": cosmetic thread}` (its faces as a set
  of entity keys, `standard`, `designation`, `class`, `internal`, `pitch`,
  `major`, `pitchDiameter`, `minor`, `start`, `direction`, `length`, in
  base units, and `hand`: `"left"` on a left-handed thread, absent on a right-handed one), and `{"tool": {"stored": stored shape, "op", "targets"}}`,
  the tool the feature applied with its operation, named as it entered it,
  so a feature pattern of a frozen feature copies it. Replay restores them.
- `command`: `{"alone": {}}` or `{"group": {"id": cmd_… (label)}}`: features
  one user action created together.
- `children`: present only on `core.composite`: ordered list of features,
  built in order as if they stood in the timeline in place of the composite;
  the composite's own named values are visible to its children, and the
  children's named values to features after the composite. A child is
  frozen only with its composite: a child's `frozen` is `{"live": {}}`, and
  a child written frozen pauses the composite. A frozen composite's effect
  is the whole composite's (the bodies before its first child against those
  after its last), its `values` hold its own and its children's named
  values, and its children are kept as written, so unfreezing restores them.
  An editor offers Freeze on top-level features only and refuses a request
  to freeze a child. Freezing a composite is not yet supported:
  `core.composite` is not yet built, so a composite pauses, and a feature
  that did not build is not frozen.

Dependencies are computed from `inputs`. Unknown types and `typeVersion`s:
chapter 18.

### 7.3 Shared input shapes

| Shape | Encoding |
| --- | --- |
| Scalar, flag, vector, placement | value object (6.3) |
| Operation | `{"op": choice value (new, join, cut, intersect), "targets": {"all": {}} \| {"bodies": body set}, "keepTools": flag}`. A feature's own tool solids are fused first. `join`: the tool fuses with each target it meets (touching counts); a target it does not meet stays as it was, even where it touches one that joins, and a tool solid that meets no target is a new body. Faces a join leaves level with each other (coplanar or coaxial within 1e-6 rad) merge into one; the merged face is named by 9.4's merge rule. Where merging them would leave an invalid solid (as merging the pieces of a sphere face split over its seam or poles can), the join keeps the faces as the fuse split them. A join whose result is smaller than the largest body in it has lost one, and pauses. When a join merges several targets, the earliest-created keeps its identity (between bodies one feature created, the creation key below) and the others become its aliases. `cut` and `intersect` act on each target on its own; a target a cut removes entirely is gone. A cut or intersect whose tool overlaps no target (by volume: a cut takes none away from any target, an intersect keeps none of any) pauses with "no target body found to cut or intersect" rather than leave a target split where the tool only touches it; within a cut that does remove material, a target the tool only touches stays as it was. The tools are consumed: a tool body's name resolves `gone` afterwards, never as an alias. With `keepTools` true, a tool the operation would use up stays a body under its own names, and the operation uses up a copy of it made in place, named as a copy (9.5) with the step `{"op": {"id": <this feature>}, "key": {"tool": {}}}`. A feature's own tool stays a new body as `new` would make it; a joining tool that meets no target is a new body, kept or not. A joining copying feature (pattern, mirror) keeps every copy as a body and joins in-place copies of those that meet a target. A feature pattern of a feature that keeps its tool pauses. A target that shares a shape with other bodies takes part as a body of its own |
| Body set | set of body references |
| Direction | `{"axis": {"axis": choice value (x, y, z), "reversed": flag}}`, `{"vector": {"v": vector, "reversed": flag}}`, `{"along": {"ref": reference, "reversed": flag}}`, `{"normal": {"ref": reference, "reversed": flag}}`. `along` names what an axis's `along` names; `normal` names a sketch (its plane's normal), a default or construction plane, or a planar face (its outward normal) |
| Point | `{"at": {"v": vector}}` or `{"of": {"ref": reference}}`. `at` is a position in the part unless the feature type says otherwise; `of` names the origin, a construction point or frame (its origin), a sketch point, a vertex, or a circular edge (its centre) |
| Axis | `{"along": {"ref": reference, "reversed": flag}}` (a default axis, which runs through the origin, a construction axis, a straight sketch line or a straight edge, directed from its start) or `{"through": {"point": point, "direction": direction}}` |
| Angle extent | `{"angle": {"a": s}}`, `{"symmetric": {"a": s, "measure": choice value (total, half)}}`, `{"full": {}}` |
| Attached frame | `{"fixed": {"placement": value}}` or `{"attach": {"support": ordered list of references, "mode": choice value (attachment-mode names), "offset": placement value, "flip": flag, "xAxis": direction}}`; the attachment-mode registry defines each mode's supports and the frame it produces; initial modes below |
| Side | `{"extent": extent, "taper": scalar}` |
| Extent | `{"distance": {"d": s}}`, `{"symmetric": {"d": s, "measure": choice value (total, half)}}`, `{"toFace": {"face": ref, "offset": s}}`, `{"toBody": {"body": ref}}`, `{"upToNext": {}}`, `{"upToLast": {}}`, `{"throughAll": {}}`. A side **stops** at `toFace` (a face, a construction plane or a default plane), `toBody`, `upToNext` or `upToLast`: it ends where the profile swept along the side first meets the stop, keeps only the part of the sweep that holds the profile, and its cap lies on the stop. `toFace`: when the profile does not wholly reach the face, the face's whole surface is used; `offset` moves the stop along the side's direction, positive past the face. `toBody`: the body's faces are the stop. `upToNext` / `upToLast`: of the faces of the operation's targets (every live body for `all`), the one met first / last by the ray from the profile's centre of mass along the side, ahead of the profile, then as `toFace` with offset 0. A stop that meets the profile, a profile the stop does not wholly stop, a stop not reached, a ray through an edge (two faces at one distance), or no face ahead pauses the feature |
| Profile set | set of region and face references |
| Curve chain | ordered list of curve references |
| Target set | set of edge and face references, not empty; where a feature takes edges, a face stands for its edges with a crease: an edge smooth with its other face (outward normals within 1e-4 rad at its sample point) and a seam are left out. An edge referenced directly is never left out |
| Override | `{"value": {"target": {"parameter": {"id"}} \| {"value": {"id"}}, "def": value def}}` replaces a value's definition; `{"input": {"feature": {"id"}, "pointer": RFC 6901 pointer under the feature's inputs, "with": JSON}}` replaces a structural part of a feature's inputs (an extent kind, a layout) with JSON valid for that feature type. A parameter is always targeted as `{"parameter"}`; its own value object can never be a `value` target, so host and configuration overrides of one parameter always name the same target. Only configurations may use `input` overrides (an insertion sets only public values). An `input` override may not remove or replace a value that is public or that any other override (any configuration row, any host insertion) targets; this is checked for all rows on load. A pointer step into a table is the row's `id`, never a position; a step into an ordered list is allowed only where the feature type gives each position a fixed meaning (the first and second of `sides`), otherwise the whole list is replaced (checked against the type's input schema); two `input` overrides in one row whose pointers overlap are an integrity error; value ids inside `with` are definitions, unique in the document. A pointer that does not resolve pauses the feature; a `value` override whose target an `input` override in the same row replaced is an integrity error. One mechanism for configurations and insertions alike |

**Attachment modes** (supports in order; the frame before `offset`
and `flip` apply; `xAxis`, when given, replaces the x direction by its
projection onto the frame's plane):
- `plane`: one plane, planar face or `standard` plane. z is its normal (a
  face's outward normal); for a plane, origin and x are the plane's own; for a
  face, the origin is the part origin projected onto it and x the part's x
  axis projected onto it (the y axis when x is within 1e-9 rad of the normal).
- `planeAtPoint`: a plane or planar face, then a point or vertex. As `plane`,
  with the origin at the point projected onto the plane.
- `threePoints`: three points or vertices `p1`, `p2`, `p3`. Origin `p1`, x
  towards `p2`, z along (p2 − p1) × (p3 − p1); collinear points pause the
  feature.
- `twoPoints`: two points or vertices `p1`, `p2`. Origin `p1`, z towards
  `p2`, x the part's x axis projected onto the plane normal to z (the y axis
  when x is within 1e-9 rad of z); coincident points pause the feature.
- `point`: one point or vertex. Origin there, the axes the part's.
- `alongLine`: one straight line: a default axis, a construction axis, a
  straight sketch line or a straight edge, directed from its start as an
  axis's `along` is. Origin its start, z along it, x as in `twoPoints`. An
  axis along an edge; a plane in this mode is normal to the line at its
  start.
- `midplane`: two planes, planar faces or `standard` planes. Parallel ones
  (normals within 1e-9 rad, either sense) give the plane halfway between
  them, z the first one's normal; otherwise the plane through their line of
  intersection, z along n1 − n2 (between two faces of a body, the bisector
  runs through the body). Origin and x as for a face in `plane`.
- `faceAxis`: one cylindrical, conical or toroidal face. z along its axis,
  signed so its first component off 0 (beyond 1e-9) is positive; origin the
  point of the axis nearest the face's centre of mass; x as in `twoPoints`.
- `center`: one circular edge (an arc too), spherical face or toroidal face.
  Origin its centre, the axes the part's.

Points are what a point's `of` names (the origin, a construction point or
frame, a sketch point, a vertex, a circular edge's centre). `flip` turns the
frame half a turn about its x axis (z and y reversed). A support of the
wrong kind or count pauses the feature; a mode the reader does not know
pauses it too (chapter 18).

### 7.4 Configurations

`{id: cfg_…, input: {"id": par_… (must exist; type choice, boolean or
integer)}, rows: ordered list of {"option": option, "overrides": ordered
list of overrides}}`; an `option` is `{"equals": {"literal": the string,
boolean or integer the input takes}}` (ranges and other matchers are later
variants), and no two rows of a configuration match one input value, so a
row is addressed by its option's literal (renaming a choice option rewrites
every configuration on that input). Two
`input` overrides in different configurations of one owner whose pointers
overlap on one feature are an integrity error, since both can be selected
together, as within a row:
- The parameter's value selects the row. No configuration overrides an
  `input` parameter. A configuration's `input` may depend
  only on table parameters that no configuration overrides, so selection
  cannot depend on its own result.
- A configuration's overrides target only what its owner defines: a part's,
  the values of its own parameter tables and features; an assembly's, the
  values of its own parameter tables, instances, joints and other rows.
  Document parameter tables and another part's values are set only by
  insertion overrides, so two owners never override one target.
- Configurations apply in list order; the later wins on the same target. An override
  replaces its target's `def` while its row is selected.
- An `input` value with no row pauses everything depending on that
  configuration.
- A host selects an inserted document's configuration by overriding that
  document's `input` parameter, which it can do only when that parameter is
  `public` (6.2); a document chooses whether hosts may select its
  configuration rows by making their `input` public.

## 8. Sketches

`core.sketch` inputs: `{frame, points, curves, constraints, regions, retired,
text, solver}`; `solver` is the integer version of the solve behaviour
(absent: 1), so a solver change cannot silently pick another branch:
- `points`: table of `{id: pt_…, x, y}`. Coordinates are the last solved
  positions: the solver's starting state (they decide which solution branch is
  kept) and the geometry of unconstrained points.
- `curves`: table of `{id: crv_…, kind, construction, origin}` + kind fields;
  `origin`: `{"drawn": {}}` or `{"from": {"id": crv_… (must exist, live or
  retired)}}`
  (made by trimming, splitting or extending that curve). A curve's **root** is
  its first ancestor; ancestry must be acyclic.
- `constraints`: table of `{id: con_…, kind, active}` + kind fields.
- `regions`: table of regions (8.3).
- `retired`: table of `{id, was: {"curve": curve row} \| {"region": region
  row} \| {"text": text row}, fate}`: former curves and regions that live
  entities descend from, and text rows a live or retired region still names
  (fate `deleted`).
  A retired row keeps its **original id** (`crv_…` or `reg_…`, moved here from
  its live table, never reused), so references and ancestry that name it
  still find it; `was` holds the row as it was, without its `id`; `fate` is
  `{"split": {}}`, `{"merged": {"into": {"id": reg_…}}}` or `{"deleted": {}}`,
  so a reference to a retired region follows its merge. Lineage lives
  here, apart from live entities.
- `text`: table of `{id: txt_…, string: value of type text, font: value of
  type library, size: value (length), frame: attached frame, path}`; `path` is `{"straight": {}}` or `{"along": {"curves":
  ordered list of crv_… (must exist)}}` (a curve the text follows). Glyph
  outlines are **built** at every solve from `string`, `font`, `size` and
  the path, never stored, so configurations can change them; they bound
  regions like drawn curves and are named `[id(text), index(glyph),
  index(contour)]` (role `glyph`). Layout: one
  glyph per Unicode code point of `string`, numbered from 0 with spaces
  counted, no ligatures; each glyph is set by its advance plus the font's
  pair kerning; `size` is the cap height (OS/2 `sCapHeight`, else the top of
  "H"); the frame's origin is the start of the baseline, with x along it. A
  `fixed` frame is a placement in the sketch frame and lies in its plane. A
  contour starts at its first on-curve point, implied points included; its
  segments are numbered from 0 in the font's order, zero-length ones dropped
  and a closing line counted last. Inserting a character before a glyph
  renumbers that glyph. Text along a curve, an `attach` frame, line breaks
  and characters the font has no glyph for pause the sketch.

### 8.1 Curves

Point fields are sketch points; every other number of a curve is either a
**solver variable** (solver state, 2.7: a circle's `radius`, an ellipse's
`minorRadius`, which constraints and dimensions drive) or a **shape value**
(a value object the solver never changes: a conic's `rho`, NURBS `weights`
and `knots`, a NURBS `degree`).

`line {start, end}`; `circle {center, radius}`; `arc {center, start, end}`
(counter-clockwise; |center − start| = |center − end| is an intrinsic
constraint the solver always enforces, like coincidence; stored coordinates
are only the solve's starting state, so the end point and every curve sharing
it agree after the solve); `ellipse {center,
majorEnd, minorRadius}` (`minorRadius` may exceed |majorEnd − center|; such
an ellipse builds from its stored values, and solver version 1 pauses on it);
`ellipticalArc {center, majorEnd, minorRadius, start, end}` (`start` and
`end` lie on the ellipse, an intrinsic constraint as for an arc; the arc
runs counter-clockwise by eccentric angle); `spline {through}` (the clamped cubic B-spline through the
points in order, with as many control points as points: parameters by
normalized cumulative chord length, interior knots by averaging consecutive
parameters (de Boor); with two points a line, with three a quadratic; end
tangents are a later optional field); `bezier {start, c1, c2, end}` (the
cubic Bézier, parameter 0 to 1); `nurbs {degree,
poles (ordered list of pt_…), weights (ordered list, one per pole), knots
(ordered list of distinct increasing numbers), multiplicities (ordered list of
integers, one per knot, summing to poles + degree + 1, or to poles + the last
multiplicity when periodic), periodic (flag)}` (weights positive); `conic
{start, end, apex, rho}` (`rho` strictly between 0 and 1: the rational
quadratic with poles start, apex, end and weights 1, rho/(1 − rho), 1, which
crosses the line from the chord's midpoint to the apex at the fraction
`rho`); shape values that do not fit pause the sketch; `point {at}`; `external {source: reference, defining: flag,
mode: choice value (project, intersect, silhouette), index, count, near}`. Each row's
`source` names exactly one entity: projecting a face writes one row per edge
of its boundary, each referencing that edge. `intersect` and `silhouette` can
yield several curves from one source; their rows carry `index` (an integer,
the curve's number when the resulting curves are sorted by their start point
in the sketch frame, by x then y, then by end point the same way, each curve
running in its own format direction), `count` (how many curves resulted
when the row was written) and `near` (the selected curve's start point then,
in the sketch frame); all three are absent for `project`. The row pauses, to
be reconnected, when the number of resulting curves is not `count` or when
the curve `index` selects is not the one whose start point is nearest
`near`, so a reordering is never followed silently. The editor writes
`count` and `near` when the row is made or reconnected; evaluation never
does. `project` names an edge; `intersect` names a face or a body, cut by
the sketch plane within its bounds; `silhouette` names a face (initially a
cylinder, cone or sphere), its curves being where the surface normal is
square to the sketch normal, trimmed to the face. An external curve builds
to a line, circle, arc, ellipse, elliptical arc or NURBS and runs in its
format direction: a line from its end smaller by x, then y, in the sketch
frame (equal within 1e-9 relative); a round curve counter-clockwise in the
sketch frame, an ellipse from the end of its major axis with the larger x,
then the larger y; an open NURBS from its smaller end, a closed one
counter-clockwise from its first knot. A projected conic whose radii agree
within 1e-9 relative is a circle. A row that cannot be built (a curve
edge-on to the plane, a source gone, a `project` row with `index`, an
`intersect` or `silhouette` row without it) pauses its sketch; dropping it
would move geometry silently.
`construction` (on every curve), `defining`, `internal` and a constraint's `active`
are flags (value objects).
Point fields name `pt_…` (must exist); control points are sketch points;
coincidence is a shared point. A `defining` external curve may bound regions.
Making two points coincide merges them: an edit that merges point P into
point Q rewrites, in the same command, every reference to P in the sketch
(curve point fields, constraint operands, the `point` ends of stored region
uses in `regions` and `retired`, and retired curve rows) to Q, and removes P.
A constraint the merge leaves holding a point to itself is removed by the
same command.
A point that no live curve uses and no active constraint names (the ends a
trim leaves for retired rows) is not sketch geometry: it is not drawn,
offered for picking or counted among the sketch's degrees of freedom, and
the solve leaves it where it is stored.

### 8.2 Constraints

Geometric: `horizontal` / `vertical` (field `of`: `{"curve": {"id"}}` or
`{"points": {"a", "b"}}`), `parallel`, `perpendicular`, `equal`, `concentric`, `tangent
{a, b, internal (flag: the curves touch from inside)}`, `curvature {a, b}`, `normal {a, b}`, `pointOnCurve`,
`midpoint`, `symmetric {a, b, axis}`, `fixed {point}`, `block {curve}`,
`collinear`, `coradial`, `offset {a, b, distance}`. Operands are tagged:
`{"point": {"id"}}`, `{"curve": {"id"}}` or `{"external": {"id"}}` (an
external curve). An operand may also be `{"sketchStandard": {"name":
"origin" | "x" | "y"}}` (9.1): the sketch's origin, a point at (0, 0), or its
x or y axis, a line through the origin along +x or +y of the sketch frame.
They are fixed in the solve, like external curves. The origin is taken where a point
is taken: `horizontal` and `vertical` `{"points"}`, `pointOnCurve` and
`midpoint` `point`, `symmetric` `a` and `b`, `distance`, `distanceX` and
`distanceY` `a` and `b`. An axis is taken where a line is taken: `parallel`,
`perpendicular`, `collinear`, `tangent`, `normal`, `offset` and `angle` `a`
and `b`, `pointOnCurve` `curve`, `symmetric` `axis`, and `distance` `a` or
`b` (a point's distance to the axis). Anywhere else the document is refused,
and so is a constraint whose operands are all the sketch's own geometry
(`sketchStandard` or `sketchX`); an unknown name pauses the sketch. A point
at the origin is written as `horizontal` and `vertical` against the origin;
there is no coincident kind. Fields: `parallel`, `perpendicular`, `equal`, `concentric`,
`collinear`, `coradial` take curves `a`, `b`; `pointOnCurve` and `midpoint`
take `point` and `curve`; `symmetric` takes `a`, `b` (points or curves) and
`axis` (a line); `distance` takes `a`, `b` (points or a point and a curve);
`distanceX`, `distanceY` take points `a`, `b`; `length`, `radius`,
`diameter` take `curve`. Sketch point coordinates and `solved` are solver
state (2.7); dimensions' `value` objects are the only driving inputs. Dimensional: `distance`,
`distanceX`, `distanceY`, `length`, `radius`, `diameter`, `angle {a, b}` (`b`
a curve or `{"sketchX": {}}`), each with `value` (value object; a `measure`
def makes it driven), `solved` (last solved number) and `label` (`{"auto":
{}}` or `{"at": {"p": [x, y]}}`, where its text is drawn). An unknown kind pauses the
sketch.

Meanings that need saying. `tangent` and `normal`: where `a` and `b` share
an end, they hold there, the angle between the curves being 0 or π
(tangent) or ±π/2 (normal), whichever the stored positions are nearer, and
for two round curves `internal` picks it; elsewhere a tangent curve touches
the other anywhere, and two tangent
lines are collinear. `offset`: `distance` ≥ 0, on the side the stored
positions put `b`; lines stay parallel at the distance, circles and arcs
concentric with radii differing by it. An editor that offsets a chain
writes one `offset` row per copied curve; their `distance` values may name
one value, so the chain moves as one (one dimension for the chain).
`block`: holds the curve where its stored positions put it, its points and
its solver variables. `angle`: counter-clockwise from `a` to `b`; `sketchX` is the
sketch's +x. External curves are fixed in the solve: constraints may use them, never move
them. **Solver version 1** succeeds only when every constraint is
met (a minimum that leaves some unmet is not a solution), trying DogLeg,
then Levenberg-Marquardt, then BFGS; otherwise, and for a
combination of curve kinds and constraints the solver cannot express, the
sketch pauses.

### 8.3 Regions

`{id: reg_…, loop, holes, origin}`: `loop`, the outer boundary as last
written by a fate command, a cycle of **uses**, counter-clockwise, starting at the use whose
`curve` is smallest by canonical form (when one curve has several uses, the
smallest `from` by canonical form); `holes`, a set of such cycles, each clockwise, starting by
the same rule. A use is `{"open": {"curve": curve key, "from": end, "to": end,
"reversed": boolean}}` (the stretch of the curve from `from` to `to`, going
along the curve's direction, defined below, or against it when `reversed`;
on a closed curve this picks which of the two arcs between the ends) or
`{"closed": {"curve": curve key}}` (a whole closed curve: any curve whose two
ends coincide, a glyph contour, a periodic NURBS). A **curve key** is `{"drawn": {"id": crv_… root}}` or `{"glyph":
{"text": txt_…, "glyph": integer, "contour": integer}}` (one contour of one
glyph of a text row, both numbered from 0 in the font's order). An **end** is
`{"point": {"id": pt_…}}` (a sketch point), `{"cross": {"with": curve key,
"sense": 1 | -1 | 0, "k": integer, "kWith": integer}}` (where curves meet
without a shared point:
`sense` is the sign of this curve's tangent × `with`'s tangent at the
crossing, in the sketch frame, 0 where the sine of their angle is within
1e-5 (a tangency), each tangent being the leaving one at a corner (the
arriving one at an open curve's end); `k` numbers, from 0 along this curve's
direction, only the crossings with that curve of that sense; `kWith` numbers
the same crossings along `with`'s direction. A `cross` end is the crossing
whose numbers along both curves are `k` and `kWith`; when no crossing has
both, the end does not exist in that solve, its use contributes no length,
and what depends on it pauses rather than move. Two circles or a line through
a circle have one crossing per sense, which no rotation can reorder. A
closed curve with several same-sense crossings with one curve (a circle and
an ellipse) reorders them when a crossing passes its origin, but then its
numbers along the two curves no longer agree, so the end pauses; an unchanged
sketch always matches. A swap passes unseen only when one edit moves
crossings past both curves' origins at once, or a new same-sense crossing
appears earlier along both curves (a spline gaining a wiggle): known
limits. Along `with`, a place where two of its descendants meet counts once,
as along this curve. Missing ends apply to stored uses only; detected regions are always
measured on their real edges. Directions and
origins are the format's, never the kernel's: an open curve runs from its
start to its end, a circle counter-clockwise in the sketch frame from
`center` + (radius, 0), an ellipse counter-clockwise from `majorEnd`, a
periodic NURBS from its first knot, a glyph contour in the font's contour
direction from its first on-curve point) or
`{"extremity": {"which": "start" | "end"}}` (an end of a curve with no sketch
point there: a `defining` external curve, or an unclamped NURBS). Evaluation detects regions at crossings
as well as at shared points, so a value change that pushes one curve across
another is seen by every reader alike; `origin`
`{"detected": {}}` or `{"from": {"id": reg_… (live or retired)}}`.

Regions change without a sketch edit when a value or configuration moves a
curve, so ids are matched by one rule at every solve, by the editor and by
evaluation alike:
- Each detected region is matched to the stored region with which it shares
  the most **shared boundary**: the total length over which their uses
  overlap, two uses overlapping where they lie on the same curve key, in the
  same role (outer loop or hole: a circle bounding a disc and the same circle
  as a hole around it never overlap) and the same direction. Overlap is
  measured on the curve's current geometry, between the parameters where
  each use's ends lie in the current solve (a `point` end at that point; a
  `cross` end at the k-th current crossing of its sense, counted against all live
  descendants of `with` together; an `extremity` at that end); a stored use
  with an end that does not exist in the current solve contributes no length.
  So adding a line that subdivides a boundary keeps
  most of each old use shared and the old region is found divided, not new.
  A detected region is matched only to a stored region sharing **uniquely**
  the most length (lengths within 1e-9 relative tie); on a tie no stored
  region keeps it: the detected region is new and the tied stored regions
  resolve to nothing in that build, so what uses them pauses rather than
  move to the wrong area. A detected region sharing no length with any
  stored region is new, except **islands**: detected regions sharing no
  length with any stored region that together exactly fill a hole of the
  detected region matched to stored region R, a hole R did not have, are
  pieces of R (so a circle drawn inside a picked rectangle, even with a line
  across it, keeps its area in the extrude). On a tie, every tied stored
  region resolves to nothing, including where it uniquely leads another
  detected region, which is then new.
- A stored region matched by one detected region keeps its id. One matched by
  several is **divided**: at build time its pieces are named as pieces of it
  (its id, with a `branch` entry for the sketch feature and `side` signs
  against the curves that divide it, 9.4), so they are its candidates (9.6); a
  profile set that holds a divided region takes all its pieces, so the
  extruded area is the area the user picked. A detected region matched by
  none is new: no profile holds it, so nothing built depends on it; during
  that build its identity is the sorted set of its uses, and when the user
  picks it the editor writes it into the table in the same command, or in
  one undo step with it.
- A stored region that no detected region matches resolves to nothing in
  that build: what uses it pauses (a configuration in which a dividing line
  falls short leaves the other region's extrude paused, not moved).
- Evaluation never writes the table, and neither does a solve. Only a command
  that adds, removes or retires a boundary curve, makes a curve construction
  or not, or puts a curve on other points (by a point merge or by changing
  its point fields) writes fates; such a curve counts as removed and added
  back as it now is, and a change only to a solver variable (`radius`,
  `minorRadius`) writes none. Its fates: a region that
  command divides gets pieces with new ids, `origin` the region (retired,
  `fate` split); a merge it causes keeps the id the matching rule gives the
  merged region (the unique most shared length; on a tie, the earliest in the
  table, since a command must write one) and retires the others
  (`fate` merged into it). A split or merge that only a value or
  configuration produces leaves the table as it is: the command states the
  curves it added, removed or retired, and only divisions along those curves,
  and unmatched regions bounded by them, get fates, judged in the active
  configuration. A fate command rewrites `loop` and `holes` only of rows that
  carry the curves it changed (rewriting others would record merges a value
  produced); pieces take their parent's place in the table, in the order of
  their sorted uses by canonical bytes. A retired region sharing with several
  regions merges into the one sharing most length, then the first in that
  order. `deleted`
  fates are kept as history.
- Overlap compares direction: a use and its reverse never overlap.

Detection rules every reader applies alike:
- **Tolerance** (same place, tangency, an end on a curve): 1e-6 mm + 1e-9 ×
  the sketch's bounding-box diagonal. A cycle with |area| ≤ tolerance ×
  perimeter is no region.
- **Crossings**: any contact without a shared point counts, T-junctions and
  tangency included, on both curves. At a place, a curve's end is its own
  sketch point, else its own `extremity`, else `cross`; when several curves
  pass one crossing, `with` is the curve the loop continues on or came from.
- **Descendants**: crossings along a curve with several live descendants are
  counted over the descendants in table order, then along each;
  consecutive descendants sharing an end point form one use.
- Edges on no cycle (dangling lines) are dropped. Curves running along each
  other are walked once, on the smaller curve key.
- A closed curve that is part of a longer loop is an `open` use with equal
  `from` and `to` (the whole curve); `closed` is used only when the use is
  the entire cycle, and runs counter-clockwise in a loop, clockwise in a
  hole.
- Canonical start ties go to the rotation whose uses read smallest. A use
  whose ends lie out of order has no stretch; a `point` end that is not the
  curve's own does not exist; identical uses appear once in a new region's
  identity.
- An arc whose two ends coincide is the whole circle. The sketch's bounding
  box is that of its region-bounding curves.
- An unclamped NURBS's ends are the curve's points at the ends of its
  parameter range (not its first and last poles); it is closed when those
  points coincide; periodic NURBS
  poles align as OCCT's do; an elliptical arc runs counter-clockwise; any
  curve whose two ends coincide is closed.
- A divided region's pieces carry one `side` entry per dividing curve the
  piece touches (a curve where the piece's boundary leaves the stored
  region's), sorted by canonical curve key.

A profile refers to regions by id.

## 9. References and naming

### 9.1 Reference forms

A reference is a tagged union:
- `{"entity": record}`: a face, edge, vertex, body, region, curve or
  construction output (9.2);
- `{"object": {"part": {"id"}} | {"assembly": {"id"}} | {"feature": {"id"}}
  | {"instance": instance path}}`;
- `{"standard": {"name": "xy" | "xz" | "yz" | "origin" | "x" | "y" | "z"}}`
  (a part's default geometry: its origin and axes, and the planes `xy` with
  x along X, y along Y, normal +Z (front); `xz` with x along X, y along −Z,
  normal +Y (ground); `yz` with x along −Z, y along Y, normal +X (side);
  each right-handed with normal = x × y, as the app's Y-up view shows them)
  and `{"sketchStandard": {"name": "origin" | "x" | "y"}}`;
- `{"inContext": {"context": {"id": ctx_… (must exist)}, "instance": instance
  path, "ref": reference}}` (12.4): `instance` names the captured instance
  `ref` lies in; an entity `ref`'s `chain` ends with that path's steps, and a
  `standard` `ref` is that instance's default geometry, placed by its
  captured `placement`. Another part's geometry is read, never changed: a
  body, an edge to blend or a face to shell or thread that lies in another
  part pauses the feature;
- `{"selection": {"id": set_… (must exist)}}`: the members of a selection set,
  each resolved where and when the set is used (for a feature, in the state
  before it), as if written there.

New reference forms are additions (chapter 19); rule-based selections
(tangent chain, all faces of a body) are planned as one.

An **instance path** is `{"path": ordered list of steps}`, outermost first,
used everywhere an instance is named; a step is `{"instance": {"id":
inst_…}}` or `{"copy": copy step}`, a copy step being the same object as in
a `chain` (9.5), its `op` an assembly pattern or mirror.

### 9.2 The entity record

| Field | Meaning |
| --- | --- |
| `id` | the identity ladder: ordered list of name hashes, coarse to fine, as the entity carried them when picked; empty list: a reference the user must reconnect |
| `branch` | ordered list of `{"split": {"id": feat_…}, "side": side}`: the split events (any feature that divides an entity: split, cut, boolean, hole) this piece descends from; empty list: not a piece |
| `side` | ordered list of `{"of": name hash of a face or a sketch curve, "sign": 1 \| -1}`: on which side of that face or dividing curve the entity's sample point lies (9.6). The record's own `side` has exactly one entry per member of `nb`, in `nb`'s order, each `of` that face, so two editors write the same record; a `branch` entry's `side` has one per tool face of that split (sorted by finest hash) or per dividing sketch curve the piece touches (sorted by canonical curve key). Each `of` is the finest level the face or curve had when written and matches as `nb`'s members do; tool faces that share a name repeat the `of`, one entry each, and such an entry matches if any face holding that name gives its sign; an entry whose `of` is absent in this build is skipped; empty list: none |
| `nb` | set, always written, of the finest identities the entity's neighbouring faces had when picked: for a face, the faces sharing an edge with it; for an edge, the faces meeting its end vertices other than the faces it bounds; for a vertex, the faces incident to it; empty for every other kind (regions, bodies, construction outputs, sketch entities); a recorded hash matches a neighbour whose ladder contains it or whose aliases include it, so later levels and merges do not break the comparison |
| `n` | how many entities in the whole part shared the finest identity and `branch` when picked |
| `snapshot` | map of measures (9.7) |

### 9.3 Identity ladder

Each level is the name hash (2.4) of one JSON object, stored in `names`:

```json
level 0: {"kind": "face", "chain": [], "feature": {"id": "feat_…"}}
level 1: {"kind": "face", "chain": [], "feature": {"id": "feat_…"}, "role": "side"}
level 2: {"kind": "face", "chain": [], "feature": {"id": "feat_…"}, "role": "side",
          "src": [{"id": {"id": "crv_…"}}, {"id": {"id": "reg_…"}}]}
```

The fields are exactly:
- `kind`: entity kind (`face`, `edge`, `vertex`, `body`, `region`, `curve`,
  `plane`, `axis`, `point`, `frame`; new kinds are additions);
- `chain`: ordered list of copy steps (9.5);
- `feature`: `{"id": feat_…}`;
- `role`: a role name from the naming-rules registry;
- `src`: ordered list of tagged items: `{"name": {"hash"}}` (another entity,
  at the level the defining naming-rules version states), `{"id": {"id"}}` (a
  sketch curve root, sketch point, region, section or hole-position id), `{"index":
  {"i"}}`, `{"text": {"t"}}` (a file's own entity id), or `{"uses": counted
  set of face hashes}` (an edge's faces, a seam's face counted twice). Edge
  direction is never part of a name: it is a kernel choice that can flip
  between builds.
- **Nested hashes in naming-rules version 1**: every `name(e)`, every
  `uses.face` and every member of a vertex's set is e's finest level as
  version 1 defines it (level 2 where its rule gives a `src`, else level 1).
Ids inside name objects are labels (history), never must-exist. `names` holds
every hash any listed name object contains, transitively.
- `feature`: the feature whose naming rule creates the entity (for edges
  and vertices, the feature whose build first produces an entity with this
  `src`). Extruding the same region again in a later feature gives new names
  under the later feature; features that only trim or move an entity keep its
  identity, for edges and vertices as for faces.
- **Levels are append-only.** Each level is defined by the naming-rules
  version that introduced it, including which level of each nested entity it
  uses; a later version may only add levels after the existing ones, never
  change one. A nested entity gaining a level therefore adds a level to its
  container without changing the container's existing levels.
- Fewer levels mean no rule names the entity yet. A better rule adds levels;
  references keep matching at the levels they hold.
- The top-level field `namingRules` (integer) is the newest naming-rules
  version the writer applied. A reader that knows only an older version opens
  the document but pauses every reference holding a level it cannot compute.

### 9.4 Naming rules

A registry (the **naming-rules registry**), versioned on its own, lists for
each operation and role the `src` shape and whether entities with that role
are selectable. Initial entries:

`src` is written with the items of 9.3: `id(x)` is `{"id": {"id": x}}`,
`name(e)` is `{"name": {"hash": e's hash at the level the rule states}}`,
`index(i)` is `{"index": {"i": i}}`, `text(t)` is `{"text": {"t": t}}`. Where a
rule lists a set, its items are sorted by the byte order of their canonical
form.

| Operation | Roles | `src` |
| --- | --- | --- |
| extrude, partial revolve | `side`; `start`, `end` | `[id(segment root), id(region)]`; `[id(region)]`. A segment of a glyph outline has no curve id: its segment root is written as the four items `id(text), index(glyph), index(contour), index(segment)`. A profile segment on a revolve's axis makes no `side` face: the two caps meet along it. `start` is the cap at the back end (on the start when there is no second side: the sketch plane, or what the extrude's `start` names); a stopped side's cap (7.3) keeps that role. One `side` face per stretch of a curve the loop follows without turning: a point where another curve only touches it, or a spline's through point, does not divide it. Thin walls: `side` is the wall on a profile curve, `inner` and `outer` the walls offset into and out of the region, each with the `src` of the curve it lies on or is offset from. On a two-sided extrude whose second side has walls of its own (its taper is not the negative of the first's), the second side's walls end their `src` with `index(1)` |
| full revolve | `side` | `[id(segment root), id(region)]` |
| sweep | `side`; `start`, `end` | `[id(section), id(segment root), id(path segment root)]`; `[id(section), id(region)]`. A circle section has no segment root or region. A path segment that is a model edge is `name(edge)`. A wall of a hole in the section is named as any other; `start` and `end` are the caps where the path starts and ends, and a sweep round a closed path has none |
| loft | `side`, `start`, `end` | for each section the face spans, in section-table order, `id(section), id(segment root)`; then `index(ordinal)`, the face's number among those one section segment yields, from its start. `start`, `end`: `[id(section), id(region)]` of the first and last section (for a face section, `name(face)` in place of the region; a segment of its edges is `name(edge)`). A point section spans no item and has no cap; a closed loft has no caps |
| box | `+x -x +y -y +z -z` | `[]` (ladder stops at level 1) |
| cylinder, cone | `top`, `bottom`, `wall` | `[]` |
| sphere, torus | `surface` | `[]` |
| fillet, chamfer | `blend`, `chamfer`; `corner` | `[name(edge)]`; `[name(vertex)]`. The kernel always carries a blend on along the edge's tangent chain; each blend face is named after its own edge. Corner faces at one vertex share the name and resolve by `n` and `nb` |
| shell | `inner`; `rim` | `[name(offset face)]`; `[name(removed face)]`. With `inside` or `outside`, `inner` names the offset faces in either direction. With `both`, `inner` names the faces offset into the body, and each face offset out of it carries on the name of the original face it offsets, so a reference to an original face follows the outer skin. A body hollowed closed: its void's faces are `inner` after the outer faces they offset (`inside`), or are the body's own faces under their names (`outside`). One rim face per opening (with `both`, the inside and outside rims are one face): a removed face with a hole in it gives two rims sharing the name, told apart by `nb` |
| hole | `bore`, `tip`, `counterbore`, `countersink` | `[id(hole position)]`. A counterbore's wall and floor share the role and resolve by `nb` and `side`; a tool face with no role of its own (the start of a hole that begins inside material) takes its piece's role |
| thread | `cover`, `flankLow`, `root`, `flankHigh`; `start`, `end` | `[id(position or feature), index(patch)]`; `[id(position or feature)]`. Modelled threads only; a cosmetic thread renames nothing. `position or feature` is the hole's position id, or the `core.thread` feature's id. The groove comes in patches of under a turn, numbered along it; `cover` faces lie on the threaded cylinder. The cut divides the cylinder by the first two `flankLow` patches rather than every groove face, as telling each piece from hundreds of faces costs more than the cut; pieces that then share a name are told apart by their records. A left-handed groove's faces take the same roles and items as a right-handed one's. Hole positions measured from edges make no new geometry: the tool faces stay named after the position id |
| import | `face`, `body` | `[text(file entity id)]`, or `[index(map index)]` when the file has none (13.3). Edges and vertices follow `any edge` and `any vertex`, so they keep their names when a later feature rebuilds them |
| any edge | `edge` | `[{"uses": counted set of face hashes}]`; two edges on the same faces share a name and resolve by `nb` and snapshot (9.6) |
| any vertex | `vertex` | the set of `name(f)` for its incident faces and edges |
| seam, pole, apex | `seam`, `pole`, `apex` (not selectable) | `[name(face)]` |
| body | `body` | the set of `id(region)` of the profiles it contains when created (for a face profile, `name(face)` of each profile face), fixed then (later joins add aliases, never change it) (extrude, revolve, sweep, loft, emboss); `[index(0)]` for a feature that makes one solid from no profile (a primitive) |
| region | `region` | `[id(region)]` |
| sketch curve, captured or external | `curve` | `[id(curve root)]` |
| sketch point | `point` | `[id(point)]` |
| kept tool (`keepTools`) | as the tool | the tool keeps every name; the copy the operation uses up takes the tool's names with the step `{"op": {"id": feature}, "key": {"tool": {}}}` appended to `chain`, so a face it leaves in the target never shares a name with the kept tool |
| pattern, mirror, derive copies | as the source | the source's `src`; the copy step goes in `chain`. A feature pattern's copied tool takes the names its feature gave it as the tool entered that feature's operation. An edge or vertex of a copy that a later step rebuilds keeps its name: its `chain` is the longest common suffix of the chains of the names in its `src`, and its `src` holds those names with that suffix removed; with an empty suffix this is the plain `any edge` and `any vertex` rule |
| extrude from a face profile | `side`; `start`, `end` | `[name(edge)]`; `[name(face)]` |
| glyph contour | `glyph` | `[id(text), index(glyph), index(contour)]`; a glyph contour is not a sketch curve, so no `curve` reference names one |
| construction feature | its output kind | `[]` (level 0 and 1 only); wires and shells have an empty ladder, since no reference names them |

A face an operation only modifies keeps its identity. A merged face keeps the
target's identity; the others are its aliases in this build. When faces or
bodies one feature creates merge with each other (the caps of two adjacent
extruded regions), the one with the lower **creation key** keeps its
identity and the others become its aliases. The creation key compares the
two ladders at the coarsest level where they differ (lower levels never
change, so adding naming levels never changes the result); when one ladder
is a prefix of the other, the shorter is lower; entities with identical
ladders have the same names, so either surviving is the same. A copy is
created by its copying feature, so in a join with its source the source,
being earlier, keeps its identity. A piece of a
divided entity keeps the parent's identity and gets a `branch` entry for the
dividing feature, whose `side` records, for each tool face of the split,
the sign of the piece's sample point by the one algorithm of 9.6 (**Sides**).
An
entity made from other entities (a fillet face from an edge piece, a copy of
a piece) **inherits** their `branch` entries, in `src` order, before its own;
an edge or vertex inherits those of its faces in `uses` order, one entry per
split feature. An edge's `feature` is whichever feature first made its faces
meet; an earlier feature inserted that also makes them meet changes the
edge's name, so its references ask (rare, and safe). When pieces merge back
with equal ladders, the one with the lower `branch` by canonical bytes keeps
its identity. A loft face's `index(ordinal)` is taken in the first listed
section it spans.
When `src` is `[]`, the ladder stops at level 1.

Frozen features and captured contexts do not name entities themselves: their
shape map (13.2) stores each sub-shape's identity as it was built, so a
reference made before freezing or capturing still matches afterwards.

### 9.5 Copies

`chain`: ordered list of copy steps, innermost first and outermost last.
An instance path (outermost first) becomes chain steps by reversing it, each
step mapped exactly: `{"instance": {"id": inst}}` becomes `{"op": {"id":
inst}, "key": {"instance": {"id": inst}}}`, and `{"copy": step}` is that copy
step itself. A captured entity's name objects are its own with this list
appended to `chain` at every level; their `src` items (and the hashes nested
there) are not rewritten, being history of the source part. Each alias is
rewritten the same way; `branch` entries name features and are unchanged. A copy step is `{"op": {"id": feat_… or inst_…}, "key":
copy key}`, outermost last. Copy keys: `{"slot": {"i": integer, "j":
integer}}` (always two indices, `j = 0` for one direction; relative to the
seed at 0, signed; a symmetric pattern direction puts its other side at
negative indices), `{"mirror": {}}`, `{"instance": {"id": inst_…}}`,
`{"derive": {}}`, `{"step": {"id": transform-step id}}`, `{"tool": {}}` (the
copy of a kept tool that its operation uses up; its `op` is that
operation's feature). A `core.move` that
keeps a copy uses `{"slot": {"i": 1, "j": 0}}` for the copy. A derive's step
has the deriving feature as `op`. An assembly feature's copy has the step
`{"op": {"id": feature}, "key": copy key}`, and its instance path is
`[{"copy": step}, …the seed's path]`.

### 9.6 Resolution

Candidates come only from names and this build's recorded history: entities
whose ladder contains the reference's finest level, entities recorded as its
aliases (an alias is an **entity key** `{hash, branch}`, so a piece that
merged into another piece still matches by its own branch), and its lineage (pieces, merges, unions, faces swept from a curve's
descendants, regions descended from a region). Never a geometric search.

0. Drop from the reference's `branch` every entry whose split is not in
   effect in the state the reference resolves against (a piece picked in one
   configuration is the whole entity in a configuration without the split). A
   split is in effect when its feature built live, or when a frozen effect or
   captured context that was built with it supplies the state.
1. Keep candidates whose `branch` contains the reference's `branch` entries
   in order (other entries may come before, between or after them, so a split
   inserted earlier in the timeline does not hide the piece).
2. **More candidates than `n`**: ask.
3. **Fewer candidates than `n`** (one or more): some have gone, perhaps the
   picked one; ranking cannot prove it survived. One that passes rule 5's
   complete tight match is same; otherwise ask, with the ranking of rule 4
   as the suggestion.
4. **Exactly `n`**: identity is semantic, not kernel provenance: an entity
   with the reference's name and `branch` is what was picked, whether or not
   the kernel rebuilt it, and the neighbours and sides below decide which of
   the `n` it is. A blend or chamfer face also counts, as a neighbour, for the
   faces its source edge lay between (so filleting every edge round a face
   does not reject that face). When the record's `nb` is not empty, a
   candidate sharing none of it is not accepted (it may be another entity
   made the same way elsewhere); with `n` 1 the one remaining candidate is
   then same. Otherwise rank by the number of agreeing signs of the record's `side` (not
   those inside `branch`), then by `nb` overlap (the count of shared
   members); a unique best is same.
5. **Several that history cannot tell apart** (equal on all of the above): the
   snapshot's `geometry` (9.7) breaks the tie only when exactly one candidate
   matches it
   within the tight tolerance (positions 1e-6 × size + 1e-9 mm, directions
   1e-9°, sizes ratio 1 ± 1e-9; `size` is the bounding-box diagonal of the
part in the state the reference resolves against), compared as in 9.7.
   Summaries (area, centroid, box) are never taken as proof; only the
   `geometry` comparison of 9.7 decides.
6. **None**, or a reference whose identity or `src` runs through a deleted or
   suppressed feature: gone, unless the entity is supplied by a frozen effect
   or a captured context, whose stored maps carry its names; feature ids in
   names are history and never need the feature to be live.

**Regions** are the one exception to rules 2–5: a region reference whose
region is divided at build time or retired with `fate` split resolves to all
its live descendants, and one whose region merged resolves to the region it
merged into. Region lineage never asks, so a split looks the same whether the
editor or a rebuild saw it first.

A reference held by a feature resolves against the state just before that
feature (chapter 4). A reference held outside the timeline (a selection set
shown on its own, an attribute, a note, a joint origin, a captured context's `at`) resolves
against the end of the timeline; `rollback` changes only what the editor
shows. A captured context's map is matched by the same rules; its
`aliases` hold every identity the entity's lineage gave it in its own part's
build, so a reference that resolved through lineage still resolves after a
re-capture.

**Sides.** A sign compares a sample point of the entity with a face. Against
a face of **another body** that still exists as a closed solid (a
neighbouring body, the solid tool of a split that keeps both sides), the
sign is point-in-solid classification: outside +1, inside −1, which is well
defined for concave shapes. Against everything else (a cut's tool faces,
whose solid is gone; a face of the entity's own body, where a boundary point
classifies as inside; an open surface or a plane) it is the side the
face's outward normal points to at the face's closest point to the sample
point: +1 on the normal's side, −1 opposite; a sample point lying in the face's surface writes no entry; when several closest points give
different signs, that entry is not written (a reference) or the feature
pauses (a piece being named). **Sample points** are found the same way for
every kind: an edge's is its parametric midpoint; a face's is the first point
of the dyadic sequence (1/2; then 1/4, 3/4; then 1/8, 3/8, 5/8, 7/8; and so
on) over its parameter bounds, taken by level (at level L, every tuple of
the first 2ᴸ − 1 values not tried at an earlier level, u fastest), that lies inside the face
and farther than 1e-6 × the entity's own bounding-box diagonal from its boundary; a region's and a body's are
the first such point of the same sequence over the bounding box (the sketch
frame for regions, the part frame for bodies, by level, x fastest, then y,
then z).
If none of the first 2²⁰ points qualifies, the tried point inside the entity
farthest from its boundary is used (the earliest on ties); only an entity
with no tried point inside it pauses the feature.

Against a **sketch curve** (a region divided by curves, a face split by
sketch curves, its sample point projected into the sketch plane): an open
curve gives +1 when the point lies to the left of the curve's stored
direction (from `start` to `end`, or along its parameter) at the closest
point; a closed curve gives +1 outside, −1 inside. By construction a piece's
sample point never lies on the dividing boundary; if it does, the feature
pauses.

Ask and gone pause the feature and its dependents and keep the reference; the
user reconnects by picking again, which writes a new record. Outcomes are
never stored. A pick writes a record that resolves until the geometry
changes, for every entity that differs from the others in name, history or
snapshot; the snapshot includes each face's vertex points, so only truly
coincident entities with the same names can share a record, and those ask.

### 9.7 Snapshot

Measures in the frame of the part or assembly holding the reference, in
format units: a pick through an instance, held by an assembly, is written
in the assembly's frame; an in-context reference's record is written in the
holding part's frame, as its captured instance stands there after its
`placement` (the comparison below reads it so). They are used for the ghost, the
reconnect suggestion and rule 5: `geometry` (below) and face `centroid`, `area`, `bbox`, `surface`
(registry enum: `plane`, `cylinder`, `cone`, `sphere`, `torus`, `freeform`;
every other kernel surface kind is `freeform`), `normal` (planar) or `axis` (cylinder, cone, torus), and
`vertices` (the set of its vertex points, sorted by x, then y, then z); edge
`midpoint` (open) or `center` (closed), `length`, `tangent` (open), `bbox`,
`curve` (registry enum: `line`, `circle`, `ellipse`, `freeform`; every other
kernel curve kind is `freeform`), `quarter` and `threeQuarter` (points at
those parameters), all in
the direction `geometry` is written in; vertex
`point`; wire `length`, `bbox`; shell `area`, `bbox`; solid, body and
compound `volume`, `bbox`; region `area`, `centroid`
(sketch frame).

`geometry` is a complete description of the entity, written whenever `n` is
greater than 1 (optional otherwise). Its layout belongs to the naming-rules
version; points and directions are `[x, y, z]`:
- `{"vertex": {"point"}}`;
- `{"edge": {"closed": boolean, "curve": curve}}`, a `curve` being
  `{"line": {"start", "end"}}`, `{"circle": {"center", "axis", "radius",
  "start", "end"}}`, `{"ellipse": {"center", "axis", "major", "radii",
  "start", "end"}}` or `{"bspline": {"degree", "poles", "weights", "knots",
  "multiplicities", "first", "last"}}`;
- `{"face": {"surface": surface, "loops": loops}}`, a `surface` being
  `{"plane": {"point", "normal"}}`, `{"cylinder" | "sphere" | "torus":
  {"origin", "axis", "x", "radii"}}`, `{"cone": {"origin", "axis", "x",
  "radii", "halfAngle"}}` or `{"bspline": {"degrees", "poles", "weights",
  "knots", "multiplicities"}}` (`normal` outward, `halfAngle` in degrees);
  `loops` is the outer loop, then the inner loops as a set, each loop an
  ordered cycle of edge `curve`s;
- `{"wire": {"edges": ordered list of edge curves}}`;
- `{"shell" | "solid" | "body": {"faces": set of face descriptions}}`.

A kind the kernel cannot read exactly is converted to a B-spline by the
naming-rules version; where it cannot be, `geometry` is absent, so rule 5
never matches and the reference asks.

**Writing order** (only so the bytes are canonical):
- A standalone open edge is written from the end whose point is smaller (by
  x, then y, then z, as written doubles), its axis then the one about which
  it runs counter-clockwise from start to end, and a B-spline's poles and
  knots in that direction (knots reversed as first + last − k, keeping
  `first` and `last`).
- A closed edge is written from its curve's parametric start.
- An edge inside a loop or wire is written in the travel direction, the
  face on the left.
- Each loop starts at the edge whose written form is smallest in canonical
  bytes; sets are sorted by canonical bytes.

**Comparison** never depends on those orders:
- Two descriptions **match** when they have the same kinds and counts and
  every number agrees within the given tolerance: weights by ratio; knots,
  `first` and `last` within 1e-12.
- An edge matches in either direction (axis, poles and knots reversed). A
  closed edge's start point is not compared, except that a degenerate
  edge's single point is.
- A loop or wire matches under any rotation, not reversed; a set by
  one-to-one matching.
- Surfaces compare by geometric content, never by frame:
  - a plane by its normal and offset;
  - a cylinder by its axis line (direction up to sign) and radius;
  - a cone by its apex, axis line and absolute half-angle (its radius depends
    on the frame);
  - a sphere by its centre and radius;
  - a torus by its centre, axis line and radii.
- An ellipse's major direction compares up to sign.
- A B-spline compares as written: an equivalent reparameterization (inserted
  knots) does not match, so the reference asks and a fresh pick writes the
  current form; it never matches wrongly.
- An in-context candidate is compared after its captured `placement` maps it
  into the holding part's frame, the frame its record is written in.

So every entity the kernel reads exactly has a complete description, and a
fresh pick among same-named entities writes a record that resolves while the
geometry is unchanged.

### 9.8 Name table

`names` holds identity-ladder levels only (library `hash` fields and asset
hashes are checked where they stand); an embedded library document keeps its
own `names`. A hash from an embedded document's table that the host itself
writes (in a reference into an instance of it, a captured shape map or a
frozen effect) is also written in the host's `names`, with every hash its
name object contains, so the host's table is complete on its own. It maps name hashes to their canonical forms. On load every
entry is re-hashed; a mismatch refuses the document. Unused entries are never
a refusal; a writer that understands every field of the document drops
them when it rewrites the name table, not on every save, so a document
loaded and saved unchanged keeps its bytes. A
missing entry pauses the references holding that hash (they become
reconnectable) instead of refusing the file.

## 10. Evaluation order

1. **Parameters**: insertion overrides from the host; configuration inputs;
   row selection; configuration overrides applied to their targets' `def`
   (except targets the host overrides); table parameters (document, then
   part or assembly).
2. **Each part**: for each feature in timeline order (the whole timeline;
   rollback is a view):
   1. `suppressed`; a suppressed feature does nothing further;
   2. if frozen, its stored bodies replace its effect; nothing further;
   3. its driving values (every value whose `def` is `expr`);
   4. its build (for a sketch, the solve), recording names and history;
   5. its measured values (`measure` defs, including driven dimensions),
      against the state after its build for its own outputs and before it for
      everything else.
3. **Each assembly**: its instances' documents with their overrides and
   configurations; captured contexts as stored (12.4); the assembly timeline,
   which creates its copies; then the joint solve (12.2), in which each copy
   moves with its seed by the pattern's transform, so joints may use copies.

Parts and assemblies are not run in two passes: they are nodes of one
dependency graph, evaluated in its topological order (a part that derives
from an assembly runs after that assembly).

**One dependency graph** covers parameter tables, the values inside each
feature, parts, assemblies, instances, derives and published values; it must
be acyclic (a part deriving from an assembly that contains that part is a
cycle). Captured contexts are stored geometry, not edges, which is what lets
a part use its own assembly.

## 11. Library

`library`: a table of entries `{id: lib_…, hash, kind, content, source,
name}`:
- `kind`: `document` (a component or parameter-only document), `material`,
  `appearance`, `threadStandard`, `sheetMetalRules`, `profileStandard`, `font`.
- `content`: `{"inline": definition}` or `{"missing": {"name"}}` (content not
  available, e.g. a linked file not found at import).
- `source`: `{"local": {}}` or `{"catalogue": {"id" (label), "version",
  "policy": "pinned" | "latest"}}`.
- Entries are keyed by id (`lib_…`), with `hash`, the name hash of
  `content`'s canonical form (absent for `missing`), as a field checked on
  load. Updating a `latest` entry replaces its content and hash under the same
  id. Loading never updates an entry; updating is an explicit command.
- A **library reference** is a value object of type `library` whose `expr`
  evaluates to a library entry, named in `refs` as `{"library": {"id": lib_…
  (must exist)}}` (a single name, or a choice such as `big ? steel : brass`);
  a configuration swaps the entry by overriding the value.
- `hash` covers `content` exactly as written; an embedded document's asset
  rows carry `mediaType`, `name` and `size` but no `data`, so the hash does
  not depend on where the bytes are stored.
- A `document` entry is a complete version-2 document at the host's
  `schemaVersion`; its assets carry no `data` (the host's `assets` holds the
  bytes). Converting a host converts its library and recomputes their hashes in one step.
- Materials and appearances are definitions, so a document weighs and renders
  the same anywhere. A `missing` entry builds nothing; dependents pause.
- A `font` entry's content is `{"inline": {"definition": {"asset": content
  hash}}}`; the asset is an OpenType file (TrueType or CFF outlines).

### 11.1 Derive

`core.derive` inputs: `{from: {"part": {"id"}} | {"assembly": {"id"}} |
{"component": value of type library}, instance: inst_…, items: {"all": {}} |
{"items": set of references}, overrides: ordered list of overrides, frame,
operation}`. Inserting a component into a part is a derive from a library
document. Override values are evaluated in the host; the inserted document's
expressions never see the host. Derived outputs carry `{"derive": {}}` in
their `chain`. An optional `mirror: {"plane": reference}` (a default plane of
the host) reflects the derived bodies in that plane after `frame`, adding
`{"mirror": {}}` to their chain after the derive step; this is how an
opposite-hand part is made. A part that derives from itself, directly or
through others, is an integrity error. Parts build on demand in dependency
order, derive sources first.

## 12. Assemblies

### 12.1 Assembly

`{id: asm_…, name, parameters, configurations, instances, jointOrigins,
joints, relations, rigidGroups, contactSets, timeline, positions,
activePosition, explodedViews, attributes, notes, properties, solver}`:
- `instances`: table of `{id: inst_…, of: {"part": {"id"}} | {"assembly":
  {"id"}} | {"component": value of type library}, placement (numeric, last solved),
  grounded (flag), suppressed (flag), overrides: ordered list of overrides}`.
  Instances of one definition with the same effective overrides share one
  build (the effective set is the targets with their evaluated results; an
  override equal to the target's default still counts, since it shields the
  target from configuration rows); each distinct set of overrides builds its own **variant** of the
  definition, whose entities carry the instance step in their `chain`. A
  definition's captured contexts and in-context features are shared by all
  its variants.
- `jointOrigins`: table of `{id: jor_…, frame: attached frame}` with
  references scoped through instance paths.
- `joints`: table of `{id: jnt_…, kind, a, b, limits, rest, state,
  suppressed, name}`: `name` (optional text; absent, an editor labels the
  joint by its kind and its number among the assembly's joints of that
  kind); `kind` from the **joint-kind registry**, which defines each
  kind's degrees of freedom by name and axis in the joint-origin frame; `a`,
  `b`: `{"origin": {"id": jor_…}}` or `{"frame": attached frame}` (geometric
  ends for path, cam and tangent joints are later variants); `limits`,
  `rest`: maps from degree-of-freedom name to `{"free": {}}` /
  `{"between": {min, max}}` and to a value; `rest` is where the solve
  starts a degree of freedom that `state` lacks (a new joint) and what a
  reset writes into `state`, and never otherwise drives the solve; `state`:
  map from degree of freedom to the last solved number.
- `relations`: table of `{id: rel_…, kind (registry), joints: ordered list
  (must exist), ratio: value}`.
- Initial **joint kinds**, with their degrees of freedom: `rigid` (none),
  `revolute` (`rz`), `slider` (`tz`), `cylindrical` (`tz`, `rz`), `pinSlot`
  (`tx`, `rz`), `planar` (`tx`, `ty`, `rz`), `ball` (`rz`, `ry`, `rx`).
  With every degree of freedom at 0, `b`'s frame coincides with `a`'s;
  otherwise `b`'s frame is `a`'s moved by the translations `tx`, `ty`, `tz`
  (mm) along `a`'s axes, then turned by the rotations (deg) about the moved
  frame's own axes, z first, then y, then x. An editor joining two faces
  writes `b`'s frame flipped, so the faces meet with their outward normals
  opposed.
- Several joints may share a joint origin. Editing a joint origin moves
  every joint that uses it; editing one joint never
  moves another: when an end the edit changes is an origin another joint
  also uses, the editor writes a new origin for the edited joint.
- Initial **relation kinds**: `gear` (two joints, each with one rotation:
  the second's rotation is `ratio` × the first's, a ratio quantity; a
  negative ratio turns the other way), `rackPinion` (a joint with one
  rotation, then one with one translation: translation = `ratio` × rotation,
  in mm/deg), `screw` (one `cylindrical` joint: `tz` = `ratio` × `rz`, in
  mm/deg). Joints of the wrong kind pause the relation.
- `rigidGroups`, `contactSets`: tables of `{id: grp_… or set_…, members: set
  of instance paths}` (`grp_` for rigid groups, `set_` for contact sets).
- `timeline`: assembly features (`core.asm.pattern`, `core.asm.mirror`,
  `core.asm.replicate`). Assembly features create instances only, never
  bodies: a cut through parts goes into each part (12.3), and an
  opposite-hand mirror creates a new part (a `core.derive` with a mirror step)
  and an instance of it, since placements are rigid. A value of an assembly
  feature sees the document's parameters, the assembly's own parameters and
  the named values of its own feature and the assembly's earlier features,
  as a part feature sees its part's (6.4); instances' published values are
  visible as 6.4 says. The parts an opposite-hand mirror lists are ordinary
  parts of the document: removing a seed from the mirror, or the mirror
  itself, removes the instances it placed and leaves the parts; an
  editor may offer to remove a part nothing else uses.
- `positions`: table of `{id: pos_…, name, state: map from jnt_… to a map from
  degree-of-freedom name to a number}`;
  `activePosition`: `{"current": {}}` or `{"position": {"id"}}`.
- `explodedViews`: table of `{id: exp_…, name, steps: ordered list of
  {instances: set of instance paths, transform: placement value}}`.
- `solver`: integer version of the joint-solve behaviour.

### 12.2 Pose

Solving starts from stored instance placements and joint `state`, respects
`limits`, keeps grounded instances fixed, and leaves under-constrained
instances where they are. An active position replaces joint `state` before
solving. Results are written back as the new stored placements and `state`,
by an editor, in the same undo step as the edit that changed the solve;
loading and evaluating never write them.
- Instances are placed outward from the grounded ones along the joints, each
  joint at its start: its `state` (or the active position's), else `rest`,
  else 0, clamped to `limits`.
- A group of instances joined to nothing grounded keeps its first instance,
  in table order, where it is stored.
- A relation's first joint drives the second.
- A joint an attribute marks `locked` (16.1) holds its `state` (clamped to
  its limits): the solve does not change it and an active position does not
  replace it.
- Joints that close a loop are satisfied by changing joint values as little
  as possible; a loop that cannot close leaves every joint at its start and
  pauses those joints and relations.
- A copy made by an assembly feature is placed by its feature's transform,
  read at the stored placements, applied to its seed's.
- A frame attached to an instance's geometry is read in that instance's
  frame; supports in more than one instance pause. A reference into an
  instance names the instance its chain ends with.
- Exploded-view steps compose in order (Tₙ ∘ … ∘ T₁ ∘ P).

### 12.3 Holes and cuts through several parts

A cut or hole through several parts is written into **each part's own
timeline** as an ordinary feature, whose references to the other parts'
geometry are in-context references (12.4). Each part keeps the result in its
own definition, so it prints with it. The command puts the hole's sizes in one document
parameter that every part's copy uses, so one edit changes them all. It
writes the hole into the part it starts in, evaluates, captures every other
part's context from that state, and writes their holes, attached to the
first hole's bore; then it re-captures every affected context from the final
state in one pass and commits all of it together, so they share one
`source`. A part with several instances (counted as instance paths through
nested assemblies), or a library component,
takes no hole until the user makes it its own part (a copy). Contexts capture
the pose, so moving a joint marks them out of date; under `automatic` the
holes follow.

### 12.4 Captured contexts

A part that uses geometry from an assembly does so through a **captured
context** in its `contexts` table: `{id: ctx_…, assembly: {"id": asm_… of
this document (must exist)}, at: instance path of this part in it,
captured, source, policy: "manual" | "automatic", position, capturedAt}`.
- `captured`: a set of `{"instance": instance path, "stored": stored shape
  (13.2), "construction": ordered list, "placement": numeric}`, one per
  captured instance. Each instance's geometry is stored in its own part's
  frame, so identical parts and unchanged instances share one asset by content
  hash; `placement` maps it into this part's frame. Re-capturing rewrites only
  the instances that changed.
- `position`: optional, `{"current": {}}`, `{"position": {"id": pos_…}}` or
  `{"captured": {"state": map from jnt_… to a map from degree-of-freedom name
  to a number}}` (the joint states at capture); absent: current. Captures are
  taken with the assembly in that position. The multi-part command writes
  `captured`, so opening a hinge to look does not move holes that were made
  closed.
- `source` is the name hash of a **manifest**: `{"assemblies": [...],
  "parts": [...], "parameters": [...], "library": [...]}`, each list holding,
  sorted by id, the rows the assembly reaches transitively (itself, nested
  assemblies, parts, the document's and their parameter tables, library
  entries), with exactly these removed: the `attributes`, `views`, `notes`,
  `properties`, `metadata`, `folders`, `groups`, `rollback` and `command`
  fields; the `name` and `description` fields **of rows** (document, part,
  assembly, feature, parameter table, parameter, value object, instance,
  position, exploded view, selection set, library entry); and dimension
  `label`s; and all **solver state** (sketch point coordinates, dimension
  `solved`, joint `state`, instance placements, captured `placement`s and
  `construction` numbers, snapshots), which is not bit-stable. Every other
  field stays, including any other field called `name`
  (a `standard` reference's, a `representation`'s) and selection `sets`. A
  field an addition (chapter 19) declares presentational is removed too.
  Every context is then reduced to exactly `{"id", "at", "position"}`:
  captures belong to no manifest (they are not bit-stable, and a capture that
  another part builds from reaches this part through that part's geometry,
  which the comparison below checks), so `source` does not depend on when
  captures are committed.
- A context is **out of date** when `source` differs from the current
  manifest's hash, or when a captured instance's placement relative to this
  part, or its geometry, differs from the current assembly's beyond 13.2's
  load-check tolerance, or its shape map's ladders, `aliases`, `branch` or
  `children` differ.
- A dangling `at` (the instance was deleted) marks the context out of date;
  the part still builds from `captured`.
- A captured entry's `construction`: ordered list of `{ladder, aliases, geometry}` for the
  captured construction outputs, `geometry` being `{"plane": {"origin",
  "normal", "x"}}`, `{"axis": {"origin", "direction"}}`, `{"point": {"at"}}`
  or `{"frame": numeric placement}`. Sketch curves are captured as edges in the
  stored shape with their curve identities, so another part's sketch, plane,
  axis or origin can be referenced like its faces.
- The captured instances are those this part's in-context references
  point into (never the instance at `at` or its descendants); adding a
  reference into another instance captures that instance too, and removing
  the last reference into one drops it. A command may capture an instance
  in the same step as the first reference into it or one step before it (a
  pick made while a feature panel is open, before the feature is written);
  an instance captured with no reference into it is not an error, and the
  next update drops it. Each sub-shape keeps its identity as
  built in its own part, its `chain` extended by the instance path as 9.5
  states.
- In-context references resolve against the captured instances, never the live
  assembly, so no loop can form. The result lives in the part's definition,
  so every instance of the part shows it; to change one instance only, the
  user first makes it its own part (a copy).
- Re-capturing keeps names: each map entry carries the identity the entity
  had in its own part, so references survive an update. The entry's shape
  map is written with each name's `chain` already extended by the instance
  path; loading checks the map against the stored shape in its own part's
  frame, then places it by `placement`, keeping every name.
- `source` is a name hash of an object that is never stored, so it is not
  one of the hashes `names` holds (20).
- A command that writes features into several parts (12.3) captures every
  affected part's context from the same assembly state (same `source`) and
  commits them together, or not at all.
- Loading never re-captures, whatever the policy.
- **Update** re-captures the context from the current assembly (an explicit
  step under `manual`; after each assembly change under `automatic`). An
  automatic update belongs to the edit that caused it: undoing the edit
  undoes the update with it, and undo or redo starts no update.
  Automatic updates run in **synchronous passes**, so no dependency order is
  needed and cycles are handled: each pass takes one snapshot of the
  document, evaluates the assembly from it once per distinct `position` the
  contexts ask for, re-captures every automatic context from its position's
  evaluation, then commits them all; at most (number of parts + 1) passes per user edit. They stop when a
  pass leaves every captured entry unchanged: the same shape-map topology
  (ladders, `aliases`, `branch` and `children`), every snapshot, `construction` value and placement
  within 13.2's load-check tolerance (re-solving can move stored bytes by a
  rounding step, so asset hashes are not compared). If
  that point is not reached, the whole update is rolled back as one
  transaction: every context, and all solver state the update's passes wrote
  (sketch points, joint `state`, instance placements), returns to what it was
  after the user's edit and before the first pass, so a bistable mechanism
  cannot keep another solution branch; the user's edit itself stays, and
  "context did not settle" is reported.
- Contexts and the multi-part command apply to parts defined in this
  document. A library component is edited in its own document; its shared
  sizes reach it as public insertion overrides.
- When the assembly has changed since capture, the part shows its context as
  out of date.

## 13. Assets, stored geometry and imported designs

### 13.1 Assets

`assets` entries keyed by content hash: `{mediaType, name, size (exact),
data}`; `data`: `{"external": {}}` (stored out of band by the storage layer)
or `{"inline": {"base64": string}}`. Missing and not-yet-loaded are reported
differently. A storage layer that fetches an external asset checks the bytes
against its key and `size` before putting them inline; bytes that do not
match are not used. An asset whose bytes could not be fetched stays
`{"external": {}}`: what uses it pauses as not loaded, and the storage layer
reports it by name as missing when the document opens. A document is stored
with any mix of inline and external rows. The table lists every asset of the document and its library
documents; storage reads only this table.
A row is **used** when a field of the document or of one of its library
documents names its hash (a stored shape, a file source, an import's source
or report, a lookup table, a font, a decal's or canvas's image). Unused rows
are never a refusal, and a reader ignores them. As with unused name-table
entries (9.8), a writer that understands every field of the document drops
them when it rewrites the asset table, not on every save, so a document
loaded and saved unchanged keeps its bytes; until then the rows that an
unfrozen feature, a removed context or a replaced import used stay.

### 13.2 Stored shapes and shape maps

A **stored shape** is `{"asset": hash, "representation": {"name", "version"},
"map": shape map}`. The **representation registry** defines, for each name
and version, the asset's byte format and its **index order**: the order in
which its sub-shapes are numbered. Initial entry `brep` 1: OCCT BREP text
format version 3, written without triangulation or point representations
(a writer removes any mesh first, as OCCT's `BRepBuilderAPI_Copy` without its
mesh does, so the bytes never depend on whether the shape was displayed),
sub-shapes numbered compounds, then compsolids, solids, shells, faces, wires,
edges, vertices; the root shape is compound 0, and each body of a stored
shape is one direct child of it, in the order of the feature's outputs. Each
kind is numbered by a depth-first walk from the root shape, children in
their stored order, counting each (shape, location) pair once at its first
visit and ignoring orientation (what `TopExp::MapShapes` does). The asset's
hash and size are verified before it is used. `mesh` and `subd` representations
are additions with their own index orders (triangle groups, cage faces). A
`brep` 1 map pays one entry per face, edge and vertex, so a triangle mesh
stored as `brep` costs about 3 kB per triangle; a `mesh` representation,
when added, maps its faces (triangle groups) and bodies only and names edges
and vertices from their faces by 9.4. Until then an importer stores a mesh
as `brep` 1 with coplanar triangles merged into faces.

A **shape map** gives the identity of every sub-shape: an ordered list of
entries, one per sub-shape in index order. Each entry: `{ladder, aliases (set of entity keys `{hash, branch}`), branch,
snapshot, children}`, `children` being the set of indices of its direct
sub-shapes (a face's wires, a wire's edges, an edge's vertices). Freezing, importing and capturing write one, so references
survive. An entry's `snapshot` holds the 9.7 measures of its kind and, on
vertices, edges and faces only, `geometry` (wires, shells and solids are tied
to what they hold by `children`). On load each entry's `children` and
`snapshot` are checked against the sub-shape at its index: `geometry` as in
9.7, each measure by its class (positions; directions, `axis` and `tangent`
up to sign; sizes), `quarter` and `threeQuarter` as a pair in either order,
and every stored measure present live (`size` being the stored shape's
bounding-box diagonal; positions 1e-6 × size + 1e-9 mm, directions 1e-6°, sizes ratio
1 ± 1e-6, loose enough that kernel versions reproduce it); a mismatch means
the decoder enumerates
differently and the feature pauses rather than attach a wrong identity.

### 13.3 Imports and imported designs

- `core.import` inputs: `{source: {"file": {"asset": hash}} | {"kept": {}},
  stored: stored shape, importer: {"format", "version"}, units: choice value
  (mm, cm, m, um, in, ft), upAxis: choice value (y, z)}`.
  Replay loads `stored`, so a newer importer or kernel never changes an
  import. `units` and `upAxis` record how the importer read the file and
  never change replay: `units` is the unit the file's lengths were taken in
  (the stored shape is in millimetres); `upAxis` is the file's axis that
  became the part's y: `y` when the file's axes are kept, `z` when the file
  was turned so that its z is the part's y ((x, y, z) became (x, z, −y)). Entity names (the `src` of the `import` rule, 9.4) use the file's
  own entity ids where it has them and the map index otherwise; they do not
  include the asset hash, so a re-import that keeps the file's ids keeps the
  names.
  Replacing the file is an explicit operation that re-pairs references.
- `metadata.origin.imported`: `{format, version, source: asset hash, report:
  asset hash}`. The report is an asset of media type `application/json`:
  `{format, version, notes}`, each note `{severity: "info" | "warning",
  object, message}`, naming what the importer could not map and the object
  of the source file it concerns. A step the importer cannot map comes in as `core.import` with
  `{"kept": {}}`, with the source program's data under its namespace in
  `extensions`.

## 14. Timeline state

`rollback`, `suppressed` and `frozen` are document state; per-configuration
suppression is an override of the `suppressed` value.

## 15. Construction geometry

Construction features produce `plane`, `axis`, `point`, `frame` outputs from
an attached frame: a plane is the frame's xy plane (its normal the frame's
z), an axis the frame's z axis through its origin, a point its origin; a
frame output is all three. A reference names an output by its feature
(`{"object": {"feature"}}`) or by its name. Default geometry is the
`standard` reference.

## 16. Attributes, appearance and documentation

### 16.1 Attributes

`{id: attr_…, target: reference, properties: map}`. Properties (each a value
object; absent: not set): `color` (text `#rrggbb`), `opacity` (ratio 0–1),
`appearance`, `material` (type library), `name`
(not on feature targets), `visible` (boolean), `filamentSlot` (integer),
`locked` (boolean), `properties` (16.4).
An assembly's attribute may also target one of its joints,
`{"object": {"joint": {"id": jnt_…}}}` (the id is reference-class); on a
joint only `locked` applies (12.2), and other properties are kept without
effect.
- Two attributes setting the same property on the same target are an
  integrity error.
- **Visibility**: an entity is shown when no `visible` along its path
  (instance path, part or feature, body, face) is false; precedence does not
  apply, so a `true` lower down never unhides it. An export writes the
  bodies shown unless the user picks others.
- **Appearance**: for `color`, `opacity`, `appearance`, `material`, an
  attribute on an instance overrides everything inside that instance; within
  a part the most
  specific target wins: face, then body, then feature, then part. A
  property on a feature target applies to the bodies that feature creates; a
  face takes its body's appearance unless a face target sets its own.
- **After a join**: the merged body keeps the target's identity and the tool
  bodies become its aliases (7.3). An attribute whose target resolves
  directly wins over one that reaches the same body only through an alias, so
  a join or cut keeps the target body's colour. Among attributes that reach
  it only through aliases, the alias whose name's feature comes first in the
  timeline wins, ties going to the lower hash. Faces keep their own
  identities, so a face colour carried in from a tool body stays on that face.
- **Filament slots**: `filamentSlot` is a user's explicit choice; without one,
  a 3MF export gives each distinct body colour its own slot. A face colour
  colours its triangles and takes no slot of its own.

### 16.2 Decals and canvases

`core.decal`: `{image: asset hash, faces: set of references, frame, size,
opacity}`. `core.canvas`: `{image: asset hash, frame, calibration: {from:
[x, y], to: [x, y], distance}, opacity}`.

### 16.3 Views and notes

`views`: table of `{id: view_…, name, camera: {position, target, up,
projection: {"perspective": {"fieldOfView"}} | {"orthographic":
{"height"}}}, position: {"current": {}} | {"named": {"id": pos_…}}}`.
`notes`: table of `{id: note_…, anchor: {"ref": {"ref": reference}} | {"at":
{"v": vector}}, text, kind}`.

### 16.4 Properties

A map from name to `{type: "text" | "number" | "boolean" | "date",
quantity (for numbers), value: value object}`, on the document, parts, assemblies, instances (through attributes)
and bodies (through attributes).

## 17. (reserved)

## 18. Extensions and unknown content

- `extensions` may appear inside any **schema object** (an object whose keys
  this text defines, including a tagged union's payload): `{"<namespace>":
  any JSON}`; `core` is reserved. It never appears as a key of a map keyed by
  user or registry names (properties, settings, attribute properties, assets,
  names), where such a key is an ordinary entry, nor inside name objects
  (their hashes must not depend on it). Extensions never change geometry.
- Unknown keys and extensions are kept byte-for-byte through load, edit and
  save; commands that rewrite an object carry them over.
- **Content that could change geometry and is not understood pauses what
  depends on it** and is reported: an unknown feature type or `typeVersion`, an
  unknown key anywhere under `inputs`, an unknown curve, constraint, joint, relation,
  attachment-mode, measure or output kind, an unknown representation, grammar, naming-rules or
  solver version, an unknown reference or value shape.
- An unknown key in **any object not listed as presentational below** (the
  top level, part and assembly rows, the feature envelope, sketch tables,
  parameters, value objects, references, configurations, instances, joints,
  relations, contexts, stored shapes, library entries) likewise pauses what
  depends on that object; at the top level, the whole document.
- **Presentational content** that is not understood (attributes, views,
  notes, properties, settings, metadata, folders) is kept and ignored. An
  addition that affects geometry is never placed in a presentational
  object.
  Attributes never change geometry; `material` affects only mass reports,
  which no grammar-1 value can measure.

## 19. Versioning and evolution

- `schemaVersion` is read first; newer is refused with a plain message; older
  supported versions are migrated step by step (pure JSON); unsupported older
  versions are refused.
- **Additions** (no `schemaVersion` change): feature types and `typeVersion`s;
  curve, constraint, output, joint, relation, attachment-mode, measure,
  library and quantity kinds; settings; attribute properties; naming-rules
  registry entries and versions; solver versions; grammar versions; asset media
  types; extension namespaces; entries of every registry; **new id kinds**
  (readers check an id's shape, `<lowercase letters>_<26 characters>`, never
  its kind against a list); **new entity kinds** for references; **new
  variants of any tagged union** (extent, direction, reference form, joint
  end, library content, value def, frame, copy key, curve key); **new
  members of a closed string set** (`standard` and `sketchStandard` names,
  configuration input types, snapshot `surface` and `curve` kinds); new optional fields in
  an object, each with its meaning when absent stated.
- A reader meeting an unknown variant handles it as unknown content
  (chapter 18).
- **A new `schemaVersion`**: any change to the meaning or encoding of an
  existing field, the id format, the canonical form or the hashes.
- Every migration is tested on pinned documents of its source version.

## 20. Integrity rules checked on load

A document breaking one is refused with the rule named; nothing is repaired
silently:
- `format`, `schemaVersion`; tagged unions with exactly one key; sets and
  counted sets in canonical order without duplicates;
- ids well formed and unique; every must-exist field resolves (a value
  object's `id`, a derive's `instance` and every table row's `id` are
  definitions);
- name hashes, asset hashes (inline data) and library `hash` fields re-hash
  to their stated values. `names` should hold the **used** hashes (every
  hash in any identity ladder, `nb`, `side.of`, `aliases`, `src` item, frozen
  identity, shape-map entry and captured `construction` entry, and every hash
  their name objects contain, transitively); neither a missing entry (it
  pauses the references holding it, 9.8) nor an unused one is a refusal,
  nor is an asset row nothing names (13.1);
- rotations of unit length in canonical sign;
- a part's groups each hold at least one feature of its own timeline, next
  to each other and in timeline order, and no feature is in two (7.1);
- an `inContext` reference's `instance` is one its context captured, and an
  entity `ref`'s `chain` ends with that path's steps;
- a configuration's `input` depends only on table parameters no
  configuration overrides (7.4);
- no `value` override targets a value defined inside another override's
  `with`;
- no cycle among table parameters, among one feature's values, among derives,
  among assemblies, in curve or region ancestry, in region merge fates,
  among selection sets, or in folders;
- parameter names unique per scope and not reserved; every name in an
  expression present in its `refs`, and no `refs` entry unused; every
  expression free of the errors appendix B decides from its text (judged with
  same-document refs only: a `published` ref's type lives in another
  document, so a mismatch there pauses); every lookup table's asset present
  in `assets`; two attributes never set the same property on the same
  target.

References whose targets are gone are not refusals; they pause (9.6).

No JSON Schema of the core is published yet; the reader in the reference
implementation and its tests check what this chapter lists. Should a schema be
generated from this text, this text wins where the two disagree.

## 21. Coverage

The core represents the concepts of parametric solid modelling listed below,
except those the table lists as excluded by design; capabilities whose
feature types are reserved are added under the core's rules when built.

| Area | Representation |
| --- | --- |
| Sketches | chapter 8 |
| Features (solid, surface, mesh, subdivision, sheet metal) | appendix A; outputs chapter 4 |
| Copy, paste, move, remove | `core.move`, `core.import` with `kept`, `core.removeBody`, `command` |
| Patterns, mirrors, chains, per-copy variation | `core.pattern`, `core.transformChain` |
| Parameters, model parameters, spreadsheets, variables, shared tables | chapter 6 |
| Configurations | 7.4 |
| Components, linked and derived designs | chapter 11 |
| Assemblies, joints, couplings, positions, exploded views | chapter 12 |
| Holes and cuts through several parts | 12.3, 12.4 |
| Attachment | attached frame (7.3) |
| Appearance, materials, decals, canvases | chapters 11, 16 |
| Timeline state, groups, folders, sets, composite features | chapters 7, 14 |
| Content the source program stores as behaviour | `core.import` with `kept`, plus `extensions` |
| Code in designs (scripts, macros, scripted features, code-generated shapes) | not represented (principle 2); imported as their results |
| Primitives combined as solids and holes, and grouped | primitives with `operation`, groups |
| Drawings, simulation, CAM, PCB | outside the model, referencing it with chapter 9 |
| Material-driven equations (mass in expressions), live cyclic cross-part adaptation | excluded by design (6.3, 12.4): mass is reported, never an input; parts adapt through captured contexts, never live |
| Assembly-only machining that leaves the component definitions unchanged | excluded by design (12.1, 12.3): the cut goes into each part |

## Appendix A. Feature catalogue (core namespace)

Inputs at `typeVersion` 1; scalars and flags are value objects; references
are chapter 9 forms. *Reserved* types have their name and envelope fixed; their
inputs are specified, under the core's rules, when they are built.

| Type | Inputs |
| --- | --- |
| `core.sketch` | chapter 8 |
| `core.extrude` | `profiles`, `sides` (ordered list of one or two sides: the first runs along `direction` from the start, the second, when present, opposite to it. The first side's distance is positive; the second's may be negative, and then ends on the first side's side of the plane; together they give a positive length, otherwise the feature pauses. Each side's taper pivots about the sketch plane (about the start, when `start` moves it), and a positive taper widens the profile as that side goes; a symmetric extent's taper applies to both halves alike; a taper with a negative second side pauses), `direction` (a sketch's normal is `{"normal": {"ref": {"object": {"feature": {"id": the sketch}}}}}`), `thin` (`{"solid": {}}` or `{"thin": {thickness, placement: choice value (inside, outside, center)}}`: the wall is the band between each loop of the profile and that loop offset by `thickness`, into the region (`inside`), out of it (`outside`) or by half each way (`center`), with sharp corners; a thin wall with a taper, or one thicker than the profile, pauses; profiles are closed), `operation`, `start` (optional; absent: `{"profilePlane": {}}`, the sketch plane), one of three: `{"profilePlane": {}}`; `{"offset": {"d": s}}`, the profile moved by `d` along `direction` (negative: against it); or `{"object": {"face": ref, "offset": s}}`, the profile projected along `direction` onto a face, a construction plane or a default plane, then moved by `offset` along `direction`, as `toFace`'s offset moves a stop. A plane parallel to the sketch plane moves the profile onto it; any other start gives the start cap its shape. A face the projected profile does not wholly reach is extended to its whole surface, as for `toFace`. Where the line along `direction` through a point inside the profile meets the face more than once, the start is the meeting nearest the sketch plane ahead of it, or behind it when none is ahead. Each side runs from the start: a distance ends on the start moved by that distance along the side, so with a start of another shape the end cap has that shape too; a stop (7.3) that meets the start pauses as one that meets the profile does, and `upToNext` and `upToLast` look from where that line through the profile's centre of mass (through a point inside the profile when the centre lies outside it) meets the start. A start plane `direction` runs along, a start the profile does not reach, and a taper with a start not parallel to the sketch plane pause the feature. A vertex or sketch point as the object, meaning the plane through it parallel to the sketch plane, is not yet supported: an object that is not a face or a plane pauses the feature |
| `core.revolve` | `profiles`, `axis`, `sides` (ordered list of one or two angle extents: the first turns by the right hand about `axis`, the second, when present, against it; `symmetric` and `full` are the only side. A partial revolve's angles are not negative and total more than 0 and less than a full turn. The axis lies in the profile's plane and does not cross the profile; otherwise the feature pauses), `thin` (as `core.extrude`), `operation` |
| `core.sweep` | `sections` (table `{id: sec_…, section: {"profiles": set} \| {"circle": {diameter, hollow}}}`; `diameter` a length, `hollow` the wall, 0 for a solid; more than one row pauses), `path` (curve chain of sketch curves and edges, in any order, joined end to end; a region in it stands for its outer loop), `orientation` (`{"fixed": {}}`: the section keeps one orientation; `{"followPath": {}}`: it turns with the path; `{"guide": {"chain"}}`: a second curve chain turns it), `twist` (optional, an angle; anything but 0 pauses), `scale` (optional, the section's size at the end of the path as a ratio, changing evenly along it), `operation`. A section of regions runs from where it is drawn, wherever on the path that is; a circle stands across the path at its start. Corners of the path are mitred. The holes of a region are swept too and cut out. A section lying along the path, or a sweep that runs into itself, pauses |
| `core.loft` | `sections` (table `{id: sec_…, section: {"profiles": set} \| {"face": ref} \| {"point": point}}`; at least two, in order; a set of several regions pauses; the holes of a region are not lofted; a point only starts or ends a loft), `rails` (list of curve chains), `centerline` (optional curve chain), `ruled` (flag: straight between neighbouring sections), `closed` (flag: on from the last section back to the first, with no caps; at least three sections, none a point), `endTangency` (optional `{start, end}`, choice values `free`, `normal`), `operation`. Rails, a centerline and tangency other than `free` pause: the kernel's loft has none of them. A loft whose result encloses nothing pauses. A closed loft's sections must have the same number of edges, and pause otherwise: the kernel lines each section up with the one before it edge by edge, as left to itself it can twist sections a quarter turn apart into a smaller valid solid |
| `core.fillet` | `sets`: ordered list, not empty, of `{targets, radius: {"constant": {s}} \| {"variable": {points: ordered list of {at, radius}}} \| {"chord": {s}}, setback}`; `s`, `radius` and `setback` are lengths, `setback` 0 means none; `at` is a ratio from 0 to 1 along the target edge, from the end at the vertex with the lower finest name. In typeVersion 1 a variable radius has exactly two points, at `at` 0 and 1 (start and end radii); an edge whose two ends share a finest name pauses a variable set. An edge is in one set only. All sets are one kernel call, so the corners between sets of different sizes are built together |
| `core.faceFillet` | `a` (face set), `b` (face set), `radius` |
| `core.chamfer` | `sets`: ordered list, not empty, of `{targets, size: {"distance": {d}} \| {"twoDistances": {d1, d2}} \| {"distanceAngle": {d, angle, flipped?}}}`; `d`, `d1`, `d2` are lengths, `angle` strictly between 0 and 90 degrees from the face `d` lies on. `d1` and `d` lie on the reference face: the target face of the set the edge came from, when exactly one of the edge's two faces is one, otherwise the face with the lower finest name. Swapping `d1` and `d2` puts the chamfer the other way round. `flipped` (flag; absent, false) puts `d` on the edge's other face instead, the angle measured from it: a distance-and-angle chamfer the other way round. An edge is in one set only |
| `core.shell` | `bodies`, `remove` (face set, each face on one of `bodies`; may be empty), `thickness`, `direction` (`inside`, `outside`, `both`), `outsideThickness` (length; absent, there is none). A body with removed faces is hollowed through them; a body with none is hollowed closed, around a sealed void. `inside` walls `thickness` into the body and `outside` walls it out of the body. `both` walls `thickness` in and `outsideThickness` out; without `outsideThickness` it pauses. `outsideThickness` is read only with `both`. Outer corners stay sharp |
| `core.hole` | `placement` (`{"frame": attached frame}` or `{"face": ref}`; with a face the frame is the one the `plane` attachment mode makes on it (7.3): z its outward normal, origin the part origin projected onto it, x the part's x axis projected; the hole runs along −z of the frame, into the material from a face's outward normal), `positions` (table `{id: hp_…, at: point, from?}`; a vector `at` is in the placement frame, a referenced point in the part; either is projected along z onto the frame's plane. Optional `from`, an ordered list of one or two `{edge: ref, d}`, measures the position from straight edges of the placement face: it lies `d` from each edge's line, perpendicular to it in the face's plane, on the side the face lies on next to the edge's middle (a negative `d` the other side); one edge sets the coordinate across it and `at` gives the one along it, two set both. An edge that is gone, curved or not an edge of the face, two parallel edges, and `from` with a `frame` placement pause), `kind` (`simple`, `counterbore`, `countersink`), `diameter`, `depth` (extent, from the plane to where the full diameter ends), `tip` (`{"angle": {a}}`, the full included angle, past `depth`, or `{"flat": {}}`; not used by through-all), `counterbore` (optional, `{diameter, depth}`, required by that kind), `countersink` (optional, `{diameter, angle}`, the full included angle, required by that kind), `thread` (`{"none": {}}` or `{"thread": {standard, designation, class, modelled, hand?}}`, the first three text values, `hand` as `core.thread`'s; with a thread the hole is drilled at the standard's tap drill, `diameter` is not used, and the thread runs the bore's whole length; `modelled` cuts it as `core.thread` does, and a pattern of such a hole pauses, as a copy would have no thread). A hole cuts every body in its way; a position that misses every body cuts nothing |
| `core.thread` | `faces` (face set: one cylinder), `standard`, `designation`, `class` (text values), `modelled` (flag), `hand` (optional choice value, `right` or `left`; absent, right), `length` (`{"full": {}}`, or `{"distance": {d, from}}`: `d` along the axis from `from`, a circular edge bounding a threaded face). The faces' outward normal decides internal or external, which must agree with the class (ISO: capitals internal); the face diameter lies between the size's minor and major diameters. A cosmetic thread changes no geometry and no name: it is the feature's own output, data on its faces. A modelled thread cuts the ISO 68-1 groove into the body along the same length, and leaves no cosmetic thread. The groove stops level with the ends of its length, so a thread stops short of a chamfer next to its face rather than running through it. The body must lose the groove's exact volume, or what is left of it where something already took part of it; anything else pauses. A left-handed modelled groove is the right-handed one reflected in the plane through the axis that holds the kernel frame's angle 0, so it starts where that one does and winds the other way; a left-handed cosmetic thread stores its hand |
| `core.draft` | `faces` (face set, not empty), `neutral` (a default plane, a construction plane or a planar face), `pull` (direction), `angle`. Each face tilts by `angle` about where it meets the neutral plane, away from `pull`; a face of a kind the kernel cannot tilt pauses |
| `core.offsetFace`, `core.pressPull` | `faces`, `distance` |
| `core.replaceFace` | `faces`, `with` (face reference) |
| `core.deleteFace` | `faces`, `heal` |
| `core.split` | `targets` (body or face set), `tool` (reference), `keep` (`{"both": {}}` or `{"side": {"sign": choice value (positive, negative)}}`) |
| `core.pattern` | `of` (`{"bodies": set}`, `{"features": set}`, `{"faces": set}`; not empty), `layout` (`{"linear": {directions: ordered list of one or two {direction, count, spacing: {"equal": {s}} \| {"list": {values}}, symmetric?}}}`, `{"circular": {axis, count, angle, symmetric}}`, `{"path": {chain, count, spacing}}`), `skip` (set of slot copy keys; the seed's slot pauses the feature), `vary` (ordered list of overrides, evaluated with `i`, `j`), `operation`. `count` includes the seed; `s` is the step between neighbours and may be negative. A linear direction's `symmetric` (flag; absent: false) spreads the direction both ways from the seed: `count` instances in all, the seed among them, the copies after it at slot indices 1 … ⌈(count − 1)/2⌉ and those before it at −1 … −⌊(count − 1)/2⌋, so an even count's extra copy lies on the positive side. A circular `symmetric` likewise spreads `count` instances both ways, the seed among them, `angle` being the whole spread from the outermost copy one way to the outermost the other, the step angle / (count − 1), less than a full turn, otherwise the feature pauses; the copies turned the positive way about the axis (right-hand rule) at positive `i`. A circular `angle` is the whole sweep, at most a full turn: at a full turn the step is angle / count, otherwise angle / (count − 1). With `new` each copy is a body of its own, even where copies overlap; with `join` the copies fuse into the targets they meet, the seed taking part only as a target, and a copy that meets no target stays a body under its own name. Not yet specified, and paused: listed and path spacing, `vary`, and `cut` or `intersect`. With `of` features: each copy is the patterned feature's tool as it entered its operation (its solids fused), moved to its slot and applied with that feature's own operation to that feature's targets, resolved in the state before the pattern; `operation` is not used; features apply in timeline order; features whose operations or targets differ, a feature without a tool (fillet, chamfer, shell, frozen), one whose operation is `new` or `intersect`, and a joining copy that meets no target pause |
| `core.mirror` | `of`, `plane` (a default plane, a construction plane or a planar face; a construction output of another kind pauses), `operation` (as `core.pattern`) |
| `core.transformChain` | `of`, `steps` (table `{id: stp_…, step: pattern layout \| {"mirror": {plane}} \| {"scale": {factor, about}}}`). Each step applies to what the steps before it made, seed included, so the copies are the product of the steps; copy n of the product, counted with the first step varying slowest, has the key `{"slot": {"i": n, "j": 0}}`. Each copied feature's own operation applies. `of` other than `features`, and a `scale` step, pause |
| `core.move` | `of` (`{"bodies": set}` or `{"faces": set}`), `transform` (placement value or `{"align": {from, to}}`; what `from` and `to` may name is not yet specified), `copy`. The placement maps each point p of what moves to R·p + T in the part frame (2.7), so a rotation turns about the part origin |
| `core.scale` | `bodies`, `factor` (vector value), `about` (point) |
| `core.removeBody` | `bodies` (body set, not empty) |
| `core.boolean` | `target` (body reference), `tools` (body set, not empty, without the target), `op` (choice value: join, cut, intersect), `keepTools` (flag; with true the tools stay, each under its own names, and the boolean uses up in-place copies of them named with the `tool` copy key, 7.3 Operation). The target keeps its identity even when a tool is older; a join is one kernel boolean of the target with all its tools, and pauses if its result is not one solid or is smaller than the largest body in it |
| `core.primitive` | `shape` (`{"box": {width, height, depth}}`, `{"cylinder": {radius, height}}`, `{"sphere": {radius}}`, `{"cone": {bottomRadius, topRadius, height}}`, `{"torus": {majorRadius, minorRadius}}`, `{"wedge": …}`, `{"prism": …}`, `{"pyramid": …}`), `frame`, `operation`. A primitive is centred on its frame's origin with its axis along the frame's z: width along x, depth along y, height along z; a cone's bottom is at −z. A cone radius of 0 is a point and that end has no face; `minorRadius` is below `majorRadius`. Wedge, prism and pyramid inputs are specified when they are built |
| `core.coil` | `axis`, `diameter` (optional: with `profiles` the helix passes through each region's centre, which sets it), `advance` (`{"pitch": {p}}`; `{"turns": {t}}` pauses), `height`, `handedness` (optional choice value, right or left; absent: right), `section` (`{"profiles": set}`; `{"shape": …}` pauses), `operation`. The helix runs along `axis` from the foot of the section's centre on it |
| `core.helix` | `axis`, `diameter`, `advance`, `height`, `handedness`; output a wire usable as a path |
| `core.rib`, `core.web` | `profile` (curve chain), `thickness`, `direction`, `operation` |
| `core.emboss` | `profile` (`{"regions": set}` or `{"text": {"ids"}}`), `faces`, `depth`, `mode` (`emboss`, `deboss`), `wrap` |
| `core.thicken` | `faces`, `thickness`, `direction` |
| `core.constructionPlane`, `core.constructionAxis`, `core.constructionPoint`, `core.constructionFrame` | `frame` |
| `core.measure` | `values` (table of value objects, each with a `name` and a `measure` def; the value's quantity is its kind's: length for distance, length and radius, then area, volume, angle) |
| `core.derive` | 11.1 |
| `core.import` | 13.3 |
| `core.decal`, `core.canvas` | 16.2 |
| `core.composite` | `parameters` (overrides exposed from its children); children in the envelope |
| `core.asm.pattern` | `of` (set of instance paths), `layout` (pattern layout: linear or circular; path reserved; symmetric directions and circular layouts as `core.pattern`, the copies on the other side at negative slots), `skip` (set of slot keys); references in the layout lie in one instance or are default geometry, read in that instance's frame at its stored placement |
| `core.asm.mirror` | `of`, `plane` (a default plane or a planar face of an instance), `hand` (`{"same": {}}`: the seed's definition, reflected in the seed's own coordinate plane whose normal is nearest the mirror's; or `{"opposite": {"parts": ordered list of {instance: instance path, part: {"id"}}}}`: an instance of the listed part, a derive with `mirror` the command writes). Copy key `{"mirror": {}}` |
| `core.asm.replicate` | `of`, `seed` (attached frame), `targets` (ordered list of attached frames): the copy at target k stands to it as the seeds stand to `seed`, key `{"slot": {"i": k + 1, "j": 0}}` |
| *reserved*: `core.patch`, `core.boundaryFill`, `core.stitch`, `core.unstitch`, `core.extendSurface`, `core.trim`, `core.ruledSurface`, `core.offsetSurface`, `core.mesh.*`, `core.subd`, `core.sheetMetal.*`, `core.sketch3d`, `core.weldment.*`, `core.routing.*` | |

**Thread standards** (initial registry): `ISO metric`, designations `M<d>` (the coarse pitch) or `M<d>x<p>` with `p` the coarse pitch or a fine pitch of ISO 261, plus M17x1.5 and M17x1, which ISO 261 leaves out (sizes that have fine pitches only, such as M15 and M17, are written with their pitch), the ISO 68-1 basic profile and tap drills per ISO 2306. Other standards are additions; non-core tables are `threadStandard` library entries (11).

## Appendix B. Expression grammar 1 (normative)

```
expr    := cond
cond    := or ( "?" expr ":" expr )?
or      := and ( "||" and )*
and     := cmp ( "&&" cmp )*
cmp     := add ( ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) add )?
add     := mul ( ( "+" | "-" ) mul )*
mul     := unary ( ( "*" | "/" | "%" ) unary )*
unary   := ( "-" | "!" ) unary | pow
pow     := post ( "^" unary )?
post    := atom ( "." ( "x" | "y" | "z" ) )?
atom    := number ( unit | "[" ustr "]" )? | "true" | "false" | string | name | call | "(" expr ")"
call    := name "(" ( expr ( "," expr )* )? ")"
number  := digits ( "." digits )? ( ( "e" | "E" ) ( "+" | "-" )? digits )?
string  := '"' ( any character except '"' and '\' | '\"' | '\\' )* '"'
unit    := "mm" | "cm" | "m" | "um" | "in" | "ft" | "deg" | "rad" | "g"
         | "kg" | "s" | "N" | "MPa"
ustr    := ufac ( ( "*" | "/" ) ufac )*
ufac    := unit ( "^" "-"? digits )?
name    := [A-Za-z_][A-Za-z0-9_]*
```

- `-2^2` is `-4` (`^` binds tighter than unary minus, right-associative).
- A number without a unit is a ratio (dimensionless); adding it to a length is
  an error. The editor writes units for entered dimensions (`5 mm`).
- Quantities follow from operands (length × length is area); incompatible
  operands are an error. Results are stored as computed (2.6).
- Operators: `+ -` on two scalars or two vectors of one quantity; `* /` on
  scalars, and between a vector and a scalar; `%` on scalars of one quantity,
  the result taking the sign of the left operand (`-5 % 3` is `-2`); `^` with
  a ratio exponent (a quantity base needs an integer exponent); comparisons on
  scalars of one quantity, `==` and `!=` also on texts and booleans; `! && ||`
  and the condition of `?:` on booleans only. Anything else is an error.
- **Dimensions**: every quantity is an exponent vector over the base
  dimensions length, mass, time and angle (force is mass·length/time²; ratio
  is all zeros); the unit list gives each unit's dimension and scale to the
  stored unit. `*` and `/` add and subtract exponents, `^` multiplies them,
  `+ - % <` and the rest need equal vectors. A result whose vector matches no
  registry quantity may be used inside an expression but not stored.
- CSV numbers use the JSON number syntax; anything else in a `name[unit]`
  column is an error. A `name[]` column holds ratios (an `integer` is a ratio
  checked when stored).
- A value of type `integer` must evaluate to a ratio that is an exact
  integer; `choice` to a text among its options; `boolean` to a boolean.
  Nothing is coerced.
- **Arithmetic** is IEEE-754 double with round-to-nearest-even, in the
  **coherent base units** mm, t, s and deg (2.6), which are also the stored
  units: stored values are read and results stored as they are. A literal
  with a unit is converted once: its number times the unit's scale, the
  scale being the exact rational of the unit table below rounded once (a
  compound unit's scale is its exact rational rounded once, so `[in^2]` is
  645.16). Every operation then rounds once. So `1 [g/cm^3] * 1000 [mm^3]`
  is about 1e-6 t (one rounding off), which the editor shows as 1 g; masses
  in t are not exact, so compare them within a tolerance, not with `==`.
- **Unit table** (scale to base, exact): mm 1, cm 10, m 1000, um 1/1000,
  in 127/5, ft 1524/5, deg 1, rad 180/π (rounded once), g 1/1000000, kg
  1/1000, s 1, N 1, MPa 1.
- A unit binds only to the number it follows: `1000 mm^3` is `(1000 mm)^3`;
  a compound unit is written in brackets, `1000 [mm^3]`, `2 [N/mm]`.
- `sqrt`, `^`, the trigonometric functions and the inverse ones return the
  **correctly rounded** result: the double nearest the exact value, with
  angles exact in degrees (`sin(x)` is the exact sine of x·π/180 for the
  double x, with true π; an inverse's exact value is taken in degrees). So
  `sin(30 deg)` is 0.5, `tan(45 deg)` is 1 and `tan(90 deg)` is an error.
  `0^0` is 1; `0^-1` and a negative base with a non-integer exponent are
  errors. Every reader computes the same bits; a platform's own approximate
  functions are not used.
- **Checking**: an expression is type-checked whole before it is evaluated,
  both `?:` branches and both sides of `&&` and `||` included; a `lookup`
  result and a non-literal exponent on a quantity are checked when taken.
  Anything decidable from the text alone (syntax, an unknown function, a
  wrong argument count, a reserved word or a missing name in `refs`, an
  unused `refs` entry, a type error the whole-expression check finds) is an
  integrity error; anything that depends on values (domain, range, a lookup
  miss, a non-finite result, an `integer` value that is not whole, a
  `choice` value not among its options) pauses what uses the value.
- Small rules: unary minus negates scalars and vectors; `.x .y .z` apply to
  vectors only, giving a scalar of the vector's quantity; −0 results are
  written +0; whitespace is space, tab, CR or LF between tokens; underflow
  rounds to a subnormal or 0 without error; `atan2` returns (−180, 180];
  nesting deeper than 256 or a unit exponent beyond 4096 is an error;
  `rotate` computes the axis norm rounded once from the exact sum of
  squares, the half angle as angle / 2, then x, y, z each as (component /
  norm) × sin(half), each operation rounded, w as cos(half), then the
  canonical sign; `range` is inclusive, compared in the stored unit, for
  `number` and `integer` values; a `date` is an RFC 3339 full date or
  date-time; renaming a value rewrites each use in `text` and re-keys its
  `refs` entry, keeping its target.
- `?:` needs both branches of one type and quantity; `/` divides a scalar
  by a scalar or a vector by a scalar (a scalar divided by a vector is an
  error).
- A value outside its parameter's `range` is never clamped: it is an error
  that pauses what uses it, wherever the value came from (its own definition,
  a configuration row or a host override).
- Functions: `abs`, `min`, `max`, `round`, `floor`, `ceil`, `sqrt`, `sin`,
  `cos`, `tan` (take an angle, return a ratio), `asin`, `acos`, `atan2`
  (return an angle in degrees; `atan2(y, x)`: y first, both of one
quantity, `atan2(0, 0)` an error), `vector(x, y, z)`
  (three scalars of one quantity), `rotate(axis, angle)` (a rotation about a
  direction vector of any quantity, normalized; a zero vector is an error),
  `placement(position, rotation)` (a length vector and a rotation),
  `lookup(table, key, column)` (`column` a text naming a header). `round`
  rounds half away from zero; `round`, `floor`, `ceil` and `sqrt` take
  ratios only (`round(x / 1 mm) * 1 mm` rounds a length); `min` and `max`
  take two or more arguments of one quantity. `&&`, `||` and `?:` evaluate
  only the operand they need. Errors (division by zero, out-of-range
  arguments, a non-finite result) pause the feature using the value.
- The unit list is fixed for grammar 1. New units come with a new grammar
  version (an addition); expressions keep the grammar they were written in,
  so a new unit name can never turn an existing name into a unit; and in
  any grammar a name bound in `refs` is a name, never a unit.
- Lookup tables are CSV assets (RFC 4180, UTF-8, with lines ending in CRLF
  or LF; a leading byte-order mark is dropped; every cell is checked when the
  table is read). The header row names each
  column, as `name` (text), `name[ustr]` (a number in that grammar unit,
  compound units allowed) or `name[]` (a ratio). A malformed table pauses
  what uses it.
  The first column is the key, always text compared exactly (`001` is not
  `1`); `key` must be a text value. A missing key or column, a duplicate
  key or a duplicate header is an error.
- Grammar 1's reserved words are never names in `refs`; a unit a later
  grammar adds never reserves a name a document already binds.
- `pi` is the constant π (a ratio); `i` and `j` are the copy indices (from
  0, signed as in 9.5; `j` is 0 in a one-direction pattern), valid
  only inside a pattern's `vary` overrides.
- Reserved words: the function names, `true`, `false`, `pi`, `i`, `j`, the
  unit names.
