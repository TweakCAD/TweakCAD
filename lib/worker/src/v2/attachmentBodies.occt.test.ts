/**
 * The wrong-attachment suite on a part of several bodies: a box with a hole
 * cut by a boolean and shelled open at the top, a row of pins made by a
 * pattern, and a revolved ring that is moved and mirrored. Every face, edge
 * and vertex is picked, one edit is made, and each pick is judged by
 * geometry (see `attachmentOracle.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { ladderOf, makeSet, readDocument, type EntityRecord, type Vec3 } from '@tweakcad/format';
import { DocBuilder } from './docBuilder';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Json } from './context';
import { box, cylinder, bodyRef, boolean } from './primitivesDocs';
import { judge, same, turning, type Move, type Outcome } from './attachmentOracle';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

/** What an edit changes. Lengths in mm, angles in degrees. */
interface Params {
  width: number;
  height: number;
  holeX: number;
  holeRadius: number;
  wall: number;
  pins: number;
  pitch: number;
  ringAngle: number;
  lift: number;
  /** A mirror of the ring, added at the end. */
  mirror: boolean;
}

const BASE: Params = {
  width: 40,
  height: 10,
  holeX: 8,
  holeRadius: 4,
  wall: 1.5,
  pins: 3,
  pitch: -8,
  ringAngle: 60,
  lift: 2,
  mirror: false,
};

const record = (id: string[]): EntityRecord =>
  ({ id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} }) as unknown as EntityRecord;
const operation = (d: DocBuilder, op = 'new') => ({
  op: d.val(`"${op}"`),
  targets: { all: {} },
  keepTools: d.val('false'),
});

function model(p: Params): { d: DocBuilder; off: string[] } {
  const d = new DocBuilder();
  const off: string[] = [];
  const block = box(d, p.width, 30, p.height, { at: [0, 0, p.height / 2] });
  const drill = cylinder(d, p.holeRadius, 30, { at: [p.holeX, 0, p.height / 2] });
  boolean(d, 'cut', bodyRef(d, block), [bodyRef(d, drill)]);
  const top = ladderOf({ kind: 'face', chain: [], feature: block, role: '+z', src: [] }, d.names);
  d.feature('core.shell', {
    bodies: makeSet([bodyRef(d, block)]),
    remove: makeSet([{ entity: record(top) }]),
    thickness: d.val(`${p.wall} mm`),
    direction: d.val('"inside"'),
  });

  const pin = box(d, 4, 4, 6, { at: [-p.width / 2 - 10, -10, 3] });
  d.feature('core.pattern', {
    of: { bodies: makeSet([bodyRef(d, pin)]) },
    layout: {
      linear: {
        directions: [
          {
            direction: { axis: { axis: d.val('"x"'), reversed: d.val('false') } },
            count: d.val(String(p.pins)),
            spacing: { equal: { s: d.val(`${p.pitch} mm`) } },
          },
        ],
      },
    },
    skip: makeSet([]),
    vary: [],
    operation: operation(d),
  });

  // On the XZ plane sketch x is world X and sketch y is world −Z: the ring's profile stands from z = 0 to 6.
  const s = d.sketch('xz', (x) => x.rect(30, -6, 4, 6));
  const region = s.region([31, -1]);
  const ring = d.feature('core.revolve', {
    profiles: makeSet([region]),
    axis: { along: { ref: { standard: { name: 'z' } }, reversed: d.val('false') } },
    sides: [{ angle: { a: d.val(`${p.ringAngle} deg`) } }],
    thin: { solid: {} },
    operation: operation(d),
  });
  const regionName = d.names.get((region.entity as { id: string[] }).id.at(-1) as string) as { src: never };
  const ringBody = {
    entity: record(ladderOf({ kind: 'body', chain: [], feature: ring, role: 'body', src: regionName.src }, d.names)),
  };
  d.feature('core.move', {
    of: { bodies: makeSet([ringBody]) },
    transform: d.val(`placement(vector(0 mm, 0 mm, ${p.lift} mm), rotate(vector(0, 0, 1), 0 deg))`),
    copy: d.val('false'),
  });
  const mirror = d.feature('core.mirror', {
    of: { bodies: makeSet([ringBody]) },
    plane: { standard: { name: 'yz' } },
    operation: operation(d),
  });
  if (!p.mirror) off.push(mirror);
  return { d, off };
}

function evaluate(b: { d: DocBuilder; off: string[] }): Evaluation {
  const doc = structuredClone(b.d.document());
  for (const f of (doc.parts as Json[])[0]!.timeline as Json[]) {
    if (b.off.includes(f.id as string))
      ((f.suppressed as Json).def as Json).expr = { text: 'true', grammar: 1, refs: {} };
  }
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  expect(ev.pauses).toEqual([]);
  return ev;
}

function check(edit: Partial<Params>, move: Move): Outcome {
  const a = model(BASE);
  const b = model({ ...BASE, ...edit });
  return judge(evaluate(a), evaluate(b), a.d.partId, move);
}

const EPS = 0.1;
const inside = (p: Vec3, w = BASE.width) => Math.abs(p[0]) <= w / 2 + EPS && Math.abs(p[1]) <= 15 + EPS;
const near = (v: number, at: number) => Math.abs(v - at) <= EPS;
const polar = (p: Vec3) => (Math.atan2(p[1], p[0]) * 180) / Math.PI;
const radial = (p: Vec3) => Math.hypot(p[0], p[1]);
const onRing = (p: Vec3) =>
  radial(p) >= 30 - EPS &&
  radial(p) <= 34 + EPS &&
  ((polar(p) >= -1 && polar(p) <= 61) || polar(p) >= 119 || polar(p) <= -179);
const inPins = (p: Vec3) => p[0] <= -27.9 && p[1] >= -12 - EPS && p[1] <= -8 + EPS;
const inner = BASE.width / 2 - BASE.wall;

/** Each coordinate moves on its own: `rules` give a point's shift per axis. */
const shift =
  (...rules: ((p: Vec3) => Vec3 | null)[]): Move =>
  (p) => {
    let q: Vec3 = [...p];
    for (const rule of rules) {
      const by = rule(p);
      if (by) q = [q[0] + by[0], q[1] + by[1], q[2] + by[2]];
    }
    return q;
  };

/** Turns points and directions of the ring's far end by `deg` about z. */
function turnRingEnd(at: number, deg: number): Move {
  const r = (deg * Math.PI) / 180;
  const rot = (v: Vec3): Vec3 => [
    v[0] * Math.cos(r) - v[1] * Math.sin(r),
    v[0] * Math.sin(r) + v[1] * Math.cos(r),
    v[2],
  ];
  const atEnd = (p: Vec3) => radial(p) >= 30 - EPS && radial(p) <= 34 + EPS && Math.abs(polar(p) - at) <= 3;
  return turning(
    (p) => (atEnd(p) ? rot(p) : p),
    (d, p) => (atEnd(p) ? rot(d) : d),
  );
}

/** Each edit: what changes, where the unchanged geometry goes, and how many picks may ask. */
const EDITS: [string, Partial<Params>, Move, number][] = [
  [
    'the box gets wider',
    { width: 50 },
    shift(
      (p) => (inside(p) && (near(p[0], 20) || near(p[0], inner)) ? [5, 0, 0] : null),
      (p) => (inside(p) && (near(p[0], -20) || near(p[0], -inner)) ? [-5, 0, 0] : null),
      (p) => (inPins(p) ? [-5, 0, 0] : null),
    ),
    0,
  ],
  ['the box gets taller', { height: 12 }, shift((p) => (inside(p) && p[2] >= BASE.height - EPS ? [0, 0, 2] : null)), 0],
  ['the hole moves', { holeX: 4 }, shift((p) => (Math.hypot(p[0] - 8, p[1]) <= 4 + 1.5 + EPS ? [-4, 0, 0] : null)), 0],
  [
    'the hole gets bigger',
    { holeRadius: 5 },
    (p) => {
      // Everything round the hole moves out by the 1 mm the radius grows.
      const r = Math.hypot(p[0] - 8, p[1]);
      return r > 1e-9 && r <= 4 + 1.5 + EPS ? [8 + ((p[0] - 8) * (r + 1)) / r, (p[1] * (r + 1)) / r, p[2]] : p;
    },
    0,
  ],
  [
    'the wall gets thicker',
    { wall: 2 },
    shift(
      (p) => (inside(p) && near(Math.abs(p[0]), inner) ? [-0.5 * Math.sign(p[0]), 0, 0] : null),
      (p) => (inside(p) && near(Math.abs(p[1]), 15 - BASE.wall) ? [0, -0.5 * Math.sign(p[1]), 0] : null),
      (p) => (inside(p) && near(p[2], BASE.wall) && Math.abs(p[0]) < inner + EPS ? [0, 0, 0.5] : null),
    ),
    0,
  ],
  ['a pin is added', { pins: 4 }, same, 0],
  [
    'the pins spread out',
    { pitch: -10 },
    shift((p) => (inPins(p) ? [-2 * Math.round((-30 - p[0]) / 8), 0, 0] : null)),
    0,
  ],
  ['the ring turns further', { ringAngle: 75 }, turnRingEnd(60, 15), 0],
  ['the ring is lifted higher', { lift: 4 }, shift((p) => (onRing(p) ? [0, 0, 2] : null)), 0],
  ['a mirror of the ring is added', { mirror: true }, same, 0],
];

describe('wrong-attachment suite, several bodies', { timeout: 60_000 }, () => {
  it('builds the part with every feature on', () => {
    const ev = evaluate(model({ ...BASE, mirror: true }));
    const bodies = [...(ev.parts.values().next().value?.state.entities.values() ?? [])].filter(
      (e) => e.kind === 'body',
    );
    expect(bodies).toHaveLength(1 + 3 + 2);
  });

  it('notices picks judged as if the ring had not turned', () => {
    const out = check({ ringAngle: 75 }, same);
    expect(out.wrong.length + out.lost.length).toBeGreaterThan(3);
  });

  for (const [name, edit, move, asks] of EDITS) {
    it(`keeps every pick on its own entity when ${name}`, () => {
      const out = check(edit, move);
      expect(out.checked).toBeGreaterThan(100);
      expect(out.wrong).toEqual([]);
      expect(out.lost).toEqual([]);
      expect(out.asked).toBeLessThanOrEqual(asks);
    });
  }
});
