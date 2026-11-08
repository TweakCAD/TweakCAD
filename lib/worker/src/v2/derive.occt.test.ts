/**
 * `core.derive` on the real kernel (11.1): bodies brought from another part,
 * an assembly or a library component, with insertion overrides, named as
 * the source with the derive step, so picks survive edits to the source.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import {
  indexItem,
  readDocument,
  resolve,
  writeRecord,
  type EntityRecord,
  type NamedEntity,
  type NamedState,
} from '@tweakcad/format';
import { Docs } from './assemblyDocs';
import { evaluateDocument, type Evaluation } from './evaluate';
import type { Json, V3 } from './context';
import { instanceStep } from './variants';
import type { DocBuilder } from './docBuilder';
import { imported } from './primitivesDocs';

let k: OcctKernel;
const builds: Evaluation[] = [];

beforeAll(async () => {
  k = await OcctKernel.init();
});
afterAll(() => {
  for (const b of builds) b.adapter.dispose();
  k.releaseAll();
});

function evaluate(doc: Json): Evaluation {
  const read = readDocument(doc);
  expect(read.diagnostics.filter((d) => d.severity !== 'ignore')).toEqual([]);
  const ev = evaluateDocument(doc, k);
  builds.push(ev);
  return ev;
}

const close = (a: readonly number[], b: readonly number[], tol = 1e-6) =>
  a.every((v, i) => Math.abs(v - (b[i] as number)) <= tol);

function one(ev: Evaluation, state: NamedState, ref: Json): NamedEntity {
  const found = resolve(ref.entity as EntityRecord, state, ev.adapter);
  if (found.outcome !== 'same' || found.entities.length !== 1)
    throw new Error(`expected one entity, got ${found.outcome}`);
  return found.entities[0] as NamedEntity;
}

const measured = (ev: Evaluation, e: NamedEntity) =>
  ev.adapter.measures(e.key) as unknown as { normal: V3; centroid: V3; volume: number };

/** A source part of a box `width` wide, and an earlier box when `extra`; a host deriving it 20 mm up. */
function hosted(o: { width?: number; extra?: boolean; override?: string } = {}) {
  const d = new Docs();
  const source = d.part('Source');
  const width = source.parameter('width', `${o.width ?? 10} mm`);
  // The extra box sits away from the main one: an edit before it in the timeline.
  const extra = d.feature('core.primitive', {
    shape: { box: { width: d.val('4 mm'), depth: d.val('4 mm'), height: d.val('4 mm') } },
    frame: d.fixedFrame([40, 0, 0]),
    operation: { op: d.val('"new"'), targets: { all: {} }, keepTools: d.flag(false) },
  });
  if (o.extra) source.add(extra);
  const box = source.box(width, '10 mm', '10 mm');
  const host = d.part('Host');
  const own = host.box('6 mm', '6 mm', '6 mm', [0, 30, 0]);
  const derive = host.derive(
    { part: { id: source.id } },
    { at: [0, 0, 20], ...(o.override ? { overrides: [d.override(width, o.override)] } : {}) },
  );
  return { d, source, host, box, own, derive, doc: d.document({ part: { id: host.id } }) };
}

describe('core.derive', () => {
  it('brings the source bodies into the host, named with the derive step', () => {
    const t = hosted();
    const ev = evaluate(t.doc);
    expect(ev.pauses).toEqual([]);
    const host = ev.parts.get(t.host.id);
    expect(host?.state.bodies.size).toBe(2);
    const step = { op: { id: t.derive }, key: { derive: {} } };
    const top = measured(ev, one(ev, host?.state as NamedState, t.d.ref('face', t.box, '+z', [step])));
    expect(close(top.centroid, [0, 0, 25])).toBe(true);
    const body = one(ev, host?.state as NamedState, t.d.ref('body', t.box, 'body', [step], [indexItem(0) as Json]));
    expect(measured(ev, body).volume).toBeCloseTo(1000, 6);
  });

  it('keeps a pick on a derived face through an edit to the source part', () => {
    const before = hosted();
    const ev = evaluate(before.doc);
    const state = ev.parts.get(before.host.id)?.state as NamedState;
    const step = { op: { id: before.derive }, key: { derive: {} } };
    const record = writeRecord(one(ev, state, before.d.ref('face', before.box, '+x', [step])), state, ev.adapter);
    for (const edit of [{ width: 16 }, { extra: true }, { width: 4, extra: true }]) {
      const after = hosted(edit);
      const ev2 = evaluate(after.doc);
      const found = resolve(record, ev2.parts.get(after.host.id)?.state as NamedState, ev2.adapter);
      expect(found.outcome).toBe('same');
      const face = measured(ev2, (found as { entities: NamedEntity[] }).entities[0] as NamedEntity);
      expect(close(face.normal, [1, 0, 0])).toBe(true);
      expect(close(face.centroid, [(edit.width ?? 10) / 2, 0, 20])).toBe(true);
    }
  });

  it('builds the source as a variant with the derive overrides', () => {
    const t = hosted({ override: '30 mm' });
    const ev = evaluate(t.doc);
    expect(ev.pauses).toEqual([]);
    const step = { op: { id: t.derive }, key: { derive: {} } };
    const body = one(
      ev,
      ev.parts.get(t.host.id)?.state as NamedState,
      t.d.ref('body', t.box, 'body', [step], [indexItem(0) as Json]),
    );
    expect(measured(ev, body).volume).toBeCloseTo(3000, 6);
    // The source part as written is untouched.
    const own = one(
      ev,
      ev.parts.get(t.source.id)?.state as NamedState,
      t.d.ref('body', t.box, 'body', [], [indexItem(0) as Json]),
    );
    expect(measured(ev, own).volume).toBeCloseTo(1000, 6);
  });

  it('derives a library component and an assembly', () => {
    const lib = new Docs(3);
    const part = lib.part('Knob');
    const knob = part.box('8 mm', '8 mm', '8 mm');
    const component = lib.document({ part: { id: part.id } });

    const d = new Docs();
    const entry = d.embed(component);
    const peg = d.part('Peg');
    const pegBox = peg.box('2 mm', '2 mm', '20 mm');
    const a = d.assembly('Pair');
    const inst = a.instance({ part: { id: peg.id } }, { grounded: true, at: [10, 0, 0] });
    const host = d.part('Host');
    const fromLib = host.derive({ component: { value: d.val('c', { c: entry }) } }, { overrides: [] });
    const fromAsm = host.derive({ assembly: { id: a.id } }, { at: [0, 50, 0] });
    const ev = evaluate(d.document({ part: { id: host.id } }));
    expect(ev.pauses).toEqual([]);
    const state = ev.parts.get(host.id)?.state as NamedState;
    const libTop = measured(
      ev,
      one(ev, state, d.ref('face', knob, '+z', [{ op: { id: fromLib }, key: { derive: {} } }])),
    );
    expect(close(libTop.centroid, [0, 0, 4])).toBe(true);
    const asmTop = measured(
      ev,
      one(ev, state, d.ref('face', pegBox, '+z', [instanceStep(inst), { op: { id: fromAsm }, key: { derive: {} } }])),
    );
    expect(close(asmTop.centroid, [10, 50, 10])).toBe(true);
  });

  it('derives one of two bodies that share an imported shape, leaving the source as it was', () => {
    const imports = (items?: Json[]) => {
      const d = new Docs();
      const source = d.part('Source');
      const shim = {
        feature: (type: string, inputs: Json) => source.add(d.feature(type, inputs)),
        val: (text: string) => d.val(text),
        names: d.names,
      };
      const fixture = imported(shim as unknown as DocBuilder, k, [
        k.makeBox(10, 10, 10),
        k.translate(k.makeBox(4, 4, 4), 40, 0, 0),
      ]);
      const host = d.part('Host');
      const derive = host.derive({ part: { id: source.id } }, items ? { items } : {});
      return { d, source, host, derive, assets: fixture.assets };
    };
    const docOf = (t: ReturnType<typeof imports>) => ({
      ...t.d.document({ part: { id: t.host.id } }),
      assets: t.assets,
    });

    const whole = imports();
    const first = evaluate(docOf(whole));
    expect(first.pauses).toEqual([]);
    const sourceState = first.parts.get(whole.source.id)?.state as NamedState;
    const small = [...sourceState.entities.values()].find(
      (e) => e.kind === 'body' && (first.adapter.measures(e.key).volume as number) < 100,
    ) as NamedEntity;
    const record = writeRecord(small, sourceState, first.adapter);

    const one = imports([{ entity: record }]);
    for (const name of Object.values(first.names.toJson() as Json)) one.d.names.intern(name as never);
    const ev = evaluate(docOf(one));
    expect(ev.pauses).toEqual([]);
    const host = ev.parts.get(one.host.id);
    expect(host?.state.bodies.size).toBe(1);
    const [body] = [...(host?.state.entities.values() ?? [])].filter((e) => e.kind === 'body');
    expect(measured(ev, body as NamedEntity).volume).toBeCloseTo(64, 6);
    const source = ev.parts.get(one.source.id);
    expect(source?.state.bodies.size).toBe(2);
    expect(source?.shapes.size).toBe(1);
  });

  it('derives one body of two, and pauses a pick that is gone from the source', () => {
    const d = new Docs();
    const source = d.part('Source');
    const big = source.box('10 mm', '10 mm', '10 mm');
    const small = source.box('4 mm', '4 mm', '4 mm', [40, 0, 0]);
    const host = d.part('Host');
    const derive = host.derive(
      { part: { id: source.id } },
      { items: [d.ref('body', small, 'body', [], [indexItem(0) as Json])] },
    );
    const ev = evaluate(d.document({ part: { id: host.id } }));
    expect(ev.pauses).toEqual([]);
    const state = ev.parts.get(host.id)?.state as NamedState;
    expect(state.bodies.size).toBe(1);
    const step = { op: { id: derive }, key: { derive: {} } };
    const body = one(ev, state, d.ref('body', small, 'body', [step], [indexItem(0) as Json]));
    expect(measured(ev, body).volume).toBeCloseTo(64, 6);
    expect(() => one(ev, state, d.ref('body', big, 'body', [step], [indexItem(0) as Json]))).toThrow();

    const gone = new Docs();
    const src = gone.part('Source');
    src.box('10 mm', '10 mm', '10 mm');
    const h = gone.part('Host');
    const missing = h.derive(
      { part: { id: src.id } },
      { items: [gone.ref('body', gone.id('feat'), 'body', [], [indexItem(0) as Json])] },
    );
    const ev2 = evaluate(gone.document({ part: { id: h.id } }));
    expect(ev2.pauses).toEqual([{ feature: missing, message: 'a derived body is gone in its source' }]);
  });

  it('joins the derived bodies into the host body, and pauses cut and intersect, which copies do not build yet', () => {
    // The host's 20 mm cube centred on the origin; the source's 10 mm cube derived 10 mm up, half inside it.
    const hostWith = (op: 'join' | 'cut' | 'intersect') => {
      const d = new Docs();
      const source = d.part('Source');
      source.box('10 mm', '10 mm', '10 mm');
      const host = d.part('Host');
      const own = host.box('20 mm', '20 mm', '20 mm');
      const derive = host.derive({ part: { id: source.id } }, { at: [0, 0, 10], op });
      return { d, host, own, derive, ev: evaluate(d.document({ part: { id: host.id } })) };
    };
    const joined = hostWith('join');
    expect(joined.ev.pauses).toEqual([]);
    const state = joined.ev.parts.get(joined.host.id)?.state as NamedState;
    expect(state.bodies.size).toBe(1);
    // The host body keeps its name through the join.
    const body = one(joined.ev, state, joined.d.ref('body', joined.own, 'body', [], [indexItem(0) as Json]));
    expect(measured(joined.ev, body).volume).toBeCloseTo(8000 + 500, 6);
    for (const op of ['cut', 'intersect'] as const) {
      const t = hostWith(op);
      expect(t.ev.pauses).toEqual([
        { feature: t.derive, message: `a copying feature with operation ${op} is not built yet` },
      ]);
    }
  });

  it('refuses a part that derives from itself, and pauses a missing component', () => {
    const t = hosted();
    const sourceJson = (t.doc.parts as Json[])[0] as Json;
    const loop = t.d.feature('core.derive', {
      from: { part: { id: t.host.id } },
      instance: t.d.id('inst'),
      items: { all: {} },
      overrides: [],
      frame: t.d.fixedFrame(),
      operation: { op: t.d.val('"new"'), targets: { all: {} }, keepTools: t.d.flag(false) },
    });
    (sourceJson.timeline as Json[]).push(loop);
    const read = readDocument(t.doc);
    expect(read.refused).toBe(true);
    expect(read.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'cycle', message: expect.stringContaining('derives from itself') }),
    );

    const d = new Docs();
    const lib = d.id('lib');
    d.library.push({
      id: lib,
      kind: 'document',
      content: { missing: { name: 'Gone.cadjson' } },
      source: { local: {} },
      name: 'Gone',
    });
    const host = d.part('Host');
    const derive = host.derive({ component: { value: d.val('c', { c: lib }) } });
    const ev2 = evaluate(d.document({ part: { id: host.id } }));
    expect(ev2.pauses).toEqual([{ feature: derive, message: expect.stringContaining('missing') }]);
  });
});
