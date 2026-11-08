/**
 * The feature-result cache changes no result: every edit of the
 * wrong-attachment suite is evaluated through the service, which resumes
 * from the build before it, and afresh, and the two builds must name and
 * shape every entity the same. Also times both, for the record.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { canonicalize, type JsonValue } from '@tweakcad/format';
import { BASE, attachmentModels, type Params } from '../attachmentDocs';
import { Docs } from '../assemblyDocs';
import { evaluateDocument, type Evaluation } from '../evaluate';
import type { Json } from '../context';
import { EvaluationService } from './service';
import { evaluateCached } from './cache';

let k: OcctKernel;
let gcs: GcsWrapper;
const builds: Evaluation[] = [];
let models: ReturnType<typeof attachmentModels>;

beforeAll(async () => {
  k = await OcctKernel.init();
  const here = dirname(fileURLToPath(import.meta.url));
  const wasm = [4, 5, 6]
    .map((up) =>
      resolvePath(here, '../'.repeat(up), 'node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm'),
    )
    .find((p) => existsSync(p));
  if (!wasm) throw new Error('planegcs.wasm not found');
  gcs = await make_gcs_wrapper(realpathSync(wasm));
  const font = new Uint8Array(readFileSync(resolvePath(here, '../../../../../src/assets/fonts/LilitaOne-Regular.ttf')));
  models = attachmentModels(k, gcs, font, fresh, (ev) => builds.push(ev));
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function fresh(doc: Json): Evaluation {
  const ev = evaluateDocument(doc, k, { solver: gcs });
  builds.push(ev);
  return ev;
}

const round = (_: string, v: unknown) => (typeof v === 'number' ? Number(v.toFixed(6)) : v);

/** Every entity of a part or assembly as its names, lineage and measures say it is, sorted; keys left out. */
function fingerprint(ev: Evaluation, part: string): string[] {
  const p = ev.parts.get(part) ?? ev.assemblies.get(part);
  if (!p) return [];
  const out = [...p.state.entities.values()].map((e) =>
    JSON.stringify(
      {
        kind: e.kind,
        ladder: e.ladder,
        branch: canonicalize(e.branch as unknown as JsonValue),
        aliases: canonicalize(e.aliases as unknown as JsonValue),
        standsFor: e.standsFor,
        createdBy: e.createdBy,
        measures: ev.adapter.measures(e.key),
      },
      round,
    ),
  );
  out.push(
    `bodies ${p.shapes.size}`,
    `sketches ${[...p.sketches.keys()].join(',')}`,
    `construction ${[...p.construction.keys()].join(',')}`,
  );
  return out.sort();
}

/** The edits of the wrong-attachment suite, early in the timeline to late. */
const EDITS: [string, Partial<Params>][] = [
  ['plate width (the first sketch)', { width: 70 }],
  ['plate depth', { depth: 12 }],
  ['boss position', { bossX: 14 }],
  ['boss height', { bossHeight: 12 }],
  ['pocket inserted', { pocket: true }],
  ['slot inserted', { slot: true }],
  ['earlier fillet inserted', { earlierFillet: true }],
  ['fillet radius', { filletRadius: 4 }],
  ['configuration', { size: 'large' }],
  ['hole position', { holeX: 40 }],
  ['hole diameter', { holeDiameter: 8 }],
  ['hole pattern count', { holeCount: 1 }],
  ['hole pattern spacing', { holeSpacing: -10 }],
  ['second hole added', { secondHole: true }],
  ['meeting fillet added', { meetingFillet: true }],
  ['ellipse position', { ellipseX: 46 }],
  ['text size (the last feature)', { textSize: 5 }],
  ['fillet frozen', { frozenFillet: true }],
];

describe('the feature-result cache', { timeout: 300_000 }, () => {
  it('changes no result, whatever an edit changes, and resumes after what it leaves alone', () => {
    const service = new EvaluationService(k, gcs);
    const rows: string[] = [];
    const resumed = new Map<string, number>();
    try {
      const base = models.model(BASE);
      const partId = base.d.partId;
      service.evaluate(models.documentOf(base));
      for (const [name, edit] of EDITS) {
        for (const [label, params] of [
          [name, { ...BASE, ...edit }],
          [`back from ${name}`, BASE],
        ] as [string, Params][]) {
          const doc = models.documentOf(models.model(params));
          const display = service.evaluate(structuredClone(doc));
          const t0 = performance.now();
          const ev = fresh(structuredClone(doc));
          const afresh = performance.now() - t0;
          expect(ev.pauses).toEqual([]);
          const kept = service.evaluation as Evaluation;
          expect(kept.pauses).toEqual(ev.pauses);
          expect(kept.stale).toEqual(ev.stale);
          expect(fingerprint(kept, partId)).toEqual(fingerprint(ev, partId));
          resumed.set(label, display.timing.resumed);
          rows.push(
            `${label.padEnd(42)} afresh ${afresh.toFixed(0).padStart(4)} ms, resumed ${display.timing.evaluate.toFixed(0).padStart(4)} ms (${display.timing.resumed} features taken over), display ${display.timing.display.toFixed(0)} ms`,
          );
        }
      }
    } finally {
      service.release();
    }
    console.log(rows.join('\n'));
    // An edit to the first sketch rebuilds everything; one to the last feature takes the rest over.
    expect(resumed.get('plate width (the first sketch)')).toBe(0);
    expect(resumed.get('text size (the last feature)')).toBeGreaterThan(20);
    expect(resumed.get('second hole added')).toBeGreaterThan(10);
  });

  it('rebuilds the part whose parameter changed and takes the other part of an assembly over', () => {
    const doc = (height: string) => {
      const d = new Docs();
      const base = d.part('Base');
      base.box('40 mm', '40 mm', '10 mm');
      const arm = d.part('Arm');
      arm.box('30 mm', '6 mm', arm.parameter('height', height), [15, 0, 0]);
      const a = d.assembly('Pair');
      a.instance({ part: { id: base.id } }, { grounded: true });
      a.instance({ part: { id: arm.id } }, { at: [0, 0, 20] });
      a.instance({ part: { id: arm.id } }, { at: [0, 30, 20] });
      return { doc: d.document({ assembly: { id: a.id } }), asm: a.id, parts: [base.id, arm.id] };
    };
    const service = new EvaluationService(k, gcs);
    try {
      service.evaluate(doc('4 mm').doc);
      const after = doc('9 mm');
      const display = service.evaluate(structuredClone(after.doc));
      // The base's one feature is taken over; the arm's box reads the edited parameter and rebuilds.
      expect(display.timing.resumed).toBe(1);
      // So is the base's placing; the arms are placed again.
      expect(display.timing.placed).toBe(1);
      const ev = fresh(structuredClone(after.doc));
      const kept = service.evaluation as Evaluation;
      for (const id of [...after.parts, after.asm]) expect(fingerprint(kept, id)).toEqual(fingerprint(ev, id));
    } finally {
      service.release();
    }
  });

  it('takes over every placing of an assembly whose parts are all taken over, nested ones too, naming as a fresh build', () => {
    const d = new Docs();
    const base = d.part('Base');
    base.box('40 mm', '40 mm', '10 mm');
    const arm = d.part('Arm');
    arm.box('30 mm', '6 mm', '4 mm', [15, 0, 0]);
    const sub = d.assembly('Arm pair');
    sub.instance({ part: { id: arm.id } }, { grounded: true });
    sub.instance({ part: { id: arm.id } }, { at: [0, 30, 0] });
    const top = d.assembly('Rig');
    top.instance({ part: { id: base.id } }, { grounded: true });
    top.instance({ assembly: { id: sub.id } }, { at: [0, 0, 20] });
    top.instance({ assembly: { id: sub.id } }, { at: [0, 0, 40] });
    const doc = d.document({ assembly: { id: top.id } });
    const service = new EvaluationService(k, gcs);
    try {
      const first = service.evaluate(structuredClone(doc));
      expect(first.timing.placed).toBe(0);
      const again = service.evaluate(structuredClone(doc));
      expect(again.timing.resumed).toBe(2);
      expect(again.timing.placed).toBeGreaterThanOrEqual(5);
      const ev = fresh(structuredClone(doc));
      const kept = service.evaluation as Evaluation;
      expect(kept.pauses).toEqual(ev.pauses);
      for (const id of [base.id, arm.id, sub.id, top.id]) expect(fingerprint(kept, id)).toEqual(fingerprint(ev, id));
      // A third time, from the second: still the same.
      service.evaluate(structuredClone(doc));
      for (const id of [sub.id, top.id])
        expect(fingerprint(service.evaluation as Evaluation, id)).toEqual(fingerprint(ev, id));
      // The display places every instance as the fresh one does.
      const plain = new EvaluationService(k, gcs);
      try {
        const shown = plain.evaluate(structuredClone(doc));
        const placed = (x: typeof shown) => x.assemblies.map((a) => a.instances.map((i) => [i.path, i.placement]));
        expect(placed(again)).toEqual(placed(shown));
      } finally {
        plain.release();
      }
    } finally {
      service.release();
    }
  });

  it('gives a resumed build every name its features made, though the build before had them in the document', () => {
    const d = new Docs();
    const part = d.part('Block');
    part.box('10 mm', '10 mm', '10 mm');
    part.box('5 mm', '5 mm', '20 mm', [0, 0, 0], 'join');
    const doc = d.document({ part: { id: part.id } });
    const plain = evaluateCached(doc, k, gcs);
    const made = Object.keys(plain.ev.names.toJson());
    // The same document with its name table holding every name, as one with picks written into it does.
    const full = evaluateCached({ ...doc, names: plain.ev.names.toJson() }, k, gcs);
    const resumed = evaluateCached(doc, k, gcs, full);
    try {
      expect(resumed.resumed).toBe(2);
      expect(made.filter((hash) => !resumed.ev.names.has(hash))).toEqual([]);
    } finally {
      plain.adapter.dispose();
      full.adapter.dispose();
    }
  });

  it('takes over the features before one whose stored shape is a new asset, and holds its result', () => {
    const service = new EvaluationService(k, gcs);
    try {
      const base = models.model(BASE);
      service.evaluate(models.documentOf(base));
      const frozen = models.documentOf(models.model({ ...BASE, frozenFillet: true }));
      const display = service.evaluate(structuredClone(frozen));
      expect(display.timing.resumed).toBeGreaterThan(0);
      expect(display.pauses).toEqual([]);
      expect(fingerprint(service.evaluation as Evaluation, base.d.partId)).toEqual(
        fingerprint(fresh(structuredClone(frozen)), base.d.partId),
      );
    } finally {
      service.release();
    }
  });
});

/**
 * Cached and fresh evaluations of an edited document agree: names, geometry,
 * values and pauses, where the edit changes nothing a feature row holds.
 */
describe('a cached evaluation is the fresh one', { timeout: 120_000 }, () => {
  /** `after` evaluated resuming from `before`, and afresh. */
  function both(
    before: Json,
    after: Json,
  ): { cached: Evaluation; fresh: Evaluation; resumed: number; misses: string[] } {
    const first = evaluateCached(structuredClone(before), k, gcs);
    const cached = evaluateCached(structuredClone(after), k, gcs, first);
    builds.push(first.ev);
    return { cached: cached.ev, fresh: fresh(structuredClone(after)), resumed: cached.resumed, misses: cached.misses };
  }
  const volumes = (ev: Evaluation, part: string) =>
    [...(ev.parts.get(part)?.state.bodies.keys() ?? [])]
      .map((b) => Number((ev.adapter.measures(b).volume as number).toFixed(6)))
      .sort((a, b) => a - b);

  it('restores the values a frozen feature gives, though the definition it froze reads an edited parameter', () => {
    const d = new Docs();
    const part = d.part('Blocks');
    const size = part.parameter('size', '10 mm');
    const width = { ...d.val('size', { size }), name: 'w' };
    const operation = () => ({ op: d.val('"new"'), targets: { all: {} }, keepTools: d.flag(false) });
    const first = part.add(
      d.feature('core.primitive', {
        shape: { box: { width, depth: d.val('10 mm'), height: d.val('10 mm') } },
        frame: d.fixedFrame(),
        operation: operation(),
      }),
    );
    const half = {
      id: d.id('val'),
      def: { expr: { text: 'w / 2', grammar: 1, refs: { w: { value: { id: width.id } } } } },
    };
    part.add(
      d.feature('core.primitive', {
        shape: { box: { width: half, depth: d.val('10 mm'), height: d.val('10 mm') } },
        frame: d.fixedFrame([0, 0, 30]),
        operation: operation(),
      }),
    );
    const live = d.document({ part: { id: part.id } });
    const frozen = new EvaluationService(k, gcs).freeze(live, first);
    expect(frozen).toMatchObject({ ok: true });
    const before = structuredClone(live);
    const row = ((before.parts as Json[])[0]!.timeline as Json[])[0]!;
    row.frozen = (frozen as { frozen: Json }).frozen;
    Object.assign(before.assets as Json, (frozen as { assets: Json }).assets);
    Object.assign(before.names as Json, (frozen as { names: Json }).names);
    const after = structuredClone(before);
    const table = (((after.parts as Json[])[0]!.parameters as Json[])[0]!.parameters as Json[])[0]!;
    ((table.value as Json).def as Json).expr = { text: '20 mm', grammar: 1, refs: {} };

    const { cached, fresh: plain, resumed } = both(before, after);
    // The frozen box keeps 10 mm, and the second box reads its frozen width: 5 × 10 × 10.
    expect(volumes(plain, part.id)).toEqual([500, 1000]);
    expect(volumes(cached, part.id)).toEqual(volumes(plain, part.id));
    // Both boxes are taken over: the second reads the frozen width as before.
    expect(resumed).toBe(2);
    expect(cached.values.value(width.id as string)).toEqual(plain.values.value(width.id as string));
    expect(fingerprint(cached, part.id)).toEqual(fingerprint(plain, part.id));
  });

  for (const where of ['part row', 'document'] as const) {
    it(`pauses every feature for content of the ${where} it does not understand, as a fresh build does`, () => {
      const d = new Docs();
      const part = d.part('Block');
      part.box('10 mm', '10 mm', '10 mm');
      part.box('5 mm', '5 mm', '20 mm', [0, 0, 0], 'join');
      const before = d.document({ part: { id: part.id } });
      const after = structuredClone(before);
      (where === 'document' ? after : (after.parts as Json[])[0]!).unheardOf = { geometry: true };
      const { cached, fresh: plain, resumed, misses } = both(before, after);
      expect(plain.pauses).toHaveLength(2);
      expect(cached.pauses).toEqual(plain.pauses);
      expect(resumed).toBe(0);
      expect(misses).toEqual([
        `part ${part.id}: feature 1 (${String(((after.parts as Json[])[0]!.timeline as Json[])[0]!.name)}) holds content not understood`,
      ]);
      expect(cached.pauses).toEqual(plain.pauses);
      expect(fingerprint(cached, part.id)).toEqual(fingerprint(plain, part.id));
    });
  }

  it('pauses a stored shape whose asset row no longer matches its hash, as a fresh build does', () => {
    const before = models.documentOf(models.model({ ...BASE, frozenFillet: true }));
    const after = structuredClone(before);
    const hash = Object.keys(after.assets as Json).find(
      (h) => !String(((after.assets as Json)[h] as Json).mediaType).startsWith('font/'),
    );
    const row = (after.assets as Json)[hash as string] as Json;
    row.size = (row.size as number) + 1;
    const partId = models.model(BASE).d.partId;
    const { cached, fresh: plain, misses } = both(before, after);
    expect(plain.pauses.map((p) => p.message)).toContain('the stored shape does not match its asset hash');
    expect(misses.some((m) => m.endsWith('reads an asset that changed'))).toBe(true);
    expect(cached.pauses).toEqual(plain.pauses);
    expect(fingerprint(cached, partId)).toEqual(fingerprint(plain, partId));
  });
});
