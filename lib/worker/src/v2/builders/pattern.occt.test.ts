/**
 * Body patterns joining on the real kernel: every copy and every target ends
 * up in the result, however the kernel fuses them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { makeSet, readDocument, type NamedEntity } from '@tweakcad/format';
import { DocBuilder } from '../docBuilder';
import { evaluateDocument, type Evaluation } from '../evaluate';
import { bodyRef, primitive } from '../primitivesDocs';

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
  return ev;
}

const bodies = (ev: Evaluation, d: DocBuilder) =>
  [...ev.parts.get(d.partId)!.state.entities.values()].filter((e) => e.kind === 'body');
const volume = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).volume as number;
const totalVolume = (ev: Evaluation, d: DocBuilder) => bodies(ev, d).reduce((sum, b) => sum + volume(ev, b), 0);
const ball = (r: number) => (4 / 3) * Math.PI * r ** 3;
/** The volume two spheres of radii `r1` and `r2`, `d` apart, share. */
const lens = (r1: number, r2: number, d: number) =>
  (Math.PI * (r1 + r2 - d) ** 2 * (d * d + 2 * d * r2 - 3 * r2 * r2 + 2 * d * r1 + 6 * r1 * r2 - 3 * r1 * r1)) /
  (12 * d);

/** A circular pattern of `body` about the part's y axis, `count` instances over a full turn. */
function patternAboutY(d: DocBuilder, body: Json, count: number, op: string): string {
  return d.feature('core.pattern', {
    of: { bodies: makeSet([body]) },
    layout: {
      circular: {
        axis: { along: { ref: { standard: { name: 'y' } }, reversed: d.val('false') } },
        count: d.val(String(count)),
        angle: d.val('360 deg'),
        symmetric: d.val('false'),
      },
    },
    skip: makeSet([]),
    vary: [],
    operation: { op: d.val(`"${op}"`), targets: { all: {} }, keepTools: d.val('false') },
  });
}

describe('body pattern joining', { timeout: 60_000 }, () => {
  // A bauble of radius 30 with a dot of radius 4 sunk into its surface, patterned eight times around it.
  const ornament = (op: string) => {
    const d = new DocBuilder();
    primitive(d, 'sphere', { radius: '30 mm' }, { at: [0, 30, 0] });
    const dot = primitive(d, 'sphere', { radius: '4 mm' }, { at: [29, 30, 0] });
    patternAboutY(d, bodyRef(d, dot), 8, op);
    return d;
  };

  it('makes the bauble and eight dots as new bodies', () => {
    const d = ornament('new');
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(9);
  });

  it('fuses every copy into the bauble, keeping the bauble and the seed', () => {
    const d = ornament('join');
    const ev = build(d);
    // The seed is a target only where a copy meets it, and no copy meets it, so it stays a body of its own.
    const found = bodies(ev, d).sort((a, b) => volume(ev, a) - volume(ev, b));
    expect(found).toHaveLength(2);
    const [seed, bauble] = found as [NamedEntity, NamedEntity];
    expect(volume(ev, seed)).toBeCloseTo(ball(4), 3);
    // The bauble with the part of each of the seven copies outside it; the copies do not meet each other.
    expect(volume(ev, bauble)).toBeCloseTo(ball(30) + 7 * (ball(4) - lens(30, 4, 29)), 0);
  });

  it('keeps every copy when the copies meet nothing', () => {
    const d = new DocBuilder();
    const dot = primitive(d, 'sphere', { radius: '4 mm' }, { at: [29, 30, 0] });
    patternAboutY(d, bodyRef(d, dot), 8, 'join');
    const ev = build(d);
    expect(bodies(ev, d)).toHaveLength(8);
    expect(totalVolume(ev, d)).toBeCloseTo(8 * ball(4), 3);
  });

  it('keeps the copies and the bodies they meet, each copy meeting a body of its own', () => {
    const d = new DocBuilder();
    const dot = primitive(d, 'sphere', { radius: '4 mm' }, { at: [29, 30, 0] });
    // Boxes over the copies at 180 and 270 degrees, each reaching into its copy's top.
    for (const at of [
      [-29, 34, 0],
      [0, 34, 29],
    ] as const) {
      primitive(d, 'box', { width: '6 mm', depth: '6 mm', height: '6 mm' }, { at });
    }
    patternAboutY(d, bodyRef(d, dot), 4, 'join');
    const ev = build(d);
    // Two copies join the boxes they reach; the third copy and the seed stay dots.
    expect(bodies(ev, d)).toHaveLength(4);
    const joined = 2 * ball(4) + 2 * (ball(4) + 216);
    expect(totalVolume(ev, d)).toBeGreaterThan(4 * ball(4) + 2 * 108);
    expect(totalVolume(ev, d)).toBeLessThan(joined);
  });
});
