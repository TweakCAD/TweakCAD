/**
 * Attached frames and directions on the real kernel: the attachment modes,
 * a plane on a planar face, and directions read from construction geometry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument, writeRecord, type NamedEntity } from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Frame, Json } from './context';
import { box, cylinder, fixedFrame, placement, primitive } from './primitivesDocs';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function run(d: DocBuilder): Evaluation {
  const doc = d.document();
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

function frameOfFeature(d: DocBuilder, id: string): Frame {
  const ev = run(d);
  expect(ev.pauses).toEqual([]);
  const output = ev.parts.get(d.partId)?.construction.get(id);
  expect(output).toBeDefined();
  return (output as { frame: Frame }).frame;
}

const close = (v: readonly number[]) => v.map((x) => expect.closeTo(x, 9));
const byFeature = (id: string): Json => ({ object: { feature: { id } } });
const attach = (d: DocBuilder, mode: string, support: Json[], xAxis?: Json): Json => ({
  attach: {
    support,
    mode: d.val(`"${mode}"`),
    offset: placement(d),
    flip: d.val('false'),
    ...(xAxis ? { xAxis } : {}),
  },
});
const point = (d: DocBuilder, at: readonly number[]) =>
  d.feature('core.constructionPoint', { frame: fixedFrame(d, at) });
const frameFeature = (d: DocBuilder, frame: Json) => d.feature('core.constructionFrame', { frame });

describe('attachment modes', () => {
  it('puts a plane on a planar face: its outward normal, the part origin and x projected onto it', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const ev = run(d);
    const part = ev.parts.get(d.partId);
    const top = [...(part?.state.entities.values() ?? [])].find(
      (e) => e.kind === 'face' && Math.abs((ev.adapter.measures(e.key).centroid as number[])[2] - 5) < 1e-9,
    );
    if (!part) throw new Error('no part');
    const record = writeRecord(top as NamedEntity, part.state, ev.adapter);
    for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
    const id = frameFeature(d, attach(d, 'plane', [{ entity: record }]));
    const frame = frameOfFeature(d, id);
    expect(frame.origin).toEqual(close([0, 0, 5]));
    expect(frame.normal).toEqual(close([0, 0, 1]));
    expect(frame.x).toEqual(close([1, 0, 0]));
  });

  it('puts the origin of planeAtPoint at the point projected onto the plane', () => {
    const d = new DocBuilder();
    const p = point(d, [3, 4, 9]);
    const id = frameFeature(d, attach(d, 'planeAtPoint', [{ standard: { name: 'xy' } }, byFeature(p)]));
    const frame = frameOfFeature(d, id);
    expect(frame.origin).toEqual(close([3, 4, 0]));
    expect(frame.normal).toEqual(close([0, 0, 1]));
  });

  it('makes a frame from three points: origin p1, x towards p2, z along (p2 - p1) x (p3 - p1)', () => {
    const d = new DocBuilder();
    const [p1, p2, p3] = [point(d, [1, 1, 1]), point(d, [2, 1, 1]), point(d, [1, 1, 2])];
    const id = frameFeature(d, attach(d, 'threePoints', [p1, p2, p3].map(byFeature)));
    const frame = frameOfFeature(d, id);
    expect(frame.origin).toEqual(close([1, 1, 1]));
    expect(frame.x).toEqual(close([1, 0, 0]));
    expect(frame.normal).toEqual(close([0, -1, 0]));
    expect(frame.y).toEqual(close([0, 0, 1]));
  });

  it('pauses on three collinear points', () => {
    const d = new DocBuilder();
    const [p1, p2, p3] = [point(d, [0, 0, 0]), point(d, [1, 0, 0]), point(d, [2, 0, 0])];
    const id = frameFeature(d, attach(d, 'threePoints', [p1, p2, p3].map(byFeature)));
    const ev = run(d);
    expect(ev.pauses).toEqual([{ feature: id, message: expect.stringMatching(/collinear/) }]);
  });

  it('runs z of twoPoints from p1 towards p2, x the part x projected, y when x is along z', () => {
    const d = new DocBuilder();
    const [p1, p2, p3] = [point(d, [1, 2, 3]), point(d, [1, 2, 13]), point(d, [5, 2, 3])];
    const up = frameFeature(d, attach(d, 'twoPoints', [p1, p2].map(byFeature)));
    const along = frameFeature(d, attach(d, 'twoPoints', [p1, p3].map(byFeature)));
    const ev = run(d);
    expect(ev.pauses).toEqual([]);
    const frames = ev.parts.get(d.partId)?.construction;
    const [a, b] = [frames?.get(up)?.frame, frames?.get(along)?.frame] as [Frame, Frame];
    expect(a.origin).toEqual(close([1, 2, 3]));
    expect(a.normal).toEqual(close([0, 0, 1]));
    expect(a.x).toEqual(close([1, 0, 0]));
    // z along the part x: x is the part y.
    expect(b.normal).toEqual(close([1, 0, 0]));
    expect(b.x).toEqual(close([0, 1, 0]));
    expect(b.y).toEqual(close([0, 0, 1]));
  });

  it('pauses twoPoints on coincident points', () => {
    const d = new DocBuilder();
    const [p1, p2] = [point(d, [1, 1, 1]), point(d, [1, 1, 1])];
    const id = frameFeature(d, attach(d, 'twoPoints', [p1, p2].map(byFeature)));
    expect(run(d).pauses).toEqual([{ feature: id, message: expect.stringMatching(/coincide/) }]);
  });

  it('puts a point frame at a vertex of a body, with the part axes', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const ev = run(d);
    const part = ev.parts.get(d.partId);
    if (!part) throw new Error('no part');
    const corner = [...part.state.entities.values()].find((e) => {
      const p = e.kind === 'vertex' ? (ev.adapter.measures(e.key).point as number[]) : undefined;
      return p !== undefined && p.every((v) => v > 0);
    });
    const record = writeRecord(corner as NamedEntity, part.state, ev.adapter);
    for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
    const id = d.feature('core.constructionPoint', { frame: attach(d, 'point', [{ entity: record }]) });
    const frame = frameOfFeature(d, id);
    expect(frame.origin).toEqual(close([10, 10, 5]));
    expect(frame.x).toEqual(close([1, 0, 0]));
    expect(frame.normal).toEqual(close([0, 0, 1]));
  });

  it('runs an alongLine axis along a straight edge from its start, and along a default axis', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const ev = run(d);
    const part = ev.parts.get(d.partId);
    if (!part) throw new Error('no part');
    // The vertical edge at x = 10, y = 10.
    const edge = [...part.state.entities.values()].find((e) => {
      if (e.kind !== 'edge') return false;
      const g = ev.adapter.edgeGeometry(e.key);
      const [s, t] = [g.start as number[], g.end as number[]];
      return g.curve.kind === 'line' && [s[0], s[1], t[0], t[1]].every((v) => Math.abs((v as number) - 10) < 1e-9);
    }) as NamedEntity;
    const g = ev.adapter.edgeGeometry(edge.key);
    const record = writeRecord(edge, part.state, ev.adapter);
    for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
    const id = d.feature('core.constructionAxis', { frame: attach(d, 'alongLine', [{ entity: record }]) });
    const onX = frameFeature(d, attach(d, 'alongLine', [{ standard: { name: 'x' } }]));
    const built = run(d);
    expect(built.pauses).toEqual([]);
    const frames = built.parts.get(d.partId)?.construction;
    const axis = frames?.get(id)?.frame as Frame;
    expect(axis.origin).toEqual(close(g.start as number[]));
    expect(axis.normal).toEqual(close([0, 0, (g.end as number[])[2] > (g.start as number[])[2] ? 1 : -1]));
    expect(axis.x).toEqual(close([1, 0, 0]));
    const x = frames?.get(onX)?.frame as Frame;
    expect(x.origin).toEqual(close([0, 0, 0]));
    expect(x.normal).toEqual(close([1, 0, 0]));
    expect(x.x).toEqual(close([0, 1, 0]));
  });

  it('pauses alongLine on a curved edge', () => {
    const d = new DocBuilder();
    const s = d.sketch('xy', (x) => x.circle(0, 0, 5));
    d.extrude({ sketch: s.feature, profiles: [s.region([0, 0])], sides: [{ distance: '4 mm' }] });
    const ev = run(d);
    const part = ev.parts.get(d.partId);
    if (!part) throw new Error('no part');
    const rim = [...part.state.entities.values()].find(
      (e) => e.kind === 'edge' && ev.adapter.edgeGeometry(e.key).curve.kind === 'circle',
    ) as NamedEntity;
    const record = writeRecord(rim, part.state, ev.adapter);
    for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
    const id = d.feature('core.constructionAxis', { frame: attach(d, 'alongLine', [{ entity: record }]) });
    expect(run(d).pauses).toEqual([{ feature: id, message: expect.stringMatching(/not straight/) }]);
  });

  it('pauses on a mode given the wrong number of supports', () => {
    const d = new DocBuilder();
    const id = frameFeature(d, attach(d, 'planeAtPoint', [{ standard: { name: 'xy' } }]));
    expect(run(d).pauses).toEqual([{ feature: id, message: expect.stringMatching(/takes 2 supports/) }]);
  });
});

describe('directions from construction geometry', () => {
  it('reads x along a construction axis', () => {
    const d = new DocBuilder();
    // The axis is its frame's z: turned -90 deg about x, it runs along +y.
    const axis = d.feature('core.constructionAxis', { frame: { fixed: { placement: placement(d, [0, 0, 0], -90) } } });
    const id = frameFeature(
      d,
      attach(d, 'plane', [{ standard: { name: 'xy' } }], { along: { ref: byFeature(axis), reversed: d.val('false') } }),
    );
    const frame = frameOfFeature(d, id);
    expect(frame.x).toEqual(close([0, 1, 0]));
    expect(frame.y).toEqual(close([-1, 0, 0]));
  });

  it('reads x along the normal of a construction plane, reversed', () => {
    const d = new DocBuilder();
    const plane = d.feature('core.constructionPlane', { frame: attach(d, 'plane', [{ standard: { name: 'xz' } }]) });
    const id = frameFeature(
      d,
      attach(d, 'plane', [{ standard: { name: 'xy' } }], {
        normal: { ref: byFeature(plane), reversed: d.val('true') },
      }),
    );
    const frame = frameOfFeature(d, id);
    // The XZ plane's normal is +Y; reversed, x runs along −Y.
    expect(frame.x).toEqual(close([0, -1, 0]));
  });
});

describe('the midplane, faceAxis and center modes', () => {
  /** The record of the first entity of the built part that `test` holds for, with its names interned in `d`. */
  function recordOf(d: DocBuilder, test: (e: NamedEntity, ev: Evaluation) => boolean): Json {
    const ev = run(d);
    const part = ev.parts.get(d.partId);
    if (!part) throw new Error('no part');
    const found = [...part.state.entities.values()].find((e) => test(e, ev));
    if (!found) throw new Error('no such entity');
    const record = writeRecord(found, part.state, ev.adapter);
    for (const name of Object.values(ev.names.toJson())) d.names.intern(name);
    return { entity: record };
  }
  const faceAt = (axis: number, at: number) => (e: NamedEntity, ev: Evaluation) => {
    if (e.kind !== 'face') return false;
    const m = ev.adapter.measures(e.key);
    return m.surface === 'plane' && Math.abs((m.centroid as number[])[axis] - at) < 1e-9;
  };

  it('puts a midplane halfway between two parallel planes or faces, either way round', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const top = recordOf(d, faceAt(2, 5));
    const bottom = recordOf(d, faceAt(2, -5));
    const between = frameFeature(d, attach(d, 'midplane', [top, bottom]));
    const raised = d.feature('core.constructionPlane', {
      frame: {
        attach: {
          support: [{ standard: { name: 'xy' } }],
          mode: d.val('"plane"'),
          offset: placement(d, [0, 0, 12]),
          flip: d.val('false'),
        },
      },
    });
    const toPlane = frameFeature(d, attach(d, 'midplane', [byFeature(raised), { standard: { name: 'xy' } }]));
    const ev = run(d);
    expect(ev.pauses).toEqual([]);
    const frames = ev.parts.get(d.partId)?.construction;
    const a = frames?.get(between)?.frame as Frame;
    expect(a.origin).toEqual(close([0, 0, 0]));
    expect(a.normal).toEqual(close([0, 0, 1]));
    expect(a.x).toEqual(close([1, 0, 0]));
    const b = frames?.get(toPlane)?.frame as Frame;
    expect(b.origin).toEqual(close([0, 0, 6]));
    expect(b.normal).toEqual(close([0, 0, 1]));
  });

  it('bisects two faces that meet, through their edge, running through the body', () => {
    const d = new DocBuilder();
    box(d, 20, 20, 10);
    const top = recordOf(d, faceAt(2, 5));
    const side = recordOf(d, faceAt(0, 10));
    const id = frameFeature(d, attach(d, 'midplane', [top, side]));
    const frame = frameOfFeature(d, id);
    const s = Math.SQRT1_2;
    expect(frame.normal).toEqual(close([-s, 0, s]));
    // Through the edge x = 10, z = 5: the part origin projected onto it.
    expect(frame.origin).toEqual(close([2.5, 0, -2.5]));
  });

  it('runs a faceAxis axis along a cylinder face, through the point nearest its centre of mass', () => {
    const d = new DocBuilder();
    cylinder(d, 5, 20, { at: [3, 4, 1] });
    const wall = recordOf(d, (e, ev) => e.kind === 'face' && ev.adapter.measures(e.key).surface === 'cylinder');
    const id = d.feature('core.constructionAxis', { frame: attach(d, 'faceAxis', [wall]) });
    const frame = frameOfFeature(d, id);
    expect(frame.origin).toEqual(close([3, 4, 1]));
    expect(frame.normal).toEqual(close([0, 0, 1]));
  });

  it('puts a center point at the centre of a circular edge or a sphere, and pauses on a flat face', () => {
    const d = new DocBuilder();
    cylinder(d, 5, 20, { at: [3, 4, 1] });
    primitive(d, 'sphere', { radius: '4 mm' }, { at: [40, 2, 3] });
    const rim = recordOf(d, (e, ev) => {
      if (e.kind !== 'edge' || ev.adapter.measures(e.key).curve !== 'circle') return false;
      return Math.abs((ev.adapter.measures(e.key).center as number[])[2] - 11) < 1e-9;
    });
    const ball = recordOf(d, (e, ev) => e.kind === 'face' && ev.adapter.measures(e.key).surface === 'sphere');
    const flat = recordOf(d, faceAt(2, 11));
    const onRim = d.feature('core.constructionPoint', { frame: attach(d, 'center', [rim]) });
    const inBall = d.feature('core.constructionPoint', { frame: attach(d, 'center', [ball]) });
    const wrong = d.feature('core.constructionPoint', { frame: attach(d, 'center', [flat]) });
    const ev = run(d);
    expect(ev.pauses).toEqual([{ feature: wrong, message: expect.stringMatching(/not a sphere or a torus/) }]);
    const frames = ev.parts.get(d.partId)?.construction;
    expect(frames?.get(onRim)?.frame.origin).toEqual(close([3, 4, 11]));
    expect(frames?.get(inBall)?.frame.origin).toEqual(close([40, 2, 3]));
  });
});
