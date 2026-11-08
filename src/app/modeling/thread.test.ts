import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Doc, Json } from '@tweakcad/editor';
import { editTarget, ValueSlots } from './feature';
import { Check, Select, ToggleRow } from './panelKit';
import {
  buildThread,
  classesFor,
  classOnFace,
  designationOfSize,
  designationsFor,
  HANDS,
  readThread,
  sizeForDiameter,
} from './thread';
import { ThreadSizeRows } from './ThreadSizeRows';

const fixtures = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../lib/testing/fixtures/v2');

/** A fixture with its Size configuration set to `size`, and its Thread 1. */
function threaded(name: string, size = 'M6') {
  const doc = JSON.parse(readFileSync(resolvePath(fixtures, `${name}.cadjson`), 'utf8')) as Doc;
  const part = (doc.parts as Json[])[0] as Json;
  for (const table of part.parameters as Json[]) {
    for (const p of table.parameters as Json[])
      if (p.name === 'Size') ((p.value as Json).def as Json).expr = { grammar: 1, refs: {}, text: `"${size}"` };
  }
  const thread = (part.timeline as Json[]).find((f) => f.type === 'core.thread') as Json;
  const target = editTarget(doc, part.id as string, thread.id as string, 'core.thread');
  if (!target) throw new Error('no thread');
  return { doc, part: part.id as string, target, stored: thread.inputs as Json };
}

const slots = (base: Json, doc: Doc) => {
  let n = 0;
  return new ValueSlots(() => `val_new${n++}`, base, doc);
};

describe('a thread sized by a parameter', () => {
  for (const name of ['hex-bolt-iso4017', 'socket-screw-iso4762', 'threaded-rod']) {
    it(`${name}: shows the size the configuration gives, and keeps the binding until another is picked`, () => {
      const { doc, part, target, stored } = threaded(name);
      const form = readThread(doc, part, stored);
      expect(form).toMatchObject({ designation: 'M6', threadClass: '6g', modelled: false });
      expect(slots(stored, doc).boundText(['designation'], form.designation)).toBe('thread');

      const kept = buildThread(doc, target, form, slots(stored, doc));
      if (!kept.ok) throw new Error(kept.message);
      expect(kept.inputs.designation).toEqual(stored.designation);

      const picked = buildThread(doc, target, { ...form, designation: 'M8' }, slots(stored, doc));
      if (!picked.ok) throw new Error(picked.message);
      expect(picked.inputs.designation).toEqual({
        id: (stored.designation as Json).id,
        def: { expr: { text: '"M8"', grammar: 1, refs: {} } },
      });

      const m10 = threaded(name, 'M10');
      expect(readThread(m10.doc, m10.part, m10.stored).designation).toBe('M10');
    });
  }

  it('keeps a literal size as a literal, with no binding', () => {
    const { doc, part, stored } = threaded('hex-bolt-iso4017');
    ((stored.designation as Json).def as Json).expr = { grammar: 1, refs: {}, text: '"M5"' };
    const form = readThread(doc, part, stored);
    expect(form.designation).toBe('M5');
    expect(slots(stored, doc).boundText(['designation'], 'M5')).toBeNull();
  });
});

describe('fields with a bound value', () => {
  const sizes = ['M5', 'M6'].map((s) => ({ id: s, label: s }));

  it('show the expression beside the dropdown or check box', () => {
    const html = renderToStaticMarkup(
      Select({ label: 'Size', value: 'M6', options: sizes, onChange: () => undefined, bound: 'thread' }),
    );
    expect(html).toContain('= thread');
    expect(html).toMatch(/<option value="M6" selected="">M6<\/option>/);
    expect(
      renderToStaticMarkup(Check({ label: 'Modeled', checked: true, onChange: () => undefined, bound: 'f' })),
    ).toContain('= f');
    expect(
      renderToStaticMarkup(Select({ label: 'Size', value: 'M6', options: sizes, onChange: () => undefined })),
    ).not.toContain('= ');
  });

  it('show a value that is not among the options as its own', () => {
    const html = renderToStaticMarkup(
      Select({ label: 'Size', value: 'M7', options: sizes, onChange: () => undefined }),
    );
    expect(html).toMatch(/<option value="M7" selected="">M7<\/option>/);
  });
});

describe('the classes a thread offers', () => {
  it('are the external ones on a shaft and the internal ones in a bore', () => {
    expect(classesFor(false)).toEqual(['6g', '4g6g', '6e', '6f', '6h']);
    expect(classesFor(true)).toEqual(['6H', '5H', '7H', '6G']);
  });

  it('follow the stored class of an edited thread', () => {
    const { doc, part, stored } = threaded('threaded-rod');
    const form = readThread(doc, part, stored);
    expect(form.internal).toBe(false);
    expect(classesFor(form.internal)).not.toContain('6H');
    ((stored.class as Json).def as Json).expr = { grammar: 1, refs: {}, text: '"6H"' };
    expect(readThread(doc, part, stored).internal).toBe(true);
  });

  it('change kind with the face picked', () => {
    expect(classOnFace('6g', true)).toBe('6H');
    expect(classOnFace('6H', false)).toBe('6g');
    expect(classOnFace('4g6g', false)).toBe('4g6g');
    expect(classOnFace('7H', true)).toBe('7H');
  });
});

describe('the hand of a thread', () => {
  it('is written for a left-handed thread only, read back, and kept bound', () => {
    const { doc, part, target, stored } = threaded('threaded-rod');
    const form = readThread(doc, part, stored);
    expect(form.hand).toBe('right');
    const right = buildThread(doc, target, form, slots(stored, doc));
    if (!right.ok) throw new Error(right.message);
    expect(right.inputs.hand).toBeUndefined();
    const left = buildThread(doc, target, { ...form, hand: 'left' }, slots(stored, doc));
    if (!left.ok) throw new Error(left.message);
    expect(left.inputs.hand).toMatchObject({ def: { expr: { text: '"left"' } } });
    expect(readThread(doc, part, left.inputs).hand).toBe('left');
    const html = renderToStaticMarkup(
      ToggleRow({ label: 'Direction', value: 'left', options: HANDS, onChange: () => undefined }),
    );
    expect(html).toContain('Right hand');
    expect(html).toContain('Left hand');
  });
});

describe('the size and designation a thread offers', () => {
  it('list the sizes, then the designations of the size, coarse first, each with its pitch', () => {
    const html = renderToStaticMarkup(ThreadSizeRows({ designation: 'M8x1', bound: null, onChange: () => undefined }));
    expect(html).toMatch(/<option value="8" selected="">8<\/option>/);
    expect(html).toContain('<option value="M8">M8x1.25</option>');
    expect(html).toMatch(/<option value="M8x1" selected="">M8x1<\/option>/);
    expect(html).toContain('<option value="M8x0.75">M8x0.75</option>');
    expect(html).toContain('<option value="15">15</option>');
  });

  it('take the coarse designation of a size picked, or its largest fine pitch where it has no coarse one', () => {
    expect(designationOfSize(10)).toBe('M10');
    expect(designationOfSize(15)).toBe('M15x1.5');
    expect(designationsFor('M10x1.25')).toEqual(['M10', 'M10x1.25', 'M10x1', 'M10x0.75']);
    expect(designationsFor('UNC 1/4')).toEqual([]);
  });

  it('follow a face: a bore its nearest tap drill, coarse where two are as near', () => {
    expect(sizeForDiameter(5, true)).toEqual({ designation: 'M6', threadClass: '6H' });
    expect(sizeForDiameter(7, true)).toEqual({ designation: 'M8x1', threadClass: '6H' });
    expect(sizeForDiameter(6.8, true)).toEqual({ designation: 'M8', threadClass: '6H' });
    expect(sizeForDiameter(15, false)).toEqual({ designation: 'M15x1.5', threadClass: '6g' });
    expect(sizeForDiameter(8, false)).toEqual({ designation: 'M8', threadClass: '6g' });
  });
});
