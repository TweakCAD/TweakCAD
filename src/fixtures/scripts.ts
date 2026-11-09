/**
 * The regression fixtures, each modelled as a user or a model would: CAD
 * tool calls and the app's command helpers (Parameters dialog,
 * configurations, Insert Component, the Joint panel's commands).
 *
 * Fasteners are parametric, their sizes public and chosen by a public
 * `Size` configuration (ISO metric M3 to M12), so they insert as catalogue
 * components with a Size choice. Threads on them are cosmetic, as a model
 * of a fastener usually is; two M6 fixtures cut theirs, in one size.
 */
import { expect } from 'vitest';
import type { Doc, Json } from '@tweakcad/editor';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  parametersOf,
  renameConfigurationRow,
  setActiveConfiguration,
  setConfigurationOverride,
  type ParameterKind,
} from '../app/parameters';
import {
  componentConfigurations,
  embedDocument,
  insertComponentCommands,
  publicParameters,
  rowOverrides,
} from '../app/assembly/library';
import { commitSolved } from '../app/assembly/commit';
import { indicesOf, type JointKind } from '../app/assembly/assembly';
import { jointCommands, jointEnd, newJointForm, type JointEnd } from '../app/assembly/joints';
import { grooveOf, grooveVolume } from '@tweakcad/worker/src/v2/builders/thread';
import type { FixtureSummary } from '@tweakcad/worker/src/v2/fixtureSummary';
import { ISO_METRIC, threadSize } from '@tweakcad/worker/src/v2/threadTable';
import { circleEdge, session, type Kernel, type Session } from './harness';

export interface Fixture {
  name: string;
  /** What it proves, for the fixtures' README. */
  proves: string;
  build(kernel: Kernel): Promise<Doc>;
  /** The pauses it is meant to end on (most: none). */
  pauses?: string[];
  /** Checks on its expectation that do not come from the build itself; `expectationOf` reads another fixture's. */
  check?(summary: FixtureSummary, expectationOf: (name: string) => FixtureSummary): void;
}

// ---- ISO metric sizes ----

const SIZES = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12'] as const;
type Size = (typeof SIZES)[number];
const DEFAULT: Size = 'M6';

/** Per size: nominal diameter, hex across flats (ISO 4017/4032), bolt head height (ISO 4017), nut height (ISO 4032). */
const HEX: Record<Size, { d: number; s: number; k: number; m: number }> = {
  M3: { d: 3, s: 5.5, k: 2, m: 2.4 },
  M4: { d: 4, s: 7, k: 2.8, m: 3.2 },
  M5: { d: 5, s: 8, k: 3.5, m: 4.7 },
  M6: { d: 6, s: 10, k: 4, m: 5.2 },
  M8: { d: 8, s: 13, k: 5.3, m: 6.8 },
  M10: { d: 10, s: 16, k: 6.4, m: 8.4 },
  M12: { d: 12, s: 18, k: 7.5, m: 10.8 },
};
/** Plain washers, ISO 7089: hole, outside diameter, thickness. */
const WASHER: Record<Size, { d1: number; d2: number; h: number }> = {
  M3: { d1: 3.2, d2: 7, h: 0.5 },
  M4: { d1: 4.3, d2: 9, h: 0.8 },
  M5: { d1: 5.3, d2: 10, h: 1 },
  M6: { d1: 6.4, d2: 12, h: 1.6 },
  M8: { d1: 8.4, d2: 16, h: 1.6 },
  M10: { d1: 10.5, d2: 20, h: 2 },
  M12: { d1: 13, d2: 24, h: 2.5 },
};
/** Socket head cap screws, ISO 4762: head diameter, socket across flats, socket depth (head height is d). */
const SOCKET: Record<Size, { dk: number; sk: number; t: number }> = {
  M3: { dk: 5.5, sk: 2.5, t: 1.3 },
  M4: { dk: 7, sk: 3, t: 2 },
  M5: { dk: 8.5, sk: 4, t: 2.5 },
  M6: { dk: 10, sk: 5, t: 3 },
  M8: { dk: 13, sk: 6, t: 4 },
  M10: { dk: 16, sk: 8, t: 5 },
  M12: { dk: 18, sk: 10, t: 6 },
};
/** Medium clearance holes, ISO 273. */
const CLEARANCE: Record<Size, number> = { M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5 };

// ---- helpers ----

type Region = { handle: string; area: number; holes?: string[][] };
type Face = { handle: string; centroid: number[]; area: number };
type Edge = { handle: string; curve: string; center?: number[]; radius?: number; faces: string[] };
type Body = { handle: string; volume: number; min: number[]; max: number[] };

/** Public parameters of the root part, added as the Parameters dialog adds them. */
function parameters(t: Session, rows: Record<string, { kind: ParameterKind; text: string }>): void {
  for (const [name, { kind, text }] of Object.entries(rows)) {
    const r = addParameter(t.s.editor, { part: t.part }, name, kind, text, [], { public: true });
    if (!r.ok) throw new Error(`${name}: ${r.error.message}`);
  }
}

/**
 * A public `Size` configuration of the root part, one row per size, each
 * overriding the parameters `values` gives for it; `active` selected.
 */
function sizeTable(t: Session, values: (size: Size) => Record<string, string>, active: Size = DEFAULT): void {
  const editor = t.s.editor;
  const ok = (r: { ok: boolean; error?: { message: string } }) => {
    if (!r.ok) throw new Error(r.error?.message);
  };
  ok(addConfiguration(editor, t.part));
  const input = configurationsOf(editor.document, t.part)[0]?.input;
  if (!input) throw new Error('no configuration');
  ok(
    editor.dispatch({
      type: 'editParameter',
      parameter: input.id,
      set: { name: 'Size', public: true, description: 'ISO metric size' },
    }),
  );
  const view = () =>
    configurationsOf(editor.document, t.part)[0] as NonNullable<ReturnType<typeof configurationsOf>[number]>;
  ok(renameConfigurationRow(editor, view(), 'Default', SIZES[0]));
  for (const size of SIZES.slice(1)) ok(addConfigurationRow(editor, view(), size));
  const params = parametersOf(editor.document, { part: t.part });
  for (const size of SIZES) {
    for (const [name, text] of Object.entries(values(size))) {
      const p = params.find((x) => x.name === name);
      if (!p) throw new Error(`no parameter ${name}`);
      ok(setConfigurationOverride(editor, t.part, view(), size, p, text));
    }
  }
  ok(setActiveConfiguration(editor, view(), active));
}

async function regions(t: Session, sketch: string): Promise<Region[]> {
  return (await t.call<{ regions: Region[] }>('get_sketch', { sketch })).regions;
}

/** A circle centred on the sketch origin (a point drawn at the origin is held there), its diameter driven by `diameter`; returns its curve id. */
async function centredCircle(t: Session, sketch: string, radius: number, diameter: string): Promise<string> {
  const c = await t.call<{ curve: string; center: string }>('sketch_draw_circle', { sketch, center: [0, 0], radius });
  await t.call('sketch_constrain', { sketch, kind: 'dimension', entities: [c.curve], value: diameter });
  return c.curve;
}

/** A regular hexagon centred on the sketch origin, two sides horizontal, `across` its width across flats. */
async function hexagon(t: Session, sketch: string, flats: number, across: string): Promise<void> {
  const r = flats / Math.sqrt(3);
  const h = await t.call<{ curves: string[]; center: string }>('sketch_draw_polygon', {
    sketch,
    center: [0, 0],
    corner: [r, 0],
    sides: 6,
  });
  await t.call('sketch_constrain', { sketch, kind: 'horizontal', entities: [h.curves[1]] });
  await t.call('sketch_constrain', {
    sketch,
    kind: 'dimension',
    entities: [h.center, h.curves[1]],
    value: `${across} / 2`,
  });
}

async function bodies(t: Session): Promise<Body[]> {
  return (await t.call<{ bodies: Body[] }>('list_bodies')).bodies;
}

async function onlyBody(t: Session): Promise<Body> {
  const all = await bodies(t);
  expect(all).toHaveLength(1);
  return all[0] as Body;
}

/** The planar face of the body facing `normal` farthest along it. */
async function extremeFace(t: Session, body: string, normal: number[]): Promise<Face> {
  const faces = (await t.call<{ faces: Face[] }>('list_faces', { body, normal })).faces;
  const along = (f: Face) => f.centroid.reduce((s, c, i) => s + c * (normal[i] as number), 0);
  const best = [...faces].sort((a, b) => along(b) - along(a))[0];
  if (!best) throw new Error(`no face facing ${JSON.stringify(normal)}`);
  return best;
}

async function edgesOf(t: Session, body: string, face: string, curve?: string): Promise<Edge[]> {
  return (await t.call<{ edges: Edge[] }>('list_edges', { body, face, ...(curve ? { curve } : {}) })).edges;
}

/** The value object of a feature's input at `path` (keys), for binding it to an expression. */
function valueAt(t: Session, feature: string, path: readonly string[]): string {
  const part = ((t.s.editor.document.parts as Json[]) ?? []).find((p) =>
    (p.timeline as Json[]).some((f) => f.id === feature),
  ) as Json;
  let at = ((part.timeline as Json[]).find((f) => f.id === feature) as Json).inputs as Json;
  for (const key of path) at = at[key] as Json;
  return at.id as string;
}

async function cylinderFaces(t: Session, body: string): Promise<(Face & { radius?: number })[]> {
  return (await t.call<{ faces: (Face & { radius?: number })[] }>('list_faces', { body, surface: 'cylinder' })).faces;
}

/** A thread on the shaft face of diameter `d`, cosmetic unless `modelled`, its designation bound to the part's `thread` parameter. */
async function shaftThread(t: Session, body: string, d: number, modelled = false): Promise<void> {
  const shaft = (await cylinderFaces(t, body)).find((f) => Math.abs((f.radius ?? 0) - d / 2) < 1e-6);
  if (!shaft) throw new Error('no shaft face');
  const made = await t.call<{ feature: string; status: string }>('feature_thread', {
    face: shaft.handle,
    designation: `M${d}`,
    threadClass: '6g',
    modelled,
  });
  expect(made.status).toBe('ok');
  await t.call('set_value', { value: valueAt(t, made.feature, ['designation']), expression: 'thread' });
}

const done = (t: Session): Doc => structuredClone(t.s.editor.document);

// ---- fasteners ----

async function washer(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Plain washer ISO 7089', 101);
  const w = WASHER[DEFAULT];
  parameters(t, {
    d1: { kind: 'length', text: `${w.d1}` },
    d2: { kind: 'length', text: `${w.d2}` },
    h: { kind: 'length', text: `${w.h}` },
  });
  const { sketch } = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await centredCircle(t, sketch, w.d2 / 2, 'd2');
  const inner = await t.call<{ curve: string; center: string }>('sketch_draw_circle', {
    sketch,
    center: [0, 0],
    radius: w.d1 / 2,
  });
  await t.call('sketch_constrain', { sketch, kind: 'dimension', entities: [inner.curve], value: 'd1' });
  const ring = (await regions(t, sketch)).find((r) => (r.holes ?? []).length === 1) as Region;
  const made = await t.call<{ status: string }>('feature_extrude', { sketch, profiles: [ring.handle], distance: 'h' });
  expect(made.status).toBe('ok');
  sizeTable(t, (s) => ({ d1: `${WASHER[s].d1}`, d2: `${WASHER[s].d2}`, h: `${WASHER[s].h}` }));
  return done(t);
}

/** A hex prism from z 0 up by `height`, `sw` across flats. */
async function hexPrism(t: Session, flats: number, height: string): Promise<void> {
  const { sketch } = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await hexagon(t, sketch, flats, 'sw');
  const made = await t.call<{ status: string }>('feature_extrude', { sketch, distance: height });
  expect(made.status).toBe('ok');
}

/** A round shank of diameter `d` from z 0 down by `L`, joined. */
async function shank(t: Session, d: number): Promise<void> {
  const { sketch } = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await centredCircle(t, sketch, d / 2, 'd');
  const made = await t.call<{ status: string }>('feature_extrude', {
    sketch,
    distance: 'L',
    reversed: true,
    operation: 'join',
  });
  expect(made.status).toBe('ok');
}

/** Chamfers the round edge of the shank's end at `z`. */
async function tipChamfer(t: Session, body: string, size: string): Promise<void> {
  const end = await extremeFace(t, body, [0, 0, -1]);
  const [edge] = await edgesOf(t, body, end.handle, 'circle');
  const made = await t.call<{ status: string }>('feature_chamfer', { edges: [edge?.handle], distance: size });
  expect(made.status).toBe('ok');
}

/** With `modelled` the thread is cut, and the bolt comes in one size: a Size table would rebuild it seven times over in the regression run. */
async function hexBolt(kernel: Kernel, modelled = false): Promise<Doc> {
  const t = modelled
    ? await session(kernel, 'Hex bolt ISO 4017, modelled thread', 122)
    : await session(kernel, 'Hex bolt ISO 4017', 102);
  const h = HEX[DEFAULT];
  parameters(t, {
    d: { kind: 'length', text: `${h.d}` },
    sw: { kind: 'length', text: `${h.s}` },
    k: { kind: 'length', text: `${h.k}` },
    L: { kind: 'length', text: '30' },
    thread: { kind: 'text', text: DEFAULT },
  });
  await hexPrism(t, h.s, 'k');
  await shank(t, h.d);
  const body = (await onlyBody(t)).handle;
  // The head's top edges chamfered, as the bearing face's 30° chamfer is drawn on a simple bolt.
  const top = await extremeFace(t, body, [0, 0, 1]);
  const lines = await edgesOf(t, body, top.handle, 'line');
  expect(lines).toHaveLength(6);
  expect(
    (await t.call<{ status: string }>('feature_chamfer', { edges: lines.map((e) => e.handle), distance: '0.1 * d' }))
      .status,
  ).toBe('ok');
  await tipChamfer(t, body, '0.1 * d');
  await shaftThread(t, body, h.d, modelled);
  if (!modelled) sizeTable(t, (s) => ({ d: `${HEX[s].d}`, sw: `${HEX[s].s}`, k: `${HEX[s].k}`, thread: s }));
  return done(t);
}

/** With `modelled` the thread is cut, and the nut comes in one size, as the bolt does. */
async function hexNut(kernel: Kernel, modelled = false): Promise<Doc> {
  const t = modelled
    ? await session(kernel, 'Hex nut ISO 4032, modelled thread', 123)
    : await session(kernel, 'Hex nut ISO 4032', 103);
  const h = HEX[DEFAULT];
  parameters(t, {
    d: { kind: 'length', text: `${h.d}` },
    sw: { kind: 'length', text: `${h.s}` },
    mh: { kind: 'length', text: `${h.m}` },
    thread: { kind: 'text', text: DEFAULT },
  });
  await hexPrism(t, h.s, 'mh');
  const body = (await onlyBody(t)).handle;
  const top = await extremeFace(t, body, [0, 0, 1]);
  const hole = await t.call<{ feature: string; status: string }>('feature_hole', {
    face: top.handle,
    positions: [[0, 0]],
    diameter: 'd',
    throughAll: true,
    thread: DEFAULT,
    modelled,
  });
  expect(hole.status).toBe('ok');
  await t.call('set_value', {
    value: valueAt(t, hole.feature, ['thread', 'thread', 'designation']),
    expression: 'thread',
  });
  // Both faces' outer edges chamfered.
  const bottom = await extremeFace(t, body, [0, 0, -1]);
  const outer = [
    ...(await edgesOf(t, body, (await extremeFace(t, body, [0, 0, 1])).handle, 'line')),
    ...(await edgesOf(t, body, bottom.handle, 'line')),
  ];
  expect(outer).toHaveLength(12);
  expect(
    (await t.call<{ status: string }>('feature_chamfer', { edges: outer.map((e) => e.handle), distance: '0.1 * d' }))
      .status,
  ).toBe('ok');
  if (!modelled) sizeTable(t, (s) => ({ d: `${HEX[s].d}`, sw: `${HEX[s].s}`, mh: `${HEX[s].m}`, thread: s }));
  return done(t);
}

async function socketScrew(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Socket head cap screw ISO 4762', 104);
  const h = SOCKET[DEFAULT];
  const d = HEX[DEFAULT].d;
  parameters(t, {
    d: { kind: 'length', text: `${d}` },
    dk: { kind: 'length', text: `${h.dk}` },
    sw: { kind: 'length', text: `${h.sk}` },
    t: { kind: 'length', text: `${h.t}` },
    L: { kind: 'length', text: '25' },
    thread: { kind: 'text', text: DEFAULT },
  });
  // The head: a cylinder dk across and d tall, from z 0 up.
  const head = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await centredCircle(t, head.sketch, h.dk / 2, 'dk');
  expect((await t.call<{ status: string }>('feature_extrude', { sketch: head.sketch, distance: 'd' })).status).toBe(
    'ok',
  );
  await shank(t, d);
  const body = (await onlyBody(t)).handle;
  // The hex socket, sketched on the head's top and cut t deep.
  const top = await extremeFace(t, body, [0, 0, 1]);
  const socket = await t.call<{ sketch: string }>('sketch_create', { on: top.handle });
  await hexagon(t, socket.sketch, h.sk, 'sw');
  const hex = (await regions(t, socket.sketch))[0] as Region;
  expect(
    (
      await t.call<{ status: string }>('feature_extrude', {
        sketch: socket.sketch,
        profiles: [hex.handle],
        distance: 't',
        reversed: true,
        operation: 'cut',
      })
    ).status,
  ).toBe('ok');
  // The head's top rim rounded.
  const rim = (await edgesOf(t, body, (await extremeFace(t, body, [0, 0, 1])).handle, 'circle')).find(
    (e) => Math.abs((e.radius ?? 0) - h.dk / 2) < 1e-6,
  );
  expect(
    (await t.call<{ status: string }>('feature_fillet', { edges: [rim?.handle], radius: '0.08 * d' })).status,
  ).toBe('ok');
  await tipChamfer(t, body, '0.1 * d');
  await shaftThread(t, body, d);
  sizeTable(t, (s) => ({
    d: `${HEX[s].d}`,
    dk: `${SOCKET[s].dk}`,
    sw: `${SOCKET[s].sk}`,
    t: `${SOCKET[s].t}`,
    thread: s,
  }));
  return done(t);
}

/** A rod `d` across and `L` long from z 0 up, chamfered at both ends; threaded along its length when `threaded`. */
async function rod(kernel: Kernel, name: string, seed: number, threaded: boolean): Promise<Doc> {
  const t = await session(kernel, name, seed);
  const d = HEX[DEFAULT].d;
  parameters(t, {
    d: { kind: 'length', text: `${d}` },
    L: { kind: 'length', text: threaded ? '40' : '20' },
    ...(threaded ? { thread: { kind: 'text' as const, text: DEFAULT } } : {}),
  });
  const { sketch } = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await centredCircle(t, sketch, d / 2, 'd');
  expect((await t.call<{ status: string }>('feature_extrude', { sketch, distance: 'L' })).status).toBe('ok');
  const body = (await onlyBody(t)).handle;
  const ends = [await extremeFace(t, body, [0, 0, 1]), await extremeFace(t, body, [0, 0, -1])];
  const rims = (await Promise.all(ends.map((f) => edgesOf(t, body, f.handle, 'circle')))).flat();
  expect(
    (await t.call<{ status: string }>('feature_chamfer', { edges: rims.map((e) => e.handle), distance: '0.1 * d' }))
      .status,
  ).toBe('ok');
  if (threaded) await shaftThread(t, body, d);
  sizeTable(t, (s) => ({ d: `${HEX[s].d}`, ...(threaded ? { thread: s } : {}) }));
  return done(t);
}

async function standoff(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Hex standoff', 107);
  const h = HEX[DEFAULT];
  parameters(t, {
    d: { kind: 'length', text: `${h.d}` },
    sw: { kind: 'length', text: `${h.s}` },
    L: { kind: 'length', text: '20' },
    thread: { kind: 'text', text: DEFAULT },
  });
  await hexPrism(t, h.s, 'L');
  const body = (await onlyBody(t)).handle;
  const top = await extremeFace(t, body, [0, 0, 1]);
  const hole = await t.call<{ feature: string; status: string }>('feature_hole', {
    face: top.handle,
    positions: [[0, 0]],
    diameter: 'd',
    throughAll: true,
    thread: DEFAULT,
  });
  expect(hole.status).toBe('ok');
  await t.call('set_value', {
    value: valueAt(t, hole.feature, ['thread', 'thread', 'designation']),
    expression: 'thread',
  });
  sizeTable(t, (s) => ({ d: `${HEX[s].d}`, sw: `${HEX[s].s}`, thread: s }));
  return done(t);
}

/**
 * An 80 × 50 × 8 plate: four M6 clearance holes at the corners, a row of
 * three tapped M6 holes (a feature pattern of one), a counterbore and a
 * countersink.
 */
async function holePlate(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Plate with hole pattern', 108);
  parameters(t, {
    W: { kind: 'length', text: '80' },
    D: { kind: 'length', text: '50' },
    T: { kind: 'length', text: '8' },
  });
  const { sketch } = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  const r = await t.call<{ curves: string[]; points: string[] }>('sketch_draw_rectangle', {
    sketch,
    from: [0, 0],
    to: [80, 50],
  });
  await t.call('sketch_constrain', { sketch, kind: 'dimension', entities: [r.curves[0]], value: 'W' });
  await t.call('sketch_constrain', { sketch, kind: 'dimension', entities: [r.curves[1]], value: 'D' });
  expect((await t.call<{ status: string }>('feature_extrude', { sketch, distance: 'T' })).status).toBe('ok');
  const body = (await onlyBody(t)).handle;
  const top = (await extremeFace(t, body, [0, 0, 1])).handle;
  const clear = await t.call<{ status: string }>('feature_hole', {
    face: top,
    positions: [
      [8, 8],
      [72, 8],
      [8, 42],
      [72, 42],
    ],
    diameter: CLEARANCE.M6,
    throughAll: true,
  });
  expect(clear.status).toBe('ok');
  const tapped = await t.call<{ feature: string; status: string }>('feature_hole', {
    face: top,
    positions: [[25, 25]],
    diameter: 6,
    depth: 12,
    tipAngle: 118,
    thread: 'M6',
  });
  // Deeper than the plate: it runs through, as a through tapped hole.
  expect(tapped.status).toBe('ok');
  const row = await t.call<{ status: string }>('feature_pattern', {
    features: [tapped.feature],
    layout: 'linear',
    direction: 'x',
    count: 3,
    spacing: 15,
  });
  expect(row.status).toBe('ok');
  const cb = await t.call<{ status: string }>('feature_hole', {
    face: top,
    positions: [[40, 10]],
    kind: 'counterbore',
    diameter: CLEARANCE.M6,
    counterboreDiameter: 11,
    counterboreDepth: 6.5,
    throughAll: true,
  });
  expect(cb.status).toBe('ok');
  const cs = await t.call<{ status: string }>('feature_hole', {
    face: top,
    positions: [[40, 40]],
    kind: 'countersink',
    diameter: CLEARANCE.M6,
    countersinkDiameter: 12,
    countersinkAngle: 90,
    throughAll: true,
  });
  expect(cs.status).toBe('ok');
  return done(t);
}

// ---- the assembly ----

const built = new Map<string, Promise<Doc>>();
function component(name: string, kernel: Kernel): Promise<Doc> {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  if (!built.has(name)) built.set(name, f.build(kernel));
  return built.get(name) as Promise<Doc>;
}

/** Inserts a component into the assembly as Insert Component does, its Size row chosen; returns the instance id. */
async function insert(
  t: Session,
  assembly: string,
  doc: Doc,
  name: string,
  size: Size | null,
  grounded = false,
): Promise<string> {
  const editor = t.s.editor;
  const embedded = embedDocument(doc, name, editor.newId('lib'), { local: {} });
  const configurations = componentConfigurations(doc, publicParameters(doc));
  const rows = size ? Object.fromEntries(configurations.map((c) => [c.input.id, size])) : {};
  const commands = insertComponentCommands(editor, embedded, { assembly }, rowOverrides(configurations, rows));
  const written = await commitSolved(t.s, `Insert ${name}`, commands);
  if (!written.ok) throw new Error(written.message);
  const instances =
    (((editor.document.assemblies as Json[]).find((a) => a.id === assembly) as Json).instances as Json[]) ?? [];
  const id = instances[instances.length - 1]?.id as string;
  if (grounded) await t.call('assembly_set_instance', { assembly, instance: id, grounded: true });
  return id;
}

/** The joint end on a round edge of an instance, as a click on that edge in the Joint panel makes it. */
async function roundEdge(
  t: Session,
  assembly: string,
  instance: string,
  centre: number[],
  radius: number,
): Promise<JointEnd> {
  const display = await t.display();
  const index = indicesOf(display, assembly, instance)[0] as number;
  const definition = display.assemblies.find((a) => a.id === assembly)?.instances[index]?.definition as number;
  const key = await circleEdge(t.s, display, definition, centre, radius);
  const end = await jointEnd(t.s, { key, instance: { assembly, index } }, instance);
  if ('problem' in end) throw new Error(end.problem);
  return end;
}

async function joint(t: Session, assembly: string, kind: JointKind, a: JointEnd, b: JointEnd): Promise<void> {
  const form = { ...newJointForm(), kind, a, b };
  const made = jointCommands(t.s.editor, assembly, form);
  if (!made.ok) throw new Error(made.message);
  const written = await commitSolved(t.s, 'Add joint', made.commands);
  if (!written.ok) throw new Error(written.message);
}

/**
 * The plate with an M6 bolt through a corner clearance hole: a washer
 * under the head and a nut below the plate, each a component of the
 * fixtures inserted with its Size row; an M5 socket screw in the counterbore; a
 * standoff on a tapped hole. The document's own part derives the plate
 * component and adds a boss on it.
 */
async function boltedJoint(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Bolted joint', 109);
  const editor = t.s.editor;
  editor.dispatch({ type: 'renamePart', part: t.part, name: 'Bracket' });
  const asm = (await t.call<{ assembly: string }>('assembly_create', { name: 'Bolted joint', root: true })).assembly;
  const plate = await insert(t, asm, await component('plate-hole-pattern', kernel), 'Plate', null, true);
  const washerId = await insert(t, asm, await component('washer-iso7089', kernel), 'Washer', 'M6');
  const bolt = await insert(t, asm, await component('hex-bolt-iso4017', kernel), 'Bolt', 'M6');
  const nut = await insert(t, asm, await component('hex-nut-iso4032', kernel), 'Nut', 'M6');
  const screw = await insert(t, asm, await component('socket-screw-iso4762', kernel), 'Screw', 'M5');
  const spacer = await insert(t, asm, await component('hex-standoff', kernel), 'Standoff', 'M6');
  const c = CLEARANCE.M6 / 2;
  // The washer sits on the plate's top round the hole at (8, 8); the bolt's head on the washer.
  await joint(
    t,
    asm,
    'rigid',
    await roundEdge(t, asm, plate, [8, 8, 8], c),
    await roundEdge(t, asm, washerId, [0, 0, 0], WASHER.M6.d1 / 2),
  );
  await joint(
    t,
    asm,
    'revolute',
    await roundEdge(t, asm, washerId, [0, 0, WASHER.M6.h], WASHER.M6.d1 / 2),
    await roundEdge(t, asm, bolt, [0, 0, 0], HEX.M6.d / 2),
  );
  // The nut under the plate, on the hole's lower rim; its top face against the plate.
  await joint(
    t,
    asm,
    'cylindrical',
    await roundEdge(t, asm, plate, [8, 8, 0], c),
    await roundEdge(t, asm, nut, [0, 0, HEX.M6.m], 2.5),
  );
  // The M5 screw stands on the counterbore's floor, the standoff on the tapped hole at (25, 25).
  await joint(
    t,
    asm,
    'revolute',
    await roundEdge(t, asm, plate, [40, 10, 1.5], 5.5),
    await roundEdge(t, asm, screw, [0, 0, 0], HEX.M5.d / 2),
  );
  await joint(
    t,
    asm,
    'rigid',
    await roundEdge(t, asm, plate, [25, 25, 8], 2.5),
    await roundEdge(t, asm, spacer, [0, 0, 0], 2.5),
  );
  // The part derives the plate and adds a boss on its top.
  const libPlate = ((editor.document.library as Json[]).find((e) => e.name === 'Plate') as Json).id as string;
  expect((await t.call<{ status: string }>('feature_derive', { part: t.part, fromComponent: libPlate })).status).toBe(
    'ok',
  );
  const derived = (await onlyBody(t)).handle;
  const top = await extremeFace(t, derived, [0, 0, 1]);
  const boss = await t.call<{ sketch: string }>('sketch_create', { on: top.handle, part: t.part });
  await t.call('sketch_draw_rectangle', { sketch: boss.sketch, from: [50, 20], to: [70, 30] });
  expect(
    (await t.call<{ status: string }>('feature_extrude', { sketch: boss.sketch, distance: 10, operation: 'join' }))
      .status,
  ).toBe('ok');
  return done(t);
}

// ---- one document per feature family ----

const ok = async (p: Promise<{ status: string }>) => expect((await p).status).toBe('ok');

/** Bodies made since `before`, by handle. */
const newest = (before: readonly Body[], after: readonly Body[]) =>
  after.filter((b) => !before.some((x) => x.handle === b.handle));

/**
 * Extrude extents and operations on a 60 × 40 × 10 plate: a roof started
 * 30 mm up (start offset), posts up to the roof's underside (to a face)
 * and up to the next face, a hole cut through all from the roof, a tapered
 * boss, a cylinder of two sides, and a block intersected with it.
 */
async function extrudes(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Extrude variants', 201);
  const plate = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_rectangle', { sketch: plate.sketch, from: [0, 0], to: [60, 40] });
  await ok(t.call('feature_extrude', { sketch: plate.sketch, distance: 10, operation: 'new' }));
  const roof = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_rectangle', { sketch: roof.sketch, from: [0, 0], to: [60, 40] });
  await ok(t.call('feature_extrude', { sketch: roof.sketch, distance: 5, startOffset: 30, operation: 'new' }));
  const [plateBody, roofBody] = [...(await bodies(t))].sort((a, b) => (a.min[2] as number) - (b.min[2] as number)) as [
    Body,
    Body,
  ];
  const plateTop = (await extremeFace(t, plateBody.handle, [0, 0, 1])).handle;
  const roofUnder = (await extremeFace(t, roofBody.handle, [0, 0, -1])).handle;
  const post = await t.call<{ sketch: string }>('sketch_create', { on: plateTop });
  await t.call('sketch_draw_rectangle', { sketch: post.sketch, from: [5, 5], to: [10, 10] });
  await ok(t.call('feature_extrude', { sketch: post.sketch, extent: 'toFace', face: roofUnder, operation: 'new' }));
  const next = await t.call<{ sketch: string }>('sketch_create', { on: plateTop });
  await t.call('sketch_draw_rectangle', { sketch: next.sketch, from: [50, 30], to: [55, 35] });
  await ok(t.call('feature_extrude', { sketch: next.sketch, extent: 'upToNext', operation: 'new' }));
  const roofTop = (await extremeFace(t, roofBody.handle, [0, 0, 1])).handle;
  const drill = await t.call<{ sketch: string }>('sketch_create', { on: roofTop });
  await t.call('sketch_draw_circle', { sketch: drill.sketch, center: [30, 20], radius: 4 });
  await ok(t.call('feature_extrude', { sketch: drill.sketch, extent: 'throughAll', reversed: true, operation: 'cut' }));
  const boss = await t.call<{ sketch: string }>('sketch_create', { on: plateTop });
  await t.call('sketch_draw_rectangle', { sketch: boss.sketch, from: [40, 5], to: [55, 15] });
  await ok(t.call('feature_extrude', { sketch: boss.sketch, distance: 8, taper: -5, operation: 'join' }));
  const pin = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_circle', { sketch: pin.sketch, center: [80, 20], radius: 5 });
  const before = await bodies(t);
  await ok(
    t.call('feature_extrude', { sketch: pin.sketch, extent: 'twoSides', distance: 10, second: 4, operation: 'new' }),
  );
  const [cylinder] = newest(before, await bodies(t)) as [Body];
  const cap = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_rectangle', { sketch: cap.sketch, from: [72, 12], to: [82, 28] });
  await ok(
    t.call('feature_extrude', {
      sketch: cap.sketch,
      extent: 'symmetric',
      distance: 6,
      operation: 'intersect',
      targets: [cylinder.handle],
    }),
  );
  return done(t);
}

/** Revolves about the Z axis: a ring by an angle, a symmetric one, one of two sides, and a groove turned into a shaft. */
async function revolves(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Revolve variants', 202);
  // On the XZ plane sketch y is world −Z.
  const ring = await t.call<{ sketch: string }>('sketch_create', { on: 'xz' });
  await t.call('sketch_draw_rectangle', { sketch: ring.sketch, from: [10, 0], to: [20, -5] });
  await ok(t.call('feature_revolve', { sketch: ring.sketch, axis: 'z', angle: 270, operation: 'new' }));
  const sym = await t.call<{ sketch: string }>('sketch_create', { on: 'xz' });
  await t.call('sketch_draw_rectangle', { sketch: sym.sketch, from: [10, -10], to: [20, -15] });
  await ok(
    t.call('feature_revolve', { sketch: sym.sketch, axis: 'z', extent: 'symmetric', angle: 90, operation: 'new' }),
  );
  const two = await t.call<{ sketch: string }>('sketch_create', { on: 'xz' });
  await t.call('sketch_draw_rectangle', { sketch: two.sketch, from: [10, -20], to: [20, -25] });
  await ok(
    t.call('feature_revolve', {
      sketch: two.sketch,
      axis: 'z',
      extent: 'twoSides',
      angle: 60,
      second: 30,
      operation: 'new',
    }),
  );
  // A shaft along Z at x = 50, and a V groove turned into it about its own axis (a sketch line).
  const shaftSketch = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_circle', { sketch: shaftSketch.sketch, center: [50, 0], radius: 6 });
  await ok(t.call('feature_extrude', { sketch: shaftSketch.sketch, distance: 30, operation: 'new' }));
  const groove = await t.call<{ sketch: string }>('sketch_create', { on: 'xz' });
  const axisLine = await t.call<{ curves: string[] }>('sketch_draw_line', {
    sketch: groove.sketch,
    points: [
      [50, 0],
      [50, -30],
    ],
    construction: true,
  });
  await t.call('sketch_draw_line', {
    sketch: groove.sketch,
    points: [
      [57, -12],
      [54, -15],
      [57, -18],
    ],
    closed: true,
  });
  const sketch = await t.call<{ curves: { id: string; handle?: string }[] }>('get_sketch', { sketch: groove.sketch });
  const line = sketch.curves.find((c) => c.id === axisLine.curves[0])?.handle ?? axisLine.curves[0];
  await ok(t.call('feature_revolve', { sketch: groove.sketch, axis: line, angle: 359, operation: 'cut' }));
  return done(t);
}

/** Blends and shells on boxes: fillets, chamfers of each size kind, a shell inward and one outward. */
async function blends(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Fillet chamfer shell', 203);
  const made: Body[] = [];
  for (const x of [0, 40, 80, 120]) {
    const before = await bodies(t);
    await ok(
      t.call('feature_primitive', {
        shape: 'box',
        width: 30,
        depth: 20,
        height: 15,
        position: [x, 0, 7.5],
        operation: 'new',
      }),
    );
    made.push(...newest(before, await bodies(t)));
  }
  const [a, b, c, d] = made as [Body, Body, Body, Body];
  const vertical = async (body: Body) =>
    (await t.call<{ edges: Edge[] }>('list_edges', { body: body.handle, parallel: [0, 0, 1] })).edges.map(
      (e) => e.handle,
    );
  await ok(t.call('feature_fillet', { edges: await vertical(a), radius: 3 }));
  await ok(
    t.call('feature_chamfer', { edges: [(await extremeFace(t, b.handle, [0, 0, 1])).handle], distance: 2, second: 1 }),
  );
  await ok(t.call('feature_chamfer', { edges: await vertical(b), distance: 2, angle: 30 }));
  await ok(t.call('feature_shell', { faces: [(await extremeFace(t, c.handle, [0, 0, 1])).handle], thickness: 2 }));
  await ok(
    t.call('feature_shell', {
      faces: [(await extremeFace(t, d.handle, [0, 0, 1])).handle],
      thickness: 1.5,
      direction: 'outside',
    }),
  );
  return done(t);
}

/**
 * Copies: a peg patterned in two directions, a hub's spoke patterned round
 * Z, a mirror of bodies and of a feature, a moved copy, booleans and a
 * removed body.
 */
async function copies(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Patterns mirrors moves', 204);
  const make = async (input: Json): Promise<Body> => {
    const before = await bodies(t);
    await ok(t.call('feature_primitive', { ...input, operation: 'new' }));
    return newest(before, await bodies(t))[0] as Body;
  };
  const peg = await make({ shape: 'cylinder', radius: 2, height: 6, position: [-60, 0, 3] });
  await ok(
    t.call('feature_pattern', {
      bodies: [peg.handle],
      layout: 'linear',
      direction: 'x',
      count: 3,
      spacing: 10,
      direction2: 'y',
      count2: 2,
      spacing2: 8,
      operation: 'new',
    }),
  );
  // The hub on the Z axis, its spoke turned round a construction axis along Z.
  const spoke = await make({ shape: 'box', width: 12, depth: 3, height: 3, position: [10, 0, 1.5] });
  await make({ shape: 'cylinder', radius: 3, height: 3, position: [0, 0, 1.5] });
  const hubAxis = await t.call<{ feature: string }>('feature_construction', {
    kind: 'axis',
    mode: 'alongLine',
    supports: ['z'],
  });
  const axes = await t.call<{ construction: { handle: string; kind: string; feature?: string }[] }>(
    'list_construction',
  );
  const axisHandle = axes.construction.find((c) => c.kind === 'axis' && c.feature === hubAxis.feature)?.handle;
  await ok(
    t.call('feature_pattern', {
      bodies: [spoke.handle],
      layout: 'circular',
      axis: axisHandle,
      count: 6,
      angle: 360,
      operation: 'new',
    }),
  );
  const block = await make({ shape: 'box', width: 10, depth: 10, height: 10, position: [0, 40, 5] });
  await ok(t.call('feature_mirror', { bodies: [block.handle], plane: 'xz', operation: 'new' }));
  // A pocket cut into the block, mirrored as a feature into the block's other half.
  const top = (await extremeFace(t, block.handle, [0, 0, 1])).handle;
  const pocket = await t.call<{ sketch: string }>('sketch_create', { on: top });
  await t.call('sketch_draw_rectangle', { sketch: pocket.sketch, from: [-4, 36], to: [-1, 44] });
  const cut = await t.call<{ feature: string; status: string }>('feature_extrude', {
    sketch: pocket.sketch,
    distance: 4,
    reversed: true,
    operation: 'cut',
    targets: [block.handle],
  });
  expect(cut.status).toBe('ok');
  const mid = await t.call<{ feature: string }>('feature_construction', {
    kind: 'plane',
    mode: 'plane',
    supports: ['yz'],
  });
  const planes = await t.call<{ construction: { handle: string; kind: string; feature?: string }[] }>(
    'list_construction',
  );
  const plane = planes.construction.find((c) => c.kind === 'plane' && c.feature === mid.feature)?.handle;
  await ok(t.call('feature_mirror', { features: [cut.feature], plane }));
  const sphere = await make({ shape: 'sphere', radius: 4, position: [100, 0, 4] });
  await ok(
    t.call('feature_move', {
      bodies: [sphere.handle],
      translate: [0, 15, 0],
      rotateAxis: [0, 0, 1],
      angle: 30,
      copy: true,
    }),
  );
  const slab = await make({ shape: 'box', width: 20, depth: 20, height: 4, position: [100, 40, 2] });
  const drill = await make({ shape: 'cylinder', radius: 3, height: 10, position: [100, 40, 2] });
  await ok(t.call('feature_boolean', { target: slab.handle, tools: [drill.handle], op: 'cut' }));
  const lump = await make({ shape: 'box', width: 6, depth: 6, height: 6, position: [108, 48, 5] });
  await ok(t.call('feature_boolean', { target: slab.handle, tools: [lump.handle], op: 'join' }));
  const spare = await make({ shape: 'torus', majorRadius: 6, minorRadius: 1.5, position: [140, 0, 1.5] });
  await ok(t.call('feature_remove_body', { bodies: [spare.handle] }));
  return done(t);
}

/**
 * Primitives of every built shape, construction geometry of each kind and
 * mode, a sketch on a construction plane, and sketch curves of each kind
 * made into regions and extruded.
 */
async function constructionAndSketches(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Primitives construction sketches', 205);
  await ok(
    t.call('feature_primitive', {
      shape: 'box',
      width: 10,
      depth: 8,
      height: 6,
      position: [0, 0, 3],
      operation: 'new',
    }),
  );
  await ok(
    t.call('feature_primitive', { shape: 'cylinder', radius: 4, height: 10, position: [20, 0, 5], operation: 'new' }),
  );
  await ok(t.call('feature_primitive', { shape: 'sphere', radius: 4, position: [40, 0, 4], operation: 'new' }));
  await ok(
    t.call('feature_primitive', {
      shape: 'cone',
      bottomRadius: 5,
      topRadius: 2,
      height: 8,
      position: [60, 0, 4],
      operation: 'new',
    }),
  );
  await ok(
    t.call('feature_primitive', {
      shape: 'torus',
      majorRadius: 6,
      minorRadius: 2,
      position: [80, 0, 2],
      operation: 'new',
    }),
  );
  await ok(t.call('feature_construction', { kind: 'plane', mode: 'plane', supports: ['xy'], offset: 20 }));
  await ok(t.call('feature_construction', { kind: 'axis', mode: 'alongLine', supports: ['y'] }));
  await ok(t.call('feature_construction', { kind: 'point', mode: 'fixed', position: [5, 5, 5] }));
  await ok(t.call('feature_construction', { kind: 'frame', mode: 'fixed', position: [0, 0, 40] }));
  const raised = (
    await t.call<{ construction: { handle: string; kind: string; frame: { origin: number[] } }[] }>('list_construction')
  ).construction.find((c) => c.kind === 'plane' && Math.abs((c.frame.origin[2] ?? 0) - 20) < 1e-9);
  // On the raised plane: a slot, an ellipse, a closed spline and an arc-and-line outline, each extruded.
  const s = await t.call<{ sketch: string }>('sketch_create', { on: raised?.handle });
  await t.call('sketch_draw_slot', { sketch: s.sketch, from: [0, 30], to: [20, 30], width: 6 });
  await t.call('sketch_draw_ellipse', { sketch: s.sketch, center: [40, 30], majorEnd: [48, 30], minorRadius: 4 });
  await t.call('sketch_draw_spline', {
    sketch: s.sketch,
    points: [
      [60, 26],
      [70, 28],
      [72, 36],
      [62, 38],
    ],
    closed: true,
  });
  const arc = await t.call<{ points: { start: string; end: string } }>('sketch_draw_arc', {
    sketch: s.sketch,
    start: [80, 26],
    end: [90, 26],
    through: [85, 31],
  });
  await t.call('sketch_draw_line', { sketch: s.sketch, points: [arc.points.start, arc.points.end] });
  const regions = await t.call<{ regions: Region[] }>('get_sketch', { sketch: s.sketch });
  expect(regions.regions).toHaveLength(4);
  await ok(
    t.call('feature_extrude', {
      sketch: s.sketch,
      profiles: regions.regions.map((r) => r.handle),
      distance: 3,
      operation: 'new',
    }),
  );
  return done(t);
}

/** A modelled fixture has no cosmetic thread, and its `twin` less an M6 groove on a cylinder of `radius` is what it is. */
function expectGroove(
  s: FixtureSummary,
  twin: FixtureSummary,
  internal: boolean,
  radius: number,
  length: number,
): void {
  const groove = grooveOf(
    {
      standard: ISO_METRIC,
      class: internal ? '6H' : '6g',
      internal,
      size: threadSize(ISO_METRIC, 'M6'),
      modelled: true,
    },
    radius,
    length,
  );
  const removed = (twin.parts[0]?.bodies[0]?.volume as number) - (s.parts[0]?.bodies[0]?.volume as number);
  expect(s.parts[0]?.threads).toEqual([]);
  expect(removed / grooveVolume(groove)).toBeCloseTo(1, 3);
}

/**
 * Joins of walls that are neither planes nor elementary surfaces: an ellipse
 * extruded into a sphere, whose wall the join splits and the face merge
 * rejoins into one face, and a closed spline extruded into a box.
 */
async function curvedJoins(kernel: Kernel): Promise<Doc> {
  const t = await session(kernel, 'Curved walls joined', 206);
  await ok(t.call('feature_primitive', { shape: 'sphere', radius: 10, position: [0, 0, 0], operation: 'new' }));
  const ear = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_ellipse', { sketch: ear.sketch, center: [6, 12], majorEnd: [6, 22], minorRadius: 3.5 });
  await ok(t.call('feature_extrude', { sketch: ear.sketch, extent: 'symmetric', distance: 3, operation: 'join' }));
  await ok(
    t.call('feature_primitive', {
      shape: 'box',
      width: 10,
      depth: 10,
      height: 6,
      position: [40, 0, 3],
      operation: 'new',
    }),
  );
  const lobe = await t.call<{ sketch: string }>('sketch_create', { on: 'xy' });
  await t.call('sketch_draw_spline', {
    sketch: lobe.sketch,
    points: [
      [56, 4],
      [50, 9],
      [43, 6],
      [42, -2],
      [52, -4],
    ],
    closed: true,
  });
  await ok(t.call('feature_extrude', { sketch: lobe.sketch, distance: 6, operation: 'join' }));
  return done(t);
}

export const FIXTURES: Fixture[] = [
  {
    name: 'features-extrude',
    proves:
      'Extrude extents and operations: distance, start offset, to a face, up to the next face, through all (cut, reversed), taper, two sides, symmetric intersect with chosen targets, join and new.',
    build: extrudes,
  },
  {
    name: 'features-revolve',
    proves:
      'Revolve by an angle, symmetric, two sides, about a standard axis and about a construction sketch line, as new bodies and as a cut.',
    build: revolves,
  },
  {
    name: 'features-blends-shell',
    proves: 'Constant fillets, chamfers by two distances and by distance and angle, shells inward and outward.',
    build: blends,
  },
  {
    name: 'features-patterns',
    proves:
      'Linear patterns in two directions, a circular pattern about a construction axis, mirrors of bodies and of a feature about a construction plane, a moved copy, boolean cut and join, a removed body.',
    build: copies,
  },
  {
    name: 'features-primitives-construction-sketch',
    proves:
      'Box, cylinder, sphere, cone and torus primitives; construction plane, axis, point and frame; a sketch on a construction plane with a slot, an ellipse, a closed spline and an arc closed by a line, extruded.',
    build: constructionAndSketches,
  },
  {
    name: 'features-curved-joins',
    proves:
      'An extruded ellipse joined into a sphere keeps its wall one face, the merge rejoining the pieces the join split; a closed spline extruded and joined into a box.',
    build: curvedJoins,
  },
  {
    name: 'washer-iso7089',
    proves:
      'A parametric ring with public sizes and a Size configuration: a region with a hole, concentric circles driven by parameters.',
    build: washer,
    check: (s) => expect(s.parts[0]?.bodies[0]?.volume).toBeCloseTo((Math.PI / 4) * (12 * 12 - 6.4 * 6.4) * 1.6, 3),
  },
  {
    name: 'hex-bolt-iso4017',
    proves:
      'Hex head (polygon sketch, chamfered top edges), joined shank, tip chamfer, a cosmetic M-thread bound to a text parameter, a Size configuration.',
    build: hexBolt,
    check: (s) => expect(s.parts[0]?.threads).toEqual(['M6 6g external']),
  },
  {
    name: 'hex-nut-iso4032',
    proves:
      'Hex prism, a tapped through hole (tap drill, cosmetic thread on the bore), chamfers on both faces, a Size configuration.',
    build: hexNut,
    check: (s) => expect(s.parts[0]?.threads).toEqual(['M6 6H internal']),
  },
  {
    name: 'hex-bolt-iso4017-modelled',
    proves:
      'The M6 hex bolt with its thread cut: the groove stops at the tip chamfer and under the head, and the bolt loses exactly its volume.',
    build: (k) => hexBolt(k, true),
    check: (s, read) => expectGroove(s, read('hex-bolt-iso4017'), false, 3, 30 - 0.6),
  },
  {
    name: 'hex-nut-iso4032-modelled',
    proves:
      'The M6 nut with its thread cut through the tap drill bore, then chamfered on both faces, losing exactly the groove.',
    build: (k) => hexNut(k, true),
    check: (s, read) => expectGroove(s, read('hex-nut-iso4032'), true, 2.5, 5.2),
  },
  {
    name: 'socket-screw-iso4762',
    proves:
      'Round head, hex socket sketched on a face and cut, a filleted rim, shank, tip chamfer, cosmetic thread, a Size configuration.',
    build: socketScrew,
  },
  {
    name: 'threaded-rod',
    proves: 'A rod chamfered at both ends with a full-length cosmetic thread, a Size configuration.',
    build: (k) => rod(k, 'Threaded rod', 105, true),
  },
  {
    name: 'dowel-pin',
    proves: 'A plain pin chamfered at both ends, a Size configuration.',
    build: (k) => rod(k, 'Dowel pin', 106, false),
  },
  {
    name: 'hex-standoff',
    proves: 'A hex standoff with a tapped hole through it, a Size configuration.',
    build: standoff,
  },
  {
    name: 'plate-hole-pattern',
    proves:
      'A plate with clearance holes at four positions, a tapped blind-through hole patterned as a feature, a counterbore and a countersink.',
    build: holePlate,
    check: (s) => expect(s.parts[0]?.threads).toEqual(['M6 6H internal', 'M6 6H internal', 'M6 6H internal']),
  },
  {
    name: 'bolted-joint',
    proves:
      'An assembly of the fastener fixtures as library components, each inserted with a Size row, placed by rigid, revolute and cylindrical joints on round edges; a part deriving the plate component and adding a boss.',
    build: boltedJoint,
  },
];
