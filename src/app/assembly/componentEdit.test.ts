import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type EditorCommand, type Json } from '@tweakcad/editor';
import { newDocument } from '../document';
import { newTarget, ValueSlots } from '../modeling/feature';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  parametersOf,
  setConfigurationOverride,
} from '../parameters';
import { assemblyOf, newAssemblyCommands, rowsOf } from './assembly';
import {
  componentEditCommands,
  defaults,
  isOverridden,
  ORIGIN,
  readComponentEdit,
  resolvedValues,
  type ComponentSite,
} from './componentEdit';
import { buildDerive, readDerive } from './derive';
import { embedDocument, insertComponentCommands } from './library';

const ok = (r: { ok: boolean; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
};

/** A component: public width and height (height = width / 2), and a public configuration whose Wide row sets width 40. */
function component(): { doc: Json; width: string; height: string; input: string } {
  const ids = seededIds(51);
  const editor = new Editor(newDocument({ ids, name: 'Block' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  ok(addParameter(editor, { part }, 'width', 'length', '20'));
  ok(addParameter(editor, { part }, 'height', 'length', 'width / 2'));
  ok(addConfiguration(editor, part));
  for (const p of parametersOf(editor.document, { part }))
    ok(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { public: true } }));
  const params = parametersOf(editor.document, { part });
  const width = params.find((p) => p.name === 'width')!;
  ok(editor.dispatch({ type: 'editParameter', parameter: width.id, set: { description: 'Overall width' } }));
  ok(addConfigurationRow(editor, configurationsOf(editor.document, part)[0]!, 'Wide'));
  ok(setConfigurationOverride(editor, part, configurationsOf(editor.document, part)[0]!, 'Wide', width, '40'));
  return {
    doc: editor.document,
    width: width.id,
    height: params.find((p) => p.name === 'height')!.id,
    input: configurationsOf(editor.document, part)[0]!.input.id,
  };
}

function run(editor: Editor, commands: readonly EditorCommand[]) {
  editor.transaction('Edit', () => {
    for (const c of commands) ok(editor.dispatch(c));
    return { ok: true, label: 'Edit', changed: true };
  });
}

function host() {
  const ids = seededIds(53);
  const editor = new Editor(newDocument({ ids, name: 'Host' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  const c = component();
  const embedded = embedDocument(c.doc, 'Block', editor.newId('lib'), {
    catalogue: { id: 'block', version: '1', policy: 'pinned' },
  });
  return { editor, part, embedded, ...c };
}

describe('Edit Component', () => {
  it('reads and writes an instance placement as translation and rotation angles', () => {
    const { editor, part, embedded } = host();
    const made = newAssemblyCommands(editor, 'Assembly 1', [part]);
    run(editor, made.commands);
    run(editor, insertComponentCommands(editor, embedded, { assembly: made.assembly }, []));
    const instance = String((rowsOf(assemblyOf(editor.document, made.assembly), 'instances')[1] as Json).id);
    const site: ComponentSite = { assembly: made.assembly, instance };
    const edit = readComponentEdit(editor.document, site)!;
    expect(edit.origin).toBe('catalog:block');
    expect(edit.placement).toEqual(ORIGIN);
    run(
      editor,
      componentEditCommands(editor.document, site, {
        ...edit,
        placement: { position: ['10', '0', '-5'], rotation: ['0', '0', '90'] },
      }),
    );
    const row = rowsOf(assemblyOf(editor.document, made.assembly), 'instances')[1] as Json;
    const placement = row.placement as { position: number[]; rotation: number[] };
    expect(placement.position).toEqual([10, 0, -5]);
    placement.rotation.forEach((v, i) => expect(v).toBeCloseTo([0, 0, Math.SQRT1_2, Math.SQRT1_2][i] as number, 9));
    expect(readComponentEdit(editor.document, site)?.placement).toEqual({
      position: ['10', '0', '-5'],
      rotation: ['0', '0', '90'],
    });
    // A field that does not read keeps the placement stored.
    const kept = componentEditCommands(editor.document, site, {
      ...edit,
      placement: { position: ['x', '0', '0'], rotation: ['0', '0', '0'] },
    });
    expect(((kept[0] as { set: Json }).set as Json).placement).toBeUndefined();
    expect(readDocument(editor.document).refused).toBe(false);
  });

  it('writes a derive placement into its frame, which the Derive panel keeps, and cuts', () => {
    const { editor, part, embedded } = host();
    run(editor, insertComponentCommands(editor, embedded, { part }, []));
    const feature = String(((((editor.document.parts as Json[])[0] as Json).timeline as Json[]).at(-1) as Json).id);
    const site: ComponentSite = { feature };
    const edit = readComponentEdit(editor.document, site)!;
    expect(edit.operation).toBe('new');
    expect(edit.placement).toEqual(ORIGIN);
    run(
      editor,
      componentEditCommands(editor.document, site, {
        ...edit,
        operation: 'cut',
        placement: { position: ['5', '2 * 3 mm', '0'], rotation: ['90', '0', '0'] },
      }),
    );
    const read = readComponentEdit(editor.document, site)!;
    expect(read.operation).toBe('cut');
    expect(read.placement).toEqual({ position: ['5', '2 * 3 mm', '0'], rotation: ['90', '0', '0'] });
    expect(readDocument(editor.document).refused).toBe(false);

    // The Derive panel reads the turned frame, offers Cut, and writes the rotation back as it found it.
    const featureRow = (((editor.document.parts as Json[])[0] as Json).timeline as Json[]).at(-1) as Json;
    const form = readDerive(editor.document, part, featureRow.inputs as Json)!;
    expect(form.operation).toBe('cut');
    expect(form.rotation).toBe('rotate(vector(1, 0, 0), 90 deg)');
    const target = newTarget(editor, part, 'Derive');
    const built = buildDerive(
      editor.document,
      { ...target, base: featureRow.inputs as Json },
      { ...form, x: '7' },
      new ValueSlots(() => editor.newId('val')),
    );
    if (!built.ok) throw new Error(built.message);
    const text = ((((built.inputs.frame as Json).fixed as Json).placement as Json).def as Json).expr as Json;
    expect(text.text).toBe('placement(vector(7 mm, 2 * 3 mm, 0 mm), rotate(vector(1, 0, 0), 90 deg))');
  });

  it("reads a derive's operation set by a parameter, and keeps it until another is picked", () => {
    const { editor, part, embedded } = host();
    run(editor, insertComponentCommands(editor, embedded, { part }, []));
    ok(addParameter(editor, { part }, 'how', 'text', '"join"'));
    const how = parametersOf(editor.document, { part }).find((p) => p.name === 'how')!;
    const featureRow = () => (((editor.document.parts as Json[])[0] as Json).timeline as Json[]).at(-1) as Json;
    const feature = String(featureRow().id);
    const op = () => ((featureRow().inputs as Json).operation as Json).op as Json;
    ok(
      editor.dispatch({
        type: 'setValueDef',
        value: String(op().id),
        def: { expr: { text: 'how', grammar: 1, refs: { how: { parameter: { id: how.id } } } } },
      }),
    );
    const site: ComponentSite = { feature };
    const edit = readComponentEdit(editor.document, site)!;
    expect(edit).toMatchObject({ operation: 'join', operationBound: 'how' });
    run(editor, componentEditCommands(editor.document, site, edit));
    expect(((op().def as Json).expr as Json).text).toBe('how');
    run(editor, componentEditCommands(editor.document, site, { ...edit, operation: 'cut' }));
    expect(((op().def as Json).expr as Json).text).toBe('"cut"');
  });

  it('shows what each public parameter resolves to under the edit, and which are overridden', () => {
    const { editor, part, embedded, width, height, input } = host();
    run(editor, insertComponentCommands(editor, embedded, { part }, []));
    const feature = String(((((editor.document.parts as Json[])[0] as Json).timeline as Json[]).at(-1) as Json).id);
    const site: ComponentSite = { feature };
    const edit = readComponentEdit(editor.document, site)!;
    expect(edit.params.map((p) => [p.name, p.description])).toEqual([
      ['width', 'Overall width'],
      ['height', ''],
    ]);
    expect(resolvedValues(editor.document, site, edit)).toEqual({
      [width]: { ok: true, text: '20 mm' },
      [height]: { ok: true, text: '10 mm' },
    });
    // A value the insertion does not set has an empty field (the panel greys in what it resolves to), never the component's own text beside a row's value.
    expect(edit.values).toEqual({ [width]: '', [height]: '' });
    expect(defaults({ ...edit, values: { [width]: '30', [height]: '' } }).values).toEqual({
      [width]: '',
      [height]: '',
    });
    // The Wide row, then a typed width over it; the height follows.
    expect(resolvedValues(editor.document, site, { ...edit, rows: { [input]: 'Wide' } })).toMatchObject({
      [width]: { text: '40 mm' },
      [height]: { text: '20 mm' },
    });
    const typed = { ...edit, values: { ...edit.values, [width]: '30' } };
    expect(resolvedValues(editor.document, site, typed)).toMatchObject({
      [width]: { text: '30 mm' },
      [height]: { text: '15 mm' },
    });
    expect(isOverridden(typed, edit.params[0]!)).toBe(true);
    expect(isOverridden(edit, edit.params[0]!)).toBe(false);
    expect(
      resolvedValues(editor.document, site, { ...edit, values: { ...edit.values, [width]: '3 +' } })[width],
    ).toMatchObject({ ok: false });
  });
  it("binds the host's parameters in overrides and placements, on insert, on edit and in the Derive panel", () => {
    const { editor, part, embedded, width } = host();
    ok(addParameter(editor, { part }, 'gap', 'length', '3'));
    const gap = parametersOf(editor.document, { part }).find((p) => p.name === 'gap')!.id;
    const override = {
      value: { target: { parameter: { id: width } }, def: { expr: { text: 'gap * 10', grammar: 1, refs: {} } } },
    };
    run(editor, insertComponentCommands(editor, embedded, { part }, [override]));
    const derive = () => (((editor.document.parts as Json[])[0] as Json).timeline as Json[]).at(-1) as Json;
    const refsOf = (v: unknown) => ((v as Json).def as Json).expr as Json;
    expect(refsOf(((derive().inputs as Json).overrides as Json[])[0]!.value).refs).toEqual({
      gap: { parameter: { id: gap } },
    });
    const site: ComponentSite = { feature: String(derive().id) };
    const edit = readComponentEdit(editor.document, site)!;
    expect(edit.values[width]).toBe('gap * 10');

    // Unchanged, the override is kept as stored; a placement naming the parameter binds it.
    const stored = ((derive().inputs as Json).overrides as Json[])[0];
    run(
      editor,
      componentEditCommands(editor.document, site, {
        ...edit,
        placement: { position: ['gap', '0', '0'], rotation: ['0', '0', '0'] },
      }),
    );
    expect(((derive().inputs as Json).overrides as Json[])[0]).toEqual(stored);
    const placement = (((derive().inputs as Json).frame as Json).fixed as Json).placement;
    expect(refsOf(placement)).toMatchObject({
      text: 'placement(vector(gap, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))',
      refs: { gap: { parameter: { id: gap } } },
    });

    // The Derive panel binds the name too.
    const form = readDerive(editor.document, part, derive().inputs as Json)!;
    const built = buildDerive(
      editor.document,
      { part, feature: String(derive().id), base: derive().inputs as Json },
      { ...form, y: 'gap * 2' },
      new ValueSlots(() => editor.newId('val'), derive().inputs as Json),
    );
    if (!built.ok) throw new Error(built.message);
    expect(refsOf(((built.inputs.frame as Json).fixed as Json).placement).refs).toEqual({
      gap: { parameter: { id: gap } },
    });
    run(editor, [{ type: 'replaceInput', feature: String(derive().id), pointer: '', with: built.inputs }]);
    expect(readDocument(editor.document).refused).toBe(false);
  });
});
