/**
 * The feature tools. Each fills the form of the feature's panel, builds the
 * inputs with the panel's model (appendix A), and writes them as the panel's
 * OK does: one undo step at the rollback marker, the references picked from
 * handles. The result says how the feature fared in the rebuild.
 */
import { canonicalize, makeSet } from '@tweakcad/format';
import { withDefaultUnit, type Editor, type Json } from '@tweakcad/editor';
import { bodiesOf, findFeature, partOfFeature } from '../app/features';
import { buildChamfer, buildFillet, newChamferForm, newFilletForm, type ChamferSize } from '../app/modeling/blends';
import {
  buildBoolean,
  buildMirror,
  buildMove,
  buildPattern,
  buildRemoveBody,
  buildShell,
  newDirection,
  newMirrorForm,
  newMoveForm,
  newPatternForm,
  newShellForm,
  type PatternDirection,
} from '../app/modeling/bodyFeatures';
import {
  CONSTRUCTION_NAMES,
  CONSTRUCTION_TYPES,
  MODES,
  SUPPORTS,
  buildConstruction,
  newConstructionForm,
  withMode,
  type ConstructionKind,
  type ConstructionMode,
} from '../app/modeling/construction';
import {
  buildExtrude,
  regionRowOf,
  writeExtrude,
  type ExtentKind,
  type ExtrudeForm,
  type ExtrudeProfile,
  type Operation,
} from '../app/modeling/extrude';
import {
  ValueSlots,
  newTarget,
  sameReference,
  writeFeature,
  type Built,
  type FeatureTarget,
  type PickedRef,
} from '../app/modeling/feature';
import { buildHole, MAX_EDGES, newHoleForm, tapDrill, type HoleKind } from '../app/modeling/hole';
import { buildLoft, newLoftForm } from '../app/modeling/loft';
import { planarFrame } from '../app/modeling/picks';
import {
  SHAPE_FIELDS,
  SHAPE_NAMES,
  buildPrimitive,
  newPrimitiveForm,
  type PrimitiveShape,
} from '../app/modeling/primitive';
import { sketchesOf } from '../app/modeling/profiles';
import { buildRevolve, newRevolveForm, type AxisChoice, type RevolveExtent } from '../app/modeling/revolve';
import { buildSweep, newSweepForm, type ChainPick, type SweepOrientation } from '../app/modeling/sweep';
import { buildThread, isBore, newThreadForm, sizeForDiameter } from '../app/modeling/thread';
import { table } from '../sketcher/rows';
import {
  added,
  check,
  currentKey,
  entryOf,
  exprArg,
  handleOf,
  optBool,
  optStr,
  planeOrAxis,
  referenceOf,
  str,
  strings,
  vec2,
  vectorArg,
  type Args,
} from './common';
import { ToolError, checkCanEdit, invalid, partArg, settledDisplay, type AiContext } from './context';
import { freezeFeature, isFrozen, unfreezeFeature } from '../app/modeling/freeze';
import type { HandleEntry } from './handles';
import { sketchAt } from './sketchWrite';

/** A pick of a handle as a panel holds it. */
function picked(ctx: AiContext, handle: unknown, kinds: Parameters<typeof entryOf>[2], field: string): PickedRef {
  const e = entryOf(ctx, handle, kinds, field);
  const r = referenceOf(e);
  return { reference: r.reference, names: r.names, label: e.handle };
}

function picks(ctx: AiContext, args: Args, field: string, kinds: Parameters<typeof entryOf>[2]): PickedRef[] {
  return (strings(args, field) as string[]).map((h, i) => picked(ctx, h, kinds, `${field}[${i}]`));
}

function oneOf<T extends string>(args: Args, field: string, options: readonly T[], fallback: T): T {
  const v = args[field];
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !options.includes(v as T)) throw invalid(`\`${field}\` is one of ${options.join(', ')}`);
  return v as T;
}

function refused(built: Built): never {
  throw new ToolError(
    'INVALID_INPUT',
    built.ok ? 'not built' : `${built.message}${built.field ? ` (${built.field})` : ''}`,
  );
}

function hasBody(ctx: AiContext, part: string): boolean {
  return bodiesOf(ctx.services.display.getState().display, part).length > 0;
}

function defaultOperation(ctx: AiContext, part: string): Operation {
  return hasBody(ctx, part) ? 'join' : 'new';
}

/** The operation's targets, when the caller picked bodies: `{bodies: set}` in place of every body. */
function withTargets(ctx: AiContext, args: Args, built: { inputs: Json; names: Json }): void {
  if (args.targets === undefined) return;
  const bodies = picks(ctx, args, 'targets', ['body']);
  const operation = built.inputs.operation as Json;
  operation.targets = { bodies: makeSet(bodies.map((b) => b.reference)) as unknown as Json };
  for (const b of bodies) Object.assign(built.names, b.names);
}

/** Writes a feature built by a panel model, then waits for the rebuild that shows it. */
async function write(
  ctx: AiContext,
  target: FeatureTarget,
  type: string,
  built: Built,
  baseName: string,
  extra: Json = {},
): Promise<Json> {
  if (!built.ok) refused(built);
  check(writeFeature(ctx.services.editor, target, type, built, baseName));
  return added(ctx, target.feature, { name: target.name, ...extra });
}

const slots = (editor: Editor) => new ValueSlots(() => editor.newId('val'));

// ---- Profiles ----

/** The profile a region handle makes: its region row, or a detected region with the row it will take. */
function profileOf(ctx: AiContext, part: string, e: HandleEntry): ExtrudeProfile {
  const { editor } = ctx.services;
  const doc = editor.document;
  const p = e.picked;
  if ('region' in p) {
    const { sketch, loop, holes } = p.region;
    const rows = table(sketchAt(doc, sketch).inputs, 'regions');
    const key = (l: unknown, h: unknown) => `${canonicalize(l)}|${canonicalize(h)}`;
    const row = rows.find((r) => key(r.loop, r.holes) === key(loop, holes));
    if (row) return { sketch, row: row.id as string };
    return {
      sketch,
      row: editor.newId('reg'),
      detected: { loop: loop as unknown as Json, holes: holes as unknown as Json },
    };
  }
  return regionRowOf(doc, part, p.reference) ?? { kept: p.reference };
}

/** The profiles a tool takes: the region handles given, or every region of `sketch`. */
async function profilesArg(ctx: AiContext, args: Args): Promise<{ part: string; profiles: ExtrudeProfile[] }> {
  const doc = ctx.services.editor.document;
  if (args.profiles !== undefined) {
    const entries = (strings(args, 'profiles') as string[]).map((h, i) =>
      entryOf(ctx, h, ['region'], `profiles[${i}]`),
    );
    const part = (entries[0] as HandleEntry).part;
    const profiles: ExtrudeProfile[] = [];
    for (const e of entries) {
      const p = profileOf(ctx, part, e);
      const same = profiles.some(
        (q) =>
          !('kept' in q) &&
          !('kept' in p) &&
          q.sketch === p.sketch &&
          (q.row === p.row ||
            (canonicalize(q.detected ?? null) === canonicalize(p.detected ?? null) && p.detected !== undefined)),
      );
      if (!same) profiles.push(p);
    }
    const sketches = new Set(profiles.flatMap((p) => ('kept' in p ? [] : [p.sketch])));
    if (sketches.size > 1) throw invalid('The profiles come from one sketch');
    return { part, profiles };
  }
  if (args.sketch === undefined) throw invalid('Give `profiles` (region handles) or `sketch`');
  const at = sketchAt(doc, args.sketch);
  const display = await settledDisplay(ctx);
  const regions = sketchesOf(display, at.part).find((s) => s.feature === at.feature)?.regions ?? [];
  if (regions.length === 0)
    throw new ToolError('REFUSED', 'The sketch has no closed region: its curves make no closed loop');
  const profiles: ExtrudeProfile[] = [];
  for (const r of regions) {
    const h = await handleOf(ctx, display, at.part, r.key, 'region', at.feature);
    if (!h) throw new ToolError('STALE_HANDLE', 'The sketch changed while its regions were read; try again');
    const p = profileOf(ctx, at.part, ctx.handles.get(h) as HandleEntry);
    if (!profiles.some((q) => !('kept' in q) && !('kept' in p) && q.row === p.row)) profiles.push(p);
  }
  return { part: at.part, profiles };
}

// ---- Extrude and revolve ----

const EXTENTS = [
  'distance',
  'symmetric',
  'twoSides',
  'throughAll',
  'toFace',
  'toBody',
  'upToNext',
  'upToLast',
] as const;
const OPERATIONS = ['new', 'join', 'cut', 'intersect'] as const;

export async function featureExtrude(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const { part, profiles } = await profilesArg(ctx, args);
  const extent = oneOf(args, 'extent', EXTENTS, 'distance');
  const taper = args.taper !== undefined ? exprArg(args, 'taper', 'deg') : '0 deg';
  const sideExtent: ExtentKind = extent === 'symmetric' || extent === 'twoSides' ? 'distance' : extent;
  const form: ExtrudeForm = {
    sides: extent === 'symmetric' ? 'symmetric' : extent === 'twoSides' ? 'two' : 'one',
    extent: sideExtent,
    distance: exprArg(args, 'distance', 'mm', sideExtent === 'distance' ? undefined : '10 mm'),
    taper,
    ...(extent === 'twoSides'
      ? { side2: { extent: 'distance' as const, distance: exprArg(args, 'second', 'mm', '0 mm'), face: null, taper } }
      : {}),
    reversed: optBool(args, 'reversed') ?? false,
    operation: oneOf(args, 'operation', OPERATIONS, defaultOperation(ctx, part)),
    face:
      extent === 'toFace'
        ? { ...planeOrAxis(ctx, args.face, ['face', 'construction'], 'face'), label: 'Face' }
        : extent === 'toBody'
          ? { ...picked(ctx, args.body, ['body'], 'body'), label: 'Body' }
          : null,
    startType: args.startFace !== undefined ? 'face' : 'profile',
    startOffset: exprArg(args, 'startOffset', 'mm', '0 mm'),
    startFace:
      args.startFace !== undefined
        ? { ...planeOrAxis(ctx, args.startFace, ['face', 'construction'], 'startFace'), label: 'Face' }
        : null,
  };
  const target = newTarget(editor, part, 'Extrude');
  const values = slots(editor);
  const doc = editor.document;
  const built = buildExtrude(doc, target, form, profiles, values);
  if (!built.ok) throw invalid(`${built.message}${built.field ? ` (${built.field})` : ''}`);
  withTargets(ctx, args, built);
  check(writeExtrude(editor, target, built, profiles));
  return added(ctx, target.feature, { name: target.name });
}

function axisChoice(ctx: AiContext, v: unknown, field: string): Exclude<AxisChoice, null> {
  if (v === 'x' || v === 'y' || v === 'z') return { standard: v };
  return { picked: picked(ctx, v, ['edge', 'curve', 'construction'], field) };
}

export async function featureRevolve(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const { part, profiles } = await profilesArg(ctx, args);
  const form = newRevolveForm(hasBody(ctx, part));
  form.profiles = profiles;
  form.axis = axisChoice(ctx, args.axis, 'axis');
  form.extent = oneOf<RevolveExtent>(args, 'extent', ['angle', 'symmetric', 'twoSides', 'full'], 'angle');
  form.angle = exprArg(args, 'angle', 'deg', form.extent === 'full' ? '360 deg' : undefined);
  form.second = exprArg(args, 'second', 'deg', '0 deg');
  form.reversed = optBool(args, 'reversed') ?? false;
  form.operation = oneOf(args, 'operation', OPERATIONS, form.operation);
  const target = newTarget(editor, part, 'Revolve');
  const built = buildRevolve(editor.document, target, form, slots(editor));
  if (built.ok) withTargets(ctx, args, built);
  return write(ctx, target, 'core.revolve', built, 'Revolve');
}

export async function featureLoft(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const entries = (strings(args, 'sections') as string[]).map((h, i) => entryOf(ctx, h, ['region'], `sections[${i}]`));
  const part = (entries[0] as HandleEntry).part;
  const form = newLoftForm(hasBody(ctx, part));
  form.sections = entries.map((e) => ({ id: editor.newId('sec'), profile: profileOf(ctx, part, e) }));
  form.ruled = optBool(args, 'ruled') ?? false;
  form.closed = optBool(args, 'closed') ?? false;
  form.operation = oneOf(args, 'operation', OPERATIONS, form.operation);
  const target = newTarget(editor, part, 'Loft');
  const built = buildLoft(editor.document, target, form, slots(editor));
  if (built.ok) withTargets(ctx, args, built);
  return write(ctx, target, 'core.loft', built, 'Loft');
}

/** The links a chain of curve, edge or region handles makes. */
function chainArg(ctx: AiContext, part: string, args: Args, field: string): ChainPick[] {
  return (strings(args, field) as string[]).map((h, i) => {
    const e = entryOf(ctx, h, ['region', 'curve', 'edge'], `${field}[${i}]`);
    if ('region' in e.picked) return { region: profileOf(ctx, part, e), label: e.handle };
    const r = referenceOf(e);
    return { reference: r.reference, names: r.names, label: e.handle };
  });
}

export async function featureSweep(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const { part, profiles } = await profilesArg(ctx, args);
  const form = newSweepForm(editor.newId('sec'), hasBody(ctx, part));
  form.profiles = profiles;
  form.path = chainArg(ctx, part, args, 'path');
  form.orientation = oneOf<SweepOrientation>(args, 'orientation', ['followPath', 'fixed', 'guide'], 'followPath');
  if (args.guide !== undefined) form.guide = chainArg(ctx, part, args, 'guide');
  form.operation = oneOf(args, 'operation', OPERATIONS, form.operation);
  const target = newTarget(editor, part, 'Sweep');
  const built = buildSweep(editor.document, target, form, slots(editor));
  if (built.ok) withTargets(ctx, args, built);
  return write(ctx, target, 'core.sweep', built, 'Sweep');
}

// ---- Edges and faces ----

/** The part of the handles a tool takes; they all come from one. */
function partOfHandles(ctx: AiContext, handles: readonly string[]): string {
  const parts = new Set(handles.map((h) => ctx.handles.get(h)?.part));
  const [part] = parts;
  if (parts.size !== 1 || !part) throw invalid('The handles come from one part');
  return part;
}

export async function featureFillet(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const form = newFilletForm();
  form.targets = picks(ctx, args, 'edges', ['edge', 'face']);
  form.radius = exprArg(args, 'radius', 'mm');
  const target = newTarget(editor, partOfHandles(ctx, strings(args, 'edges') as string[]), 'Fillet');
  return write(ctx, target, 'core.fillet', buildFillet(editor.document, target, form, slots(editor)), 'Fillet');
}

export async function featureChamfer(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const form = newChamferForm();
  form.targets = picks(ctx, args, 'edges', ['edge', 'face']);
  form.distance = exprArg(args, 'distance', 'mm');
  const size: ChamferSize =
    args.second !== undefined ? 'twoDistances' : args.angle !== undefined ? 'distanceAngle' : 'distance';
  if (args.second !== undefined && args.angle !== undefined) throw invalid('Give `second` or `angle`, not both');
  form.size = size;
  form.second = exprArg(args, 'second', 'mm', form.second);
  form.angle = exprArg(args, 'angle', 'deg', form.angle);
  const flipped = optBool(args, 'flipped');
  if (flipped !== undefined && size !== 'distanceAngle')
    throw invalid('`flipped` goes with `angle`; for two distances swap `distance` and `second`');
  form.flipped = flipped ?? false;
  const target = newTarget(editor, partOfHandles(ctx, strings(args, 'edges') as string[]), 'Chamfer');
  return write(ctx, target, 'core.chamfer', buildChamfer(editor.document, target, form, slots(editor)), 'Chamfer');
}

export async function featureHole(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const faceEntry = entryOf(ctx, args.face, ['face'], 'face');
  const frame = await planarFrame(ctx.services, await currentKey(ctx, faceEntry));
  if (!frame) throw invalid(`${faceEntry.handle} is not a flat face`);
  const form = newHoleForm();
  form.face = picked(ctx, args.face, ['face'], 'face');
  const positions = args.positions;
  if (!Array.isArray(positions) || positions.length === 0) throw invalid('`positions` lists [x, y] in the face frame');
  form.positions = positions.map((p, i) => {
    const [x, y] = vec2(p, `positions[${i}]`);
    return { id: editor.newId('hp'), x: `${x} mm`, y: `${y} mm` };
  });
  const from = args.from;
  if (from !== undefined && !Array.isArray(from)) throw invalid('`from` lists {position, edge, distance}');
  for (const [i, f] of ((from ?? []) as Args[]).entries()) {
    const position = form.positions[f.position as number];
    if (!Number.isInteger(f.position) || !position)
      throw invalid(`\`from[${i}].position\` is an index into \`positions\``);
    if ((position.from ?? []).length >= MAX_EDGES)
      throw invalid(`position ${String(f.position)} is measured from two edges at most`);
    position.from = [
      ...(position.from ?? []),
      { edge: picked(ctx, f.edge, ['edge'], `from[${i}].edge`), distance: exprArg(f, 'distance', 'mm') },
    ];
  }
  form.kind = oneOf<HoleKind>(args, 'kind', ['simple', 'counterbore', 'countersink'], 'simple');
  form.diameter = exprArg(args, 'diameter', 'mm');
  form.extent = optBool(args, 'throughAll') ? 'throughAll' : 'distance';
  form.depth = exprArg(args, 'depth', 'mm', form.extent === 'throughAll' ? '10 mm' : undefined);
  if (args.tipAngle !== undefined) {
    form.tip = 'angle';
    form.tipAngle = exprArg(args, 'tipAngle', 'deg');
  }
  form.counterboreDiameter = exprArg(
    args,
    'counterboreDiameter',
    'mm',
    form.kind === 'counterbore' ? undefined : form.counterboreDiameter,
  );
  form.counterboreDepth = exprArg(
    args,
    'counterboreDepth',
    'mm',
    form.kind === 'counterbore' ? undefined : form.counterboreDepth,
  );
  form.countersinkDiameter = exprArg(
    args,
    'countersinkDiameter',
    'mm',
    form.kind === 'countersink' ? undefined : form.countersinkDiameter,
  );
  form.countersinkAngle = exprArg(args, 'countersinkAngle', 'deg', '90 deg');
  const thread = optStr(args, 'thread');
  if (thread !== undefined) {
    if (tapDrill(thread) === null) throw invalid(`${thread} is not in the ISO metric thread table`);
    form.threaded = true;
    form.designation = thread;
    form.threadClass = optStr(args, 'threadClass') ?? '6H';
    form.modelled = optBool(args, 'modelled') ?? false;
    form.hand = oneOf(args, 'hand', ['right', 'left'], 'right');
  }
  const target = newTarget(editor, faceEntry.part, 'Hole');
  const r = (v: readonly number[]) => v.map((n) => Math.round(n * 1e6) / 1e6);
  return write(ctx, target, 'core.hole', buildHole(editor.document, target, form, slots(editor)), 'Hole', {
    frame: { origin: r(frame.origin), x: r(frame.x), y: r(frame.y), normal: r(frame.normal) },
  });
}

/** The body handle of each face handle's body, picked from the shown display. */
async function bodiesOfFaces(ctx: AiContext, faces: readonly HandleEntry[]): Promise<PickedRef[]> {
  const display = await settledDisplay(ctx);
  const out: PickedRef[] = [];
  const seen = new Set<number>();
  for (const f of faces) {
    const key = await currentKey(ctx, f, display);
    const body = display.entities[key]?.body;
    if (body === null || body === undefined) throw invalid(`${f.handle} is not on a body`);
    if (seen.has(body)) continue;
    seen.add(body);
    const h = await handleOf(ctx, display, f.part, body, 'body', display.entities[body]?.feature ?? '');
    if (!h) throw new ToolError('STALE_HANDLE', 'The model changed while it was read; try again');
    out.push(picked(ctx, h, ['body'], 'body'));
  }
  return out;
}

export async function featureShell(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const handles = (args.faces === undefined ? [] : strings(args, 'faces')) as string[];
  const closed = (args.bodies === undefined ? [] : strings(args, 'bodies')) as string[];
  if (handles.length + closed.length === 0) throw invalid('Give `faces` to remove, or `bodies` to hollow closed');
  const entries = handles.map((h, i) => entryOf(ctx, h, ['face'], `faces[${i}]`));
  const form = newShellForm();
  form.faces = handles.length > 0 ? picks(ctx, args, 'faces', ['face']) : [];
  const owners = await bodiesOfFaces(ctx, entries);
  const picked = closed.length > 0 ? picks(ctx, args, 'bodies', ['body']) : [];
  if (picked.some((b) => owners.some((o) => sameReference(o.reference, b.reference))))
    throw invalid('A body in `bodies` has faces in `faces`: give one or the other');
  form.bodies = [...owners, ...picked];
  form.thickness = exprArg(args, 'thickness', 'mm');
  form.direction = oneOf(args, 'direction', ['inside', 'outside', 'both'] as const, 'inside');
  if (form.direction === 'both') form.outside = exprArg(args, 'outsideThickness', 'mm');
  else if (args.outsideThickness !== undefined) throw invalid("`outsideThickness` goes with `direction` 'both'");
  const target = newTarget(editor, partOfHandles(ctx, [...handles, ...closed]), 'Shell');
  return write(ctx, target, 'core.shell', buildShell(editor.document, target, form, slots(editor)), 'Shell');
}

/** What a pattern or mirror copies: body handles, or feature ids. */
function copied(ctx: AiContext, args: Args): { of: 'bodies' | 'features'; items: PickedRef[]; part: string } {
  if ((args.bodies === undefined) === (args.features === undefined))
    throw invalid('Give `bodies` (body handles) or `features` (feature ids)');
  if (args.bodies !== undefined) {
    const handles = strings(args, 'bodies') as string[];
    return { of: 'bodies', items: picks(ctx, args, 'bodies', ['body']), part: partOfHandles(ctx, handles) };
  }
  const doc = ctx.services.editor.document;
  const ids = strings(args, 'features') as string[];
  const items = ids.map((id) => {
    if (!findFeature(doc, id)) throw new ToolError('NOT_FOUND', `There is no feature ${id}`);
    return { reference: { object: { feature: { id } } }, names: {}, label: id };
  });
  const parts = new Set(ids.map((id) => partOfFeature(doc, id)));
  const [part] = parts;
  if (parts.size !== 1 || !part) throw invalid('The features come from one part');
  return { of: 'features', items, part };
}

function patternDirection(
  ctx: AiContext,
  args: Args,
  axisField: string,
  countField: string,
  spacingField: string,
  symmetricField: string,
): PatternDirection {
  const d = newDirection();
  d.axis = axisChoice(ctx, args[axisField] ?? 'x', axisField);
  d.reversed = optBool(args, 'reversed') ?? false;
  d.count = exprArg(args, countField, '');
  d.spacing = exprArg(args, spacingField, 'mm');
  d.symmetric = optBool(args, symmetricField) ?? false;
  return d;
}

export async function featurePattern(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const what = copied(ctx, args);
  const form = newPatternForm();
  form.of = what.of;
  form.items = what.items;
  form.layout = oneOf(args, 'layout', ['linear', 'circular'] as const, 'linear');
  if (form.layout === 'linear') {
    form.directions = [patternDirection(ctx, args, 'direction', 'count', 'spacing', 'symmetric')];
    if (args.direction2 !== undefined || args.count2 !== undefined)
      form.directions.push(patternDirection(ctx, args, 'direction2', 'count2', 'spacing2', 'symmetric2'));
  } else {
    form.circular = {
      axis: axisChoice(ctx, args.axis ?? 'z', 'axis'),
      reversed: optBool(args, 'reversed') ?? false,
      count: exprArg(args, 'count', ''),
      angle: exprArg(args, 'angle', 'deg', '360 deg'),
      distribution: optBool(args, 'symmetric') === true ? 'symmetric' : 'partial',
    };
  }
  form.operation = oneOf(args, 'operation', ['new', 'join'] as const, form.operation);
  const target = newTarget(editor, what.part, 'Pattern');
  return write(ctx, target, 'core.pattern', buildPattern(doc, target, form, slots(editor)), 'Pattern');
}

export async function featureMirror(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const what = copied(ctx, args);
  const form = newMirrorForm();
  form.of = what.of;
  form.items = what.items;
  form.plane = { ...planeOrAxis(ctx, args.plane, ['face', 'construction'], 'plane'), label: 'Plane' };
  form.operation = oneOf(args, 'operation', ['new', 'join'] as const, form.operation);
  const target = newTarget(editor, what.part, 'Mirror');
  return write(ctx, target, 'core.mirror', buildMirror(doc, target, form, slots(editor)), 'Mirror');
}

export async function featureMove(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const handles = strings(args, 'bodies') as string[];
  const form = newMoveForm();
  form.bodies = picks(ctx, args, 'bodies', ['body']);
  [form.x, form.y, form.z] = vectorArg(args, 'translate', 'mm', ['0 mm', '0 mm', '0 mm']) as [string, string, string];
  form.axis = vectorArg(args, 'rotateAxis', '', ['0', '0', '1']) as [string, string, string];
  form.angle = exprArg(args, 'angle', 'deg', '0 deg');
  form.copy = optBool(args, 'copy') ?? false;
  const target = newTarget(editor, partOfHandles(ctx, handles), 'Move');
  return write(ctx, target, 'core.move', buildMove(editor.document, target, form, slots(editor)), 'Move');
}

export async function featureBoolean(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const tools = strings(args, 'tools') as string[];
  const form = {
    target: picked(ctx, args.target, ['body'], 'target'),
    tools: picks(ctx, args, 'tools', ['body']),
    op: oneOf(args, 'op', ['join', 'cut', 'intersect'] as const, 'join'),
    keepTools: optBool(args, 'keepTools') ?? false,
  };
  const target = newTarget(editor, partOfHandles(ctx, [str(args, 'target'), ...tools]), 'Combine');
  return write(ctx, target, 'core.boolean', buildBoolean(editor.document, target, form, slots(editor)), 'Combine');
}

export async function featureRemoveBody(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const handles = strings(args, 'bodies') as string[];
  const target = newTarget(editor, partOfHandles(ctx, handles), 'Remove');
  return write(
    ctx,
    target,
    'core.removeBody',
    buildRemoveBody(editor.document, target, { bodies: picks(ctx, args, 'bodies', ['body']) }),
    'Remove',
  );
}

export async function featurePrimitive(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const part = partArg(ctx, args.part);
  const shape = oneOf<PrimitiveShape>(args, 'shape', ['box', 'cylinder', 'sphere', 'cone', 'torus'], 'box');
  const form = newPrimitiveForm(shape);
  for (const f of SHAPE_FIELDS[shape])
    form.dims[f.field] = exprArg(args, f.field, 'mm', withDefaultUnit(f.initial, 'mm'));
  [form.x, form.y, form.z] = vectorArg(args, 'position', 'mm', ['0 mm', '0 mm', '0 mm']) as [string, string, string];
  form.operation = oneOf(args, 'operation', OPERATIONS, hasBody(ctx, part) ? 'join' : 'new');
  const target = newTarget(editor, part, SHAPE_NAMES[shape]);
  return write(ctx, target, 'core.primitive', buildPrimitive(doc, target, form, slots(editor)), SHAPE_NAMES[shape]);
}

export async function featureThread(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const faceEntry = entryOf(ctx, args.face, ['face'], 'face');
  const form = newThreadForm();
  form.face = picked(ctx, args.face, ['face'], 'face');
  let designation = optStr(args, 'designation');
  let threadClass = optStr(args, 'threadClass');
  if (designation === undefined || threadClass === undefined) {
    // The size the face's diameter takes, a bore or a shaft, as the thread panel chooses it.
    const display = await settledDisplay(ctx);
    const key = await currentKey(ctx, faceEntry, display);
    const radius = await ctx.client.measure('radius', [key]);
    const axis = (await ctx.client.properties(key))?.measures.axis;
    if (!('value' in radius) || !axis)
      throw invalid(`${faceEntry.handle} is not a cylinder; give \`designation\` and \`threadClass\``);
    const bore = isBore(display, key, radius.value, axis);
    const size = sizeForDiameter(2 * radius.value, bore === true);
    if (!size) throw invalid(`No ISO metric size fits a ${2 * radius.value} mm ${bore ? 'bore' : 'shaft'}`);
    designation ??= size.designation;
    threadClass ??= size.threadClass;
  }
  form.designation = designation;
  form.threadClass = threadClass;
  form.modelled = optBool(args, 'modelled') ?? false;
  form.hand = oneOf(args, 'hand', ['right', 'left'], 'right');
  const target = newTarget(editor, faceEntry.part, 'Thread');
  return write(ctx, target, 'core.thread', buildThread(editor.document, target, form, slots(editor)), 'Thread', {
    designation,
    threadClass,
  });
}

export async function featureConstruction(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const doc = editor.document;
  const kind = oneOf<ConstructionKind>(args, 'kind', ['plane', 'axis', 'point', 'frame'], 'plane');
  const mode = oneOf<ConstructionMode>(args, 'mode', MODES[kind], MODES[kind][0] as ConstructionMode);
  let form = withMode(newConstructionForm(kind), mode);
  const slotsOf = SUPPORTS[mode];
  let part: string;
  if (mode === 'fixed') {
    [form.x, form.y, form.z] = vectorArg(args, 'position', 'mm', ['0 mm', '0 mm', '0 mm']) as [string, string, string];
    part = partArg(ctx, args.part);
  } else {
    const given = strings(args, 'supports') as string[];
    if (given.length !== slotsOf.length)
      throw invalid(`The ${mode} mode takes ${slotsOf.length} supports: ${slotsOf.join(', ')}`);
    form = {
      ...form,
      supports: given.map((s, i) =>
        slotsOf[i] === 'plane'
          ? { ...planeOrAxis(ctx, s, ['face', 'construction'], `supports[${i}]`), label: s }
          : slotsOf[i] === 'line'
            ? { ...planeOrAxis(ctx, s, ['edge', 'curve', 'construction'], `supports[${i}]`), label: s }
            : slotsOf[i] === 'round'
              ? picked(ctx, s, ['face'], `supports[${i}]`)
              : slotsOf[i] === 'center'
                ? picked(ctx, s, ['edge', 'face'], `supports[${i}]`)
                : picked(ctx, s, ['vertex', 'point', 'construction', 'edge'], `supports[${i}]`),
      ),
    };
    const fromHandles = given.filter((s) => ctx.handles.get(s));
    part = fromHandles.length > 0 ? partOfHandles(ctx, fromHandles) : partArg(ctx, args.part);
  }
  form.offset = exprArg(args, 'offset', 'mm', '0 mm');
  form.angle = exprArg(args, 'angle', 'deg', '0 deg');
  form.flip = optBool(args, 'flip') ?? false;
  const target = newTarget(editor, part, CONSTRUCTION_NAMES[kind]);
  return write(
    ctx,
    target,
    CONSTRUCTION_TYPES[kind],
    buildConstruction(doc, target, form, slots(editor)),
    CONSTRUCTION_NAMES[kind],
  );
}

export async function featureFreeze(ctx: AiContext, args: Args): Promise<Json> {
  checkCanEdit(ctx);
  const { editor } = ctx.services;
  const feature = str(args, 'feature');
  if (!findFeature(editor.document, feature))
    throw new ToolError('NOT_FOUND', `There is no feature ${feature} in a part`);
  if (optBool(args, 'frozen') ?? true) {
    // The feature freezes as the newest document builds it.
    await settledDisplay(ctx);
    const r = await freezeFeature(ctx.services, feature);
    if (!r.ok) throw new ToolError('REFUSED', r.message);
  } else check(unfreezeFeature(editor, feature));
  return added(ctx, feature, { frozen: isFrozen(findFeature(editor.document, feature)) });
}
