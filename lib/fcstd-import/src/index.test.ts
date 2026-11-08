import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readDocument, writeDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { importFcstd, importFcstdXml } from './index';
import type { Json } from './writer';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, '..', 'fixtures', name);
const options = () => ({ ids: seededIds(5), writer: { app: 'test', version: '0' }, now: '2026-11-06T00:00:00Z' });

const timeline = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];

describe('importing FreeCAD files', () => {
  it('converts a FreeCAD 0.19 file of sketches, a revolution, a pad and a groove into a document that reads clean', () => {
    const result = importFcstdXml(readFileSync(fixture('nozzle-0.19.Document.xml'), 'utf8'), options());
    if (!result.ok) throw new Error(result.error);
    const { document, notes, steps } = result.value;
    expect(readDocument(document).refused).toBe(false);
    expect(timeline(document).map((f) => f.type)).toEqual([
      'core.sketch',
      'core.revolve',
      'core.sketch',
      'core.extrude',
      'core.sketch',
      'core.revolve',
    ]);
    expect(steps).toEqual([]);
    expect(notes.filter((n) => n.severity === 'warning')).toEqual([]);
    const sketch = timeline(document)[0] as Json;
    expect(((sketch.inputs as Json).constraints as Json[]).length).toBeGreaterThan(10);
  });

  it('writes the same document from the same file', () => {
    const bytes = new Uint8Array(readFileSync(fixture('constrained_plate.FCStd')));
    const a = importFcstd(bytes, options());
    const b = importFcstd(bytes, options());
    if (!a.ok || !b.ok) throw new Error('not imported');
    expect(writeDocument(a.value.document)).toBe(writeDocument(b.value.document));
  });

  it('keeps the file and a report of what it did as the document’s origin (13.3)', () => {
    const bytes = new Uint8Array(readFileSync(fixture('constrained_plate.FCStd')));
    const result = importFcstd(bytes, { ...options(), name: 'plate' });
    if (!result.ok) throw new Error(result.error);
    const { document } = result.value;
    const origin = ((document.metadata as Json).origin as Json).imported as Json;
    expect(origin.format).toBe('FreeCAD');
    expect(String(origin.version)).toMatch(/^1\./);
    const assets = document.assets as Record<string, Json>;
    expect(assets[origin.source as string]?.size).toBe(bytes.length);
    expect(assets[origin.report as string]?.mediaType).toBe('application/json');
    expect((document.metadata as Json).name).toBe('plate');
  });

  it('names a dimension after its FreeCAD constraint name', () => {
    const xml = readFileSync(fixture('nozzle-0.19.Document.xml'), 'utf8').replace(
      'Name="" Type="7"',
      'Name="width" Type="7"',
    );
    const result = importFcstdXml(xml, options());
    if (!result.ok) throw new Error(result.error);
    const named = JSON.stringify(result.value.document).match(/"name":"width"/g);
    expect(named).toHaveLength(1);
    expect(readDocument(result.value.document).refused).toBe(false);
  });

  it('refuses what is not a FreeCAD file, and says when a file has no Body', () => {
    const notZip = importFcstd(strToU8('hello'), options());
    expect(notZip.ok).toBe(false);
    const noDocument = importFcstd(zipSync({ 'other.txt': strToU8('x') }), options());
    expect(noDocument.ok === false && noDocument.error).toMatch(/no Document\.xml/);
    const empty = importFcstd(
      zipSync({ 'Document.xml': strToU8('<Document ProgramVersion="1.1"><Objects/><ObjectData/></Document>') }),
      options(),
    );
    if (!empty.ok) throw new Error(empty.error);
    expect(empty.value.notes.map((n) => n.message)).toContain(
      'the file has no PartDesign Body or Part workbench solid, so nothing was imported',
    );
    expect(readDocument(empty.value.document).refused).toBe(false);
  });

  it('takes the shapes a file shows up to a budget of stored shape, the first always', () => {
    const shape = (name: string) =>
      `<Object name="${name}"><Properties><Property name="Shape" type="Part::PropertyPartShape"><Part file="${name}.brp"/></Property></Properties></Object>`;
    const names = ['Big', 'Next', 'Small'];
    const xml = `<Document ProgramVersion="1.1"><Objects>${names.map((n) => `<Object type="Part::Feature" name="${n}"/>`).join('')}</Objects><ObjectData>${names.map(shape).join('')}</ObjectData></Document>`;
    const sizes = { Big: 9e6, Next: 1e6, Small: 1e3 };
    const files = Object.fromEntries(names.map((n) => [`${n}.brp`, new Uint8Array(sizes[n as keyof typeof sizes])]));
    const result = importFcstd(zipSync({ 'Document.xml': strToU8(xml), ...files }, { level: 0 }), options());
    if (!result.ok) throw new Error(result.error);
    expect(result.value.steps.map((s) => s.object)).toEqual(['Big']);
    expect(result.value.notes.map((n) => n.message)).toContain(
      '2 shapes it shows were left out: an import takes no more than 8 MB of the shapes FreeCAD stored',
    );
  });
});
