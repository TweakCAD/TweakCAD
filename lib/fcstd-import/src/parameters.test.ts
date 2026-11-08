import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { importFcstdXml } from './index';
import type { Json } from './writer';

const options = () => ({ ids: seededIds(5), writer: { app: 'test', version: '0' }, now: '2026-11-06T00:00:00Z' });

const prop = (name: string, inner: string) => `<Property name="${name}">${inner}</Property>`;
const float = (name: string, v: number) => prop(name, `<Float value="${v}"/>`);
/** A Body of one box beside `objects`. */
const xmlOf = (objects: { name: string; type: string; props: string }[]) => {
  const all = [
    ...objects,
    {
      name: 'Body',
      type: 'PartDesign::Body',
      props: prop('Group', '<LinkList count="1"><Link value="Box"/></LinkList>') + prop('Tip', '<Link value="Box"/>'),
    },
    {
      name: 'Box',
      type: 'PartDesign::AdditiveBox',
      props: float('Length', 10) + float('Width', 10) + float('Height', 10),
    },
  ];
  return `<Document ProgramVersion="1.1"><Objects>${all.map((o) => `<Object type="${o.type}" name="${o.name}"/>`).join('')}</Objects><ObjectData>${all
    .map((o) => `<Object name="${o.name}"><Properties>${o.props}</Properties></Object>`)
    .join('')}</ObjectData></Document>`;
};
const sheet = (cells: [string, string, string][]) => ({
  name: 'Sheet',
  type: 'Spreadsheet::Sheet',
  props: prop(
    'cells',
    `<Cells Count="${cells.length}" xlink="0">${cells.map(([address, content, alias]) => `<Cell address="${address}" content="${content}" alias="${alias}"/>`).join('')}</Cells>`,
  ),
});

/** The imported parameters by name, each with its text, and the notes about them. */
function imported(objects: { name: string; type: string; props: string }[]) {
  const result = importFcstdXml(xmlOf(objects), options());
  if (!result.ok) throw new Error(result.error);
  const { document, notes } = result.value;
  expect(readDocument(document).refused).toBe(false);
  const rows = (document.parameters as Json[]).flatMap((t) => t.parameters as Json[]);
  return {
    parameters: Object.fromEntries(rows.map((p) => [p.name, (((p.value as Json).def as Json).expr as Json).text])),
    notes: notes.filter((n) => n.object === 'Sheet' || n.object === 'Vars').map((n) => n.message),
  };
}

describe('importing parameters', () => {
  it('leaves out a VarSet property that is not a number', () => {
    const vars = {
      name: 'Vars',
      type: 'App::VarSet',
      props: [
        '<Property name="Width" type="App::PropertyLength"><Float value="abc"/></Property>',
        '<Property name="Depth" type="App::PropertyLength"><Float value="12.5"/></Property>',
      ].join(''),
    };
    expect(imported([vars])).toEqual({
      parameters: { Depth: '12.5 mm' },
      notes: ['its Width is not a number, so it was left out'],
    });
  });

  it('leaves out a spreadsheet cell that is not a number the expression grammar reads', () => {
    expect(
      imported([
        sheet([
          ['A1', '1.2.3 mm', 'a'],
          ['A2', '4 mm', 'b'],
        ]),
      ]),
    ).toEqual({ parameters: { b: '4 mm' }, notes: ['its a is not a number here, so it was left out'] });
  });

  it('leaves out a spreadsheet formula of aliases that the expression grammar does not read', () => {
    expect(
      imported([
        sheet([
          ['A1', '10 mm', 'a'],
          ['A2', '=a +', 'b'],
          ['A3', '=a * 2', 'c'],
        ]),
      ]),
    ).toEqual({
      parameters: { a: '10 mm', c: 'a * 2' },
      notes: ['its b is not an expression read here, so it was left out'],
    });
  });
});
