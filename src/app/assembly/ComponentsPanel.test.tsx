import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ComponentDetail, ComponentSummary } from '@tweakcad/api-types';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { newDocument } from '../document';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  parametersOf,
  setConfigurationOverride,
} from '../parameters';
import { ComponentCard, ConfigureView } from './ComponentsPanel';
import { chooseRow, embedDocument, insertComponentCommands, insertOverrides, newInsertForm } from './library';

const ok = (r: { ok: boolean; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
};

/** A component: a public width with a description, a public choice, and a public Size configuration whose M4 row widens it. */
function component() {
  const ids = seededIds(41);
  const editor = new Editor(newDocument({ ids, name: 'Bolt' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  ok(addParameter(editor, { part }, 'width', 'length', '20'));
  ok(addParameter(editor, { part }, 'head', 'choice', 'hex', ['hex', 'socket']));
  ok(addConfiguration(editor, part));
  for (const p of parametersOf(editor.document, { part }))
    ok(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { public: true } }));
  const width = parametersOf(editor.document, { part }).find((p) => p.name === 'width')!;
  ok(editor.dispatch({ type: 'editParameter', parameter: width.id, set: { description: 'Shank width' } }));
  ok(addConfigurationRow(editor, configurationsOf(editor.document, part)[0]!, 'M4'));
  ok(setConfigurationOverride(editor, part, configurationsOf(editor.document, part)[0]!, 'M4', width, '40'));
  const input = configurationsOf(editor.document, part)[0]!.input.id;
  return { doc: editor.document, width: width.id, input };
}

const detail = {
  id: 'c1',
  slug: 'bolt',
  name: 'Bolt',
  standard: 'ISO 4762',
  thumbnailUrl: null,
  updatedAt: '2026-01-01',
  manifest: { schemaVersion: 1, parameters: [], installHint: 'Use a 3 mm hex key.' },
} as unknown as ComponentDetail;

const none = () => undefined;

describe('the Components panel', () => {
  it('shows a component card with its standard', () => {
    const item = {
      id: 'c1',
      slug: 'bolt',
      name: 'Bolt',
      standard: 'ISO 4762',
      thumbnailUrl: null,
      likeCount: 3,
    } as unknown as ComponentSummary;
    const html = renderToStaticMarkup(<ComponentCard item={item} onClick={none} />);
    expect(html).toContain('ISO 4762');
    expect(renderToStaticMarkup(<ComponentCard item={{ ...item, standard: null }} onClick={none} />)).not.toContain(
      'ISO',
    );
  });

  it('configures a component: Size, a choice as a select, units, descriptions and the Boolean of a part insert', () => {
    const { doc } = component();
    const form = newInsertForm(doc);
    const html = renderToStaticMarkup(
      <ConfigureView
        detail={detail}
        form={form}
        target="part"
        error={null}
        onChange={none}
        onBack={none}
        onInsert={none}
      />,
    );
    expect(html).toContain('ISO 4762');
    expect(html).toContain('Use a 3 mm hex key.');
    expect(html).toMatch(/Size<\/span><select[^>]*data-testid="components-configuration-select"/);
    expect(html).toContain('<option value="Default" selected="">Default</option><option value="M4">M4</option>');
    expect(html).toContain('title="width">Shank width</span>');
    expect(html).toMatch(/aria-label="width"[^>]*\/><span[^>]*>mm<\/span>/);
    expect(html).toMatch(
      /<select[^>]*data-testid="param-input-head"[^>]*><option value="hex" selected="">hex<\/option><option value="socket">socket<\/option>/,
    );
    expect(html).toContain(
      '<option value="new" selected="">New body</option><option value="cut">Cut from existing bodies</option><option value="join">Join with existing bodies</option>',
    );
    expect(html).toContain('Insert into the part');
    // An instance in an assembly meets no bodies.
    const asm = renderToStaticMarkup(
      <ConfigureView
        detail={detail}
        form={form}
        target="assembly"
        error={null}
        onChange={none}
        onBack={none}
        onInsert={none}
      />,
    );
    expect(asm).not.toContain('Boolean');
    expect(asm).toContain('Insert into the assembly');
  });

  it('seeds the fields from the chosen Size and overrides only what differs from it', () => {
    const { doc, width, input } = component();
    const form = newInsertForm(doc);
    expect(form.values[width]).toBe('20 mm');
    expect(insertOverrides(form)).toEqual([]);
    const m4 = chooseRow(form, input, 'M4');
    expect(m4.values[width]).toBe('40 mm');
    expect(insertOverrides(m4).map((o) => ((o.value as Json).def as Json).expr)).toEqual([
      { text: '"M4"', grammar: 1, refs: {} },
    ]);
    const wider = { ...m4, values: { ...m4.values, [width]: '45' } };
    expect(insertOverrides(wider).map((o) => (((o.value as Json).def as Json).expr as Json).text)).toEqual([
      '45 mm',
      '"M4"',
    ]);
    // Back to the component's own row: no override of the input.
    expect(insertOverrides(chooseRow(m4, input, 'Default'))).toEqual([]);
  });

  it('derives a component into a part as a cut', () => {
    const { doc } = component();
    const ids = seededIds(43);
    const host = new Editor(newDocument({ ids, name: 'Host' }), { ids });
    const part = ((host.document.parts as Json[])[0] as Json).id as string;
    const embedded = embedDocument(doc, 'Bolt', host.newId('lib'), { local: {} });
    const commands = insertComponentCommands(host, embedded, { part }, [], 'cut');
    const feature = (commands.find((c) => c.type === 'addFeature') as { feature: Json }).feature;
    expect(((((feature.inputs as Json).operation as Json).op as Json).def as Json).expr).toMatchObject({
      text: '"cut"',
    });
  });
});
