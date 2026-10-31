/**
 * CAD tool catalogue exposed to tool consumers (via MCP, in-app chat, etc.).
 *
 * Three consumer surfaces import this module unchanged:
 *   - the in-app chat panel (talks to the server chat endpoint)
 *   - the server-side tool loop (runs on a document clone)
 *   - the local MCP bridge (exposes these as MCP tools)
 *
 * Adding a new tool is a one-file change here. All three surfaces pick
 * it up because they all execute through `toolExecutor.ts`.
 *
 * Field naming: we store `inputSchema` (camelCase) because that's what
 * the MCP SDK expects. Surfaces that need the snake_case `input_schema`
 * form rename once at request-build time.
 */

/**
 * Minimal JSON Schema shape — narrow enough to feed the MCP SDK (which
 * expects an object schema for tool inputs) without pulling a dependency.
 */
export type ToolInputSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

/** One callable tool. */
export type CadToolDefinition = {
  /** Stable tool name. MCP requires `^[a-zA-Z0-9_-]{1,64}$`. */
  name: string;
  /** Human-readable, client-facing description. */
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: ToolInputSchema;
};

/**
 * Canonical, frozen list of tools. Order is stable so MCP clients can
 * cache against it. Add new tools by appending — never reorder.
 *
 * The v1 set covers: read state, dispatch mutations, group mutations into
 * one undo step, list features compactly, and inspect build diagnostics.
 * Component-generation / repair-loop tools land later.
 */
export const CAD_TOOLS: readonly CadToolDefinition[] = Object.freeze([
  {
    name: 'cad_help',
    description:
      'Returns a workflow guide for this CAD toolset: canonical tool ' +
      'ordering, how to discover IDs, coordinate system + units, common ' +
      'patterns (build a plate, plate-with-hole, recover from a failed ' +
      'extrude), and gotchas previous agents hit. ' +
      'CALL THIS FIRST if you are about to model anything more than a ' +
      'single one-shot mutation. Cheap (returns a markdown string). ' +
      'Reading the guide saves multiple wasted rounds on shape/enum guesses.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_document',
    description:
      'Return a snapshot of the current CAD document (parts, parameters, ' +
      'features, embedded components). Call this FIRST when you need to ' +
      'know the current state — every id you reference in mutations must ' +
      'come from a real entry here, not from memory. ' +
      'After mutations, the new state is also returned by `dispatch_command`, ' +
      "so you don't have to re-call get_document just to learn what changed.",
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_command',
    description:
      'Apply a single CadCommand to the document. ESCAPE HATCH for commands ' +
      "that don't have a dedicated tool yet (fillet, chamfer, hole, mirror, " +
      'pattern, shell, sweep, revolve, loft, set/delete parameter, etc.). ' +
      'PREFER the wrapped tools when they exist: ' +
      '`sketch_create` / `sketch_draw_*` / `feature_extrude` have validated ' +
      'schemas and return ids directly, so you avoid round-tripping ' +
      '`get_document` after every dispatch. ' +
      'Commands are validated before applying; invalid commands return an ' +
      'error without mutating state. Returns the new document snapshot. ' +
      'Examples: ' +
      "`{type:'SetParameter',scope:'project',name:'width',value:{name:'width',expression:'50',unit:'mm'}}`, " +
      "`{type:'SuppressFeature',partId:'part_X',featureId:'feat_Y',enabled:false}`.",
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          description:
            "A CadCommand with discriminator `type` (e.g. CreatePart, " +
            "SetParameter, SuppressFeature). See @tweakcad/core/src/commands/types.ts.",
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'begin_transaction',
    description:
      'Open an undo-grouped transaction. All commands dispatched until ' +
      'a matching `end_transaction` collapse into ONE undo step labeled ' +
      'with the given string. ' +
      'IMPORTANT: open a transaction whenever you are about to make a ' +
      'multi-step change so the user can Ctrl-Z your whole reply at once. ' +
      'Always close it — if you forget, the next user action will appear ' +
      'as part of your transaction and break undo for them.',
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: "Undo step label (e.g. \"AI: add 4 mounting holes\").",
        },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_transaction',
    description:
      'Close the currently open undo-grouped transaction. Pair with ' +
      'every `begin_transaction` you call.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'query_features',
    description:
      'Return a compact list of features in a part timeline (id, type, name, ' +
      'enabled, visible). Use this instead of `get_document` when you only ' +
      'need to enumerate the timeline — much smaller payload. Pass a partId ' +
      'to scope; omit for all parts.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: {
          type: 'string',
          description: 'Optional — limit to this part. Omit for all parts.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'Return rebuild diagnostics — per-feature build status (success / ' +
      'failed / blocked / suppressed) and the error message when failed. ' +
      'CALL THIS AFTER every geometry-creating mutation (extrude, fillet, ' +
      'hole, etc.) to confirm the build succeeded. A `failed` status means ' +
      'your model is wrong — STOP chaining more operations until you ' +
      'investigate and fix. Pass a partId to scope; omit for all parts.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: {
          type: 'string',
          description: 'Optional part id to scope the result.',
        },
      },
      additionalProperties: false,
    },
  },
  // ---- Viewport manipulation tools ----
  //
  // These tools let the caller control the camera without the user
  // having to drag/scroll. Use them when you've added or modified
  // geometry that's outside the current frame, or when you want to
  // look at the result from a specific angle.
  {
    name: 'view_fit_all',
    description:
      'Frame the viewport camera to fit all visible bodies in the project. ' +
      'Useful after creating new geometry that might be outside the current ' +
      "view (e.g. an extrude that's larger than what was framed before).",
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'view_set_standard',
    description:
      'Snap the camera to a named standard view: front / back / top / ' +
      'bottom / left / right, or `home` for the default isometric angle. ' +
      'Combine with `view_fit_all` to land on a clean framed iso view.',
    inputSchema: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['front', 'back', 'top', 'bottom', 'left', 'right', 'home'],
          description: 'Which standard view to switch to.',
        },
      },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_zoom',
    description:
      'Zoom the camera in or out by one step. Multiple calls compound. ' +
      'Prefer `view_fit_all` when you want a known framing; use this for ' +
      'fine-grained adjustments.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
          description: "'in' brings the camera closer, 'out' pulls back.",
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  // Note: `view_get_state` was removed from the catalog. It cost ~60
  // tokens per request to advertise across all sessions and no current
  // flow actually called it intentionally — the only call seen in the
  // smoke test was a reflexive viewport probe. Re-add as a one-liner
  // here if a real use case ever shows up (the ToolHost method, browser
  // impl, and bridge round-trip can all come with it).
  // ---- Higher-level modeling tools ----
  //
  // These wrap CadCommands with full JSON schemas + return the new ids
  // directly. Without these the caller would have to read the
  // CadCommand type definitions to learn the command shapes and
  // round-trip get_document just to find ids it just created.
  // Discoverability gap → first-class tool.
  //
  // Every tool here is a thin wrapper around one CadCommand. The
  // underlying command stays the single source of truth.
  {
    name: 'sketch_create',
    description:
      'Create a new sketch feature on the given part, sitting on one of ' +
      'the three default planes (XY, XZ, YZ). Returns `{ sketchId }`. ' +
      "Use the sketchId in subsequent sketch_draw_* and feature_extrude calls.",
    inputSchema: {
      type: 'object',
      properties: {
        partId: {
          type: 'string',
          description: 'The part id. Read from get_document().parts keys.',
        },
        plane: {
          type: 'string',
          enum: ['XY', 'XZ', 'YZ'],
          description: 'Which default plane to sketch on.',
        },
      },
      required: ['partId', 'plane'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_line',
    description:
      'Draw a line segment in a sketch. Endpoints snap to existing ' +
      'sketch points within `tolerance` mm — this is how sequential lines ' +
      'share corners and form closed loops the extrude can consume. ' +
      'Returns `{ entityId }` (the line entity id). For an axis-aligned ' +
      'rectangle, prefer sketch_draw_rectangle — it produces a single ' +
      'rectangle entity in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        from: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Start point in sketch-plane coordinates [x, y] (mm).',
        },
        to: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'End point [x, y] (mm).',
        },
        construction: {
          type: 'boolean',
          description: 'Construction line (dashed, not used in profile detection). Default false.',
        },
        tolerance: {
          type: 'number',
          description: 'Coincident-point merge tolerance (mm). Default 1e-6.',
        },
      },
      required: ['sketchId', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_rectangle',
    description:
      'Draw an axis-aligned rectangle in a sketch. Emits the 4 edges as a ' +
      'single rectangle entity that extrude can use directly. `corner` is ' +
      'the bottom-left (min X, min Y); negative width/height is normalized. ' +
      'Returns `{ entityId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        corner: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Bottom-left corner [x, y] (mm).',
        },
        width: { type: 'number', description: 'Extent along +X (mm). Non-zero.' },
        height: { type: 'number', description: 'Extent along +Y (mm). Non-zero.' },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'corner', 'width', 'height'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_circle',
    description:
      'Draw a circle in a sketch from center + radius. Circles are ' +
      'intrinsically closed — feature_extrude can use them directly. ' +
      'Returns `{ entityId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        center: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Center [x, y] (mm).',
        },
        radius: { type: 'number', description: 'Radius (mm). Must be positive.' },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'center', 'radius'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_slot',
    description:
      'Draw a slot (stadium shape: two semicircular end-caps + a straight ' +
      'strip between them) from two end-cap centers + width. ' +
      'Total outer length = |center2 − center1| + width. ' +
      'Returns `{ entityId }`. ' +
      'CAVEAT: the region detector does NOT yet understand slot entities, ' +
      'so a sketch containing only a slot will return 0 closed regions ' +
      'and `feature_extrude` will fail. Until the detector grows slot ' +
      "support, do NOT use this for extrudable profiles — build the slot " +
      'manually with `sketch_draw_rectangle` + 2× `sketch_draw_circle` ' +
      '(circles at the end-cap centers, rectangle between them). The ' +
      "planar graph walker will merge them into one stadium region.",
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        center1: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'First end-cap center [x, y] (mm).',
        },
        center2: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Second end-cap center [x, y] (mm). Must differ from center1.',
        },
        width: {
          type: 'number',
          description: 'Slot width = end-cap diameter (mm). Must be > 0.',
        },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'center1', 'center2', 'width'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_arc',
    description:
      'Draw an arc from center + radius + start/end angles (radians, CCW ' +
      'from +X axis). The arc\'s start and end points snap to existing ' +
      'coincident sketch points within `tolerance`. Returns `{ entityId }`. ' +
      'CAVEAT: the planar-graph region detector does NOT yet handle arc ' +
      'entities — a closed loop containing an arc returns 0 detected ' +
      'regions and `feature_extrude` will fail. The arc DOES round-trip ' +
      'cleanly through the document (UI editor sees it correctly, points ' +
      'snap as expected). Until the detector grows arc support, prefer ' +
      'all-line profiles for extrudes; use arcs only when you need them ' +
      'for visual reference (with `construction: true`).',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        center: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Center [x, y] (mm).',
        },
        radius: { type: 'number', description: 'Radius (mm). Must be > 0.' },
        startAngle: {
          type: 'number',
          description: 'Start angle in RADIANS (CCW from +X axis).',
        },
        endAngle: {
          type: 'number',
          description: 'End angle in RADIANS. Must differ from startAngle. CCW from startAngle to endAngle.',
        },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'center', 'radius', 'startAngle', 'endAngle'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_arc3point',
    description:
      'Draw an arc through three points (start → mid → end). The mid ' +
      'point is a construction input only — it fixes the arc\'s curvature ' +
      'but is NOT preserved as a sketch point. Use this when you have ' +
      'three known points along the arc; use `sketch_draw_arc` when you ' +
      'have center + radius + angles. Internally delegates to the same ' +
      'core primitive as `sketch_draw_arc`, so the resulting arc entity ' +
      'is structurally identical (no special "3-point arc" type). Returns ' +
      '`{ entityId }`. Same region-detector caveat as `sketch_draw_arc` — ' +
      'closed loops with arc segments don\'t yet detect.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        start: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Start point [x, y] (mm).' },
        mid:   { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'A point on the arc between start and end. NOT preserved as a sketch point.' },
        end:   { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'End point [x, y] (mm).' },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'start', 'mid', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_polygon',
    description:
      'Draw a regular N-sided inscribed polygon — center + a point on ' +
      'vertex 0 (which fixes both the circumscribed radius and the ' +
      'orientation). Decomposes at draw time into N SketchLineEntity ' +
      'records held together by N coincident + (N-1) equal-length + ' +
      '(N-1) angle constraints (invariant #11: no composite polygon ' +
      'entity). A construction center point is also added. Returns ' +
      '`{ entityIds }` with the N new line ids in CCW order — pass ' +
      'the whole list as `ProfileRef.wireEntityIds` to extrude the ' +
      'polygon as one closed profile.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Polygon center [x, y] (mm).' },
        vertex: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'A point on vertex 0 — fixes orientation + circumscribed radius.' },
        sides:  { type: 'integer', minimum: 3, maximum: 64, description: 'Number of sides (3..64).' },
        construction: { type: 'boolean', description: 'Construction geometry (all sides). Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'center', 'vertex', 'sides'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_ellipse',
    description:
      'Draw an ellipse from center + major-axis endpoint (which defines ' +
      'both the major-axis length and the rotation) + minorRadius. ' +
      'Single curve primitive — no decomposition (an ellipse IS a curve). ' +
      'CAVEAT: ellipses round-trip via the editor sidecar only; they ' +
      'don\'t yet have a document `entities` projection, so the region ' +
      'detector + extrude can\'t consume them. Use for visual reference; ' +
      'returns `{ geometryId }` — the editor SketchGeometryId, usable ' +
      'with `sketch_apply_constraint`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Ellipse center [x, y] (mm).' },
        major:  { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Major-axis endpoint [x, y]; vector center→major fixes the major axis length and rotation.' },
        minorRadius: { type: 'number', description: 'Minor-axis radius (mm). Must be > 0.' },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'center', 'major', 'minorRadius'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_spline',
    description:
      'Draw a spline as an ordered control-point sequence (≥2 points). ' +
      'Each control point may snap to an existing coincident sketch ' +
      'point within `tolerance`. Single curve primitive (a spline IS a ' +
      'curve — same rationale as ellipse). CAVEAT: splines round-trip ' +
      'via the editor sidecar only; the document `entities` projection ' +
      'and region detector don\'t consume them yet. Use for visual ' +
      'reference / construction. Returns `{ geometryId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        points: {
          type: 'array',
          items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          minItems: 2,
          description: 'Ordered control points (≥2). Each is [x, y] (mm).',
        },
        construction: { type: 'boolean', description: 'Construction geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'points'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_point',
    description:
      'Place a standalone reference point — wraps a SketchPoint in a ' +
      'SketchStandalonePoint geometry so it shows up as a first-class ' +
      'addressable entity in the sketch browser. Useful as a dimension ' +
      'anchor, midpoint marker, or construction reference. May snap to ' +
      'an existing point within `tolerance` (reuses that point id). ' +
      'CAVEAT: standalone points round-trip via the editor sidecar only ' +
      '(no document `entities` projection). Returns `{ geometryId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        at: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Point location [x, y] (mm).' },
        construction: { type: 'boolean', description: 'Construction (reference) geometry. Default false.' },
        tolerance: { type: 'number', description: 'Coincident-point merge tolerance (mm). Default 1e-6.' },
      },
      required: ['sketchId', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_apply_constraint',
    description:
      'Apply a constraint to a sketch. One tool covers EVERY constraint kind ' +
      'and every dimension — the discriminator is the `constraint.type` ' +
      'field. The handler appends to the sketch editor state without ' +
      'running the solver; the in-browser editor re-solves on next ' +
      'interaction (drag, dimension edit). Returns `{ constraintId }`. ' +
      'Use `list_sketch_elements(sketchId)` to discover point + geometry ' +
      'ids the constraint should reference. ' +
      'Examples: ' +
      "`{type:'horizontal',geometryId:'<lineId>'}`, " +
      "`{type:'coincident',pointA:'<ptA>',pointB:'<ptB>'}`, " +
      "`{type:'tangent',lineId:'<lineId>',circleId:'<circleId>'}` (line-circle), " +
      "`{type:'tangent',circleId:'<aId>',secondCircleId:'<bId>'}` (circle-circle), " +
      "`{type:'length',geometryId:'<lineId>',value:50}`, " +
      "`{type:'distance',pointA:'<a>',pointB:'<b>',value:25}`, " +
      "`{type:'angle',geometryA:'<la>',geometryB:'<lb>',value:1.5708}` (radians).",
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        constraint: {
          type: 'object',
          description:
            "A SketchConstraintInput. `type` is one of: coincident, horizontal, " +
            "vertical, fixed, distance, distanceX, distanceY, radius, length, " +
            "parallel, perpendicular, angle, tangent, pointOnLine, " +
            "pointOnCircle, symmetric, equal, concentric, midpoint. " +
            "See @tweakcad/core/src/sketch/types.ts.",
        },
      },
      required: ['sketchId', 'constraint'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_remove_constraint',
    description:
      'Remove a constraint from a sketch by id. Idempotent — no-op on ' +
      'missing ids. Use this to revert an over-constraint that the editor ' +
      'flagged red.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string' },
        constraintId: { type: 'string' },
      },
      required: ['sketchId', 'constraintId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sketch_elements',
    description:
      'Return the full editor-state graph of a sketch: every point ' +
      '(with coords), every geometry (with point refs + curve type + ' +
      'construction flag), every constraint (with refs + kind). ' +
      'USE THIS to discover the point + geometry ids you need to feed ' +
      'into `sketch_apply_constraint`. The flat `entities` document model ' +
      'returned by `get_document` does NOT include the point ids — it ' +
      'collapses rectangles into a single entity and bakes line endpoints ' +
      'into the entity body — so this tool is the only way to address ' +
      'individual corners or edges of a multi-line shape.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
      },
      required: ['sketchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_extrude',
    description:
      "Extrude a sketch's closed profile(s) along the sketch normal. " +
      'If `profiles` is omitted, ALL closed regions in the sketch are ' +
      'used (the common case — works whenever the sketch has exactly the ' +
      'shapes you want to extrude). Selecting a ring together with the ' +
      'region filling its hole extrudes the solid outer shape, so to keep ' +
      'a hole open pass `profiles` without the inner region. ' +
      "The tool resolves the sketch's part " +
      'automatically from sketchId. Returns `{ featureId }`. ' +
      'AFTER calling: ALWAYS call `get_diagnostics` to confirm the ' +
      'extrude built (sketches can build successfully but extrude can ' +
      'still fail). If it failed, use `list_sketch_regions(sketchId)` to ' +
      'inspect what regions the detector found; common cause is no ' +
      'closed loop. Use `view_fit_all` + `view_screenshot` for visual ' +
      'confirmation if requested.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id to extrude from.' },
        distance: {
          type: 'number',
          description: "Extrusion distance (mm). For direction='symmetric' this is the TOTAL extent (half each way).",
        },
        operation: {
          type: 'string',
          enum: ['newBody', 'join', 'cut'],
          description:
            "'newBody' creates a new disconnected body (most common — start here). " +
            "'join' adds the extrude to existing bodies (boolean union). " +
            "'cut' subtracts the extrude from existing bodies. Default 'newBody'. " +
            "WARNING: today multiple sequential 'cut' features each operate " +
            'on the most recent build of the targeted body — but each leaves ' +
            "behind a body entry in `list_bodies` for the prior build. After " +
            "N cuts you'll see N+1 bodies; the one with the highest " +
            'sourceFeatureId is the current state. Pass `targetBodies` ' +
            'explicitly if you have multiple bodies and need to be precise.',
        },
        direction: {
          type: 'string',
          enum: ['normal', 'reversed', 'symmetric'],
          description:
            "'normal' extrudes along the sketch's normal (default). " +
            "'reversed' extrudes the opposite way. " +
            "'symmetric' extrudes equally in both directions (distance is the TOTAL).",
        },
        profiles: {
          type: 'array',
          description:
            'OPTIONAL. Explicit profile selection. Each profile names a ' +
            'sketch and the entity ids whose closed loop is the wire. Omit ' +
            'this to auto-use every closed region in the sketch.',
          items: {
            type: 'object',
            properties: {
              wireEntityIds: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                description:
                  'Entity ids forming the wire boundary (e.g. [circleId] or [lineA, lineB, lineC, lineD]). ' +
                  'For a ring, the outer boundary alone or outer + hole ids ([outer, inner]) both name the ring.',
              },
              interiorPoint: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Optional disambiguator: a 2D point known to lie inside this region.',
              },
            },
            required: ['wireEntityIds'],
            additionalProperties: false,
          },
        },
      },
      required: ['sketchId', 'distance'],
      additionalProperties: false,
    },
  },
  // ---- Body-replication tools ----
  //
  // Revolve takes a sketch profile + axis + angle.
  // Mirror/Pattern act on existing bodies (need bodyId from list_bodies).
  {
    name: 'feature_revolve',
    description:
      'Revolve a sketch profile around a Cartesian axis to create a ' +
      'solid body. Omit `profile` to auto-pick the FIRST closed region ' +
      'in the sketch (the common case). `angle` is in degrees — 360 = ' +
      'full revolution; partial angles produce sector solids. ' +
      'Returns `{ featureId }`. CALL `wait_for_rebuild` then ' +
      '`get_diagnostics` afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id to revolve from.' },
        axis: {
          type: 'string',
          enum: ['x', 'y', 'z'],
          description: "Rotation axis: 'x', 'y', or 'z' (cartesian). For axes along picked edges, fall back to dispatch_command.",
        },
        angle: {
          type: 'number',
          description: 'Sweep angle in DEGREES. 360 = full revolve. Negative reverses direction.',
        },
        operation: {
          type: 'string',
          enum: ['newBody', 'join', 'cut'],
          description: "Default 'newBody'. 'join' fuses into existing bodies, 'cut' subtracts.",
        },
        profile: {
          type: 'object',
          description: 'OPTIONAL. Explicit profile selection. Omit for auto-detect.',
          properties: {
            wireEntityIds: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Entity ids forming the wire boundary.',
            },
            interiorPoint: {
              type: 'array',
              items: { type: 'number' },
              minItems: 2,
              maxItems: 2,
              description: 'Optional disambiguator: a 2D point known to lie inside this region.',
            },
          },
          required: ['wireEntityIds'],
          additionalProperties: false,
        },
      },
      required: ['sketchId', 'axis', 'angle'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_mirror',
    description:
      'Mirror an existing body across a default plane (XY / YZ / XZ). ' +
      "Use `operation: 'join'` to fuse the mirror into the source body " +
      "(symmetric one-piece result); `operation: 'newBody'` (default) " +
      "keeps the mirror as a separate body. " +
      'Returns `{ featureId }`. For mirroring across a construction ' +
      'plane or a body face, fall back to `dispatch_command CreateMirror`.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string' },
        bodyId: { type: 'string', description: 'The body to mirror (from `list_bodies`).' },
        plane: {
          type: 'string',
          enum: ['XY', 'YZ', 'XZ'],
          description: 'Default plane to mirror across.',
        },
        operation: {
          type: 'string',
          enum: ['newBody', 'join'],
          description: "Default 'newBody'. 'join' produces one symmetric body; 'newBody' leaves the mirror as a sibling.",
        },
      },
      required: ['partId', 'bodyId', 'plane'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_pattern',
    description:
      'Replicate a body in a regular linear or circular pattern. ' +
      "Linear: `{ patternType: 'linear', direction: 'x'|'y'|'z', count: int, spacing: mm }`. " +
      "Circular: `{ patternType: 'circular', axis: 'x'|'y'|'z', count: int, fullAngle?: degrees }`. " +
      'Source body counts as instance #1; `count` MUST be ≥ 2 (1 = no-op). ' +
      "fullAngle defaults to 360. " +
      'Returns `{ featureId }`. For non-Cartesian axes / directions ' +
      'or feature-mode patterns, fall back to `dispatch_command`.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string' },
        bodyId: { type: 'string', description: 'The body to replicate (from `list_bodies`).' },
        patternType: {
          type: 'string',
          enum: ['linear', 'circular'],
          description: 'Linear (line of copies) or circular (polar array).',
        },
        count: {
          type: 'integer',
          minimum: 2,
          description: 'Total instance count including the source (≥ 2).',
        },
        direction: {
          type: 'string',
          enum: ['x', 'y', 'z'],
          description: 'Linear only: axis to replicate along.',
        },
        spacing: {
          type: 'number',
          description: 'Linear only: center-to-center spacing in mm between consecutive instances.',
        },
        axis: {
          type: 'string',
          enum: ['x', 'y', 'z'],
          description: 'Circular only: rotation axis.',
        },
        fullAngle: {
          type: 'number',
          description: 'Circular only: total sweep in degrees. Default 360.',
        },
      },
      required: ['partId', 'bodyId', 'patternType', 'count'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_shell',
    description:
      'Hollow a body to a uniform wall thickness, leaving one or more ' +
      'faces open so the cavity is reachable. Discovery: ' +
      '`list_faces(bodyId)` → pick the stable face ids you want left ' +
      'open. All open faces must belong to the same body. Wall grows ' +
      'INWARD (toward the body interior). Returns `{ featureId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string' },
        bodyId: { type: 'string', description: 'The body to shell (from `list_bodies`).' },
        removedFaceIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Stable face ids of faces to leave OPEN (the cavity opens through these).',
        },
        thickness: {
          type: 'number',
          description: 'Wall thickness (mm). > 0. Grows inward.',
        },
        tolerance: {
          type: 'number',
          description: 'Optional. Offset-surface fit tolerance. Default 1e-3 (loose); pass 1e-6 for precise shells.',
        },
      },
      required: ['partId', 'bodyId', 'removedFaceIds', 'thickness'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_sweep',
    description:
      'Sweep a closed profile along a closed path (spine). Canonical ' +
      'use: circle profile + circle path = torus. Both `profile` and ' +
      '`path` are `{ sketchId, wireEntityIds? }` — when wireEntityIds is ' +
      'omitted the wrapper picks the first detected region of that sketch. ' +
      'V1 only supports `operation: newBody` (the schema enforces this). ' +
      'Open-wire paths and body-edge paths are deferred. ' +
      'Returns `{ featureId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'object',
          properties: {
            sketchId: { type: 'string' },
            wireEntityIds: { type: 'array', items: { type: 'string' } },
            interiorPoint: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          },
          required: ['sketchId'],
          additionalProperties: false,
          description: 'Closed profile to sweep.',
        },
        path: {
          type: 'object',
          properties: {
            sketchId: { type: 'string' },
            wireEntityIds: { type: 'array', items: { type: 'string' } },
            interiorPoint: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          },
          required: ['sketchId'],
          additionalProperties: false,
          description: 'Closed region whose boundary wire is the sweep spine.',
        },
      },
      required: ['profile', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_loft',
    description:
      'Loft a solid through 2–16 ordered closed profile sections. ' +
      'Profile order matters — the surface interpolates between ' +
      'consecutive entries in the given order. Each profile is ' +
      '`{ sketchId, wireEntityIds? }` (auto-pick first region when ' +
      'wireEntityIds is omitted). Use `ruled: true` for straight ' +
      '(faster, simpler topology) instead of a smooth fit. Use ' +
      '`closed: true` to wrap the last profile back to the first ' +
      '(torus-style loops). Returns `{ featureId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        profiles: {
          type: 'array',
          minItems: 2,
          maxItems: 16,
          items: {
            type: 'object',
            properties: {
              sketchId: { type: 'string' },
              wireEntityIds: { type: 'array', items: { type: 'string' } },
              interiorPoint: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            },
            required: ['sketchId'],
            additionalProperties: false,
          },
          description: 'Ordered profile sections (2–16).',
        },
        operation: {
          type: 'string',
          enum: ['newBody', 'join', 'cut'],
          description: "Default 'newBody'.",
        },
        ruled: {
          type: 'boolean',
          description: 'If true, straight segments between profiles instead of a smooth fit.',
        },
        closed: {
          type: 'boolean',
          description: 'If true, wraps last → first (closed loop / torus).',
        },
      },
      required: ['profiles'],
      additionalProperties: false,
    },
  },
  // ---- Edge / face modification tools ----
  //
  // Fillet, chamfer, and hole all need stable edge / face references
  // discovered via list_edges / list_faces. The wrappers take a flat
  // shape (partId + bodyId + stable*Id + measurement) and assemble the
  // EdgeRef / FaceRef envelopes the CadCommand expects.
  {
    name: 'feature_fillet',
    description:
      'Round one or more edges of a body with a constant-radius fillet. ' +
      'Discovery flow: call `list_bodies(partId)` → pick `bodyId` → ' +
      '`list_edges(bodyId)` → collect the `stableEdgeId` of each edge ' +
      'you want to fillet. All edges must belong to ONE body. ' +
      'Returns `{ featureId }`. CALL `wait_for_rebuild` then ' +
      '`get_diagnostics` afterward to confirm the fillet succeeded — ' +
      "fillets fail when radius exceeds the edge's adjacent geometry.",
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'The part id containing the body.' },
        bodyId: {
          type: 'string',
          description: 'The body id (from `list_bodies`). All edges must belong to this body.',
        },
        stableEdgeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Stable edge ids from `list_edges`. At least one required.',
        },
        radius: {
          type: 'number',
          description: 'Fillet radius (mm). Must be > 0 and smaller than the adjacent geometry can absorb.',
        },
      },
      required: ['partId', 'bodyId', 'stableEdgeIds', 'radius'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_chamfer',
    description:
      'Bevel one or more edges of a body with a symmetric chamfer ' +
      '(equal setback on each adjacent face). Discovery flow identical ' +
      'to `feature_fillet`. Returns `{ featureId }`. CALL ' +
      '`wait_for_rebuild` then `get_diagnostics` afterward.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'The part id containing the body.' },
        bodyId: { type: 'string', description: 'The body id (from `list_bodies`).' },
        stableEdgeIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Stable edge ids from `list_edges`.',
        },
        distance: {
          type: 'number',
          description: 'Symmetric setback per face (mm). Must be > 0.',
        },
      },
      required: ['partId', 'bodyId', 'stableEdgeIds', 'distance'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_hole',
    description:
      'Drill a cylindrical hole into a body, perpendicular to a chosen ' +
      'face. Discovery: `list_bodies(partId)` → `list_faces(bodyId)` → ' +
      'pick the planar face with the right `stableFaceId`. ' +
      '`center` is a [u, v] offset (mm) from the face centroid in the ' +
      "face's tangent frame: v = +X and u = X × normal, except when the " +
      'normal points mostly along ±X (|nx| > 0.9), where v = +Y and ' +
      'u = Y × normal. So on an upward (+Y) face, center = [z, x] ' +
      'relative to the centroid; on a +Z face, [-y, x]. The centroid of ' +
      "a face with an opening (a shelled box's rim) lies off the face, " +
      'so [0, 0] there drills into empty space. A hole that removes no ' +
      'material fails the feature. ' +
      '`depth` is along the face normal (use a value larger than the ' +
      'body for a through-hole). ' +
      "`kind` selects 'simple' (cylindrical) | 'counterbore' (with a " +
      "cylindrical recess) | 'countersink' (conical recess). " +
      'Counterbore needs `counterboreDiameter` + `counterboreDepth`; ' +
      'countersink needs `countersinkDiameter` + optional ' +
      '`countersinkAngle` (default 90°). Returns `{ featureId }`.',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string' },
        bodyId: { type: 'string', description: 'The body id (from `list_bodies`).' },
        stableFaceId: {
          type: 'string',
          description: 'Stable face id of the face to drill into. Get from `list_faces`.',
        },
        center: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Center [u, v] in mm from the face centroid, in the face frame described above. [0, 0] = face centroid.',
        },
        diameter: {
          type: 'number',
          description: 'Hole diameter (mm). > 0.',
        },
        depth: {
          type: 'number',
          description: 'Hole depth measured from the face along the normal (mm). > 0. Use a large value for through-hole.',
        },
        kind: {
          type: 'string',
          enum: ['simple', 'counterbore', 'countersink'],
          description: "Default 'simple'. Counterbore / countersink require their matching fields.",
        },
        counterboreDiameter: {
          type: 'number',
          description: 'Required when kind = counterbore. Head recess diameter (mm), must be > diameter.',
        },
        counterboreDepth: {
          type: 'number',
          description: 'Required when kind = counterbore. Head recess depth (mm), > 0.',
        },
        countersinkDiameter: {
          type: 'number',
          description: 'Required when kind = countersink. Rim diameter at face surface (mm), must be > diameter.',
        },
        countersinkAngle: {
          type: 'number',
          description: 'Optional when kind = countersink. Full included angle in degrees (0 < a < 180). Default 90.',
        },
      },
      required: ['partId', 'bodyId', 'stableFaceId', 'center', 'diameter', 'depth'],
      additionalProperties: false,
    },
  },
  // ---- ID discovery tools ----
  //
  // The kernel produces bodies / faces / edges during rebuild. Their
  // IDs live in the viewport store (build artifacts), NOT in the
  // document. Without these tools the caller has no way to learn which
  // ids exist — and therefore can't call fillet, chamfer, hole, or
  // sketch-on-face. Each tool returns a list with enough metadata
  // (geometric kind, area, centroid, normal, etc.) that the caller can
  // pick the right id in one call.
  {
    name: 'list_bodies',
    description:
      'List the bodies a part has produced from its most recent build. ' +
      'Each entry has `bodyId`, `sourceFeatureId` (which feature created ' +
      'it), `role`, and `boundingBox`. Use BEFORE `list_faces` / ' +
      '`list_edges` to find the bodyId you need. ' +
      'Returns `[]` if the part has no built bodies (sketch-only project, ' +
      'or build failed — check `get_diagnostics`).',
    inputSchema: {
      type: 'object',
      properties: {
        partId: { type: 'string', description: 'The part id to enumerate.' },
      },
      required: ['partId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_faces',
    description:
      "List the faces of a body. Each entry currently has just " +
      '`faceId`, `stableFaceId` (survives rebuilds — preferred for ' +
      'fillet/chamfer/hole references), and `triStart`/`triEnd` ' +
      '(triangle range in the displayMesh). ' +
      'CAVEAT: per-face metadata (kind / area / centroid / normal) ' +
      "isn't surfaced yet — the topology layer doesn't compute it. " +
      'Until it does, agents must pick faces by stableFaceId convention ' +
      '(e.g. for an extrude origin XY, the top face is typically the ' +
      'highest-indexed planar face). For finding the face adjacent to a ' +
      'specific edge, use `find_face` with `adjacentToEdgeIds`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'The body id. Get from `list_bodies`.' },
      },
      required: ['bodyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_edges',
    description:
      'List the edges of a body. Each entry has `edgeId`, `stableEdgeId` ' +
      '(preferred for fillet/chamfer — survives rebuilds), ' +
      '`adjacentFaceIds`, and segment start/end points. ' +
      'USE THIS before any tool that needs an edgeId (fillet, chamfer). ' +
      '`adjacentFaceIds` holds the two faces the edge bounds (the same ' +
      'face twice for a seam or open-shell edge).',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'The body id. Get from `list_bodies`.' },
      },
      required: ['bodyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_edges',
    description:
      'Filter a body\'s edges by topology criteria. Each filter is ' +
      'OPTIONAL; multiple filters AND together. ' +
      'Examples: `{ betweenFaces: [faceA, faceB] }` returns the one ' +
      'edge between two faces (the classic fillet target). ' +
      '`{ adjacentToFaceIds: [topFaceId] }` returns the 4 edges ' +
      'around the top face of a box. `{ lengthRange: { min: 50 } }` ' +
      'returns edges at least 50 mm long. ' +
      'Returns the same shape as `list_edges`, so you can pipe the ' +
      'result straight into `feature_fillet.stableEdgeIds`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'The body id (from `list_bodies`).' },
        adjacentToFaceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Match-ANY: keep edges touching at least one of these faceIds.',
        },
        betweenFaces: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2,
          description: 'Order-insensitive pair: keep edges whose two adjacent faces equal this set.',
        },
        lengthRange: {
          type: 'object',
          properties: {
            min: { type: 'number', description: 'Minimum chord length (mm).' },
            max: { type: 'number', description: 'Maximum chord length (mm).' },
          },
          additionalProperties: false,
          description: 'Chord-length range (mm). Either bound is optional.',
        },
        lengthApprox: {
          type: 'object',
          properties: {
            value: { type: 'number', description: 'Target chord length (mm).' },
            tolerance: { type: 'number', description: 'Allowed deviation (mm). Default 1e-3.' },
          },
          required: ['value'],
          additionalProperties: false,
          description: 'Exact-ish chord-length match.',
        },
      },
      required: ['bodyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_face',
    description:
      "Filter a body's faces by topology criteria. v1 supports two " +
      'filters (more land as the topology layer gains kind / normal / ' +
      'centroid metadata): ' +
      '`adjacentToEdgeIds` returns faces touching ANY of the given ' +
      'edges (handy when you have an edge id and want its faces); ' +
      '`withStableIdOnly: true` drops faces without a `stableFaceId` ' +
      "so you only get refs that survive rebuilds. " +
      'Returns the same shape as `list_faces`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodyId: { type: 'string', description: 'The body id (from `list_bodies`).' },
        adjacentToEdgeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Match-ANY: keep faces adjacent to at least one of these edgeIds.',
        },
        withStableIdOnly: {
          type: 'boolean',
          description: 'Default false. When true, omit faces without a stableFaceId.',
        },
      },
      required: ['bodyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sketch_regions',
    description:
      'List the closed regions detected in a sketch. Each entry has an ' +
      '`id`, `type` (`circle` / `polygon` / `ellipse` / `closedSpline`), ' +
      '`area` (fillable area, holes subtracted), `center` (a point inside ' +
      'the region), and `wireEntityIds` (the sketch entities forming the ' +
      'outer boundary). A loop nested inside another makes the outer ' +
      'region a ring: it lists the inner loop under `holeEntityIds`, and ' +
      'the inner loop is also its own region. Two concentric circles give ' +
      'the ring `{ wireEntityIds: [outer], holeEntityIds: [inner] }` plus ' +
      'the inner disc `{ wireEntityIds: [inner] }`. Extruding the ring makes ' +
      'a tube; extruding ring + disc together makes the solid outer shape. ' +
      'USE THIS when a sketch has MULTIPLE shapes and you need to pick ' +
      'specific ones for extrude/revolve (e.g. extrude just the outer ' +
      'rectangle, ignore the inner hole). For sketches with one obvious ' +
      'region, you can usually omit `profiles` in `feature_extrude` and ' +
      "let auto-detect handle it. Empty result means there's no closed " +
      "loop yet — your geometry doesn't form a profile.",
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
      },
      required: ['sketchId'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_pick_geometry',
    description:
      'Hit-test the sketch at a (x, y) sketch-space coordinate and return ' +
      'the topmost geometry under it (or `null` if nothing within the ' +
      'standard tolerance band). Returns `{ geometryId, type }` where ' +
      'type is `line` | `circle` | `arc` | `ellipse`. ' +
      'USE THIS before issuing `sketch_trim` / `sketch_extend` / ' +
      '`sketch_offset` when you have a point on a curve but not its ' +
      'geometry id — e.g. the user said "trim the segment near (12, 8)". ' +
      'The same picker the in-app modify tools use; the same tolerance ' +
      'window (~2 mm).',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        x: { type: 'number', description: 'Sketch-space X coordinate (mm).' },
        y: { type: 'number', description: 'Sketch-space Y coordinate (mm).' },
      },
      required: ['sketchId', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_trim',
    description:
      'Trim the picked geometry against its nearest intersections with ' +
      'other sketch geometry. ' +
      '`cursor` selects which side of the curve to remove (the piece ' +
      'under the cursor is deleted). Behavior by type: ' +
      '- line with 0–1 intersections → whole line removed; ≥2 → segment ' +
      'between previous and next intersection that contains the cursor ' +
      'is removed. ' +
      '- arc with 0–1 → whole arc removed; ≥2 → CCW segment between ' +
      'cursor-bracketing intersections removed. ' +
      '- circle with 0–1 → whole circle removed; ≥2 → arc going CCW ' +
      'from prevCW to nextCCW (the side NOT under the cursor) replaces ' +
      'the circle. ' +
      '- ellipse / spline / point → whole-delete. ' +
      "Returns `{ ok: true }`. Use `sketch_pick_geometry` to find the " +
      "`geometryId` if you only have a coordinate.",
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        geometryId: { type: 'string', description: 'The sketch geometry id to trim.' },
        cursor: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[x, y] in sketch space — selects which piece to remove.',
        },
      },
      required: ['sketchId', 'geometryId', 'cursor'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_extend',
    description:
      'Extend the picked LINE to the nearest other geometry along its ' +
      'infinite extension. The closer endpoint is the one that moves. ' +
      'Only operates on lines today (arc / spline / ellipse extend is a ' +
      'follow-up). Returns `{ ok: true }`. No-op if no extension target ' +
      'exists.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        geometryId: { type: 'string', description: 'The line geometry id to extend.' },
      },
      required: ['sketchId', 'geometryId'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_fillet',
    description:
      'Round the corner between two lines that share an endpoint with a ' +
      'tangent fillet arc. The corner is auto-detected (closest endpoint ' +
      'pair). `radius` is optional — when omitted, defaults to ' +
      'min(10, shorter-leg / 5). The two lines\' shared corner endpoints ' +
      'are moved inward to the new tangent points and a fresh arc lands ' +
      'on the bisector. Returns `{ filletId }` (the new arc geometry id) ' +
      'or `null` if the operation was a no-op (lines parallel, no shared ' +
      'corner, radius too large for the legs).',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        geometryAId: { type: 'string', description: 'First line geometry id.' },
        geometryBId: { type: 'string', description: 'Second line geometry id.' },
        radius: {
          type: 'number',
          description: 'Optional fillet radius in mm. Auto-defaults from leg length.',
        },
      },
      required: ['sketchId', 'geometryAId', 'geometryBId'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_offset',
    description:
      'Create a parallel copy of a line or circle at a fixed `distance`. ' +
      '`cursor` selects which side of the original to offset toward — ' +
      'the offset appears on the side the cursor is on. Set ' +
      '`construction: true` to make the copy a construction curve. Arc / ' +
      'ellipse / spline offset is not yet supported (returns no-op). ' +
      'Returns `{ offsetId }` (the new geometry id) or `null` on no-op.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        geometryId: { type: 'string', description: 'The line or circle geometry id to offset.' },
        distance: { type: 'number', description: 'Offset distance in mm (positive).' },
        cursor: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '[x, y] in sketch space — picks which side to offset toward.',
        },
        construction: {
          type: 'boolean',
          description: 'Optional. When true, the offset copy is a construction curve.',
        },
      },
      required: ['sketchId', 'geometryId', 'distance', 'cursor'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_mirror',
    description:
      'Mirror the listed geometries across a line defined by two points ' +
      'in sketch coords (`axisA`, `axisB`). Lines / circles / arcs are ' +
      'mirrored to fresh geometries with fresh points; other types are ' +
      'skipped. Originals are NOT modified. Symmetric constraints ' +
      'between paired points are not yet emitted (follow-up). Returns ' +
      '`{ ok: true }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        geometryIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Geometries to mirror. Unsupported types are silently skipped.',
        },
        axisA: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'First point [x, y] on the mirror axis.',
        },
        axisB: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Second point [x, y] on the mirror axis.',
        },
      },
      required: ['sketchId', 'geometryIds', 'axisA', 'axisB'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_move_point',
    description:
      'Move a single sketch point to new coordinates. Equivalent to a ' +
      'drag-end in the editor: one CadCommand, one undo entry. The ' +
      'solver re-runs with the moved point anchored — coincident or ' +
      'connected geometry follows. ' +
      'Use `sketch_move_points` instead when moving multiple points ' +
      'atomically (dragging a whole rectangle, for instance) — N points ' +
      'in one call collapse to one undo entry and the solver only runs ' +
      'once. Returns `{ ok: true }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        pointId: { type: 'string', description: 'The sketch point id to move.' },
        to: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: 'Destination [x, y] in sketch space.',
        },
      },
      required: ['sketchId', 'pointId', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_move_points',
    description:
      'Atomically move several sketch points to new coordinates. The ' +
      'moved set is anchored when the solver re-runs, so neighbours that ' +
      'share coincident / parallel / etc. constraints follow the drag ' +
      'without overriding the explicit positions. One CadCommand = one ' +
      'undo entry, regardless of how many points moved. Empty `moves` is ' +
      'a no-op (no undo entry recorded). Returns `{ ok: true }`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketchId: { type: 'string', description: 'The sketch feature id.' },
        moves: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              pointId: { type: 'string', description: 'The sketch point id.' },
              to: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Destination [x, y] in sketch space.',
              },
            },
            required: ['pointId', 'to'],
            additionalProperties: false,
          },
          description: 'List of point-id + destination pairs to apply atomically.',
        },
      },
      required: ['sketchId', 'moves'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_rebuild',
    description:
      'Block until the worker has finished its current rebuild. Call ' +
      'this AFTER any geometry-creating tool (extrude, fillet, hole, ' +
      'pattern, mirror, etc.) before reading `get_diagnostics` / ' +
      '`list_bodies` / `list_faces` / `list_edges`. Reads come from the ' +
      'viewport store, updated only after the worker settles. ' +
      'Default timeout 10 s. Returns `{ waitedMs }`. ' +
      'In practice `waitedMs` is often 0–1 ms because by the time the ' +
      "MCP round-trip returns to you the worker has already finished — " +
      'but call this anyway as cheap insurance. A waitedMs near the ' +
      "timeout means the worker is hung; treat the build as failed and " +
      'inspect `get_diagnostics`. ' +
      'You do NOT need to call this after read-only tools or after ' +
      'sketch_create / sketch_draw_* (those mutate document state only, ' +
      "not the worker's body graph).",
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Optional. Max ms to wait before failing. Default 10000.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'view_screenshot',
    description:
      'Capture a JPEG screenshot of the current viewport and return it ' +
      'as an image you can SEE in your reasoning. Use this to verify ' +
      'visual results: that an extrude landed in the right spot, that a ' +
      'fillet looks reasonable, that the topology matches the user\'s ' +
      'intent. Downscaled to max 768px on the long edge at JPEG q=0.6 ' +
      "— payload is ~25-60 KB base64, fits comfortably in any MCP " +
      'client\'s tool-result budget. Prefer calling `view_fit_all` ' +
      '(or `view_set_standard`) before capturing so the image actually ' +
      'shows what you want to inspect.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
] as const);

/** Lookup helper: tool by name, or `undefined` if not registered. */
export function findTool(name: string): CadToolDefinition | undefined {
  return CAD_TOOLS.find((t) => t.name === name);
}

/** Type guard: is this string a known tool name? */
export function isToolName(name: string): boolean {
  return CAD_TOOLS.some((t) => t.name === name);
}
