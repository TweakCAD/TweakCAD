/**
 * Decoded designs built on the real kernel and solver. Real files can't live
 * in the repository, so each design here is written as the parser's plain data
 * and judged by the solid it builds, in the file's centimetres.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { EvaluationService } from '@tweakcad/worker/src/v2/service/service';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { complete } from './complete';
import { convertDesign, type ImportNote } from './convert';
import { FaceIndex, type BrepSurface } from './parser/brep';
import type {
  F3dDesign,
  F3dDimension,
  F3dExtrude,
  F3dFeature,
  F3dPrimitive,
  F3dLine,
  F3dParameter,
  F3dRelation,
  F3dSketch,
} from './parser/types';
import type { Json } from './writer';
import { asmStream, boxRecords, type BuiltRecord } from './parser/asmBuilder.testHelper';

/** Records of a second body, renumbered to follow a first body's records in one stream. */
function shifted(records: BuiltRecord[], by: number): BuiltRecord[] {
  return records.map((r) => ({
    ...r,
    items: r.items.map((x) => (x.t === 'ref' && x.v >= 0 ? { ...x, v: x.v + by } : x)),
  }));
}

const here = dirname(fileURLToPath(import.meta.url));

let k: OcctKernel;
let gcs: GcsWrapper;
let service: EvaluationService;

beforeAll(async () => {
  k = await OcctKernel.init();
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  service = new EvaluationService(k, gcs);
});
afterAll(() => {
  service.release();
  k.releaseAll();
});

const client = {
  evaluate: (doc: unknown, options?: { meshes?: boolean }) => Promise.resolve(service.evaluate(doc as Json, options)),
  vetSketch: (inputs: unknown) => Promise.resolve(service.vetSketch(inputs as Json)),
  vetSketches: (doc: unknown, features: string[]) => Promise.resolve(service.vetSketches(doc as Json, features)),
  locateOnSurfaces: (
    part: string,
    before: string | undefined,
    pairs: Parameters<EvaluationService['locateOnSurfaces']>[2],
  ) => Promise.resolve(service.locateOnSurfaces(part, before, [...pairs])),
  bodiesMadeBy: (part: string, before: string | undefined, features: string[]) =>
    Promise.resolve(service.bodiesMadeBy(part, before, features)),
  locateFacesOnSurfaces: (
    part: string,
    before: string | undefined,
    surfaces: Parameters<EvaluationService['locateFacesOnSurfaces']>[2],
  ) => Promise.resolve(service.locateFacesOnSurfaces(part, before, [...surfaces])),
  importFile: (bytes: Uint8Array, format: 'step', name: string) =>
    Promise.resolve(service.importFile(bytes, format, name)),
};

const SKETCH = 1;
/** Operation ids, by the record they lead to. */
const OPS = new Map([
  [301, 100],
  [302, 110],
]);
/** A 2 × 1 cm rectangle from the origin: points 10–13, lines 20–23. */
function rectangle(
  o: { placement?: number[] | null; relations?: F3dRelation[]; dimensions?: F3dDimension[] } = {},
): F3dSketch {
  const at: [number, number][] = [
    [0, 0],
    [2, 0],
    [2, 1],
    [0, 1],
  ];
  const lines: F3dLine[] = at.map((_, i) => ({
    kind: 'line',
    id: 20 + i,
    primaryId: 20 + i,
    secondaryId: 0,
    startId: 10 + i,
    endId: 10 + ((i + 1) % 4),
    construction: false,
  }));
  return {
    id: SKETCH,
    name: 'Outline',
    placement: o.placement ?? null,
    componentName: null,
    componentId: null,
    points: new Map(at.map(([x, y], i) => [10 + i, { id: 10 + i, x, y, z: 0 }])),
    curves: lines,
    relations: o.relations ?? [],
    dimensions: o.dimensions ?? [],
    skipped: {},
  };
}

const profile = {
  sketchId: SKETCH,
  regions: [{ curves: [20, 21, 22, 23].map((primary) => ({ primary, secondary: 0 })) }],
};

const parameter = (id: number, value: number, unit = 'cm'): F3dParameter => ({
  id,
  name: `d${id}`,
  role: 'AlongDistance',
  expression: `${value} ${unit}`,
  unit,
  value,
  isUser: false,
  ownerId: null,
});

function extrude(o: Partial<F3dExtrude> = {}): F3dExtrude {
  return {
    kind: 'extrude',
    id: 100,
    operation: 'newBody',
    sides: 'one',
    reversed: false,
    solid: true,
    start: 'plane',
    vector: [0, 0, 1],
    profiles: [profile],
    along: parameter(101, 3),
    against: null,
    side1Offset: null,
    side2Offset: null,
    profileOffset: null,
    taper: null,
    side2Taper: null,
    wall: null,
    faces: [],
    ...o,
  };
}

const design = (sketch: F3dSketch, features: F3dFeature[], faces = new FaceIndex()): F3dDesign => ({
  parameters: [],
  sketches: [sketch],
  features: [{ kind: 'sketch', id: 2, sketchId: SKETCH }, ...features],
  order: [2, ...features.map((f) => f.id)],
  faces,
  leftOut: {},
  storedBodies: new Map(),
  storedShapes: new Map(),
  brep: () => undefined,
  links: [],
  upAxis: null,
  components: [],
  componentOf: new Map(),
  recordOfOp: (op) => OPS.get(Math.abs(op)),
});

/** Bounds of the shown bodies, and their summed volume, in mm. */
function measured(display: Display): { volume: number; min: number[]; max: number[] } {
  let volume = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const body of display.definitions.flatMap((d) => d.bodies)) {
    const m = service.measure('volume', [body.key]);
    if ('value' in m) volume += m.value;
    const p = body.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a] as number, p[i + a] as number);
        max[a] = Math.max(max[a] as number, p[i + a] as number);
      }
    }
  }
  return { volume, min, max };
}

/**
 * A design with features that are not translated: the document reads, every
 * feature has its row in order, and the rows of `f3d.` types are what pauses.
 */
async function kept(
  d: F3dDesign,
): Promise<{ timeline: Json[]; paused: string[]; notes: ImportNote[]; volume: number }> {
  const { document, steps, notes } = convertDesign(d, {
    ids: seededIds(9),
    writer: { app: 'test', version: '0' },
    name: 'plate',
    now: '2026-11-06T00:00:00Z',
  });
  notes.push(...(await complete(document, steps, client)));
  expect(readDocument(document).diagnostics.filter((x) => x.severity === 'refuse')).toEqual([]);
  const display = service.evaluate(document);
  const timeline = ((document.parts as Json[])[0] as Json).timeline as Json[];
  const name = (id: string) => timeline.find((f) => f.id === id)?.name as string;
  return { timeline, paused: display.pauses.map((p) => name(p.feature)), notes, volume: measured(display).volume };
}

/** The row `name` of a timeline, with its type and what it keeps of the file. */
function rowNamed(timeline: Json[], name: string): Json {
  const row = timeline.find((f) => f.name === name);
  if (!row) throw new Error(`no row ${name} in ${timeline.map((f) => f.name).join(', ')}`);
  return row;
}

async function built(
  d: F3dDesign,
): Promise<{ document: Json; display: Display; notes: ImportNote[]; volume: number; min: number[]; max: number[] }> {
  const { document, steps, notes } = convertDesign(d, {
    ids: seededIds(9),
    writer: { app: 'test', version: '0' },
    name: 'plate',
    now: '2026-11-06T00:00:00Z',
  });
  notes.push(...(await complete(document, steps, client)));
  expect(readDocument(document).diagnostics.filter((x) => x.severity === 'refuse')).toEqual([]);
  const display = service.evaluate(document);
  expect(display.pauses.map((p) => p.message)).toEqual([]);
  return { document, display, notes, ...measured(display) };
}

describe('extrudes', { timeout: 60_000 }, () => {
  it('runs along the file vector', async () => {
    const r = await built(design(rectangle(), [extrude()]));
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    expect(r.min[2]).toBeCloseTo(0);
    expect(r.max[2]).toBeCloseTo(30);
  });

  it('runs the other way when the vector opposes the sketch normal', async () => {
    const r = await built(design(rectangle(), [extrude({ vector: [0, 0, -1] })]));
    expect(r.min[2]).toBeCloseTo(-30);
    expect(r.max[2]).toBeCloseTo(0);
  });

  it('turns round for a reversed extrude', async () => {
    const r = await built(design(rectangle(), [extrude({ reversed: true })]));
    expect(r.min[2]).toBeCloseTo(-30);
  });

  it('turns round for a negative distance', async () => {
    const r = await built(design(rectangle(), [extrude({ along: parameter(101, -3) })]));
    expect(r.min[2]).toBeCloseTo(-30);
    expect(r.max[2]).toBeCloseTo(0);
  });

  it('builds two sides', async () => {
    const r = await built(design(rectangle(), [extrude({ sides: 'two', against: parameter(102, 1) })]));
    expect(r.min[2]).toBeCloseTo(-10);
    expect(r.max[2]).toBeCloseTo(30);
  });

  it('reads a symmetric distance as each side', async () => {
    const r = await built(design(rectangle(), [extrude({ sides: 'symmetric' })]));
    expect(r.min[2]).toBeCloseTo(-30);
    expect(r.max[2]).toBeCloseTo(30);
  });

  it('starts at the profile offset', async () => {
    const r = await built(design(rectangle(), [extrude({ start: 'offset', profileOffset: parameter(103, 1) })]));
    expect(r.min[2]).toBeCloseTo(10);
    expect(r.max[2]).toBeCloseTo(40);
  });

  it('keeps the offset above the sketch when the extrude runs down', async () => {
    const r = await built(
      design(rectangle(), [extrude({ start: 'offset', profileOffset: parameter(103, 1), vector: [0, 0, -1] })]),
    );
    expect(r.max[2]).toBeCloseTo(-10);
    expect(r.min[2]).toBeCloseTo(-40);
  });

  it('follows the sketch frame, away from the origin', async () => {
    // Sketch x along model y, sketch y along model z, its origin at x = 5 cm: its normal is model x.
    const r = await built(
      design(rectangle({ placement: [0, 0, 1, 5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1] }), [
        extrude({ vector: [1, 0, 0] }),
      ]),
    );
    expect(r.min).toEqual([expect.closeTo(50), expect.closeTo(0), expect.closeTo(0)]);
    expect(r.max).toEqual([expect.closeTo(80), expect.closeTo(20), expect.closeTo(10)]);
  });

  it('cuts through what is there', async () => {
    const cut = extrude({
      id: 110,
      operation: 'cut',
      profiles: [{ sketchId: SKETCH, regions: profile.regions }],
      along: null,
      vector: [0, 0, 1],
    });
    const hole = { ...rectangle() };
    const r = await built(design(hole, [extrude({ along: parameter(101, 3) }), cut]));
    expect(r.volume).toBeCloseTo(0, 3);
  });

  it('runs through all after a cut took a whole body', async () => {
    const cut = extrude({ id: 110, operation: 'cut', along: null });
    const again = extrude({ id: 120, along: null, operation: 'newBody' });
    const r = await built(design(rectangle(), [extrude(), cut, again]));
    expect(r.max[2]).toBeGreaterThan(0);
  });

  it('keeps a surface extrude in the timeline untranslated, and says so', async () => {
    const r = await kept(design(rectangle(), [extrude({ solid: false })]));
    expect(r.volume).toBe(0);
    const row = rowNamed(r.timeline, 'Extrude 1');
    expect(row.type).toBe('f3d.extrude');
    expect((row.inputs as Json).reason).toBe('surface extrude');
    expect(r.paused).toEqual(['Extrude 1']);
    expect(r.notes).toContainEqual({
      severity: 'warning',
      object: 'Extrude 1',
      message: 'not translated (surface extrude): kept in the timeline, where it and what depends on it pause',
    });
  });

  it('keeps an extrude of no length, with the parameters it owns', async () => {
    const r = await kept(design(rectangle(), [extrude({ along: parameter(101, 0) })]));
    const row = rowNamed(r.timeline, 'Extrude 1');
    expect(row.type).toBe('f3d.extrude');
    expect((row.inputs as Json).reason).toBe('extrude of no length');
    expect(((row.inputs as Json).parameters as Json[]).map((p) => p.role)).toEqual(['AlongDistance']);
  });

  it('keeps a feature with no translation at its place, and what does not depend on it builds', async () => {
    const thicken: F3dFeature = {
      kind: 'unsupported',
      id: 105,
      what: 'thicken',
      parameters: [{ ...parameter(106, 0.2), role: 'Thickness', name: 'd9', expression: '2 mm' }],
    };
    const r = await kept(design(rectangle(), [extrude(), thicken, extrude({ id: 110, operation: 'join' })]));
    expect(r.timeline.map((f) => [f.name, f.type])).toEqual([
      ['Outline', 'core.sketch'],
      ['Extrude 1', 'core.extrude'],
      ['Thicken 1', 'f3d.thicken'],
      ['Extrude 2', 'core.extrude'],
    ]);
    expect((rowNamed(r.timeline, 'Thicken 1').inputs as Json).parameters).toEqual([
      { name: 'd9', role: 'Thickness', expression: '2 mm' },
    ]);
    expect(r.paused).toEqual(['Thicken 1']);
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
  });

  it('builds a second side the other way round when the first has no length', async () => {
    const r = await built(
      design(rectangle(), [extrude({ sides: 'two', along: parameter(101, 0), against: parameter(102, 2) })]),
    );
    expect(r.min[2]).toBeCloseTo(-20);
    expect(r.max[2]).toBeCloseTo(0);
  });

  it('reads an up-to plane parallel to the sketch as a distance', async () => {
    const faces = new FaceIndex();
    const surface: BrepSurface = { kind: 'plane', origin: [0, 0, 4], normal: [0, 0, 1] };
    faces.add([{ tags: [{ token: '1', ops: [7] }], surface }]);
    const r = await built(
      design(
        rectangle(),
        [extrude({ side1Offset: parameter(104, 0), along: null, faces: [{ token: '1', ops: [7] }] })],
        faces,
      ),
    );
    expect(r.max[2]).toBeCloseTo(40);
  });

  it('starts from the face it names, found in the model as built, and follows it when that face moves', async () => {
    // The first extrude's top at z 30 mm; the second starts there and runs 10 mm on.
    const faces = new FaceIndex();
    faces.add([{ tags: [{ token: '1', ops: [7] }], surface: { kind: 'plane', origin: [0, 0, 3], normal: [0, 0, 1] } }]);
    const onTop = extrude({
      id: 110,
      operation: 'join',
      start: 'face',
      along: parameter(105, 1),
      faces: [{ token: '1', ops: [7] }],
    });
    const r = await built(design(rectangle(), [extrude(), onTop], faces));
    expect(r.max[2]).toBeCloseTo(40);
    expect(r.volume).toBeCloseTo(20 * 10 * 40, 3);
    const timeline = ((r.document.parts as Json[])[0] as Json).timeline as Json[];
    const [first, second] = timeline.filter((f) => f.type === 'core.extrude') as [Json, Json];
    const start = (second.inputs as Json).start as Json;
    expect(Object.keys(start)).toEqual(['object']);

    // The first extrude made 20 mm taller: the second still starts on its top.
    const taller = structuredClone(r.document);
    const tall = (((taller.parts as Json[])[0] as Json).timeline as Json[]).find((f) => f.id === first.id) as Json;
    const d = ((((tall.inputs as Json).sides as Json[])[0] as Json).extent as Json).distance as Json;
    ((d.d as Json).def as Json).expr = { text: '50 mm', grammar: 1, refs: {} };
    const after = service.evaluate(taller);
    expect(after.pauses).toEqual([]);
    expect(measured(after).max[2]).toBeCloseTo(60);
  });

  it('stops on a face that is not parallel to the sketch, found in the model as built', async () => {
    // A cylinder of radius 1 cm along X, its axis at y 0.5, z 5: the rectangle rises until it meets its underside.
    const cylinder: F3dPrimitive = {
      kind: 'primitive',
      id: 200,
      shape: 'cylinder',
      operation: 'newBody',
      plane: [0, 0, 1, -1, 1, 0, 0, 0.5, 0, 1, 0, 5, 0, 0, 0, 1],
      onPlane: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      sizes: { Diameter: parameter(300, 2), Height: parameter(301, 4) },
    };
    const faces = new FaceIndex();
    const surface: BrepSurface = { kind: 'cone', origin: [0, 0.5, 5], axis: [1, 0, 0], radius: 1, sine: 0, cosine: 1 };
    faces.add([{ tags: [{ token: '1', ops: [7] }], surface }]);
    const stop = extrude({ side1Offset: parameter(104, 0), along: null, faces: [{ token: '1', ops: [7] }] });
    const r = await built({ ...design(rectangle(), [stop], faces), features: [cylinder, stop], order: [200, 2, 100] });
    // The area under a circle of radius 10 mm across the 10 mm the rectangle spans, about its middle.
    const under = 5 * Math.sqrt(75) + 100 * Math.asin(0.5);
    const cylinderVolume = Math.PI * 10 * 10 * 40;
    expect(r.volume).toBeCloseTo(cylinderVolume + 20 * (50 * 10 - under), 0);
    expect(r.min[2]).toBeCloseTo(0);
  });
});

describe('revolves', { timeout: 60_000 }, () => {
  const revolve = (angle: F3dParameter | null): F3dFeature => ({
    kind: 'revolve',
    id: 100,
    operation: 'newBody',
    profiles: [profile],
    axis: { origin: [0, 0, 0], direction: [0, 1, 0] },
    angle,
  });
  const quarter = (value: number): F3dParameter => ({ ...parameter(101, value, 'rad'), expression: `${value} rad` });

  it('turns a profile about a model axis', async () => {
    const r = await built(design(rectangle(), [revolve(quarter(Math.PI / 2))]));
    expect(r.volume).toBeCloseTo((Math.PI * 20 * 20 * 10) / 4, 1);
  });

  it('turns the other way for a negative angle', async () => {
    const [a, b] = [
      await built(design(rectangle(), [revolve(quarter(Math.PI / 2))])),
      await built(design(rectangle(), [revolve(quarter(-Math.PI / 2))])),
    ];
    expect(a.max[2]).toBeCloseTo(0);
    expect(a.min[2]).toBeCloseTo(-20);
    expect(b.max[2]).toBeCloseTo(20);
    expect(b.min[2]).toBeCloseTo(0);
  });

  it('writes a whole turn as full', () => {
    const { document } = convertDesign(design(rectangle(), [revolve(null)]), {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
    });
    const row = ((document.parts as Json[])[0]?.timeline as Json[])[1] as Json;
    expect((row.inputs as Json).sides).toEqual([{ full: {} }]);
  });
});

describe('fillets', { timeout: 60_000 }, () => {
  const plane = (token: string, origin: [number, number, number], normal: [number, number, number]) => ({
    tags: [{ token, ops: [7] }],
    surface: { kind: 'plane' as const, origin, normal },
  });
  const name = (token: string) => ({ token, ops: [7] });

  it('finds an edge by the two faces either side of it', async () => {
    const faces = new FaceIndex();
    faces.add([plane('1', [2, 0, 0], [1, 0, 0]), plane('2', [0, 1, 0], [0, 1, 0])]);
    const fillet: F3dFeature = {
      kind: 'fillet',
      id: 200,
      sets: [{ size: parameter(201, 0.2), edges: [{ faces: [name('1'), name('2')] }] }],
    };
    const r = await built(design(rectangle(), [extrude(), fillet], faces));
    // A 2 mm radius takes a corner's square less its quarter circle, along the 30 mm edge.
    expect(r.volume).toBeCloseTo(20 * 10 * 30 - (4 - Math.PI) * 30, 2);
    expect(r.notes).toEqual([]);
  });

  it('keeps a fillet whose edge is not in the model, to pick it again', async () => {
    const faces = new FaceIndex();
    faces.add([plane('1', [9, 0, 0], [1, 0, 0]), plane('2', [0, 9, 0], [0, 1, 0])]);
    const fillet: F3dFeature = {
      kind: 'fillet',
      id: 200,
      sets: [{ size: parameter(201, 0.2), edges: [{ faces: [name('1'), name('2')] }] }],
    };
    const r = await kept(design(rectangle(), [extrude(), fillet], faces));
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    const row = rowNamed(r.timeline, 'Fillet 1');
    expect(row.type).toBe('core.fillet');
    const targets = ((((row.inputs as Json).sets as Json[])[0] as Json).targets as Json).set as Json[];
    expect(targets).toEqual([{ entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } }]);
    expect(r.paused).toEqual(['Fillet 1']);
    expect(r.notes).toEqual([
      {
        severity: 'warning',
        object: 'Fillet 1',
        message:
          'none of its edges were found in the imported model: it is kept and pauses until they are picked again',
      },
    ]);
  });

  it('keeps a chamfer on an edge whose faces the stored bodies do not hold, to pick it again', async () => {
    const fillet: F3dFeature = {
      kind: 'chamfer',
      id: 200,
      uneven: false,
      sets: [{ size: parameter(201, 0.2), edges: [{ faces: [name('8'), name('9')] }] }],
    };
    const r = await kept(design(rectangle(), [extrude(), fillet]));
    expect(rowNamed(r.timeline, 'Chamfer 1').type).toBe('core.chamfer');
    expect(r.paused).toEqual(['Chamfer 1']);
    expect(r.notes.map((n) => n.message)).toContain(
      'none of its edges were found in the imported model: it is kept and pauses until they are picked again',
    );
  });
});

describe('construction planes', { timeout: 60_000 }, () => {
  // A plane 3 cm above XY: x, y and normal as the matrix's columns.
  const lifted = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 3, 0, 0, 0, 1];
  const plane = (o: Partial<F3dFeature & { kind: 'constructionPlane' }> = {}): F3dFeature => ({
    kind: 'constructionPlane',
    id: 50,
    matrix: lifted,
    base: 'xy',
    offset: parameter(51, 3),
    ...o,
  });
  /** The rectangle drawn again on the plane, as sketch 3, and extruded 1 cm from it. */
  const onPlane = (p: F3dFeature): F3dDesign => {
    const upper: F3dSketch = { ...rectangle({ placement: lifted }), id: 3, name: 'Upper' };
    const base = design(rectangle(), []);
    const features: F3dFeature[] = [
      { kind: 'sketch', id: 2, sketchId: SKETCH },
      extrude(),
      p,
      { kind: 'sketch', id: 4, sketchId: 3 },
      extrude({ id: 110, operation: 'join', along: parameter(111, 1), profiles: [{ ...profile, sketchId: 3 }] }),
    ];
    return { ...base, sketches: [rectangle(), upper], features, order: features.map((f) => f.id) };
  };

  it('writes an offset plane attached to the plane it is offset from, and a sketch on it attached to it', async () => {
    const r = await built(onPlane(plane()));
    const timeline = ((r.document.parts as Json[])[0] as Json).timeline as Json[];
    const row = rowNamed(timeline, 'Plane 1');
    expect(row.type).toBe('core.constructionPlane');
    const attach = (row.inputs as Json).frame as Json;
    expect(((attach.attach as Json).support as Json[])[0]).toEqual({ standard: { name: 'xy' } });
    const sketch = rowNamed(timeline, 'Upper');
    const support = ((((sketch.inputs as Json).frame as Json).attach as Json).support as Json[])[0];
    expect(support).toEqual({ object: { feature: { id: row.id } } });
    expect(r.max[2]).toBeCloseTo(40);
    expect(r.volume).toBeCloseTo(20 * 10 * 40, 3);
  });

  it('writes a plane of a kind it does not decode where the file stored it', async () => {
    const r = await built(onPlane(plane({ base: null, offset: null })));
    const timeline = ((r.document.parts as Json[])[0] as Json).timeline as Json[];
    expect(Object.keys((rowNamed(timeline, 'Plane 1').inputs as Json).frame as Json)).toEqual(['fixed']);
    expect(r.max[2]).toBeCloseTo(40);
  });
});

describe('holes', { timeout: 60_000 }, () => {
  const size = (id: number, role: string, value: number, unit = 'cm'): F3dParameter => ({
    ...parameter(id, value, unit),
    role,
  });
  // The 2 × 1 × 3 cm block's top, at its middle.
  const hole = (sizes: F3dParameter[]): F3dFeature => ({
    kind: 'hole',
    id: 200,
    centres: [[1, 0.5, 3]],
    plane: { origin: [1, 0.5, 3], normal: [0, 0, 1], x: [1, 0, 0] },
    sizes: Object.fromEntries(sizes.map((p) => [p.role, p])),
  });

  it('drills a hole from the face it starts on, through all when it has no depth', async () => {
    const r = await built(
      design(rectangle(), [extrude(), hole([size(201, 'HoleDiameter', 0.4), size(202, 'TipAngle', Math.PI, 'rad')])]),
    );
    const timeline = ((r.document.parts as Json[])[0] as Json).timeline as Json[];
    const row = rowNamed(timeline, 'Hole 1');
    expect(row.type).toBe('core.hole');
    expect(Object.keys((row.inputs as Json).placement as Json)).toEqual(['face']);
    expect((row.inputs as Json).depth).toEqual({ throughAll: {} });
    expect(r.volume).toBeCloseTo(20 * 10 * 30 - Math.PI * 2 * 2 * 30, 2);
  });

  it('drills a blind countersunk hole to its depth', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        hole([
          size(201, 'HoleDiameter', 0.4),
          size(202, 'HoleDepth', 1),
          size(203, 'TipAngle', Math.PI, 'rad'),
          size(204, 'CSDiameter', 0.7),
          size(205, 'CSAngle', Math.PI / 2, 'rad'),
        ]),
      ]),
    );
    const timeline = ((r.document.parts as Json[])[0] as Json).timeline as Json[];
    expect(((rowNamed(timeline, 'Hole 1').inputs as Json).kind as Json).def).toEqual({
      expr: { text: '"countersink"', grammar: 1, refs: {} },
    });
    // The bore 10 mm deep, and the countersink's cone from 3.5 down to 2 mm across 1.5 mm, less the bore it holds.
    const cone = (Math.PI * 1.5 * (3.5 * 3.5 + 3.5 * 2 + 2 * 2)) / 3 - Math.PI * 2 * 2 * 1.5;
    expect(r.volume).toBeCloseTo(20 * 10 * 30 - Math.PI * 2 * 2 * 10 - cone, 2);
  });

  it('keeps a hole placed by its distances to edges, which stores no centre, untranslated', async () => {
    const byEdges: F3dFeature = { ...hole([size(201, 'HoleDiameter', 0.4)]), centres: [] };
    const r = await kept(design(rectangle(), [extrude(), byEdges]));
    const row = rowNamed(r.timeline, 'Hole 1');
    expect(row.type).toBe('f3d.hole');
    expect((row.inputs as Json).reason).toBe('a hole placed by its distances to edges');
    expect(r.paused).toEqual(['Hole 1']);
  });
});

describe('ellipses', { timeout: 60_000 }, () => {
  const ellipse = (majorRadius: number, minorRadius: number): F3dSketch => ({
    ...rectangle(),
    points: new Map(),
    curves: [
      {
        kind: 'ellipse',
        id: 20,
        primaryId: 20,
        secondaryId: 0,
        centerId: 0,
        center: [0, 0],
        majorAxis: [1, 0],
        minorAxis: [0, 1],
        majorRadius,
        minorRadius,
        startAngle: 0,
        endAngle: Math.PI * 2,
        construction: false,
      },
    ],
  });
  const whole = { sketchId: SKETCH, regions: [{ curves: [{ primary: 20, secondary: 0 }] }] };

  it('writes a round ellipse as a circle', async () => {
    const r = await built(design(ellipse(2, 2), [extrude({ profiles: [whole] })]));
    expect(r.volume).toBeCloseTo(Math.PI * 20 * 20 * 30, 0);
    const sketch = ((r.document.parts as Json[])[0]?.timeline as Json[])[0]?.inputs as Json;
    expect((sketch.curves as Json[])[0]?.kind).toBe('circle');
  });

  it('takes the longer axis as the major one, whatever the file calls it', async () => {
    const r = await built(design(ellipse(1, 2), [extrude({ profiles: [whole] })]));
    expect(r.volume).toBeCloseTo(Math.PI * 10 * 20 * 30, 0);
    expect(r.max[1]).toBeCloseTo(20, 0);
  });
});

describe('features on whole bodies', { timeout: 60_000 }, () => {
  const second = extrude({ id: 110, start: 'offset', profileOffset: parameter(103, 3), along: parameter(104, 1) });
  const body = (op: number) => ({ ops: [op] });
  const translate = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('joins two bodies', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        second,
        {
          kind: 'combine',
          id: 200,
          op: 'join',
          keepTools: false,
          newComponent: false,
          target: body(301),
          tools: [body(302)],
        },
      ]),
    );
    expect(r.display.definitions[0]?.bodies).toHaveLength(1);
    expect(r.volume).toBeCloseTo(20 * 10 * 40, 3);
  });

  it('keeps the tools of a combine that keeps them', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        second,
        {
          kind: 'combine',
          id: 200,
          op: 'join',
          keepTools: true,
          newComponent: false,
          target: body(301),
          tools: [body(302)],
        },
      ]),
    );
    expect(r.notes.map((n) => n.message).filter((m) => /combine/.test(m))).toEqual([]);
    expect(r.display.definitions[0]?.bodies).toHaveLength(2);
    const row = ((r.document.parts as Json[])[0]?.timeline as Json[]).find((f) => f.type === 'core.boolean') as Json;
    expect(((row.inputs as Json).keepTools as Json).def).toEqual({ expr: { text: 'true', grammar: 1, refs: {} } });
  });

  it('moves a body', async () => {
    const r = await built(
      design(rectangle(), [extrude(), { kind: 'move', id: 200, matrix: translate(5), bodies: [body(301)] }]),
    );
    expect(r.min[0]).toBeCloseTo(50);
    expect(r.max[0]).toBeCloseTo(70);
  });

  it('removes a body', async () => {
    const r = await built(
      design(rectangle(), [extrude(), second, { kind: 'removeBody', id: 200, bodies: [body(302)] }]),
    );
    expect(r.max[2]).toBeCloseTo(30);
  });

  it('says nothing about removing a body that is already gone', async () => {
    const combine: F3dFeature = {
      kind: 'combine',
      id: 200,
      op: 'join',
      keepTools: false,
      newComponent: false,
      target: body(301),
      tools: [body(302)],
    };
    const r = await built(
      design(rectangle(), [extrude(), second, combine, { kind: 'removeBody', id: 201, bodies: [body(302)] }]),
    );
    expect(r.notes).toEqual([]);
  });

  it('mirrors a body in an origin plane', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        {
          kind: 'mirror',
          id: 200,
          plane: 'yz',
          frame: null,
          planeFace: null,
          of: { bodies: [body(301)], features: [], other: false },
        },
      ]),
    );
    expect(r.min[0]).toBeCloseTo(-20);
    expect(r.max[0]).toBeCloseTo(20);
    expect(r.volume).toBeCloseTo(2 * 20 * 10 * 30, 3);
  });

  it('mirrors the bodies of a feature that made them', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        {
          kind: 'mirror',
          id: 200,
          plane: 'xz',
          frame: null,
          planeFace: null,
          of: { bodies: [], features: [100], other: false },
        },
      ]),
    );
    expect(r.min[1]).toBeCloseTo(-10);
  });

  it('mirrors about a plane of its own through a construction plane', async () => {
    const frame = {
      origin: [3, 0, 0] as [number, number, number],
      normal: [1, 0, 0] as [number, number, number],
      x: [0, 1, 0] as [number, number, number],
    };
    const r = await built(
      design(rectangle(), [
        extrude(),
        {
          kind: 'mirror',
          id: 200,
          plane: null,
          frame,
          planeFace: null,
          of: { bodies: [body(301)], features: [], other: false },
        },
      ]),
    );
    expect(r.max[0]).toBeCloseTo(60);
  });

  it('keeps a mirror whose plane it cannot read untranslated, with a note', async () => {
    const r = await kept(
      design(rectangle(), [
        extrude(),
        {
          kind: 'mirror',
          id: 200,
          plane: null,
          frame: null,
          planeFace: null,
          of: { bodies: [body(301)], features: [], other: false },
        },
      ]),
    );
    const row = rowNamed(r.timeline, 'Mirror 1');
    expect(row.type).toBe('f3d.mirror');
    expect((row.inputs as Json).reason).toBe('mirror about a plane not read');
    expect(r.paused).toEqual(['Mirror 1']);
  });

  it('repeats a body along a line', async () => {
    const pattern: F3dFeature = {
      kind: 'pattern',
      id: 200,
      layout: 'rectangular',
      of: { bodies: [body(301)], features: [], other: false },
      directions: [{ origin: [0, 0, 0], direction: [1, 0, 0] }],
      counts: [3, 1],
      uSpacing: parameter(201, 3),
      vSpacing: parameter(202, 0),
      angle: null,
    };
    const r = await built(design(rectangle(), [extrude(), pattern]));
    expect(r.volume).toBeCloseTo(3 * 20 * 10 * 30, 3);
    expect(r.max[0]).toBeCloseTo(80);
  });

  it('runs a pattern the other way for a negative spacing', async () => {
    const pattern: F3dFeature = {
      kind: 'pattern',
      id: 200,
      layout: 'rectangular',
      of: { bodies: [body(301)], features: [], other: false },
      directions: [{ origin: [0, 0, 0], direction: [1, 0, 0] }],
      counts: [2, 1],
      uSpacing: parameter(201, -3),
      vSpacing: null,
      angle: null,
    };
    const r = await built(design(rectangle(), [extrude(), pattern]));
    expect(r.min[0]).toBeCloseTo(-30);
  });

  it('turns a body about an axis', async () => {
    const angle: F3dParameter = { ...parameter(201, Math.PI, 'rad'), expression: `${Math.PI} rad` };
    const pattern: F3dFeature = {
      kind: 'pattern',
      id: 200,
      layout: 'circular',
      of: { bodies: [body(301)], features: [], other: false },
      directions: [{ origin: [-1, 0, 0], direction: [0, 0, 1] }],
      counts: [2],
      uSpacing: null,
      vSpacing: null,
      angle,
    };
    const r = await built(design(rectangle(), [extrude(), pattern]));
    expect(r.volume).toBeCloseTo(2 * 20 * 10 * 30, 3);
  });

  it('shells a body, taking the face the file names', async () => {
    const faces = new FaceIndex();
    faces.add([{ tags: [{ token: '1', ops: [7] }], surface: { kind: 'plane', origin: [0, 0, 3], normal: [0, 0, 1] } }]);
    const r = await built(
      design(
        rectangle(),
        [
          extrude(),
          { kind: 'shell', id: 200, faces: [{ token: '1', ops: [7] }], bodies: [], inner: parameter(201, 0.1) },
        ],
        faces,
      ),
    );
    expect(r.volume).toBeCloseTo(20 * 10 * 30 - 18 * 8 * 29, 2);
  });
});

describe('primitives', { timeout: 60_000 }, () => {
  const none = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const at = (x: number, y: number, z: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
  const primitive = (
    shape: F3dPrimitive['shape'],
    sizes: Record<string, number>,
    o: Partial<F3dPrimitive> = {},
  ): F3dPrimitive => ({
    kind: 'primitive',
    id: 200,
    shape,
    operation: 'newBody',
    plane: none,
    onPlane: none,
    sizes: Object.fromEntries(Object.entries(sizes).map(([role, value], i) => [role, parameter(300 + i, value)])),
    ...o,
  });

  it('stands a box on its corner', async () => {
    const r = await built(
      design(rectangle(), [primitive('box', { DistanceX: 2, DistanceY: 1, DistanceZ: 3 }, { onPlane: at(1, 0, 0) })]),
    );
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    expect(r.min).toEqual([expect.closeTo(10), expect.closeTo(0), expect.closeTo(0)]);
    expect(r.max).toEqual([expect.closeTo(30), expect.closeTo(10), expect.closeTo(30)]);
  });

  it('runs a box the other way for a negative height', async () => {
    const r = await built(design(rectangle(), [primitive('box', { DistanceX: 2, DistanceY: 1, DistanceZ: -3 })]));
    expect(r.min[2]).toBeCloseTo(-30);
    expect(r.max[2]).toBeCloseTo(0);
  });

  it('stands a cylinder on its base, on the plane it was drawn on', async () => {
    const r = await built(
      design(rectangle(), [primitive('cylinder', { Diameter: 2, Height: 1 }, { plane: at(0, 0, 5) })]),
    );
    expect(r.volume).toBeCloseTo(Math.PI * 10 * 10 * 10, 0);
    expect(r.min[2]).toBeCloseTo(50);
    expect(r.max[2]).toBeCloseTo(60);
  });

  it('centres a sphere and a torus on where they stand', async () => {
    const sphere = await built(design(rectangle(), [primitive('sphere', { Diameter: 2 }, { onPlane: at(3, 0, 0) })]));
    expect(sphere.min[0]).toBeCloseTo(20, 1);
    expect(sphere.max[0]).toBeCloseTo(40, 1);
    const torus = await built(design(rectangle(), [primitive('torus', { MajorDiameter: 4, MinorDiameter: 1 })]));
    expect(torus.max[0]).toBeCloseTo(25, 1);
    expect(torus.max[2]).toBeCloseTo(5, 1);
  });

  it('cuts with a primitive', async () => {
    const r = await built(
      design(rectangle(), [
        extrude(),
        primitive('box', { DistanceX: 1, DistanceY: 1, DistanceZ: 1 }, { id: 201, operation: 'cut' }),
      ]),
    );
    expect(r.volume).toBeCloseTo(20 * 10 * 30 - 10 * 10 * 10, 3);
  });

  it('keeps a primitive with a size missing untranslated, with a note', async () => {
    const r = await kept(design(rectangle(), [primitive('cylinder', { Height: 1 })]));
    const row = rowNamed(r.timeline, 'Primitive 1');
    expect(row.type).toBe('f3d.primitive');
    expect((row.inputs as Json).reason).toBe('cylinder with its sizes not read');
    expect(r.paused).toEqual(['Primitive 1']);
  });
});

describe('a body removed after a copy that is left out', { timeout: 60_000 }, () => {
  it('stays, since the copy that carried it on was not made', async () => {
    const pasted: F3dFeature = { kind: 'unsupported', id: 150, what: 'pasted body', parameters: [] };
    const d = design(rectangle(), [extrude(), pasted, { kind: 'removeBody', id: 200, bodies: [{ ops: [301] }] }]);
    const r = await kept(d);
    expect(r.volume).toBeGreaterThan(0);
    expect(rowNamed(r.timeline, 'Pasted body 1').type).toBe('f3d.pastedBody');
    const removal = rowNamed(r.timeline, 'Remove Body 1');
    expect(removal.type).toBe('f3d.removeBody');
    expect((removal.inputs as Json).reason).toBe('remove body in a design whose copies are not imported');
    expect(r.paused).toEqual(['Pasted body 1', 'Remove Body 1']);
  });
});

describe('bodies with no history', { timeout: 60_000 }, () => {
  // Two boxes in one stream, keyed 5 and 9: 1 × 1 × 1 cm and 1 × 2 × 1 cm.
  const first = boxRecords([0, 0, 0], [1, 1, 1], 5);
  const stream = asmStream([...first, ...shifted(boxRecords([3, 0, 0], [4, 2, 1], 9), first.length)]);
  const stored = (over: Partial<F3dDesign>): F3dDesign => ({
    ...design(rectangle(), [extrude()]),
    storedBodies: new Map([[null, 2]]),
    storedShapes: new Map([
      [
        null,
        [
          { stream: 'BREP.a.smb', selector: 5 },
          { stream: 'BREP.a.smb', selector: 9 },
        ],
      ],
    ]),
    brep: (name) => (name === 'BREP.a.smb' ? stream : undefined),
    leftOut: { 'stored body': 2 },
    ...over,
  });
  const convert = (d: F3dDesign) =>
    convertDesign(d, {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
      name: 'plate',
      now: '2026-11-06T00:00:00Z',
    });

  it('come in as the file stored them, in a Base Feature at the start of their component', async () => {
    const { document, steps, notes, report } = convert(stored({}));
    expect(await complete(document, steps, client)).toEqual([]);
    const timeline = ((document.parts as Json[])[0] as Json).timeline as Json[];
    expect(timeline[0]).toMatchObject({ type: 'core.import', name: 'Base Feature' });
    const stored0 = (timeline[0]?.inputs as Json).stored as Json;
    expect(stored0.representation).toEqual({ name: 'brep', version: 1 });
    // The stored shape is the only asset it adds: the file is its source.
    expect(Object.keys(document.assets as Json)).toEqual([stored0.asset]);
    expect(readDocument(document).diagnostics.filter((x) => x.severity === 'refuse')).toEqual([]);
    const display = service.evaluate(document);
    expect(display.pauses).toEqual([]);
    expect(display.definitions.flatMap((x) => x.bodies)).toHaveLength(3);
    expect(report.leftOut['stored body']).toBeUndefined();
    expect(notes.find((n) => n.object === 'timeline')?.message).toBe(
      '2 bodies have no history and come in as the file stored them, in 1 Base Feature',
    );
  });

  it('say which bodies could not be read', () => {
    const { notes, steps, report } = convert(
      stored({
        storedShapes: new Map([[null, [{ stream: 'BREP.a.smb', selector: 5 }, null]]]),
      }),
    );
    expect(steps.filter((s) => s.kind === 'store').map((s) => (s.kind === 'store' ? s.bodies : 0))).toEqual([1]);
    expect(report.leftOut['stored body']).toBe(1);
    expect(notes.find((n) => n.severity === 'warning' && n.object === 'timeline')?.message).toBe(
      '1 body with no history could not be read from the file, so it is not drawn.',
    );
  });

  it('stand a turned design on its Y axis like the rest of it', async () => {
    const { document, steps } = convert(stored({ upAxis: 'z' }));
    await complete(document, steps, client);
    const display = service.evaluate(document);
    const tall = display.definitions.flatMap((x) => x.bodies).length;
    expect(tall).toBe(3);
    const timeline = ((document.parts as Json[])[0] as Json).timeline as Json[];
    expect(((timeline[0]?.inputs as Json).upAxis as Json).def).toMatchObject({ expr: { text: '"z"' } });
  });
});

describe('components', { timeout: 60_000 }, () => {
  const world = [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const at = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('makes a part of a component and places it wherever the file puts it', async () => {
    // A sketch in a component: the file gives its model position through the component's first place.
    const sketch: F3dSketch = { ...rectangle({ placement: world }), componentId: 50, componentName: 'Key' };
    const d: F3dDesign = {
      ...design(sketch, [extrude()]),
      components: [{ id: 50, name: 'Key', world, placements: [at(2), at(5), at(8)] }],
      componentOf: new Map([[100, 50]]),
    };
    const { document, steps, notes, report } = convertDesign(d, {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
      name: 'keys',
      now: '2026-11-06T00:00:00Z',
    });
    notes.push(...(await complete(document, steps, client)));
    expect(readDocument(document).diagnostics.filter((x) => x.severity === 'refuse')).toEqual([]);
    expect(report).toMatchObject({ parts: 1, instances: 3 });
    const part = (document.parts as Json[])[0] as Json;
    expect(part.name).toBe('Key');
    const display = service.evaluate(document);
    expect(display.pauses).toEqual([]);
    const instances = ((document.assemblies as Json[])[0] as Json).instances as { placement: { position: number[] } }[];
    expect(instances.map((i) => i.placement.position[0])).toEqual([20, 50, 80]);
    // The part holds the component as it is in its own coordinates, from the origin.
    const shapes = [...(service.evaluation?.parts.get(part.id as string)?.shapes.values() ?? [])];
    const box = k.getBoundingBox(shapes[0] as (typeof shapes)[number]);
    expect(box.xmin).toBeCloseTo(0);
    expect(box.xmax).toBeCloseTo(20);
  });

  it('places a linked design at each link, with its own parts and parameters', async () => {
    const parameter = {
      name: 'width',
      expression: '20 mm',
      unit: 'mm',
      value: 2,
      isUser: true,
    } as F3dDesign['parameters'][number];
    const bolt: F3dDesign = { ...design(rectangle(), [extrude()]), parameters: [parameter] };
    const d: F3dDesign = {
      ...design(rectangle(), [extrude()]),
      parameters: [parameter],
      links: [{ design: bolt, name: 'Bolt', placements: [at(2), at(5)] }],
    };
    const { document, steps, report } = convertDesign(d, {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
      name: 'frame',
      now: '2026-11-06T00:00:00Z',
    });
    await complete(document, steps, client);
    expect(readDocument(document).diagnostics.filter((x) => x.severity === 'refuse')).toEqual([]);
    expect(report).toMatchObject({ parts: 2, instances: 3 });
    expect((document.parts as Json[]).map((p) => p.name)).toEqual(['frame', 'Bolt']);
    const instances = ((document.assemblies as Json[])[0] as Json).instances as { placement: { position: number[] } }[];
    expect(instances.map((i) => i.placement.position[0])).toEqual([0, 20, 50]);
    expect(service.evaluate(document).pauses).toEqual([]);
  });

  it('writes a design linked twice once', () => {
    const bolt = design(rectangle(), [extrude()]);
    const d: F3dDesign = {
      ...design(rectangle(), [extrude()]),
      links: [
        { design: bolt, name: 'Bolt', placements: [at(2)] },
        { design: bolt, name: 'Bolt', placements: [at(5)] },
      ],
    };
    expect(convertDesign(d, { ids: seededIds(9), writer: { app: 'test', version: '0' } }).report).toMatchObject({
      parts: 2,
      instances: 3,
    });
  });

  it('places what a root with nothing of its own links to', () => {
    const empty: F3dDesign = {
      ...design(rectangle(), []),
      sketches: [],
      features: [],
      order: [],
      links: [{ design: design(rectangle(), [extrude()]), name: 'Bolt', placements: [at(2)] }],
    };
    const { document, report } = convertDesign(empty, {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
      name: 'frame',
    });
    expect(report).toMatchObject({ parts: 1, instances: 1 });
    expect(Object.keys(document.root as Json)).toEqual(['assembly']);
  });

  it('keeps a design with only its root as one part with no assembly', () => {
    const { document, report } = convertDesign(design(rectangle(), [extrude()]), {
      ids: seededIds(9),
      writer: { app: 'test', version: '0' },
    });
    expect(document.assemblies).toEqual([]);
    expect(report).toMatchObject({ parts: 1, instances: 1 });
  });

  it('gives a feature using another component a copy of the sketch, in its own coordinates', () => {
    const d: F3dDesign = {
      ...design(rectangle(), [extrude()]),
      components: [{ id: 50, name: 'Key', world, placements: [world] }],
      componentOf: new Map([[100, 50]]),
    };
    const { document } = convertDesign(d, { ids: seededIds(9), writer: { app: 'test', version: '0' } });
    const parts = document.parts as Json[];
    expect(parts).toHaveLength(2);
    expect((parts[1]?.timeline as Json[]).map((f) => f.type)).toEqual(['core.sketch', 'core.extrude']);
  });
});

describe('sketch constraints', { timeout: 60_000 }, () => {
  it('keeps what the solver holds', async () => {
    const relations: F3dRelation[] = [
      { id: 40, kind: 'horizontal', loci: [20] },
      { id: 41, kind: 'vertical', loci: [21] },
    ];
    const r = await built(design(rectangle({ relations }), [extrude()]));
    const sketch = ((r.document.parts as Json[])[0]?.timeline as Json[])[0]?.inputs as Json;
    expect((sketch.constraints as Json[]).filter((c) => (c.of as Json).curve)).toHaveLength(2);
    expect(r.notes).toEqual([]);
  });

  it('takes out a constraint that would stop the sketch solving, leaving the geometry', async () => {
    // The two long sides are level with each other, and a dimension the geometry has twice over the same span holds; a third, conflicting pair does not.
    const relations: F3dRelation[] = [
      { id: 40, kind: 'horizontal', loci: [20] },
      { id: 41, kind: 'parallel', loci: [20, 22] },
      { id: 42, kind: 'horizontal', loci: [22] },
      { id: 43, kind: 'vertical', loci: [21] },
      { id: 44, kind: 'vertical', loci: [23] },
      { id: 45, kind: 'perpendicular', loci: [20, 21] },
      { id: 46, kind: 'perpendicular', loci: [22, 23] },
    ];
    const r = await built(design(rectangle({ relations }), [extrude()]));
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    expect(r.max[0]).toBeCloseTo(20);
  });
});

describe('up axis', { timeout: 60_000 }, () => {
  it('stands a design modelled Z up on the Y axis: its XY sketch lies on the ground plane', async () => {
    const r = await built({ ...design(rectangle(), [extrude()]), upAxis: 'z' });
    // (x, y, z) became (x, z, -y): 3 cm up, the sketch's 1 cm toward -z.
    expect(r.min).toEqual([expect.closeTo(0), expect.closeTo(0), expect.closeTo(-10)]);
    expect(r.max).toEqual([expect.closeTo(20), expect.closeTo(30), expect.closeTo(0)]);
    const sketch = ((r.document.parts as Json[])[0]?.timeline as Json[])[0]?.inputs as Json;
    expect(JSON.stringify(sketch.frame)).toContain('"standard":{"name":"xz"}');
  });

  it('keeps the axes of a design modelled Y up, or one that does not say', async () => {
    for (const upAxis of ['y', null] as const) {
      const r = await built({ ...design(rectangle(), [extrude()]), upAxis });
      expect(r.max).toEqual([expect.closeTo(20), expect.closeTo(10), expect.closeTo(30)]);
    }
  });
});

describe('profiles', { timeout: 60_000 }, () => {
  /** The rectangle with more lines drawn on it: points from 14, lines from 24. */
  function drawnOn(extra: [[number, number], [number, number]][]): F3dSketch {
    const s = rectangle();
    extra.forEach(([a, b], i) => {
      s.points.set(14 + 2 * i, { id: 14 + 2 * i, x: a[0], y: a[1], z: 0 });
      s.points.set(15 + 2 * i, { id: 15 + 2 * i, x: b[0], y: b[1], z: 0 });
      s.curves.push({
        kind: 'line',
        id: 24 + i,
        primaryId: 24 + i,
        secondaryId: 0,
        startId: 14 + 2 * i,
        endId: 15 + 2 * i,
        construction: false,
      });
    });
    return s;
  }

  it('finds a profile that names a longer line lying over one of its sides', async () => {
    const sketch = drawnOn([
      [
        [-1, 0],
        [3, 0],
      ],
    ]);
    const over = {
      sketchId: SKETCH,
      regions: [{ curves: [24, 21, 22, 23].map((primary) => ({ primary, secondary: 0 })) }],
    };
    const r = await built(design(sketch, [extrude({ profiles: [over] })]));
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    expect(r.max[0]).toBeCloseTo(20);
  });

  it('takes every region inside a profile that lines drawn later split', async () => {
    const sketch = drawnOn([
      [
        [1, 0],
        [1, 1],
      ],
    ]);
    const r = await built(design(sketch, [extrude({ profiles: [profile] })]));
    expect(r.volume).toBeCloseTo(20 * 10 * 30, 3);
    expect(r.min[0]).toBeCloseTo(0);
    expect(r.max[0]).toBeCloseTo(20);
  });
});
