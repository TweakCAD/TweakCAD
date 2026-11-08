import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { bodyGroups, componentsOf, duplicateDerive, freshInputs } from './browserActions';
import { buildDerive, newDeriveForm } from './assembly/derive';
import type { FeatureRow } from './features';
import { ValueSlots, newTarget, writeFeature } from './modeling/feature';

const row = (o: Partial<FeatureRow> & { id: string; type: string }): FeatureRow => ({
  name: o.id,
  iconKey: o.type.replace(/^core\./, ''),
  suppressed: false,
  frozen: false,
  status: 'success',
  hidden: false,
  children: [],
  ...o,
});

function derived(): { editor: Editor; base: string; feature: string } {
  const d = new Docs(7);
  const base = d.part('Base');
  base.box('60 mm', '40 mm', '10 mm', [0, 0, 5]);
  const arm = d.part('Arm');
  arm.box('40 mm', '10 mm', '6 mm', [0, 0, 3]);
  const editor = new Editor(d.document({ part: { id: base.id } }), { ids: seededIds(5) });
  const target = newTarget(editor, base.id, 'Derive');
  const form = { ...newDeriveForm(editor.document, base.id, editor.newId('inst')), source: { part: arm.id }, z: '20' };
  const built = buildDerive(editor.document, target, form, new ValueSlots(() => editor.newId('val')));
  if (!built.ok) throw new Error(built.message);
  expect(writeFeature(editor, target, 'core.derive', built, 'Derive').ok).toBe(true);
  return { editor, base: base.id, feature: target.feature };
}

describe('duplicating a derived component', () => {
  it('adds another derive with the same inputs, fresh value and instance ids, named as the next', () => {
    const { editor, base, feature } = derived();
    expect(duplicateDerive(editor, feature).ok).toBe(true);
    const timeline = ((editor.document.parts as Json[]).find((p) => p.id === base)?.timeline ?? []) as Json[];
    const derives = timeline.filter((f) => f.type === 'core.derive');
    expect(derives.map((f) => f.name)).toEqual(['Derive 1', 'Derive 2']);
    const [a, b] = derives as [Json, Json];
    expect(b.id).not.toBe(a.id);
    const inputsA = a.inputs as Json;
    const inputsB = b.inputs as Json;
    expect(inputsB.from).toEqual(inputsA.from);
    expect(inputsB.instance).not.toBe(inputsA.instance);
    const valueIds = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.flatMap(valueIds)
        : v && typeof v === 'object'
          ? [
              ...('def' in v && typeof (v as Json).id === 'string' ? [(v as Json).id as string] : []),
              ...Object.values(v).flatMap(valueIds),
            ]
          : [];
    const idsA = valueIds(inputsA);
    expect(idsA.length).toBeGreaterThan(0);
    expect(valueIds(inputsB).some((id) => idsA.includes(id))).toBe(false);
    expect(readDocument(editor.document).refused).toBe(false);
  });

  it('refuses a feature that is not a derive', () => {
    const { editor, base } = derived();
    const first = (((editor.document.parts as Json[]).find((p) => p.id === base)?.timeline ?? []) as Json[])[0] as Json;
    expect(duplicateDerive(editor, String(first.id)).ok).toBe(false);
  });

  it('renews every value id and the instance, and nothing else', () => {
    let n = 0;
    const out = freshInputs(
      {
        instance: 'inst_a',
        from: { part: { id: 'part_a' } },
        offset: { id: 'val_a', def: { expr: { text: '1' } } },
        list: [{ id: 'val_b', def: {} }],
      },
      (kind) => `${kind}_${++n}`,
    );
    expect(out).toEqual({
      instance: 'inst_3',
      from: { part: { id: 'part_a' } },
      offset: { id: 'val_1', def: { expr: { text: '1' } } },
      list: [{ id: 'val_2', def: {} }],
    });
  });
});

describe('browser groups', () => {
  it('lists derived components, composites included', () => {
    const rows = [
      row({ id: 'a', type: 'core.extrude' }),
      row({ id: 'b', type: 'core.derive' }),
      row({ id: 'c', type: 'core.pattern', children: [row({ id: 'd', type: 'core.derive' })] }),
    ];
    expect(componentsOf(rows).map((r) => r.id)).toEqual(['b', 'd']);
  });

  it('puts the bodies of an import that made several under it, at its first body', () => {
    const rows = [
      row({ id: 'imp', type: 'core.import' }),
      row({ id: 'one', type: 'core.import' }),
      row({ id: 'ext', type: 'core.extrude' }),
    ];
    const bodies = [
      { key: 1, feature: 'ext' },
      { key: 2, feature: 'imp' },
      { key: 3, feature: 'one' },
      { key: 4, feature: 'imp' },
      { key: 5, feature: 'ext' },
    ];
    const groups = bodyGroups(rows, bodies).map((g) =>
      'body' in g ? g.body.key : { [g.feature.id]: g.bodies.map((b) => b.key) },
    );
    // Two bodies of an extrude stay apart; an import of one body is a plain row.
    expect(groups).toEqual([1, { imp: [2, 4] }, 3, 5]);
  });
});
