import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { attributeFor, featureHidden, setVisible } from './attributes';
import { newDocument } from './document';
import { partView } from './features';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  evaluatedText,
  parametersOf,
  plainRow,
  previewText,
  removeConfigurationRow,
  renameConfigurationRow,
  setActiveConfiguration,
  setConfigurationOverride,
  setParameterKind,
  setParameterOptions,
  setParameterText,
  shownParameters,
  suggestedName,
  type ParameterView,
} from './parameters';

function setup() {
  const ids = seededIds(31);
  const editor = new Editor(newDocument({ ids, name: 'p' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  return { editor, part };
}

const ok = (r: { ok: boolean; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
};
const clean = (editor: Editor) => expect(readDocument(editor.document).refused).toBe(false);

describe('parameters', () => {
  it('adds the first parameter of a scope with its table, as one step, and edits it', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { document: true }, 'width', 'length', '40'));
    expect(editor.store.undoLabel()).toBe('Add width');
    ok(addParameter(editor, { part }, 'height', 'length', 'width / 2'));
    ok(addParameter(editor, { part }, 'holes', 'integer', '4'));
    ok(addParameter(editor, { part }, 'finish', 'choice', 'matte', ['matte', 'gloss']));
    clean(editor);
    const doc = parametersOf(editor.document, { document: true });
    const own = parametersOf(editor.document, { part });
    expect(doc.map((p) => [p.name, p.text])).toEqual([['width', '40 mm']]);
    expect(own.map((p) => [p.name, p.kind, p.text])).toEqual([
      ['height', 'length', 'width / 2'],
      ['holes', 'integer', '4'],
      ['finish', 'choice', '"matte"'],
    ]);
    expect(evaluatedText(editor.document, { part }, own[0] as ParameterView)).toBe('20 mm');
    // A document parameter sees only the document's table.
    expect(addParameter(editor, { document: true }, 'w2', 'length', 'height').ok).toBe(false);
    expect(addParameter(editor, { part }, '2bad', 'length', '1').ok).toBe(false);
    ok(setParameterText(editor, { document: true }, doc[0] as ParameterView, '60'));
    expect(evaluatedText(editor.document, { part }, parametersOf(editor.document, { part })[0] as ParameterView)).toBe(
      '30 mm',
    );
    expect(setParameterText(editor, { part }, own[0] as ParameterView, '30 deg').ok).toBe(false);
    clean(editor);
  });

  it('makes a parameter public and describes it, each one step', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'width', 'length', '40'));
    const p = parametersOf(editor.document, { part })[0] as ParameterView;
    expect(p.public).toBe(false);
    ok(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { public: true } }));
    ok(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { description: 'Plate width' } }));
    clean(editor);
    expect(parametersOf(editor.document, { part })[0]).toMatchObject({ public: true, description: 'Plate width' });
    editor.undo();
    editor.undo();
    expect(parametersOf(editor.document, { part })[0]).toMatchObject({ public: false, description: '' });
  });
});

describe('editing a parameter after it is made', () => {
  it('adds one public and described, and suggests param_N for a name', () => {
    const { editor, part } = setup();
    expect(suggestedName([])).toBe('param_1');
    ok(
      addParameter(editor, { part }, suggestedName(parametersOf(editor.document, { part })), 'length', '5', [], {
        public: true,
        description: 'Gap',
      }),
    );
    expect(parametersOf(editor.document, { part })[0]).toMatchObject({
      name: 'param_1',
      public: true,
      description: 'Gap',
    });
    expect(suggestedName([{ name: 'param_1' }, { name: 'param_2' }])).toBe('param_3');
    expect(suggestedName([{ name: 'x' }, { name: 'param_2' }])).toBe('param_3');
    clean(editor);
  });

  it('changes the kind of a parameter, keeping its value where it reads as the new kind, as one step', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'width', 'length', '40'));
    const view = () => parametersOf(editor.document, { part })[0] as ParameterView;
    ok(setParameterKind(editor, { part }, view(), 'number'));
    expect(view()).toMatchObject({ kind: 'number', text: '40' });
    expect(editor.store.undoLabel()).toBe('Make width Number');
    ok(setParameterKind(editor, { part }, view(), 'angle'));
    expect(view()).toMatchObject({ kind: 'angle', text: '40 deg' });
    ok(setParameterKind(editor, { part }, view(), 'boolean'));
    expect(view()).toMatchObject({ kind: 'boolean', text: 'false' });
    ok(setParameterKind(editor, { part }, view(), 'choice'));
    expect(view()).toMatchObject({ kind: 'choice', options: ['false'], text: '"false"' });
    clean(editor);
    editor.undo();
    editor.undo();
    expect(view()).toMatchObject({ kind: 'angle', text: '40 deg' });
    // The input of a configuration stays a choice.
    ok(addConfiguration(editor, part));
    const input = configurationsOf(editor.document, part)[0]!.input;
    expect(setParameterKind(editor, { part }, input, 'text').ok).toBe(false);
    // A length becomes a choice of its number.
    ok(addParameter(editor, { part }, 'gap', 'length', '25'));
    const gap = parametersOf(editor.document, { part }).find((p) => p.name === 'gap')!;
    ok(setParameterKind(editor, { part }, gap, 'choice'));
    expect(parametersOf(editor.document, { part }).find((p) => p.name === 'gap')).toMatchObject({
      kind: 'choice',
      options: ['25'],
      text: '"25"',
    });
  });

  it('edits the options of a choice; its value moves to the first when they drop it', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'finish', 'choice', 'matte', ['matte', 'gloss']));
    const view = () => parametersOf(editor.document, { part })[0] as ParameterView;
    ok(setParameterOptions(editor, view(), ['matte', 'gloss', 'satin']));
    expect(view()).toMatchObject({ options: ['matte', 'gloss', 'satin'], text: '"matte"' });
    ok(setParameterOptions(editor, view(), ['satin', 'gloss']));
    expect(view()).toMatchObject({ options: ['satin', 'gloss'], text: '"satin"' });
    expect(setParameterOptions(editor, view(), [' ', '']).ok).toBe(false);
    clean(editor);
  });

  it('previews what typed text comes to before it is committed', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'width', 'length', '40'));
    expect(previewText(editor.document, { part }, 'length', [], 'width / 4')).toEqual({ ok: true, text: '10 mm' });
    expect(previewText(editor.document, { part }, 'length', [], 'width +')).toMatchObject({ ok: false });
    expect(previewText(editor.document, { part }, 'choice', ['a', 'b'], 'b')).toEqual({ ok: true, text: 'b' });
  });
});

describe('configurations', () => {
  it('adds presets of the part parameters, renames and removes rows, and switches the active one', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'length', 'length', '10'));
    ok(addConfiguration(editor, part));
    let [c] = configurationsOf(editor.document, part);
    expect(c).toMatchObject({ active: 'Default', rows: [{ option: 'Default' }] });
    expect(c?.input.name).toBe('configuration');
    ok(addConfigurationRow(editor, c!, 'M3x10'));
    ok(addConfigurationRow(editor, configurationsOf(editor.document, part)[0]!, 'M3x20'));
    expect(addConfigurationRow(editor, configurationsOf(editor.document, part)[0]!, 'M3x20').ok).toBe(false);
    const length = parametersOf(editor.document, { part }).find((p) => p.name === 'length') as ParameterView;
    ok(setConfigurationOverride(editor, part, configurationsOf(editor.document, part)[0]!, 'M3x20', length, '20'));
    clean(editor);
    c = configurationsOf(editor.document, part)[0];
    expect(c?.rows.map((r) => [r.option, r.overrides.get(length.id) ?? null])).toEqual([
      ['Default', null],
      ['M3x10', null],
      ['M3x20', '20 mm'],
    ]);

    // The active row decides the parameter's value.
    ok(setActiveConfiguration(editor, c!, 'M3x20'));
    expect(configurationsOf(editor.document, part)[0]?.active).toBe('M3x20');
    clean(editor);

    // Renaming the active row renames its option and keeps it active; removing it moves to the first row.
    ok(renameConfigurationRow(editor, configurationsOf(editor.document, part)[0]!, 'M3x20', 'Long'));
    c = configurationsOf(editor.document, part)[0];
    expect(c?.active).toBe('Long');
    expect(c?.input.options).toEqual(['Default', 'M3x10', 'Long']);
    clean(editor);
    ok(removeConfigurationRow(editor, c!, 'Long'));
    c = configurationsOf(editor.document, part)[0];
    expect(c?.active).toBe('Default');
    expect(c?.rows.map((r) => r.option)).toEqual(['Default', 'M3x10']);
    ok(setConfigurationOverride(editor, part, c!, 'M3x10', length, '12'));
    // Clear active picks a row that overrides nothing, once the active one overrides something.
    expect(plainRow(configurationsOf(editor.document, part)[0]!)).toBeNull();
    ok(setActiveConfiguration(editor, configurationsOf(editor.document, part)[0]!, 'M3x10'));
    expect(plainRow(configurationsOf(editor.document, part)[0]!)).toBe('Default');
    ok(setActiveConfiguration(editor, configurationsOf(editor.document, part)[0]!, 'Default'));
    ok(setConfigurationOverride(editor, part, configurationsOf(editor.document, part)[0]!, 'M3x10', length, ''));
    expect(configurationsOf(editor.document, part)[0]?.rows[1]?.overrides.size).toBe(0);
    clean(editor);
  });
});

describe('attributes', () => {
  it('hides what a feature shows through an attribute, and shows it again by removing it', () => {
    const { editor, part } = setup();
    const feature = {
      id: editor.newId('feat'),
      type: 'core.constructionPlane',
      typeVersion: 1,
      name: 'Plane 1',
      suppressed: { id: editor.newId('val'), def: { expr: { text: 'false', grammar: 1, refs: {} } } },
      frozen: { live: {} },
      command: { alone: {} },
      inputs: {
        frame: {
          fixed: {
            placement: {
              id: editor.newId('val'),
              def: {
                expr: {
                  text: 'placement(vector(0 mm, 0 mm, 0 mm), rotate(vector(0, 0, 1), 0 deg))',
                  grammar: 1,
                  refs: {},
                },
              },
            },
          },
        },
      },
    };
    ok(editor.dispatch({ type: 'addFeature', container: part, feature }));
    ok(setVisible(editor, part, { feature: feature.id }, false));
    expect(featureHidden(editor.document, part, feature.id)).toBe(true);
    expect(partView(editor.document, part, null)?.features[0]?.hidden).toBe(true);
    clean(editor);
    ok(setVisible(editor, part, { feature: feature.id }, true));
    expect(attributeFor(editor.document, part, { feature: feature.id })).toBeUndefined();
  });
});

describe('the browser parameter list', () => {
  /** The fixture nut, its Size configuration set to `size`. */
  function nut(size: string): { doc: Json; part: string } {
    const file = resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      '../../lib/testing/fixtures/v2/hex-nut-iso4032.cadjson',
    );
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Json;
    const part = (doc.parts as Json[])[0] as Json;
    for (const table of part.parameters as Json[]) {
      for (const p of table.parameters as Json[])
        if (p.name === 'Size') ((p.value as Json).def as Json).expr = { grammar: 1, refs: {}, text: `"${size}"` };
    }
    return { doc, part: part.id as string };
  }

  it('shows each value under the selected configuration, and the row that sets it', () => {
    const { doc, part } = nut('M10');
    const shown = Object.fromEntries(shownParameters(doc, part).map((p) => [p.name, p]));
    expect(shown.thread).toMatchObject({ value: 'M10', text: '"M6"', configured: 'M10' });
    expect(shown.d).toMatchObject({ value: '10 mm', text: '6 mm', configured: 'M10' });
    // The input that selects the row is its own value.
    expect(shown.Size).toMatchObject({ value: 'M10', configured: null });
  });

  it('shows a value no configuration sets as its own, and an expression as what it comes to', () => {
    const { editor, part } = setup();
    ok(addParameter(editor, { part }, 'width', 'length', '20'));
    ok(addParameter(editor, { part }, 'height', 'length', 'width / 2'));
    expect(shownParameters(editor.document, part).map((p) => [p.name, p.value, p.text, p.configured])).toEqual([
      ['width', '20 mm', '20 mm', null],
      ['height', '10 mm', 'width / 2', null],
    ]);
  });
});
