/**
 * The CAD tool catalogue: the tools an AI client calls to read and edit a
 * TweakCAD document, as JSON schemas. It is a public contract, read by
 * three consumers unchanged:
 *   - the in-app chat (the site's chat endpoint offers these to the model);
 *   - the MCP bridge (the app advertises them to the bridge, which lists them
 *     to MCP clients);
 *   - the app's tool executor, which runs every call against the open editor.
 *
 * The tools work in terms of the editor's commands and the version-2
 * document (spec `document-format-v2`): parts, features with their inputs,
 * value objects bound to expressions, and sketch rows. What the model is
 * built into comes from the evaluation's display: bodies, faces, edges,
 * vertices, sketch regions and construction geometry are listed with
 * handles. A feature input that references geometry takes handles, and the
 * executor writes each reference by picking the entity (spec 9.2); the
 * caller never writes a reference by hand.
 *
 * `inputSchema` is camelCase, as the MCP SDK expects it; surfaces that need
 * `input_schema` rename it when they build a request.
 */

/**
 * The version of this contract. A change that renames or removes a tool or
 * an input, or changes what one means, increases it.
 */
export const CAD_TOOLS_CONTRACT = 3;

/** A JSON schema for a tool's input: an object schema, as the MCP SDK takes it. */
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
  /** What the tool does, for the model. */
  description: string;
  /** JSON schema of the tool's input. */
  inputSchema: ToolInputSchema;
};

// ---- Shared input shapes ----

/** An expression: a number in the field's unit, or expression text naming parameters and values. */
function expr(description: string): Record<string, unknown> {
  return { type: ['number', 'string'], description };
}

function handles(description: string, minItems = 1): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' }, minItems, description };
}

const handle = (description: string): Record<string, unknown> => ({ type: 'string', description });

const vec2 = (description: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description,
});

const vec3 = (description: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: ['number', 'string'] },
  minItems: 3,
  maxItems: 3,
  description,
});

/** A sketch point: `[x, y]` in sketch coordinates (mm), or the id of a point the sketch has. */
const point = (description: string): Record<string, unknown> => ({
  type: ['array', 'string'],
  items: { type: 'number' },
  description: `${description} [x, y] in mm, or the id of a point of the sketch (pt_…).`,
});

const featureId = (description = 'The feature id (feat_…).'): Record<string, unknown> => ({
  type: 'string',
  description,
});

const sketchId = { type: 'string', description: 'The sketch feature id (feat_…).' };

const construction = {
  type: 'boolean',
  description: 'Draw construction curves (not part of any profile). Default false.',
};

const tolerance = {
  type: 'number',
  description:
    'A point within this distance (mm) of a point the sketch has becomes that point, so curves share corners. Default 1e-6.',
};

/** The part a tool works on when it names none, as the app's modeling commands choose it. */
const WORKING_PART =
  'the part the app works in (the part opened or edited in context, else the root part, else the first part)';

const partField = { type: 'string', description: `Optional: the part (part_…); default ${WORKING_PART}.` };

const JOIN_WHEN_BODY = "'join' when the part has a body, else 'new'";

const operation = (offered: readonly string[], fallback = JOIN_WHEN_BODY): Record<string, unknown> => ({
  type: 'string',
  enum: offered,
  description:
    "'new' makes new bodies; 'join' fuses with the bodies the result meets (a result that meets none stays a new body); " +
    `${offered.includes('cut') ? "'cut' removes from them; 'intersect' keeps the common part. " : ''}Default ${fallback}.`,
});

const targets = handles(
  'Optional, for join, cut and intersect: the bodies to act on (body handles), instead of every body.',
  1,
);

const axis = {
  type: 'string',
  description:
    "A standard axis 'x', 'y' or 'z', or a handle of a straight sketch line, straight edge or construction axis.",
};

const plane = {
  type: 'string',
  description: "A standard plane 'xy', 'xz' or 'yz', or a handle of a planar face or construction plane.",
};

const empty: ToolInputSchema = { type: 'object', properties: {}, additionalProperties: false };

/**
 * Every tool, in a stable order. New tools are added at the end of their
 * group; a removal or rename is a contract change (`CAD_TOOLS_CONTRACT`).
 */
export const CAD_TOOLS: readonly CadToolDefinition[] = Object.freeze([
  // ---- Guide and reading ----
  {
    name: 'cad_help',
    description:
      'The workflow guide for these tools: the document model, handles and how references are made, units and sketch ' +
      'coordinates, worked examples (a plate, a plate with holes, fillets, a revolve), and what fails and why. ' +
      'Call it first when you are about to model more than one change.',
    inputSchema: empty,
  },
  {
    name: 'get_document',
    description:
      'The document as stored (format version 2): metadata, parameters, parts with their timelines of features and ' +
      'their inputs, assemblies and assets. Every number a user can set is a value object `{id, name?, def: {expr: {text}}}`. ' +
      "Pass `part` to get one part only. Use `list_features` for a short outline; read this for a feature's inputs and value ids.",
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string', description: 'Optional: only this part (part id).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_features',
    description:
      'An outline of the document: each part with its features in timeline order (id, type, name, suppressed, and ' +
      "status 'ok', 'paused' with the reason, or 'blocked' by an earlier pause), its rollback marker, the parameters, " +
      'and the assemblies. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string', description: 'Optional: only this part.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_diagnostics',
    description:
      'What the newest rebuild could not do: each paused feature with its reason, features blocked by it, stale ones, ' +
      'captured contexts that are out of date, and a failed rebuild. Empty lists mean everything built. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: { part: { type: 'string', description: 'Optional: only this part.' } },
      additionalProperties: false,
    },
  },
  // ---- Editing the document ----
  {
    name: 'run_command',
    description:
      'Run one editor command on the document, for edits no other tool makes: rename, suppress, delete, move or roll back ' +
      'features, parameters and their tables, configurations, attributes, notes and assembly rows. Commands are JSON with a `type`, e.g. ' +
      "`{type:'renameFeature',feature:'feat_…',name:'Base'}`, `{type:'setSuppressed',feature:'feat_…',suppressed:true}`, " +
      "`{type:'removeFeature',feature:'feat_…'}`, `{type:'setRollback',part:'part_…',before:'feat_…'}` (omit `before` for the end). " +
      "Feature groups: `{type:'addGroup',part:'part_…',group:{id:'new:grp',name:'Holes',members:['feat_…']}}` (features next to each other in the timeline), `editGroup`, `removeGroup`. " +
      'A row a command adds needs an id: write `"new:<kind>"` (`new:grp`, `new:val`, `new:tbl`, …) and one is made; the same token ' +
      'twice in one command is one id, and the made ids are returned. ' +
      'A refused command changes nothing and says why. References to geometry are not written here: use `set_reference`.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'object', description: 'An editor command: an object with a string `type`.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_reference',
    description:
      "Write a reference into a feature's inputs at a JSON pointer (RFC 6901, under the inputs), for inputs no feature tool covers. " +
      'The reference is made by picking: give a handle, a standard plane or axis name, or a feature id. ' +
      "A pointer ending in `/-` appends to a list. Example: `{feature:'feat_…', pointer:'/frame/attach/support/-', entity:'f:4'}`.",
    inputSchema: {
      type: 'object',
      properties: {
        feature: featureId('The feature whose inputs take the reference.'),
        pointer: { type: 'string', description: "Where, under the feature's inputs, e.g. '/plane'." },
        entity: handle('A handle from a list tool.'),
        standard: { type: 'string', enum: ['xy', 'xz', 'yz', 'x', 'y', 'z'], description: 'A standard plane or axis.' },
        ofFeature: featureId('A whole feature, as patterns and mirrors of features reference one.'),
      },
      required: ['feature', 'pointer'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_value',
    description:
      "Set a value object's expression: a feature input such as an extrude's distance, a sketch dimension or a parameter's value. " +
      "Value ids (val_…) are in `get_document`. A bare number takes the value's unit (mm, deg). Expressions may name parameters and " +
      "earlier named values, e.g. 'width / 2 + 1 mm'.",
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The value id (val_…).' },
        expression: expr('The new expression.'),
      },
      required: ['value', 'expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_parameter',
    description:
      'Create or change a named parameter of the document or of a part. Features and dimensions use it by name in their ' +
      "expressions, so one change resizes everything that uses it. Returns the parameter id. Example: `{name:'width', expression:'60'}`.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Parameter name: a letter or _ then letters, digits or _.' },
        expression: expr('Its value: a number in `unit`, or an expression.'),
        unit: {
          type: 'string',
          enum: ['mm', 'deg', 'none'],
          description: "The quantity: 'mm' a length (default), 'deg' an angle, 'none' a plain number.",
        },
        part: {
          type: 'string',
          description: 'Optional: a part id, for a part parameter. Default: a document parameter.',
        },
        description: { type: 'string', description: 'Optional description.' },
      },
      required: ['name', 'expression'],
      additionalProperties: false,
    },
  },
  {
    name: 'begin_transaction',
    description:
      'Open an undo group: every change until the matching `end_transaction` is one undo step with this label. ' +
      'Always close it; groups nest.',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string', description: 'The undo label, e.g. "Add 4 mounting holes".' } },
      required: ['label'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_transaction',
    description: 'Close the innermost undo group you opened with `begin_transaction`.',
    inputSchema: empty,
  },
  // ---- Sketches ----
  {
    name: 'sketch_create',
    description:
      "Add a sketch to a part on a standard plane ('xy', 'xz', 'yz') or on a planar face or construction plane (a handle). " +
      'A sketch on a face follows the face when earlier features change. It goes in at the rollback marker. ' +
      'Returns `{sketch, frame}`: the sketch plane in part coordinates (origin, x, y, normal), so you can place sketch coordinates. ' +
      'Standard planes: xy has x = +X, y = +Y, normal +Z; xz has x = +X, y = −Z, normal +Y; yz has x = −Z, y = +Y, normal +X.',
    inputSchema: {
      type: 'object',
      properties: {
        on: plane,
        part: partField,
      },
      required: ['on'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_line',
    description:
      'Draw a chain of lines through two or more points; consecutive lines share their points. `closed` joins the last point to ' +
      'the first, making a closed outline. Returns `{curves, points}` (the new ids). Points given by id, or within `tolerance` ' +
      'of an existing point, are that point. A point at [0, 0] is held at the sketch origin.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        points: { type: 'array', items: point('A point:'), minItems: 2, description: 'The points in order.' },
        closed: { type: 'boolean', description: 'Join the last point to the first. Default false.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'points'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_rectangle',
    description:
      'Draw an axis-aligned rectangle from two opposite corners: four lines sharing corner points, held horizontal and vertical by ' +
      'constraints. Returns `{curves, points}`: curve i runs from point i to point i + 1, starting at `from`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        from: point('One corner:'),
        to: point('The opposite corner:'),
        construction,
        tolerance,
      },
      required: ['sketch', 'from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_circle',
    description: 'Draw a circle from its centre and radius. Returns `{curve, center}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        center: point('The centre:'),
        radius: { type: 'number', description: 'Radius (mm), more than 0.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'center', 'radius'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_arc',
    description:
      'Draw a circular arc: through three points (`start`, `through`, `end`), or from `center`, `start` and `end` running ' +
      'counter-clockwise from start to end (the end is moved onto the circle through start). Returns `{curve, points}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        start: point('Where the arc starts:'),
        end: point('Where it ends:'),
        through: vec2('A point the arc passes between start and end [x, y] (three-point arc).'),
        center: point('The centre (centre arc):'),
        construction,
        tolerance,
      },
      required: ['sketch', 'start', 'end'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_slot',
    description:
      'Draw a slot: two parallel lines and two half-circle ends around the segment from `from` to `to`, `width` across. ' +
      'Its overall length is the segment length plus the width. Returns `{curves, points}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        from: vec2('The centre of one end [x, y].'),
        to: vec2('The centre of the other end [x, y].'),
        width: { type: 'number', description: 'The slot width (mm), more than 0.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'from', 'to', 'width'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_polygon',
    description:
      'Draw a regular polygon inscribed in a circle: `center`, a first corner `corner` and `sides`. Lines share their corners; ' +
      'they are held equal in length. Returns `{curves, points}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        center: vec2('The centre [x, y].'),
        corner: vec2('The first corner [x, y]: sets the size and the turn.'),
        sides: { type: 'integer', minimum: 3, maximum: 64, description: 'Number of sides.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'center', 'corner', 'sides'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_ellipse',
    description:
      'Draw an ellipse from its centre, the end of its major axis (which sets the major radius and the turn) and its minor radius, ' +
      'no more than the major radius. Returns `{curve, points}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        center: point('The centre:'),
        majorEnd: point('The end of the major axis:'),
        minorRadius: { type: 'number', description: 'Minor radius (mm), more than 0.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'center', 'majorEnd', 'minorRadius'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_spline',
    description:
      'Draw a smooth curve (a cubic spline) through two or more points in order; `closed` makes it a closed loop. ' +
      'Constraints on the spline curve itself do not solve; constrain its points. Returns `{curve, points}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        points: {
          type: 'array',
          items: point('A point:'),
          minItems: 2,
          description: 'The points it passes, in order.',
        },
        closed: { type: 'boolean', description: 'A closed loop. Default false.' },
        construction,
        tolerance,
      },
      required: ['sketch', 'points'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_draw_point',
    description: 'Place a sketch point, for constraints and dimensions, or as a hole centre. Returns `{curve, point}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        at: vec2('Where [x, y] (mm).'),
        construction,
        tolerance,
      },
      required: ['sketch', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_constrain',
    description:
      'Add a constraint or a dimension to sketch rows (point and curve ids), as the sketch editor applies it to a selection. ' +
      "Geometric kinds: 'coincident' (points become one point; or a point onto a curve), 'horizontal', 'vertical', 'hv' (lines, or two points), " +
      "'parallel', 'perpendicular', 'collinear' (two lines), 'equal' (lines, or round curves), 'tangent' (two curves), 'concentric' (round curves), " +
      "'midpoint' (a point and a curve), 'symmetric' (two points, or two circles or arcs, then a line), 'fix' (points or curves; again to unfix). " +
      "Dimension kinds: 'dimension' (a line's length, a circle's diameter, an arc's radius, the distance between two points or a point and a line, " +
      "the angle between two lines), 'dimensionX' and 'dimensionY' (along the sketch x or y). The sketch's own origin and axes are 'origin', " +
      "'xAxis' and 'yAxis' in `entities`. " +
      'A dimension takes `value`, an expression (default: what it measures now); its value is named (d1, d2, …) for use in other expressions. ' +
      'The sketch is solved; a constraint that would over-constrain it is refused. Returns `{constraints, dof}` (degrees of freedom left).',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        kind: {
          type: 'string',
          enum: [
            'coincident',
            'hv',
            'horizontal',
            'vertical',
            'parallel',
            'perpendicular',
            'collinear',
            'equal',
            'tangent',
            'concentric',
            'midpoint',
            'symmetric',
            'fix',
            'dimension',
            'dimensionX',
            'dimensionY',
          ],
        },
        entities: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            "Point and curve ids (pt_…, crv_…), or 'origin', 'xAxis', 'yAxis', in the order the kind reads them.",
        },
        value: expr('For a dimension: its expression, a number in mm (deg for an angle) or text such as "width / 2".'),
      },
      required: ['sketch', 'kind', 'entities'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_set_dimension',
    description:
      "Change a sketch dimension's value; the sketch is solved again and the geometry follows. Returns `{dof}`.",
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        constraint: { type: 'string', description: 'The dimension constraint id (con_…).' },
        value: expr('The new expression, a number in mm (deg for an angle) or text.'),
      },
      required: ['sketch', 'constraint', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_move_points',
    description:
      'Move sketch points to new positions and solve, as a drag ends: constrained geometry follows, and the solve may move a point ' +
      'away from where it was asked to keep the constraints. Returns `{dof}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        moves: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              point: { type: 'string', description: 'Point id (pt_…).' },
              to: vec2('New position [x, y] (mm).'),
            },
            required: ['point', 'to'],
            additionalProperties: false,
          },
        },
      },
      required: ['sketch', 'moves'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_set_construction',
    description: 'Make sketch curves construction curves (not part of any profile), or normal ones again.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        curves: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Curve ids (crv_…).' },
        construction: { type: 'boolean' },
      },
      required: ['sketch', 'curves', 'construction'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_delete',
    description:
      "Delete sketch rows: curves, points and constraints by id. A curve's constraints go with it, and its points when nothing else uses them; " +
      'a point goes with the curves that use it.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['sketch', 'ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_pick_geometry',
    description:
      'What lies at a point of a sketch, as the in-app picker finds it: a point within `tolerance` of `at` first, otherwise the nearest ' +
      'curve within it (construction curves included). Use it to find a curve id for `sketch_trim`, `sketch_extend` or `sketch_offset` ' +
      'from a position. Returns `{id, kind, distance}` (`kind` is `point` or the curve kind, `distance` in mm), or `{id: null}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        at: vec2('The point [x, y] in sketch coordinates (mm).'),
        tolerance: { type: 'number', description: 'How far from `at` a hit may lie (mm, more than 0; default 2).' },
      },
      required: ['sketch', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_trim',
    description:
      "Trim a curve where other curves cross it, removing the piece at `at`; the pieces left keep the curve's constraints that still fit. " +
      'A curve nothing crosses is deleted; a circle needs two crossings. Returns `{dof}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        curve: { type: 'string', description: 'The curve id (crv_…).' },
        at: vec2('A point on the piece to remove [x, y].'),
      },
      required: ['sketch', 'curve', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_extend',
    description:
      'Extend a line or arc: its free end nearest `at` moves on to the first curve it meets. Returns `{dof}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        curve: { type: 'string', description: 'The line or arc id.' },
        at: vec2('A point near the end to move [x, y].'),
      },
      required: ['sketch', 'curve', 'at'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_fillet',
    description:
      'Round the corner two lines share with a tangent arc: give the corner point, or the two lines. The radius is a dimension, named ' +
      'for use in expressions. Returns `{dof, name}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        corner: { type: 'string', description: 'The corner point id.' },
        lines: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 2,
          description: 'The two line ids, instead of the corner.',
        },
        radius: { type: 'number', description: 'Radius (mm), more than 0.' },
      },
      required: ['sketch', 'radius'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_offset',
    description:
      'Offset a curve and the chain of lines and arcs joined to it end to end (a circle alone), `distance` to the side `side` lies on. ' +
      'The copies are held by offset constraints sharing one named distance. Returns `{dof, name}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        curve: { type: 'string', description: 'A curve of the chain.' },
        side: vec2('A point on the side to offset to [x, y].'),
        distance: { type: 'number', description: 'Distance (mm), more than 0.' },
      },
      required: ['sketch', 'curve', 'side', 'distance'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_mirror',
    description:
      "Mirror curves across a line of the sketch, or the sketch's x or y axis; each copied point is held symmetric to its original. " +
      'Returns `{dof}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        curves: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The curve ids to mirror.' },
        axis: { type: 'string', description: "A line id, or 'xAxis' or 'yAxis'." },
      },
      required: ['sketch', 'curves', 'axis'],
      additionalProperties: false,
    },
  },
  {
    name: 'sketch_project',
    description:
      "Bring model geometry into a sketch as external curves, which follow it when it changes: 'project' an edge onto the sketch plane, " +
      "or 'intersect' a face or body with the plane. External curves bound regions and take constraints; the solve never moves them. " +
      'Returns `{curves, dof}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        entity: handle('An edge handle to project, or a face or body handle to intersect.'),
        mode: { type: 'string', enum: ['project', 'intersect'] },
      },
      required: ['sketch', 'entity'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_sketch',
    description:
      'A sketch as it stands: its plane (frame in part coordinates), points with positions, curves with their points and whether ' +
      'they are construction curves, constraints and dimensions with their values, the degrees of freedom left (0 is fully defined), ' +
      'and the closed regions with a handle each (area, a point inside, the curves of the outer loop and of each hole). ' +
      'A region inside another is a hole of it and also a region of its own. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: { sketch: sketchId },
      required: ['sketch'],
      additionalProperties: false,
    },
  },
  // ---- Features ----
  {
    name: 'feature_extrude',
    description:
      "Extrude sketch regions along their sketch's normal. `profiles` are region handles from `get_sketch`; without them every region " +
      'of `sketch` is used (a region and the region filling its hole together extrude solid; leave the inner one out to keep the hole). ' +
      "`extent`: 'distance' (default; `distance`), 'symmetric' (`distance` is the total, half each side), 'twoSides' (`distance` and `second`), " +
      "'throughAll', 'toFace' (`face`, a face or plane handle), 'toBody' (`body`), 'upToNext', 'upToLast'. " +
      'The extrude starts on the sketch plane, or `startOffset` along the direction from it; with `startFace` it starts on that face or plane, ' +
      'the profile projected onto it along the direction (a slanted or curved face gives the caps its shape), moved by `startOffset`. ' +
      'Returns `{feature, status}`; a paused feature says why.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        profiles: handles('Region handles, from one sketch.'),
        extent: {
          type: 'string',
          enum: ['distance', 'symmetric', 'twoSides', 'throughAll', 'toFace', 'toBody', 'upToNext', 'upToLast'],
        },
        distance: expr('Length (mm) or expression; more than 0.'),
        second: expr('The second side (twoSides), against the normal.'),
        face: handle('For toFace: a face, construction plane or standard plane (xy, xz, yz).'),
        body: handle('For toBody: a body handle.'),
        startFace: handle(
          'Start on this face, construction plane or standard plane (xy, xz, yz) instead of the sketch plane.',
        ),
        startOffset: expr('Move the start along the direction (mm); negative moves it back. Default 0.'),
        reversed: { type: 'boolean', description: 'Run against the sketch normal. Default false.' },
        taper: expr('Taper angle (deg); positive widens. Default 0.'),
        operation: operation(['new', 'join', 'cut', 'intersect']),
        targets,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'feature_revolve',
    description:
      "Revolve sketch regions about an axis in the sketch's plane that does not cross them. `extent`: 'angle' (default; `angle`), " +
      "'symmetric' (`angle` total), 'twoSides' (`angle` and `second`), 'full' (a whole turn). " +
      'Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        profiles: handles('Region handles; default every region of `sketch`.'),
        axis,
        extent: { type: 'string', enum: ['angle', 'symmetric', 'twoSides', 'full'] },
        angle: expr('Angle (deg).'),
        second: expr('Second side angle (deg), for twoSides.'),
        reversed: { type: 'boolean', description: 'Turn against the right hand about the axis.' },
        operation: operation(['new', 'join', 'cut', 'intersect']),
        targets,
      },
      required: ['axis'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_loft',
    description:
      'Loft a solid through closed sections, in the order given: at least two region handles, from any sketches. ' +
      '`ruled` joins them with straight segments; `closed` runs on from the last section back to the first (at least three). ' +
      'Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sections: handles('Region handles, in order.', 2),
        ruled: { type: 'boolean', description: 'Straight segments between sections. Default false.' },
        closed: { type: 'boolean', description: 'Close the loop from the last section to the first. Default false.' },
        operation: operation(['new', 'join', 'cut', 'intersect']),
        targets,
      },
      required: ['sections'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_sweep',
    description:
      'Run sketch regions along a path. `path` is a chain of curve or edge handles, joined end to end, or one region handle standing for its outer loop; ' +
      "corners are mitred. `orientation`: 'followPath' (default; the section turns with the path), 'fixed' (it keeps one orientation) or 'guide' (`guide` turns it). " +
      'The section stands across the path where it starts. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        sketch: sketchId,
        profiles: handles('Region handles; default every region of `sketch`.'),
        path: handles('Curve or edge handles, or one region handle.'),
        orientation: { type: 'string', enum: ['followPath', 'fixed', 'guide'] },
        guide: handles('For orientation guide: curve or edge handles.'),
        operation: operation(['new', 'join', 'cut', 'intersect']),
        targets,
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_fillet',
    description:
      'Round edges with a constant radius. `edges` are edge handles, or face handles standing for their sharp edges. ' +
      'A radius too big for the faces beside an edge pauses the feature. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: { edges: handles('Edge or face handles.'), radius: expr('Radius (mm).') },
      required: ['edges', 'radius'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_chamfer',
    description:
      'Bevel edges: `distance` on both faces, or `distance` and `second` (two distances), or `distance` and `angle` (deg, between 0 and 90). ' +
      'With `angle`, `flipped` puts the distance on the other face of each edge. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        edges: handles('Edge or face handles.'),
        distance: expr('Setback (mm).'),
        second: expr('Second setback (mm), for two distances.'),
        angle: expr('Angle (deg), with `distance`.'),
        flipped: { type: 'boolean', description: 'With `angle`: the distance on the other face (default false).' },
      },
      required: ['edges', 'distance'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_hole',
    description:
      'Drill holes into a planar face at positions in the face frame: origin = the part origin projected onto the face, ' +
      "x = the part's X axis projected onto it (Y when the face faces ±X), y = normal × x; the hole runs into the material. " +
      "The frame is returned as `frame`. `kind`: 'simple', 'counterbore' (counterboreDiameter, counterboreDepth), 'countersink' " +
      '(countersinkDiameter, countersinkAngle). `depth` or `throughAll`; `tipAngle` gives a drill point (default flat). `from` measures a ' +
      'position from up to two straight edges of the face: it then lies `distance` from each edge, into the face, and follows the edges ' +
      'when the face changes; with one edge the coordinate along it stays as given. `thread` ' +
      "('M5', or a fine pitch such as 'M8x1') taps the hole at the ISO tap drill. Returns `{feature, status, frame}`.",
    inputSchema: {
      type: 'object',
      properties: {
        face: handle('A planar face handle.'),
        positions: { type: 'array', items: vec2('[x, y] in the face frame (mm).'), minItems: 1 },
        from: {
          type: 'array',
          description: 'Edges the positions are measured from, at most two per position.',
          items: {
            type: 'object',
            properties: {
              position: { type: 'integer', minimum: 0, description: 'Index into `positions`.' },
              edge: handle('A straight edge handle of the face.'),
              distance: expr('Distance from the edge (mm), into the face.'),
            },
            required: ['position', 'edge', 'distance'],
            additionalProperties: false,
          },
        },
        diameter: expr('Hole diameter (mm).'),
        depth: expr('Depth (mm), to where the full diameter ends.'),
        throughAll: { type: 'boolean', description: 'Through everything; `depth` is not used.' },
        tipAngle: expr('Drill point angle (deg), e.g. 118.'),
        kind: { type: 'string', enum: ['simple', 'counterbore', 'countersink'] },
        counterboreDiameter: expr('mm'),
        counterboreDepth: expr('mm'),
        countersinkDiameter: expr('mm'),
        countersinkAngle: expr('Included angle (deg), default 90.'),
        thread: { type: 'string', description: "ISO metric designation, e.g. 'M5' or 'M8x1'." },
        threadClass: { type: 'string', description: "Thread class, default '6H'." },
        modelled: { type: 'boolean', description: 'With `thread`: cut it into the bore. Default false: cosmetic.' },
        hand: {
          type: 'string',
          enum: ['right', 'left'],
          description: 'With `thread`: right-handed (default) or left-handed.',
        },
      },
      required: ['face', 'positions', 'diameter'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_shell',
    description:
      'Hollow bodies to a wall `thickness`, opening the faces given (face handles) on the bodies they lie on; `bodies` (body handles) ' +
      "are hollowed with no opening, around a sealed void. Give `faces`, `bodies` or both, never a face and its own body. `direction` 'inside' " +
      "(default) keeps the outside, 'outside' grows out, 'both' walls `thickness` in and `outsideThickness` out. Returns `{feature, status}`.",
    inputSchema: {
      type: 'object',
      properties: {
        faces: handles('Faces to remove.'),
        bodies: handles('Bodies to hollow closed, with no face removed.'),
        thickness: expr('Wall thickness (mm); with direction both, the inside wall.'),
        direction: { type: 'string', enum: ['inside', 'outside', 'both'] },
        outsideThickness: expr("Outside wall (mm), with direction 'both'."),
      },
      required: ['thickness'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_pattern',
    description:
      "Copy bodies (body handles) or features (feature ids) in a pattern. `layout` 'linear': `direction` (axis or handle), `count`, " +
      "`spacing` (step, may be negative), and optionally `direction2`, `count2`, `spacing2`; 'circular': `axis`, `count`, `angle` " +
      '(the whole sweep, default 360; at a full turn the step is angle / count). `count` includes the original. `symmetric` ' +
      '(`symmetric2` for the second direction) spreads the copies both ways from the original, `count` still taking in them all ' +
      "and an even count's extra copy going the positive way; a symmetric circular `angle` is the whole spread, under 360. " +
      'Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodies: handles('Body handles to copy.'),
        features: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Feature ids to copy, instead of bodies, all of one part; the pattern goes into that part.',
        },
        layout: { type: 'string', enum: ['linear', 'circular'] },
        direction: axis,
        count: expr('Number of copies, original included.'),
        spacing: expr('Step between copies (mm).'),
        direction2: axis,
        count2: expr('Copies along the second direction.'),
        spacing2: expr('Step along the second direction (mm).'),
        symmetric: {
          type: 'boolean',
          description: 'Copies on both sides of the original: along `direction`, or about `axis`. Default false.',
        },
        symmetric2: { type: 'boolean', description: 'Copies on both sides along `direction2`. Default false.' },
        axis,
        angle: expr('Circular sweep (deg).'),
        reversed: { type: 'boolean', description: 'Run against the direction or axis.' },
        operation: operation(['new', 'join'], "'new'"),
      },
      required: ['layout', 'count'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_mirror',
    description: 'Mirror bodies (body handles) or features (feature ids) across a plane. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodies: handles('Body handles.'),
        features: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Feature ids, instead of bodies, all of one part; the mirror goes into that part.',
        },
        plane,
        operation: operation(['new', 'join'], "'join'"),
      },
      required: ['plane'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_move',
    description:
      'Move bodies: a turn of `angle` about `rotateAxis` through the part origin, then a shift by `translate`. `copy` keeps the originals. ' +
      'Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        bodies: handles('Body handles.'),
        translate: vec3('Shift [x, y, z] (mm or expressions).'),
        rotateAxis: vec3('Turn axis direction [x, y, z], default [0, 0, 1].'),
        angle: expr('Turn angle (deg), default 0.'),
        copy: { type: 'boolean' },
      },
      required: ['bodies'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_boolean',
    description:
      'Combine bodies: the `target` body joined with, cut by, or intersected with the `tools` bodies. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        target: handle('The body that keeps its identity.'),
        tools: handles('The tool bodies; they are used up unless `keepTools`.'),
        op: { type: 'string', enum: ['join', 'cut', 'intersect'] },
        keepTools: {
          type: 'boolean',
          description: 'Keep the tool bodies as they are after the operation. Default false.',
        },
      },
      required: ['target', 'tools', 'op'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_primitive',
    description:
      "Add a primitive solid centred on `position`, its axis along part Z: 'box' (width along X, depth along Y, height along Z), " +
      "'cylinder' (radius, height), 'sphere' (radius), 'cone' (bottomRadius, topRadius, height; the bottom at −Z), 'torus' " +
      '(majorRadius, minorRadius). Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string', enum: ['box', 'cylinder', 'sphere', 'cone', 'torus'] },
        width: expr('mm'),
        depth: expr('mm'),
        height: expr('mm'),
        radius: expr('mm'),
        bottomRadius: expr('mm'),
        topRadius: expr('mm'),
        majorRadius: expr('mm'),
        minorRadius: expr('mm'),
        position: vec3('Centre [x, y, z] (mm), default the origin.'),
        operation: operation(['new', 'join', 'cut', 'intersect']),
        part: partField,
      },
      required: ['shape'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_thread',
    description:
      'Thread a cylindrical face, ISO metric: a cosmetic thread, data on the face with no change to the geometry, or with `modelled` ' +
      'the groove cut into the body, which is slower to rebuild and leaves many faces. ' +
      'Without `designation` and `threadClass` the size follows the face: a shaft takes the size of its diameter (class 6g), a bore ' +
      'the size whose tap drill it is (6H). Classes in capitals are internal. Returns `{feature, status, designation, threadClass}`.',
    inputSchema: {
      type: 'object',
      properties: {
        face: handle('A cylindrical face handle.'),
        designation: { type: 'string', description: "e.g. 'M6' (coarse) or 'M8x1' (fine, ISO 261)." },
        threadClass: { type: 'string', description: "e.g. '6H' (internal) or '6g' (external)." },
        modelled: { type: 'boolean', description: 'Cut the thread into the body. Default false: cosmetic.' },
        hand: { type: 'string', enum: ['right', 'left'], description: 'Right-handed (default) or left-handed.' },
      },
      required: ['face'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_construction',
    description:
      "Add construction geometry: a plane, axis, point or frame, whose frame is attached to supports. Modes: 'plane' (one plane or flat " +
      "face; plane, axis, frame), 'planeAtPoint' (a plane, then a point; axis, point), 'threePoints' (origin, a point along x, a point in " +
      "the plane; plane, frame), 'twoPoints' (origin, a point the z axis runs towards; axis), 'point' (one point, the part's axes; point, " +
      "frame), 'alongLine' (a straight edge, sketch line, construction axis or 'x', 'y', 'z'; z along it from its start; axis, plane), " +
      "'midplane' (two planes or flat faces; halfway between them, or bisecting where they meet; plane), 'faceAxis' (a cylindrical, " +
      "conical or toroidal face; its axis; axis), 'center' (a circular edge, sphere or torus face; its centre; point), " +
      "'fixed' (at `position` in part coordinates; point, frame). A plane is the frame's xy plane, an axis its z " +
      'axis, a point its origin. `offset` moves it along the frame normal (mm), `angle` turns it about its x axis, `flip` turns it over. ' +
      'Points are vertex, sketch point or construction point handles. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['plane', 'axis', 'point', 'frame'] },
        mode: {
          type: 'string',
          enum: [
            'plane',
            'planeAtPoint',
            'threePoints',
            'twoPoints',
            'point',
            'alongLine',
            'midplane',
            'faceAxis',
            'center',
            'fixed',
          ],
        },
        supports: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: "Handles, or standard planes 'xy', 'xz', 'yz', in the mode's order.",
        },
        offset: expr('Along the frame normal (mm).'),
        angle: expr('Turn about the frame x axis (deg).'),
        flip: { type: 'boolean' },
        position: vec3('For fixed: [x, y, z] (mm).'),
        part: { type: 'string', description: `Optional: the part, for fixed; default ${WORKING_PART}.` },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_remove_body',
    description: 'Remove bodies from the part from here on (they stay in earlier states). Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: { bodies: handles('Body handles.') },
      required: ['bodies'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_freeze',
    description:
      "Freeze a feature of a part's timeline: its result is stored as it last built, so later edits before it no longer change it " +
      '(the link to its inputs is broken). `frozen: false` makes it build from its inputs again. Sketches, measures and ' +
      'assembly features are never frozen; a feature that paused has nothing to store. A frozen feature whose input body an earlier ' +
      "edit changed is listed as 'blocked' with why, and still shows what it stored. Returns `{feature, frozen, status}`.",
    inputSchema: {
      type: 'object',
      properties: { feature: featureId(), frozen: { type: 'boolean', description: 'Default true.' } },
      required: ['feature'],
      additionalProperties: false,
    },
  },
  // ---- Assemblies ----
  {
    name: 'get_assembly',
    description:
      'An assembly: its instances (id, label such as "Bracket:1", what each places, grounded, where the pose solve puts it), joints (id, ' +
      'label, kind, solved values in mm and deg), motion links, rigid groups, contact sets, positions (and the active one), exploded views, ' +
      'its features that copy instances (patterns, mirrors, replicates, with how many copies each placed), ' +
      'and the captured contexts of its parts that are out of date, with why. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: {
          type: 'string',
          description: 'Optional: the assembly (asm_…); default the one shown, else the root, else the only one.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_create',
    description:
      'Make an assembly holding instances of `parts` (the first grounded at the origin). In a document whose root is a part it becomes ' +
      'the root unless `root` is false. Returns the assembly as `get_assembly` does.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parts: { type: 'array', items: { type: 'string' }, description: 'Part ids (part_…) to place, in order.' },
        root: { type: 'boolean', description: 'Make it the document root. Default: when the root is a part.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_insert',
    description:
      'Place an instance of a part, another assembly or a library component of this document in `assembly`, at `position` (mm) turned ' +
      '`angle` deg about Z. Give one of `part`, `subassembly`, `component`. Joints then move it; a grounded instance stays. ' +
      'Returns `{instance, label, assembly}`.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: {
          type: 'string',
          description: 'Optional: the assembly the instance goes into; default as get_assembly.',
        },
        part: { type: 'string', description: 'A part id (part_…) to place.' },
        subassembly: { type: 'string', description: 'An assembly id (asm_…) to place, as a subassembly.' },
        component: { type: 'string', description: 'A library entry id (lib_…) of an embedded component document.' },
        position: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3,
          description: '[x, y, z] in mm. Default the origin.',
        },
        angle: { type: 'number', description: 'Turn about Z, deg. Default 0.' },
        grounded: { type: 'boolean', description: 'Fix it where it is placed. Default false.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_joint',
    description:
      'Join two instances: each end is a flat face (its centre, z its outward normal) or a round edge (its centre, ' +
      "on the flat face it bounds) of an instance, `{instance, at}` with `at` a face or edge handle listed from that instance's part, or " +
      "`{standard: 'xy' | 'xz' | 'yz'}` for a plane of the assembly. With every value 0 the ends coincide; `faceToFace` (default true) " +
      'turns the second end to face the first, so two faces mate. Kinds and their degrees of freedom: rigid (none), revolute (rz), ' +
      'slider (tz), cylindrical (tz, rz), pinSlot (tx, rz), planar (tx, ty, rz), ball (rz, ry, rx). The pose solve moves the instances; ' +
      'returns `{joint, label, assembly}`.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        kind: { type: 'string', enum: ['rigid', 'revolute', 'slider', 'cylindrical', 'pinSlot', 'planar', 'ball'] },
        a: { type: 'object', description: '{instance: inst_…, at: handle} or {standard: plane}.' },
        b: {
          type: 'object',
          description: '{instance: inst_…, at: handle} or {standard: plane}: the end that moves onto `a`.',
        },
        faceToFace: { type: 'boolean' },
        offset: { type: 'number', description: "Along the first end's normal, mm. Default 0." },
        angle: { type: 'number', description: "About the first end's normal, deg. Default 0." },
        limits: {
          type: 'object',
          description: 'Optional: degree of freedom → [min, max] (mm or deg), e.g. {"rz": [0, 90]}.',
        },
      },
      required: ['kind', 'a', 'b'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_drive',
    description:
      "Set (drive) a joint's values: degree of freedom → number (mm or deg). The instances move as the solve places them.",
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        joint: { type: 'string', description: 'The joint id (jnt_…).' },
        values: { type: 'object', description: 'e.g. {"rz": 45}.' },
      },
      required: ['joint', 'values'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_move_instance',
    description:
      'Move an instance to `position` (mm) turned `angle` deg about Z. A joint or grounding may hold it where the solve puts it.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        instance: { type: 'string', description: 'The instance id (inst_…).' },
        position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        angle: { type: 'number' },
      },
      required: ['instance', 'position'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_set_instance',
    description: 'Ground or unground an instance, or suppress or unsuppress it.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        instance: { type: 'string' },
        grounded: { type: 'boolean' },
        suppressed: { type: 'boolean' },
      },
      required: ['instance'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_set_joint',
    description:
      'Rename a joint, lock or unlock it (lock motion: a locked joint holds where it stands; drive, drag and the active position leave it ' +
      'alone), or suppress or unsuppress it. An empty `name` gives the joint its numbered label again.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        joint: { type: 'string', description: 'The joint id (jnt_…).' },
        name: { type: 'string' },
        locked: { type: 'boolean' },
        suppressed: { type: 'boolean' },
      },
      required: ['joint'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_delete',
    description:
      'Delete a row of an assembly by id: an instance (with the joints, joint origins and group memberships that stand on it), a joint (with ' +
      'its motion links and the joint origins no other joint uses), a motion link, a group, a position or an exploded view.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        row: { type: 'string', description: 'inst_…, jnt_…, rel_…, grp_…, set_…, pos_… or exp_….' },
      },
      required: ['row'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_relation',
    description:
      'A motion link between joints; the first drives. gear: two turning joints, the second turns `ratio` times the first (negative turns ' +
      'the other way). rackPinion: a turning joint drives a sliding one, `ratio` mm per deg. screw: one cylindrical joint whose slide follows its turn, `ratio` mm per deg.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        kind: { type: 'string', enum: ['gear', 'rackPinion', 'screw'] },
        joints: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
        ratio: { type: 'number' },
      },
      required: ['kind', 'joints', 'ratio'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_group',
    description:
      'A rigid group (the instances move as one) or a contact set (instances that touch while dragged) of two or more instances.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        kind: { type: 'string', enum: ['rigid', 'contact'] },
        instances: { type: 'array', items: { type: 'string' }, minItems: 2 },
      },
      required: ['kind', 'instances'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_position',
    description:
      "Positions: 'capture' saves every joint's current values under `name`; 'activate' poses the assembly in `position`; " +
      "'current' goes back to the joints' own values; 'update' overwrites `position` with the current values.",
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        action: { type: 'string', enum: ['capture', 'activate', 'current', 'update'] },
        position: { type: 'string', description: 'For activate and update: pos_….' },
        name: { type: 'string', description: 'For capture.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_exploded_view',
    description:
      'An exploded view: steps applied in order, each moving its instances by `move` [x, y, z] mm. It does not change the pose; `show` ' +
      '(default true) draws the assembly in it.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        name: { type: 'string' },
        steps: {
          type: 'array',
          items: { type: 'object' },
          minItems: 1,
          description: '[{instances: [inst_…], move: [x, y, z]}].',
        },
        show: { type: 'boolean' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'feature_derive',
    description:
      "Bring another part's, an assembly's or a library component's bodies into a part as a derive feature: offset by [x, y, z] mm, " +
      'optionally mirrored in a standard plane (an opposite-hand part), as new bodies or joined. Give one of `fromPart`, `fromAssembly`, `fromComponent`. Returns `{feature, status}`.',
    inputSchema: {
      type: 'object',
      properties: {
        part: { type: 'string', description: `Optional: the part that takes them; default ${WORKING_PART}.` },
        fromPart: { type: 'string' },
        fromAssembly: { type: 'string' },
        fromComponent: { type: 'string', description: 'A library entry id (lib_…).' },
        offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
        mirror: { type: 'string', enum: ['none', 'xy', 'xz', 'yz'] },
        operation: { type: 'string', enum: ['new', 'join'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_update_contexts',
    description:
      "Re-capture captured contexts that are out of date (a part that uses another part's geometry through an assembly, as a hole " +
      'through several parts does): all of them, or the one named. Returns what was updated and what is still out of date.',
    inputSchema: {
      type: 'object',
      properties: { context: { type: 'string', description: 'Optional: the context id (ctx_…).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_hole_through',
    description:
      "A hole through several parts: it starts on a flat face of `instance` (a face handle of that instance's part), at `points` [x, y] " +
      "in the face's placement frame (its origin the part origin projected on it, x the part's x), and goes through the parts of the " +
      'instances in `through`. Each part gets its own hole, one document parameter sizing them all, and the other parts follow the first ' +
      'through their contexts. Each part must be placed once and be a part of this document.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        instance: { type: 'string', description: 'The instance the hole starts in.' },
        face: { type: 'string', description: 'A flat face handle of its part.' },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, minItems: 1 },
        diameter: { type: ['number', 'string'], description: 'mm, or an expression.' },
        through: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The other instances.' },
      },
      required: ['instance', 'face', 'points', 'diameter', 'through'],
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_pattern',
    description:
      "Copy instances in a pattern: 'linear' along one or two directions (`directions`: " +
      "[{axis, count, spacing}], count including the original, spacing in mm between neighbours), or 'circular' about `axis` " +
      "(`count` copies spread over `angle` deg, 360 by default). An axis is 'x', 'y' or 'z' of the assembly, or {instance, at} with " +
      "`at` a straight edge handle of that instance's part. The copies follow their originals when those move. Give `feature` (an " +
      "existing pattern's id) to edit it: fields left out keep their values. Returns `{feature, copies, status, assembly}`.",
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        feature: { type: 'string', description: 'Optional: the pattern to edit (feat_…).' },
        instances: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'The instances to copy (inst_…).',
        },
        layout: { type: 'string', enum: ['linear', 'circular'] },
        directions: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { type: 'object' },
          description:
            "For linear: [{axis, count, spacing, reversed?, symmetric?}]; count and spacing take numbers or expressions; symmetric spreads them both ways from the original, count still taking in them all and an even count's extra copy going the positive way.",
        },
        axis: { type: ['string', 'object'], description: "For circular: 'x', 'y', 'z' or {instance, at}." },
        count: { type: ['number', 'string'], description: 'For circular: how many, the original included.' },
        angle: { type: ['number', 'string'], description: 'For circular: the whole sweep in deg; default 360.' },
        reversed: { type: 'boolean', description: 'For circular: turn the other way.' },
        symmetric: {
          type: 'boolean',
          description:
            'For circular: copies both ways from the original, `count` in all and `angle` (under 360) the whole spread.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_mirror',
    description:
      "Mirror instances in a plane: `plane` is 'xy', 'xz' or 'yz' of the assembly, or {instance, at} " +
      "with `at` a flat face handle of that instance's part. 'same' hand (default) places each original's own part turned to face the " +
      "mirror; 'opposite' makes a new part per original, a derive of its part reflected, placed where the reflection lands. Give " +
      '`feature` to edit an existing mirror. Returns `{feature, copies, status, assembly}`.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        feature: { type: 'string', description: 'Optional: the mirror to edit (feat_…).' },
        instances: { type: 'array', items: { type: 'string' }, minItems: 1 },
        plane: { type: ['string', 'object'], description: "'xy', 'xz', 'yz' or {instance, at}." },
        hand: { type: 'string', enum: ['same', 'opposite'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'assembly_replicate',
    description:
      'Place copies of instances at other places like the one they sit at, as a bolt in every hole like the first: `seed` is where they ' +
      'sit and each of `targets` a place a copy goes, each {instance, at} with `at` a flat face (its centre) or round edge (its centre) ' +
      "handle of that instance's part, or {standard: plane}. Each copy stands to its target as the originals stand to the seed. Give " +
      '`feature` to edit an existing replicate. Returns `{feature, copies, status, assembly}`.',
    inputSchema: {
      type: 'object',
      properties: {
        assembly: { type: 'string' },
        feature: { type: 'string', description: 'Optional: the replicate to edit (feat_…).' },
        instances: { type: 'array', items: { type: 'string' }, minItems: 1 },
        seed: { type: 'object', description: '{instance, at} or {standard}.' },
        targets: { type: 'array', items: { type: 'object' }, minItems: 1 },
      },
      additionalProperties: false,
    },
  },
  // ---- What the model is built into ----
  {
    name: 'list_bodies',
    description:
      'The bodies a part shows after the newest rebuild: a handle each, its name, the feature that made it, its bounding box ' +
      '(min, max in part coordinates, mm) and volume (mm³). Handles name the body by its identity, so they keep working after ' +
      'later edits for as long as the body exists. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: { part: partField },
      additionalProperties: false,
    },
  },
  {
    name: 'list_faces',
    description:
      "A body's faces: a handle each, its surface ('plane', 'cylinder', 'cone', 'sphere', 'torus', …), area (mm²), centroid, and a plane's " +
      "outward normal or a cylinder's axis and radius. Filters narrow the list: `surface`, and `normal` (planar faces whose outward normal is within " +
      '1° of it). Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        body: handle('A body handle.'),
        surface: { type: 'string', description: "Only faces of this surface kind, e.g. 'plane'." },
        normal: vec3('Only planar faces facing this way, e.g. [0, 1, 0] for upward faces.'),
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_edges',
    description:
      "A body's edges: a handle each, its curve ('line', 'circle', …), length (mm), end points, midpoint, a circle's centre and radius, " +
      'and the handles of the two faces it lies between. Filters: `face` (edges of that face), `between` (the edge between two faces), ' +
      '`curve`, `parallel` (straight edges along this direction), `minLength`, `maxLength`. Waits for the newest rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        body: handle('A body handle.'),
        face: handle('Only edges of this face.'),
        between: handles('Only the edges between these two faces.', 2),
        curve: { type: 'string', description: "Only edges of this curve kind, e.g. 'line' or 'circle'." },
        parallel: vec3('Only straight edges along this direction.'),
        minLength: { type: 'number' },
        maxLength: { type: 'number' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_vertices',
    description:
      "A body's vertices: a handle and a position each, for construction geometry through points. Waits for the newest rebuild.",
    inputSchema: {
      type: 'object',
      properties: { body: handle('A body handle.') },
      required: ['body'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_construction',
    description:
      'The construction planes, axes, points and frames a part shows, and the three standard planes: a handle each (standard ones by ' +
      'name), with the frame (origin, x, y, normal).',
    inputSchema: {
      type: 'object',
      properties: { part: partField },
      additionalProperties: false,
    },
  },
  {
    name: 'measure',
    description:
      "Measure between entities (handles): 'distance' (the least distance between two), 'length' (edges or curves, summed), 'area' (faces), " +
      "'volume' (bodies), 'angle' (between two lines, axes or planar faces), 'radius' (a circle, arc, cylinder or sphere). " +
      'Returns `{value, quantity}` in mm, mm², mm³ or deg.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['distance', 'length', 'area', 'volume', 'angle', 'radius'] },
        entities: handles('The handles to measure.'),
      },
      required: ['kind', 'entities'],
      additionalProperties: false,
    },
  },
  // ---- The view ----
  {
    name: 'view_fit_all',
    description: 'Frame the camera on everything shown.',
    inputSchema: empty,
  },
  {
    name: 'view_set_standard',
    description: 'Turn the camera to a standard view: front, back, top, bottom, left, right, or home (the iso view).',
    inputSchema: {
      type: 'object',
      properties: { view: { type: 'string', enum: ['front', 'back', 'top', 'bottom', 'left', 'right', 'home'] } },
      required: ['view'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_zoom',
    description: 'Zoom the camera one step in or out.',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['in', 'out'] } },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'view_screenshot',
    description:
      'A JPEG of the viewport as the user sees it, returned as an image you can look at, at most 768 px on its long side. ' +
      'Call `view_fit_all` or `view_set_standard` first so it shows what you want to check. Waits for the newest rebuild.',
    inputSchema: empty,
  },
] as const);

/** The tool of that name, or `undefined`. */
export function findTool(name: string): CadToolDefinition | undefined {
  return CAD_TOOLS.find((t) => t.name === name);
}

/** Whether a tool of that name exists. */
export function isToolName(name: string): boolean {
  return CAD_TOOLS.some((t) => t.name === name);
}
