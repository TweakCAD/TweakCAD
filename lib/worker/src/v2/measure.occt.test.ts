/**
 * Measured values on the real kernel: `core.measure` and driven sketch
 * dimensions measure distance, length, area, volume, angle and radius after
 * their feature's build, later values follow them through edits, and a value
 * that cannot be measured pauses what uses it.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  idItem,
  ladderOf,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { box, cylinder, fixedFrame } from './primitivesDocs';

type Json = Record<string, unknown>;
let k: OcctKernel;
let gcs: GcsWrapper;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [3, 4, 5]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

/** Names seen in earlier builds, which the records of these documents use. */
const known: Json = {};

function run(d: DocBuilder): Evaluation {
  const doc = d.document();
  const named = { ...doc, names: { ...(doc.names as Json), ...known } };
  const read = readDocument(JSON.parse(JSON.stringify(named)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(named, k, { solver: gcs });
  builds.push(ev);
  Object.assign(known, ev.names.toJson());
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = run(d);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const stateOf = (ev: Evaluation) => [...ev.parts.values()][0]!.state;
const all = (ev: Evaluation) => [...stateOf(ev).entities.values()];
const near = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
const pick = (ev: Evaluation, e: NamedEntity) => writeRecord(e, stateOf(ev), ev.adapter);
const total = (ev: Evaluation) =>
  all(ev)
    .filter((e) => e.kind === 'body')
    .reduce((sum, e) => sum + (ev.adapter.measures(e.key).volume as number), 0);
const faceAt = (ev: Evaluation, at: Vec3) =>
  all(ev).find((e) => e.kind === 'face' && near(ev.adapter.measures(e.key).centroid as Vec3, at)) as NamedEntity;
const edgeAt = (ev: Evaluation, at: Vec3) =>
  all(ev).find(
    (e) =>
      e.kind === 'edge' && near((ev.adapter.measures(e.key).midpoint ?? ev.adapter.measures(e.key).center) as Vec3, at),
  ) as NamedEntity;
const result = (ev: Evaluation, id: string) => {
  const v = ev.values.value(id);
  if (v.kind !== 'scalar') throw new Error(`${id} is not a scalar`);
  return v.value;
};

/** A named measured value. */
const measured = (d: DocBuilder, name: string, kind: string, of: Json[]) => ({
  id: d.id('val'),
  name,
  def: { measure: { kind, of } },
});
const entity = (record: EntityRecord) => ({ entity: record });
/** A value object of `text` naming one other value as `name`. */
const using = (d: DocBuilder, text: string, name: string, id: string) => ({
  id: d.id('val'),
  def: { expr: { text, grammar: 1, refs: { [name]: { value: { id } } } } },
});

/** A 20 × 10 × 6 box centred on the origin, `width` along x, and a separate cylinder of radius 3. */
function part(width = 20): DocBuilder {
  const d = new DocBuilder();
  box(d, width, 10, 6);
  cylinder(d, 3, 4, { at: [40, 0, 0] });
  return d;
}

/** Records on the plain part, as an editor writes them. */
function partPicks(width = 20) {
  const d = part(width);
  const ev = build(d);
  const w = width / 2;
  return {
    plusX: pick(ev, faceAt(ev, [w, 0, 0])),
    minusX: pick(ev, faceAt(ev, [-w, 0, 0])),
    top: pick(ev, faceAt(ev, [0, 0, 3])),
    bottom: pick(ev, faceAt(ev, [0, 0, -3])),
    topFront: pick(ev, edgeAt(ev, [0, -5, 3])),
    rim: pick(ev, edgeAt(ev, [40, 0, 2])),
    wall: pick(
      ev,
      all(ev).find((e) => e.kind === 'face' && ev.adapter.measures(e.key).surface === 'cylinder') as NamedEntity,
    ),
    box: pick(
      ev,
      all(ev).find((e) => e.kind === 'body' && (ev.adapter.measures(e.key).volume as number) > 1000) as NamedEntity,
    ),
  };
}

describe('core.measure', () => {
  it('measures each kind on the real kernel', () => {
    const p = partPicks();
    const d = part();
    const values = [
      measured(d, 'across', 'distance', [entity(p.plusX), entity(p.minusX)]),
      measured(d, 'fromOrigin', 'distance', [{ standard: { name: 'origin' } }, entity(p.plusX)]),
      measured(d, 'edges', 'length', [entity(p.topFront), entity(p.rim)]),
      measured(d, 'faces', 'area', [entity(p.top), entity(p.plusX)]),
      measured(d, 'solid', 'volume', [entity(p.box)]),
      measured(d, 'square', 'angle', [entity(p.top), entity(p.plusX)]),
      measured(d, 'opposite', 'angle', [entity(p.top), entity(p.bottom)]),
      measured(d, 'toAxis', 'angle', [{ standard: { name: 'z' } }, entity(p.top)]),
      measured(d, 'planes', 'angle', [{ standard: { name: 'xz' } }, { standard: { name: 'xy' } }]),
      measured(d, 'onEdge', 'angle', [{ standard: { name: 'x' } }, entity(p.topFront)]),
      measured(d, 'wallRadius', 'radius', [entity(p.wall)]),
      measured(d, 'rimRadius', 'radius', [entity(p.rim)]),
    ];
    d.feature('core.measure', { values });
    const ev = build(d);
    const at = (name: string) => result(ev, values.find((v) => v.name === name)!.id);
    expect(at('across')).toBeCloseTo(20, 9);
    expect(at('fromOrigin')).toBeCloseTo(10, 9);
    expect(at('edges')).toBeCloseTo(20 + 6 * Math.PI, 9);
    expect(at('faces')).toBeCloseTo(200 + 60, 9);
    expect(at('solid')).toBeCloseTo(1200, 9);
    expect(at('square')).toBeCloseTo(90, 9);
    expect(at('opposite')).toBeCloseTo(180, 9);
    expect(at('toAxis')).toBeCloseTo(0, 9);
    expect(at('planes')).toBeCloseTo(90, 9);
    expect([0, 180].some((a) => Math.abs(at('onEdge') - a) < 1e-9)).toBe(true);
    expect(at('wallRadius')).toBeCloseTo(3, 9);
    expect(at('rimRadius')).toBeCloseTo(3, 9);
  });

  it('measures an edge angle the same way after a rebuild that changes the part', () => {
    const angleOn = (width: number) => {
      const p = partPicks(width);
      const d = part(width);
      const value = measured(d, 'onEdge', 'angle', [{ standard: { name: 'x' } }, entity(p.topFront)]);
      d.feature('core.measure', { values: [value] });
      return result(build(d), value.id);
    };
    expect(angleOn(30)).toBeCloseTo(angleOn(20), 9);
  });

  it('pauses what uses a value whose entity is gone, or that has the wrong references', () => {
    const p = partPicks();
    const cases: [Json[], string, string][] = [
      [
        [entity({ ...p.plusX, id: [p.plusX.id[0] as string, 'a'.repeat(26)] }), entity(p.minusX)],
        'distance',
        'a measured entity is gone',
      ],
      [[entity(p.plusX)], 'distance', 'a distance is measured between two references'],
      [[entity(p.topFront)], 'area', 'an area is measured on faces'],
      [[entity(p.wall), entity(p.top)], 'angle', 'an angle is measured between lines, axes and planar faces'],
      [
        [{ standard: { name: 'xy' } }, entity(p.top)],
        'distance',
        'a distance to a default or construction axis or plane is not measured yet',
      ],
    ];
    for (const [of, kind, message] of cases) {
      const d = part();
      const value = measured(d, 'meas', kind, of);
      d.feature('core.measure', { values: [value] });
      const user = box(d, 1, 1, 1, { at: [0, 0, 20] });
      const doc = d.document();
      const timeline = (doc.parts as Json[])[0]!.timeline as Json[];
      const shape = ((timeline.find((f) => f.id === user)!.inputs as Json).shape as Json).box as Json;
      shape.width = using(
        d,
        kind === 'angle' ? 'meas / 1 deg * 1 mm' : kind === 'area' ? 'meas / 1 mm' : 'meas',
        'meas',
        value.id,
      );
      const ev = evaluateDocument({ ...doc, names: { ...(doc.names as Json), ...known } }, k);
      builds.push(ev);
      expect(ev.pauses).toEqual([{ feature: user, message }]);
    }
  });

  it('pauses what uses a value of a suppressed measure', () => {
    const p = partPicks();
    const d = part();
    const value = measured(d, 'meas', 'distance', [entity(p.plusX), entity(p.minusX)]);
    const m = d.feature('core.measure', { values: [value] });
    d.feature('core.primitive', {
      shape: { box: { width: using(d, 'meas', 'meas', value.id), depth: d.val('1 mm'), height: d.val('1 mm') } },
      frame: fixedFrame(d, [0, 0, 20]),
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const doc = d.document();
    const feature = ((doc.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === m)!;
    ((feature.suppressed as Json).def as Json).expr = { text: 'true', grammar: 1, refs: {} };
    const ev = evaluateDocument({ ...doc, names: { ...(doc.names as Json), ...known } }, k);
    builds.push(ev);
    expect(ev.pauses.map((x) => x.message)).toEqual(['the feature that measures it is suppressed']);
  });
});

describe('values that follow a measure', () => {
  /**
   * The part, a measure of its width, and a sketch on top whose rectangle is
   * half that wide by a driving dimension, extruded 2 mm.
   */
  function following(width: number, p: ReturnType<typeof partPicks>) {
    const d = part(width);
    const across = measured(d, 'across', 'distance', [entity(p.plusX), entity(p.minusX)]);
    d.feature('core.measure', { values: [across] });
    const s = d.sketch(
      'xy',
      (x) => {
        const r = x.rect(0, 0, 7, 4);
        x.fixed(r.points[0] as string);
        x.horizontal(r.lines[0] as string);
        x.vertical(r.lines[1] as string);
        x.horizontal(r.lines[2] as string);
        x.vertical(r.lines[3] as string);
        x.distanceX(r.points[0] as string, r.points[1] as string, 'across / 2');
        ((x.constraints.at(-1) as Json).value as Json).def = using(d, 'across / 2', 'across', across.id).def;
        x.distanceY(r.points[0] as string, r.points[3] as string, '4 mm');
      },
      3,
    );
    d.extrude({ sketch: s.feature, profiles: [s.region([1, 1])], sides: [{ distance: '2 mm' }] });
    return d;
  }

  it('drives a sketch dimension, which follows the measured width through an edit, a pick kept', () => {
    const p20 = partPicks(20);
    const d20 = following(20, p20);
    const ev20 = build(d20);
    expect(total(ev20)).toBeCloseTo(1200 + Math.PI * 36 + 10 * 4 * 2, 6);
    const side = pick(ev20, faceAt(ev20, [10, 2, 4]));

    const p30 = partPicks(30);
    const d30 = following(30, p30);
    const ev30 = build(d30);
    expect(total(ev30)).toBeCloseTo(1800 + Math.PI * 36 + 15 * 4 * 2, 6);
    const r = resolve(side, stateOf(ev30), ev30.adapter);
    expect(r.outcome).toBe('same');
    const found = (r as { entities: readonly NamedEntity[] }).entities[0] as NamedEntity;
    expect(near(ev30.adapter.measures(found.key).centroid as Vec3, [15, 2, 4])).toBe(true);
  });

  it('measures a driven sketch dimension after the solve, for later values to use', () => {
    const d = new DocBuilder();
    let corners: string[] = [];
    const s = d.sketch('xy', (x) => {
      const r = x.rect(0, 0, 7, 3);
      corners = r.points;
      x.fixed(r.points[0] as string);
      x.horizontal(r.lines[0] as string);
      x.vertical(r.lines[1] as string);
      x.horizontal(r.lines[2] as string);
      x.vertical(r.lines[3] as string);
      x.distanceX(r.points[0] as string, r.points[1] as string, '8 mm');
      x.distanceY(r.points[0] as string, r.points[3] as string, '6 mm');
    });
    const pointRef = (pt: string) => ({
      entity: {
        id: ladderOf({ kind: 'point', chain: [], feature: s.feature, role: 'point', src: [idItem(pt)] }, d.names),
        branch: [],
        side: [],
        nb: { set: [] },
        n: 1,
        snapshot: {},
      },
    });
    const diagonal = measured(d, 'diagonal', 'distance', [
      pointRef(corners[0] as string),
      pointRef(corners[2] as string),
    ]);
    const doc = d.document();
    const sketch = ((doc.parts as Json[])[0]!.timeline as Json[]).find((f) => f.id === s.feature)!;
    const constraints = (sketch.inputs as Json).constraints as Json[];
    constraints.push({
      id: d.id('con'),
      kind: 'distance',
      active: d.val('true'),
      a: { point: { id: corners[0] } },
      b: { point: { id: corners[2] } },
      value: diagonal,
      solved: 0,
      label: { auto: {} },
    });
    const named = { ...doc, names: d.names.toJson() };
    const read = readDocument(JSON.parse(JSON.stringify(named)));
    expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
    const ev = evaluateDocument(named, k, { solver: gcs });
    builds.push(ev);
    expect(ev.pauses).toEqual([]);
    expect(result(ev, diagonal.id)).toBeCloseTo(10, 9);
  });
});
