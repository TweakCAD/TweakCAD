/**
 * Keep Tools on the real kernel: `core.boolean`, a feature's operation and a
 * joining pattern keep their tool bodies under their own names, and the faces
 * a copy of the tool leaves in the target carry the `tool` copy step, so a
 * pick on either keeps its entity through an upstream edit.
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
  type ShapeKey,
  type Vec3,
} from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';

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

function build(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  expect(ev.pauses).toEqual([]);
  const part = ev.parts.get(d.partId)!;
  // Every sub-shape of every live body has a name.
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
const centroid = (ev: Evaluation, key: ShapeKey) => ev.adapter.measures(key).centroid as Vec3;
const keysOf = (ev: Evaluation, e: NamedEntity) =>
  ((ev.names.get(e.ladder[0] as string) as Json).chain as Json[]).map((s) => s.key);
const hasToolStep = (ev: Evaluation, e: NamedEntity) =>
  keysOf(ev, e).some((key) => JSON.stringify(key) === JSON.stringify({ tool: {} }));
const pick = (ev: Evaluation, d: DocBuilder, e: NamedEntity): EntityRecord =>
  writeRecord(e, stateOf(ev, d), ev.adapter);
function found(ev: Evaluation, d: DocBuilder, record: EntityRecord): NamedEntity {
  const r = resolve(record, stateOf(ev, d), ev.adapter);
  expect(r.outcome).toBe('same');
  return (r.outcome === 'same' ? r.entities[0] : undefined) as NamedEntity;
}
/** The one face of `body` whose centroid has y = `y`, chosen by whether its name carries the tool step. */
function faceAt(ev: Evaluation, d: DocBuilder, body: ShapeKey | undefined, y: number, fromTool: boolean): NamedEntity {
  const shape = body === undefined ? undefined : stateOf(ev, d).bodies.get(body);
  const hits = faces(ev, d).filter(
    (f) =>
      (shape === undefined || f.body === shape) &&
      Math.abs(centroid(ev, f.key)[1] - y) < 1e-6 &&
      hasToolStep(ev, f) === fromTool,
  );
  expect(hits).toHaveLength(1);
  return hits[0] as NamedEntity;
}

const bodyRef = (d: DocBuilder, region: Json, feature: string): Json => {
  const record = region.entity as EntityRecord;
  const src = (d.names.get(record.id[record.id.length - 1] as string) as { src: never }).src;
  const id = ladderOf({ kind: 'body', chain: [], feature, role: 'body', src }, d.names);
  return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
};

function setKeepTools(d: DocBuilder, feature: string): void {
  const timeline = ((d.document().parts as Json[])[0] as Json).timeline as Json[];
  (((timeline.find((f) => f.id === feature) as Json).inputs as Json).operation as Json).keepTools = d.val('true');
}

/**
 * A 20 × 10 × 5 target from the origin and a 10 × 6 tool of height `toolHeight`
 * at x 15–25, y 2–8, overlapping it by 5 × 6 × 5.
 */
function twoBoxes(toolHeight = '8 mm') {
  const d = new DocBuilder();
  const a = d.sketch('xy', (s) => s.rect(0, 0, 20, 10));
  const ra = a.region([1, 1]);
  const ea = d.extrude({ sketch: a.feature, profiles: [ra], sides: [{ distance: '5 mm' }] });
  const b = d.sketch('xy', (s) => s.rect(15, 2, 10, 6));
  const rb = b.region([24, 7]);
  const eb = d.extrude({ sketch: b.feature, profiles: [rb], sides: [{ distance: toolHeight }] });
  return { d, target: bodyRef(d, ra, ea), tool: bodyRef(d, rb, eb) };
}

function combine(op: string, keep: boolean, toolHeight?: string) {
  const t = twoBoxes(toolHeight);
  const feature = t.d.feature('core.boolean', {
    target: t.target,
    tools: makeSet([t.tool]),
    op: t.d.val(`"${op}"`),
    keepTools: t.d.val(String(keep)),
  });
  return { ...t, feature };
}

const VOLUMES: Record<string, number> = { join: 1000 + 480 - 150, cut: 1000 - 150, intersect: 150 };

describe('Combine with Keep Tools', () => {
  for (const op of ['join', 'cut', 'intersect']) {
    it(`${op}: the tool stays with every name it had; the target takes its faces under the tool step`, () => {
      const plain = twoBoxes();
      const before = build(plain.d);
      const toolBody = bodies(before, plain.d).find((b) => Math.abs(volume(before, b) - 480) < 1e-6) as NamedEntity;
      const toolNames = all(before, plain.d)
        .filter((e) => e.body === toolBody.body)
        .map((e) => e.ladder.join())
        .sort();

      const t = combine(op, true);
      const ev = build(t.d);
      const after = bodies(ev, t.d);
      expect(after.map((b) => volume(ev, b)).sort((x, y) => x - y)).toEqual(
        [VOLUMES[op], 480].sort((x, y) => (x as number) - (y as number)).map((v) => expect.closeTo(v as number, 6)),
      );
      const kept = after.find((b) => b.ladder.join() === toolBody.ladder.join()) as NamedEntity;
      expect(volume(ev, kept)).toBeCloseTo(480, 6);
      expect(
        all(ev, t.d)
          .filter((e) => e.body === kept.body)
          .map((e) => e.ladder.join())
          .sort(),
      ).toEqual(toolNames);

      // The target keeps its identity, and no name of it is a name of the kept tool.
      const target = after.find((b) => b !== kept) as NamedEntity;
      expect(target.ladder).toEqual((t.target.entity as EntityRecord).id);
      const keptHashes = new Set(
        all(ev, t.d)
          .filter((e) => e.body === kept.body)
          .flatMap((e) => e.ladder),
      );
      expect(all(ev, t.d).filter((e) => e.body === target.body && e.ladder.some((h) => keptHashes.has(h)))).toEqual([]);
      expect(faces(ev, t.d).filter((f) => f.body === target.body && hasToolStep(ev, f)).length).toBeGreaterThan(0);
    });

    it(`${op}: picks on the kept tool and on the target's face from it survive a taller tool`, () => {
      const d1 = combine(op, true);
      const before = build(d1.d);
      const kept = bodies(before, d1.d).find((b) => Math.abs(volume(before, b) - 480) < 1e-6) as NamedEntity;
      const target = bodies(before, d1.d).find((b) => b !== kept) as NamedEntity;
      const onTool = pick(before, d1.d, faceAt(before, d1.d, kept.key, 2, false));
      const onTarget = pick(before, d1.d, faceAt(before, d1.d, target.key, 2, true));

      const d2 = combine(op, true, '9 mm');
      const after = build(d2.d);
      const toolFace = found(after, d2.d, onTool);
      expect(centroid(after, toolFace.key)).toEqual([
        expect.closeTo(20, 9),
        expect.closeTo(2, 9),
        expect.closeTo(4.5, 9),
      ]);
      const targetFace = found(after, d2.d, onTarget);
      expect(centroid(after, targetFace.key)[1]).toBeCloseTo(2, 9);
      expect(hasToolStep(after, targetFace)).toBe(true);
      expect(targetFace.body).not.toBe(toolFace.body);
    });
  }

  it('uses the tool up without Keep Tools', () => {
    const t = combine('cut', false);
    const ev = build(t.d);
    expect(bodies(ev, t.d).map((b) => volume(ev, b))).toEqual([expect.closeTo(850, 6)]);
    expect(faces(ev, t.d).filter((f) => hasToolStep(ev, f))).toEqual([]);
  });
});

describe('an operation that keeps its tool', () => {
  /** The 20 × 10 target of height `height`, and an extrude of the tool profile cutting it with Keep Tools. */
  function cutKeeping(height: string) {
    const d = new DocBuilder();
    const a = d.sketch('xy', (s) => s.rect(0, 0, 20, 10));
    d.extrude({ sketch: a.feature, profiles: [a.region([1, 1])], sides: [{ distance: height }] });
    const b = d.sketch('xy', (s) => s.rect(15, 2, 10, 6));
    const cut = d.extrude({
      sketch: b.feature,
      profiles: [b.region([24, 7])],
      sides: [{ distance: '8 mm' }],
      op: 'cut',
    });
    setKeepTools(d, cut);
    return d;
  }

  it('cuts the target and leaves the extruded tool a new body under the extrude’s names', () => {
    const d = cutKeeping('5 mm');
    const ev = build(d);
    expect(
      bodies(ev, d)
        .map((b) => volume(ev, b))
        .sort((x, y) => x - y),
    ).toEqual([expect.closeTo(480, 6), expect.closeTo(850, 6)]);
    const tool = bodies(ev, d).find((b) => Math.abs(volume(ev, b) - 480) < 1e-6) as NamedEntity;
    expect(keysOf(ev, tool)).toEqual([]);
    expect(
      faces(ev, d)
        .filter((f) => f.body === tool.body)
        .every((f) => !hasToolStep(ev, f)),
    ).toBe(true);
  });

  it('keeps picks on the kept tool and on the cut wall when the target gets taller', () => {
    const d1 = cutKeeping('5 mm');
    const before = build(d1);
    const tool = bodies(before, d1).find((b) => Math.abs(volume(before, b) - 480) < 1e-6) as NamedEntity;
    const target = bodies(before, d1).find((b) => b !== tool) as NamedEntity;
    const onTool = pick(before, d1, faceAt(before, d1, tool.key, 2, false));
    const wall = pick(before, d1, faceAt(before, d1, target.key, 2, true));
    const d2 = cutKeeping('6 mm');
    const after = build(d2);
    expect(centroid(after, found(after, d2, onTool).key)[2]).toBeCloseTo(4, 9);
    const moved = found(after, d2, wall);
    expect(centroid(after, moved.key)).toEqual([expect.closeTo(17.5, 9), expect.closeTo(2, 9), expect.closeTo(3, 9)]);
  });

  it('pauses a feature pattern of a feature that keeps its tool', () => {
    const d = cutKeeping('5 mm');
    const timeline = ((d.document().parts as Json[])[0] as Json).timeline as Json[];
    const cut = (timeline[timeline.length - 1] as Json).id as string;
    d.feature('core.pattern', {
      of: { features: makeSet([{ object: { feature: { id: cut } } }]) },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"y"'), reversed: d.val('false') } },
              count: d.val('2'),
              spacing: { equal: { s: d.val('3 mm') } },
            },
          ],
        },
      },
      skip: makeSet([]),
      vary: [],
      operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.val('false') },
    });
    const ev = evaluateDocument(d.document(), k);
    builds.push(ev);
    expect(ev.pauses.map((p) => p.message)).toEqual([expect.stringMatching(/keeps its tool body/)]);
  });
});

describe('a joining pattern that keeps its copies', () => {
  it('leaves every copy a body and joins copies of those that meet the seed', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.rect(0, 0, 10, 10));
    const region = s.region([1, 1]);
    const extrude = d.extrude({ sketch: s.feature, profiles: [region], sides: [{ distance: '5 mm' }] });
    d.feature('core.pattern', {
      of: { bodies: makeSet([bodyRef(d, region, extrude)]) },
      layout: {
        linear: {
          directions: [
            {
              direction: { axis: { axis: d.val('"x"'), reversed: d.val('false') } },
              count: d.val('3'),
              spacing: { equal: { s: d.val('5 mm') } },
            },
          ],
        },
      },
      skip: makeSet([]),
      vary: [],
      operation: { op: d.val('"join"'), targets: { all: {} }, keepTools: d.val('true') },
    });
    const ev = build(d);
    // The seed joined with both copies, and the two copies kept.
    expect(
      bodies(ev, d)
        .map((b) => volume(ev, b))
        .sort((x, y) => x - y),
    ).toEqual([expect.closeTo(500, 6), expect.closeTo(500, 6), expect.closeTo(1000, 6)]);
    const kept = bodies(ev, d).filter((b) => Math.abs(volume(ev, b) - 500) < 1e-6);
    expect(kept.map((b) => keysOf(ev, b))).toEqual(
      expect.arrayContaining([[{ slot: { i: 1, j: 0 } }], [{ slot: { i: 2, j: 0 } }]]),
    );
  });
});
