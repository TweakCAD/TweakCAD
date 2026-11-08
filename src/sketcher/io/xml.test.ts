import { describe, expect, it } from 'vitest';
import { parseXml } from './xml';

describe('parseXml', () => {
  it('reads elements, attributes in either quote and text, past the prolog and comments', () => {
    const root = parseXml(
      `<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY e "x">]>\n<!-- c --><svg a="1" b='two &amp; &#x41;'><g><path d="M0 0"/></g><title>A &lt;b&gt;<![CDATA[ & c]]></title></svg>`,
    );
    expect(root?.name).toBe('svg');
    expect(root?.attrs).toEqual({ a: '1', b: 'two & A' });
    expect(root?.children.map((c) => c.name)).toEqual(['g', 'title']);
    expect(root?.children[0]?.children[0]?.attrs.d).toBe('M0 0');
    expect(root?.children[1]?.text).toBe('A <b> & c');
  });

  it('keeps a quoted > inside an attribute', () => {
    expect(parseXml('<a t="x > y"/>')?.attrs.t).toBe('x > y');
  });

  it('refuses text that is not well-formed', () => {
    expect(parseXml('<a><b></a>')).toBeNull();
    expect(parseXml('<a>')).toBeNull();
    expect(parseXml('<a x=1/>')).toBeNull();
    expect(parseXml('<a/><b/>')).toBeNull();
    expect(parseXml('no markup')).toBeNull();
  });
});
