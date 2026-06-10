import { describe, expect, it } from 'vitest';
import { parseXml, findChild, findChildren, descendants } from './xml.ts';

describe('parseXml', () => {
  it('parses a simple element with attributes', () => {
    const r = parseXml('<root a="1" b="two"/>');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.name).toBe('root');
    expect(r.value.attrs).toEqual({ a: '1', b: 'two' });
    expect(r.value.children).toHaveLength(0);
  });

  it('parses nested elements and preserves order', () => {
    const r = parseXml('<a><b/><c x="1"/><b/></a>');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.children.map((c) => c.name)).toEqual(['b', 'c', 'b']);
    expect(findChildren(r.value, 'b')).toHaveLength(2);
    expect(findChild(r.value, 'c')?.attrs['x']).toBe('1');
  });

  it('decodes the standard five entities', () => {
    const r = parseXml('<a v="&lt;&gt;&amp;&quot;&apos;"/>');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.attrs['v']).toBe('<>&"\'');
  });

  it('skips XML declaration and comments', () => {
    const r = parseXml(`<?xml version="1.0"?>\n<!-- a comment --><root/>`);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.name).toBe('root');
  });

  it('rejects mismatched end tags', () => {
    const r = parseXml('<a><b></a></b>');
    expect(r.ok).toBe(false);
  });

  it('collects all descendants depth-first', () => {
    const r = parseXml('<svg><g><rect/><circle/></g><line/></svg>');
    if (!r.ok) throw new Error(r.error);
    expect(descendants(r.value).map((n) => n.name)).toEqual(['g', 'rect', 'circle', 'line']);
  });
});
