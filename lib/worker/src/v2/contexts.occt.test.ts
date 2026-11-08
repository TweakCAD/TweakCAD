/**
 * Captured contexts and a hole through two parts (12.3, 12.4) on the real
 * kernel. A plate sits on a bracket; the bracket's hole is placed by an
 * in-context reference to the centre of the plate's hole, read from the
 * bracket's captured context, and one document parameter sizes both holes.
 * The bracket follows the plate only when its context is re-captured, and
 * an out-of-date context says why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  canonicalize,
  nameHash,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type Vec3,
} from '@tweakcad/format';
import { Docs, instancePath, pathOf } from './assemblyDocs';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Json } from './context';
import { captureContext } from './capture';
import { contextOf } from './contexts';
import { instanceStep } from './variants';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(doc: Json, read = true): Evaluation {
  if (read) {
    const result = readDocument(JSON.parse(JSON.stringify(doc)));
    expect(result.diagnostics.filter((x) => x.severity !== 'ignore')).toEqual([]);
  }
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

function capture(doc: Json, part: string, context: string): Json {
  const { document, evaluation } = captureContext(doc, k, part, context, { capturedAt: '2026-11-05T00:00:00Z' });
  builds.push(evaluation);
  return document;
}

interface Design {
  /** The hole's diameter, through one document parameter. */
  diameter?: number;
  /** Where the plate's hole is along x. */
  holeX?: number;
  /** Where the plate sits along x in the assembly. */
  plateX?: number;
  /** Hinge the plate on the bracket by a revolute joint at this angle, in place of a stored placement. */
  hinge?: number;
  /** The context's `position`; absent: current. */
  position?: 'captured';
}

interface Built {
  doc: Json;
  bracket: string;
  context: string;
  plateInstance: string;
  joint?: string;
  /** Rewrites the bracket hole's position to `ref`. */
  positionAt(doc: Json, ref: Json): void;
}

/**
 * A 60 × 40 × 10 plate with a through hole, on a 60 × 40 × 6 bracket whose
 * hole is placed on the plate's underside, through the bracket's context.
 */
function design(o: Design = {}): Built {
  const d = new Docs();
  const diameter = d.parameter('hole', `${o.diameter ?? 6} mm`);
  d.parameters.push({ id: d.id('tbl'), name: 'Shared', parameters: [diameter] });
  const size = () => d.val('hole', { hole: diameter.id as string });

  const plate = d.part('Plate');
  const plateBox = plate.box('60 mm', '40 mm', '10 mm', [0, 0, 5]);
  const hole = (placement: Json, at: Json) =>
    d.feature('core.hole', {
      placement,
      positions: [{ id: d.id('hp'), at }],
      kind: d.val('"simple"'),
      diameter: size(),
      depth: { throughAll: {} },
      tip: { flat: {} },
      thread: { none: {} },
    });
  plate.add(hole({ frame: d.fixedFrame([0, 0, 10]) }, { at: { v: d.val(`vector(${o.holeX ?? 10} mm, 5 mm, 0 mm)`) } }));

  const bracket = d.part('Bracket');
  const bracketBox = bracket.box('60 mm', '40 mm', '6 mm', [0, 0, 3]);
  const asm = d.assembly('Stack');
  const bracketInstance = asm.instance({ part: { id: bracket.id } }, { grounded: true });
  const plateInstance = asm.instance(
    { part: { id: plate.id } },
    { at: o.hinge === undefined ? [o.plateX ?? 0, 0, 6] : [200, 0, 0] },
  );
  let joint: string | undefined;
  if (o.hinge !== undefined) {
    const top = asm.origin(d.planeFrame(d.faceThrough(bracketInstance, bracketBox, '+z')));
    const bottom = asm.origin(d.planeFrame(d.faceThrough(plateInstance, plateBox, '-z'), { flip: true }));
    joint = asm.joint('revolute', top, bottom, { state: { rz: o.hinge } });
  }

  const context = d.id('ctx');
  (bracket.json.contexts as Json[]).push({
    id: context,
    assembly: { id: asm.id },
    at: pathOf(instancePath(bracketInstance)),
    captured: { set: [] },
    source: nameHash({}),
    policy: 'manual',
    capturedAt: '2026-11-05T00:00:00Z',
    ...(o.position === 'captured' && joint
      ? { position: { captured: { state: { [joint]: { rz: o.hinge ?? 0 } } } } }
      : {}),
  });
  const inPlate = (ref: Json) => ({
    inContext: { context: { id: context }, instance: pathOf(instancePath(plateInstance)), ref },
  });
  // The plate's underside, flipped so the hole runs down into the bracket.
  const underside = inPlate(d.ref('face', plateBox, '-z', [instanceStep(plateInstance)]));
  const placement = {
    frame: { attach: { support: [underside], mode: d.val('"plane"'), offset: d.placementValue(), flip: d.flag(true) } },
  };
  bracket.add(hole(placement, { at: { v: d.val('vector(0 mm, 0 mm, 0 mm)') } }));

  const doc = d.document({ assembly: { id: asm.id } });
  return {
    doc,
    bracket: bracket.id,
    context,
    plateInstance,
    ...(joint ? { joint } : {}),
    positionAt(target: Json, ref: Json) {
      const part = (target.parts as Json[]).find((p) => p.id === bracket.id) as Json;
      const feature = (part.timeline as Json[]).at(-1) as Json;
      ((feature.inputs as Json).positions as Json[])[0]!.at = { of: { ref: inPlate(ref) } };
    },
  };
}

const bracketOf = (ev: Evaluation, b: Built) => ev.parts.get(b.bracket)!;
const bores = (ev: Evaluation, b: Built) =>
  [...bracketOf(ev, b).state.entities.values()].filter(
    (e) => e.kind === 'face' && ev.adapter.measures(e.key).surface === 'cylinder',
  );
const centre = (ev: Evaluation, e: NamedEntity) => ev.adapter.measures(e.key).centroid as Vec3;
const radius = (ev: Evaluation, e: NamedEntity) => {
  const s = ev.adapter.faceGeometry(e.key).surface;
  return s.kind === 'cylinder' ? (s.radii[0] as number) : NaN;
};

/**
 * The finished design: captured once to find the plate's hole edge in the
 * bracket's context, the bracket's hole put on its centre, and captured again.
 */
function finished(o: Design = {}): Built & { edge: EntityRecord } {
  const b = design(o);
  const first = capture(b.doc, b.bracket, b.context);
  const ev = evaluate(first);
  const place = contextOf({ ev, part: bracketOf(ev, b) }, b.context).place;
  const rim = [...place.state.entities.values()].find((e) => {
    const m = ev.adapter.measures(e.key);
    return e.kind === 'edge' && m.curve === 'circle' && Math.abs((m.center as Vec3)[2] - 6) < 1e-9;
  }) as NamedEntity;
  expect(rim).toBeDefined();
  const edge = writeRecord(rim, place.state, ev.adapter);
  b.positionAt(first, { entity: edge });
  return { ...b, doc: capture(first, b.bracket, b.context), edge };
}

/** The same design with `o` changed, keeping the bracket's stored context and hole position, as an edit leaves a document. */
function edited(base: Built & { edge: EntityRecord }, o: Design): Built {
  const b = design(o);
  const part = (base.doc.parts as Json[]).find((p) => p.id === base.bracket) as Json;
  const target = (b.doc.parts as Json[]).find((p) => p.id === b.bracket) as Json;
  target.contexts = structuredClone(part.contexts);
  b.positionAt(b.doc, { entity: base.edge });
  b.doc.assets = structuredClone(base.doc.assets);
  b.doc.names = { ...(b.doc.names as Json), ...(base.doc.names as Json) };
  return b;
}

describe('captured contexts', () => {
  it('captures the instances the part references, in their own frame, with their placement', () => {
    const b = finished();
    const row = ((b.doc.parts as Json[]).find((p) => p.id === b.bracket)!.contexts as Json[])[0] as Json;
    const entries = (row.captured as Json).set as Json[];
    expect(entries.map((e) => canonicalize(e.instance))).toEqual([canonicalize(pathOf(instancePath(b.plateInstance)))]);
    expect((entries[0] as Json).placement).toEqual({ position: [0, 0, 6], rotation: [0, 0, 0, 1] });
    const ev = evaluate(b.doc);
    expect(ev.pauses).toEqual([]);
    expect(ev.outOfDate).toEqual([]);
  });

  it('puts the bracket hole on the plate hole, through the context (12.3)', () => {
    const b = finished();
    const ev = evaluate(b.doc);
    const [bore] = bores(ev, b);
    expect(bores(ev, b)).toHaveLength(1);
    expect(centre(ev, bore as NamedEntity)).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
      expect.closeTo(3, 9),
    ]);
    expect(radius(ev, bore as NamedEntity)).toBeCloseTo(3, 9);
  });

  it('sizes both holes from one document parameter', () => {
    const base = finished();
    const b = edited(base, { diameter: 8 });
    const ev = evaluate(b.doc);
    expect(radius(ev, bores(ev, b)[0] as NamedEntity)).toBeCloseTo(4, 9);
    const plate = [...ev.parts.values()].find((p) => p !== bracketOf(ev, b))!;
    const plateBore = [...plate.state.entities.values()].find(
      (e) => e.kind === 'face' && ev.adapter.measures(e.key).surface === 'cylinder',
    ) as NamedEntity;
    expect(radius(ev, plateBore)).toBeCloseTo(4, 9);
  });

  it('keeps the captured hole until the context is re-captured, then follows, keeping a pick on the bore', () => {
    const base = finished();
    const ev0 = evaluate(base.doc);
    const pick = writeRecord(bores(ev0, base)[0] as NamedEntity, bracketOf(ev0, base).state, ev0.adapter);

    const moved = edited(base, { holeX: 20 });
    const stale = evaluate(moved.doc);
    expect(centre(stale, bores(stale, moved)[0] as NamedEntity)[0]).toBeCloseTo(10, 9);
    expect(stale.outOfDate.map((o) => o.reason)).toContain('the assembly changed since the capture');

    const updated = capture(moved.doc, moved.bracket, moved.context);
    const ev = evaluate(updated);
    expect(ev.outOfDate).toEqual([]);
    const found = resolve(pick, bracketOf(ev, moved).state, ev.adapter);
    expect(found.outcome).toBe('same');
    const bore = (found as { entities: NamedEntity[] }).entities[0] as NamedEntity;
    expect(centre(ev, bore)[0]).toBeCloseTo(20, 9);
  });

  it('notices a captured instance that moved, though the design did not change, and follows it once re-captured', () => {
    const base = finished();
    const moved = edited(base, { plateX: 5 });
    const ev = evaluate(moved.doc);
    expect(ev.outOfDate.map((o) => o.reason)).toEqual(['a captured instance moved']);
    const updated = capture(moved.doc, moved.bracket, moved.context);
    const after = evaluate(updated);
    expect(centre(after, bores(after, moved)[0] as NamedEntity)[0]).toBeCloseTo(15, 9);
  });

  it('keeps holes made with the hinge closed when the hinge opens, if the context holds its position', () => {
    const base = finished({ hinge: 0, position: 'captured' });
    const open = edited(base, { hinge: 90, position: 'captured' });
    const ev = evaluate(open.doc);
    expect(ev.outOfDate).toEqual([]);
    expect(centre(ev, bores(ev, open)[0] as NamedEntity).slice(0, 2)).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
    ]);
    // Re-capturing takes the held position, not the open one.
    const again = evaluate(capture(open.doc, open.bracket, open.context));
    expect(centre(again, bores(again, open)[0] as NamedEntity).slice(0, 2)).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(5, 9),
    ]);
  });

  it('moves the hole with the hinge when the context follows the current position', () => {
    const base = finished({ hinge: 0 });
    const open = edited(base, { hinge: 90 });
    const stale = evaluate(open.doc);
    expect(stale.outOfDate.map((o) => o.reason)).toEqual(['a captured instance moved']);
    const after = evaluate(capture(open.doc, open.bracket, open.context));
    expect(centre(after, bores(after, open)[0] as NamedEntity).slice(0, 2)).toEqual([
      expect.closeTo(-5, 9),
      expect.closeTo(10, 9),
    ]);
  });

  it('pauses a reference into an instance the context did not capture', () => {
    const base = finished();
    const part = (base.doc.parts as Json[]).find((p) => p.id === base.bracket) as Json;
    ((part.contexts as Json[])[0] as Json).captured = { set: [] };
    const ev = evaluate(base.doc, false);
    expect(ev.pauses.map((p) => p.message)).toEqual([expect.stringMatching(/did not capture/)]);
  });
});
