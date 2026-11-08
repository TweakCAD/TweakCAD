import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { newDocument } from './document';
import { addConfiguration, addParameter, parametersOf, type ParameterView } from './parameters';
import { AddParameterRow, ParameterRow } from './ParametersDialog';

function setup() {
  const ids = seededIds(61);
  const editor = new Editor(newDocument({ ids, name: 'p' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  return { editor, part };
}

const run = () => true;
const ask = () => Promise.resolve(false);
const table = (rows: React.ReactNode) =>
  renderToStaticMarkup(
    <table>
      <tbody>{rows}</tbody>
    </table>,
  );

describe('the parameters dialog', () => {
  it('shows a length with its unit and a Kind select, and a choice with its options to edit', () => {
    const { editor, part } = setup();
    addParameter(editor, { part }, 'width', 'length', '40');
    addParameter(editor, { part }, 'finish', 'choice', 'matte', ['matte', 'gloss']);
    const [width, finish] = parametersOf(editor.document, { part }) as [ParameterView, ParameterView];
    const w = table(
      <ParameterRow editor={editor} doc={editor.document} scope={{ part }} p={width} run={run} ask={ask} />,
    );
    expect(w).toMatch(/aria-label="width value"[^>]*value="40"\/><span[^>]*>mm<\/span>/);
    expect(w).toContain('40 mm</td>');
    expect(w).toMatch(/<select aria-label="width kind"[^>]*><option value="length" selected="">Length<\/option>/);
    expect(w).toContain('aria-label="Remove width"');
    const f = table(
      <ParameterRow editor={editor} doc={editor.document} scope={{ part }} p={finish} run={run} ask={ask} />,
    );
    expect(f).toMatch(
      /<select aria-label="finish value"[^>]*><option value="matte" selected="">matte<\/option><option value="gloss">gloss<\/option>/,
    );
    expect(f).toContain('Options:');
    expect(f).toMatch(/aria-label="finish options"[^>]*value="matte, gloss"/);
  });

  it('keeps a configuration input a choice, its options the configuration rows', () => {
    const { editor, part } = setup();
    addConfiguration(editor, part);
    const input = parametersOf(editor.document, { part })[0] as ParameterView;
    const html = table(
      <ParameterRow editor={editor} doc={editor.document} scope={{ part }} p={input} run={run} ask={ask} />,
    );
    expect(html).not.toContain('kind"');
    expect(html).not.toContain('Options:');
  });

  it('adds with Pub, a suggested name, the unit and a description', () => {
    const { editor, part } = setup();
    addParameter(editor, { part }, 'width', 'length', '40');
    const params = parametersOf(editor.document, { part });
    const html = table(<AddParameterRow doc={editor.document} scope={{ part }} params={params} onAdd={() => true} />);
    expect(html).toContain('aria-label="New parameter public"');
    expect(html).toContain('placeholder="param_2"');
    expect(html).toMatch(/aria-label="New parameter value"[^>]*\/><span[^>]*>mm<\/span>/);
    expect(html).toContain('aria-label="New parameter description"');
  });
});
