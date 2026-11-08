/**
 * The wrong-attachment suite: a part built from several feature types, every
 * face, edge and vertex picked, then one everyday edit and a full rebuild.
 * Each pick must resolve to the entity that is geometrically the same one
 * (judged by surfaces, never by names), or else ask; it must never land on a
 * different entity.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readDocument } from '@tweakcad/format';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Json } from './context';
import { above, inBox, judge, same, type Move, type Outcome } from './attachmentOracle';
import { BASE, TEXT_AT, attachmentModels, type Built, type Params } from './attachmentDocs';

let k: OcctKernel;
let gcs: GcsWrapper;
const builds: Evaluation[] = [];
let models: ReturnType<typeof attachmentModels>;
// Lilita One, under the SIL Open Font License (its licence text sits next to the file).
const FONT = new Uint8Array(
  readFileSync(
    resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../../src/assets/fonts/LilitaOne-Regular.ttf'),
  ),
);

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
  models = attachmentModels(k, gcs, FONT, evaluateChecked, (ev) => builds.push(ev));
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

/** Evaluates a document that must read clean and build without a pause. */
function evaluateChecked(doc: Json): Evaluation {
  const read = readDocument(JSON.parse(JSON.stringify(doc)));
  expect(read.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k, { solver: gcs });
  builds.push(ev);
  expect(ev.pauses).toEqual([]);
  return ev;
}

const evaluate = (b: Built): Evaluation => evaluateChecked(models.documentOf(b));
const model = (p: Params): Built => models.model(p);

/** The text grown from cap height 4 to 5: its points scale about the start of its baseline. */
const grows: Move = (p) =>
  p[0] >= 32.9 && p[0] <= 41 && p[1] >= 1.5 && p[1] <= 7.5 && p[2] >= 9.4 && p[2] <= 10 + 1e-6
    ? [TEXT_AT[0] + 1.25 * (p[0] - TEXT_AT[0]), TEXT_AT[1] + 1.25 * (p[1] - TEXT_AT[1]), p[2]]
    : p;

/** Picks everything in the base build, rebuilds after `edit`, and judges every resolution. */
function check(edit: Partial<Params>, move: Move): Outcome {
  const a = model(BASE);
  const b = model({ ...BASE, ...edit });
  return judge(evaluate(a), evaluate(b), a.d.partId, move);
}

/** Each edit: what changes, where the unchanged geometry goes, and how many picks may ask (pieces of a divided entity). */
const EDITS: [string, Partial<Params>, Move, number][] = [
  [
    'the plate gets wider (a sketch dimension)',
    { width: 70 },
    (p) => (p[0] > 55 + 1e-6 ? [p[0] + 10, p[1], p[2]] : p),
    0,
  ],
  ['the plate gets thicker', { depth: 12 }, (p) => (p[2] > 9 ? [p[0], p[1], p[2] + 2] : p), 0],
  ['the boss moves', { bossX: 14 }, inBox([10, 10, 10], [25, 30, 18], [4, 0, 0]), 0],
  ['the boss gets taller', { bossHeight: 12 }, above(10, 4), 0],
  ['the hole moves, its patterned copy with it', { holeX: 40 }, inBox([42, 7.9, -1e9], [48, 23, 1e9], [-5, 0, 0]), 0],
  ['the hole pattern drops its copy', { holeCount: 1 }, same, 0],
  ['the hole pattern spreads', { holeSpacing: -10 }, inBox([41.9, 7.9, -1e9], [48.1, 14.1, 1e9], [0, -1, 0]), 0],
  ['the hole gets bigger', { holeDiameter: 8 }, same, 0],
  ['the fillet gets bigger', { filletRadius: 4 }, inBox([56.9, 36.9, -1e9], [57.1, 37.1, 1e9], [-1, -1, 0]), 0],
  ['a pocket is inserted before the fillet', { pocket: true }, same, 0],
  ['a second hole is added at the end', { secondHole: true }, same, 0],
  ['a fillet is inserted before the first', { earlierFillet: true }, same, 0],
  ['the configuration changes', { size: 'large' }, above(10, 4), 0],
  ['a fillet meeting the first is added at the end', { meetingFillet: true }, same, 0],
  ['a slot dividing the plate is inserted before the fillet', { slot: true }, same, 8],
  ['the fillet is frozen', { frozenFillet: true }, same, 0],
  [
    'the plate gets wider before a frozen fillet, which keeps its stored shape',
    { frozenFillet: true, width: 70 },
    same,
    0,
  ],
  ['the elliptical hole moves', { ellipseX: 46 }, inBox([42.9, 28.9, -1e9], [51.1, 35.1, 1e9], [-1, 0, 0]), 0],
  ['the engraved text grows (a text size)', { textSize: 5 }, grows, 0],
];

describe('wrong-attachment suite', { timeout: 60_000 }, () => {
  it('builds the part with every feature on', () => {
    const ev = evaluate(model({ ...BASE, pocket: true, secondHole: true }));
    expect(ev.parts.size).toBe(1);
  });

  it('notices a pick judged against the wrong place', () => {
    // Judged as if the wider plate had not moved its right side, the picks there look wrong.
    const out = check({ width: 70 }, same);
    expect(out.wrong.length + out.lost.length).toBeGreaterThan(5);
  });

  for (const [name, edit, move, asks] of EDITS) {
    it(`keeps every pick on its own entity when ${name}`, () => {
      const out = check(edit, move);
      expect(out.checked).toBeGreaterThan(60);
      expect(out.wrong).toEqual([]);
      expect(out.lost).toEqual([]);
      expect(out.asked).toBeLessThanOrEqual(asks);
    });
  }
});
