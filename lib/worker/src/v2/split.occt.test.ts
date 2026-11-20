/**
 * Split on the real kernel: a body divided by a default plane keeps its
 * identity in the positive piece, the negative piece being its copy under the
 * `split` step; one side can be kept alone; a plane that misses the body,
 * and a face target, pause.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  ladderOf,
  makeSet,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import { bodyRef as primitiveBody, cylinder, primitive } from './primitivesDocs';

const sphere = (d: DocBuilder, radius: number) => primitive(d, 'sphere', { radius: `${radius} mm` });

type Json = Record<string, unknown>;
let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

function build(d: DocBuilder): Evaluation {
  const ev = evaluate(d);
  expect(ev.pauses).toEqual([]);
  const part = ev.parts.get(d.partId)!;
  for (const shape of part.shapes.keys()) {
    const t = ev.adapter.topology(shape);
    const keys = [
      ...t.faces,
      ...t.edges.map((e) => e.edge),
      ...t.vertices.map((v) => v.vertex),
      ...t.solids.map((s) => s.solid),
    ];
    expect(keys.filter((key) => !part.state.entities.has(key))).toEqual([]);
  }
  return ev;
}

const stateOf = (ev: Evaluation, d: DocBuilder) => ev.parts.get(d.partId)!.state;
const all = (ev: Evaluation, d: DocBuilder) => [...stateOf(ev, d).entities.values()];
const bodies = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'body');
const faces = (ev: Evaluation, d: DocBuilder) => all(ev, d).filter((e) => e.kind === 'face');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
/** A face's centroid, or the middle of a body's bounding box. */
function centroid(ev: Evaluation, e: NamedEntity): Vec3 {
  const m = ev.adapter.measures(e.key);
  if (m.centroid) return m.centroid;
  const [lo, hi] = m.bbox as readonly [Vec3, Vec3];
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}
const roleOf = (ev: Evaluation, e: NamedEntity) => (ev.names.get(e.ladder[1] as string) as Json | null)?.role;

const bodyRef = (d: DocBuilder, region: Json, feature: string): Json => {
  const record = region.entity as EntityRecord;
  const src = (d.names.get(record.id[record.id.length - 1] as string) as { src: never }).src;
  const id = ladderOf({ kind: 'body', chain: [], feature, role: 'body', src }, d.names);
  return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
};

/** A 20 × 10 × 5 box from x = `x0`, split by the YZ plane (normal +x), keeping `keep`. */
function splitBox(keep: Json, x0 = -10) {
  const d = new DocBuilder();
  const s = d.sketch('xy', (sk) => sk.rect(x0, 0, 20, 10));
  const region = s.region([x0 + 1, 1]);
  const extrude = d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: '5 mm' }] });
  const target = bodyRef(d, region, extrude);
  d.feature('core.split', { targets: makeSet([target]), tool: { standard: { name: 'yz' } }, keep });
  return { d, target };
}

const side = (sign: string, d: DocBuilder) => ({ side: { sign: d.val(`"${sign}"`) } });

describe('core.split', () => {
  it('divides a body into two pieces, the positive one keeping its identity, each with a split face', () => {
    const { d, target } = splitBox({ both: {} });
    const ev = build(d);
    const pieces = bodies(ev, d);
    expect(pieces).toHaveLength(2);
    for (const p of pieces) expect(volume(ev, p)).toBeCloseTo(500, 6);
    const positive = pieces.find((p) => centroid(ev, p)[0] > 0) as NamedEntity;
    const negative = pieces.find((p) => centroid(ev, p)[0] < 0) as NamedEntity;
    expect(positive.ladder).toEqual((target.entity as EntityRecord).id);
    expect(negative.ladder).not.toEqual(positive.ladder);
    const chain = (ev.names.get(negative.ladder[0] as string) as Json).chain as Json[];
    expect(chain.map((step) => step.key)).toEqual([{ split: {} }]);
    // The pieces share no sub-shape.
    const keysOf = (body: NamedEntity) => {
      const t = ev.adapter.topology(body.body);
      return [...t.faces, ...t.edges.map((e) => e.edge), ...t.vertices.map((v) => v.vertex)];
    };
    expect(keysOf(positive).filter((key) => keysOf(negative).includes(key))).toEqual([]);
    const split = faces(ev, d).filter((f) => roleOf(ev, f) === 'split');
    expect(split).toHaveLength(2);
    expect(new Set(split.map((f) => f.body)).size).toBe(2);
    for (const f of split) expect(centroid(ev, f)[0]).toBeCloseTo(0, 9);

    // A pick on either piece's split face, or on either piece, finds that one alone.
    for (const e of [...split, ...pieces]) {
      const r = resolve(writeRecord(e, stateOf(ev, d), ev.adapter), stateOf(ev, d), ev.adapter);
      expect(r.outcome).toBe('same');
      expect(r.outcome === 'same' && r.entities.map((x) => x.key)).toEqual([e.key]);
    }
  });

  it('splits a sphere and a cylinder through their axes, where seams and poles lie on the plane', () => {
    for (const make of [(d: DocBuilder) => sphere(d, 8), (d: DocBuilder) => cylinder(d, 5, 10)]) {
      const d = new DocBuilder();
      const feature = make(d);
      d.feature('core.split', {
        targets: makeSet([primitiveBody(d, feature)]),
        tool: { standard: { name: 'xz' } },
        keep: { both: {} },
      });
      const ev = build(d);
      const pieces = bodies(ev, d);
      expect(pieces).toHaveLength(2);
      const [a, b] = pieces.map((p) => volume(ev, p)) as [number, number];
      expect(a).toBeCloseTo(b, 6);
      expect(pieces.map((p) => Math.sign(centroid(ev, p)[1])).sort()).toEqual([-1, 1]);
    }
  });

  it('keeps one side', () => {
    for (const [sign, x] of [
      ['positive', 5],
      ['negative', -5],
    ] as const) {
      const { d } = splitBox({});
      const timeline = ((d.document().parts as Json[])[0] as Json).timeline as Json[];
      ((timeline.at(-1) as Json).inputs as Json).keep = side(sign, d);
      const ev = build(d);
      const [piece, ...rest] = bodies(ev, d);
      expect(rest).toEqual([]);
      expect(volume(ev, piece as NamedEntity)).toBeCloseTo(500, 6);
      expect(centroid(ev, piece as NamedEntity)[0]).toBeCloseTo(x, 6);
      expect(faces(ev, d).filter((f) => roleOf(ev, f) === 'split')).toHaveLength(1);
    }
  });

  it('pauses when the plane misses the body', () => {
    const { d } = splitBox({ both: {} }, 5);
    expect(evaluate(d).pauses.map((p) => p.message)).toEqual([expect.stringContaining('does not cross')]);
  });

  it('pauses on a face target', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (sk) => sk.rect(-10, 0, 20, 10));
    const region = s.region([1, 1]);
    d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: '5 mm' }] });
    const before = build(d);
    const face = faces(before, d)[0] as NamedEntity;
    const record = writeRecord(face, stateOf(before, d), before.adapter);
    const names = JSON.parse(JSON.stringify(before.names.usedBy(record))) as Record<string, never>;
    d.names.adopt(Object.entries(names));
    d.feature('core.split', {
      targets: makeSet([{ entity: record }]),
      tool: { standard: { name: 'yz' } },
      keep: { both: {} },
    });
    expect(evaluate(d).pauses.map((p) => p.message)).toEqual([expect.stringContaining('splitting faces')]);
  });
});
