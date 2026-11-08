/**
 * A small XML reader for the SVG files sketch import takes: elements,
 * attributes and text, with the five standard entities and numeric character
 * references. Declarations, comments, processing instructions, doctype and
 * CDATA are passed over. Works without a DOM, so it runs in workers and Node.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const SPACE = /\s/;

/** The root element of `source`, or null when it is not well-formed. */
export function parseXml(source: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) break;
    const top = stack[stack.length - 1];
    if (lt > i && top) {
      const text = source.slice(i, lt);
      if (text.trim()) top.text += decode(text);
    }
    i = lt;
    const skipTo = (end: string): boolean => {
      const at = source.indexOf(end, i);
      if (at < 0) return false;
      i = at + end.length;
      return true;
    };
    if (source.startsWith('<!--', i)) {
      if (!skipTo('-->')) return null;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i);
      if (end < 0) return null;
      if (top) top.text += source.slice(i + 9, end);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      if (!skipTo('?>')) return null;
      continue;
    }
    if (source.startsWith('<!', i)) {
      if (!skipDeclaration()) return null;
      continue;
    }
    if (source[i + 1] === '/') {
      const end = source.indexOf('>', i);
      if (end < 0) return null;
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) return null;
      i = end + 1;
      continue;
    }
    const end = tagEnd(source, i + 1);
    if (end < 0) return null;
    let body = source.slice(i + 1, end);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const node = element(body);
    if (!node) return null;
    if (top) top.children.push(node);
    else if (root) return null;
    else root = node;
    if (!selfClosing) stack.push(node);
    i = end + 1;
  }
  return stack.length === 0 ? root : null;

  /** Passes a `<!DOCTYPE …>` with an internal subset in brackets. */
  function skipDeclaration(): boolean {
    let depth = 0;
    for (let j = i + 2; j < source.length; j++) {
      const ch = source[j];
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '>' && depth <= 0) {
        i = j + 1;
        return true;
      }
    }
    return false;
  }
}

function tagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < source.length; j++) {
    const ch = source[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return j;
  }
  return -1;
}

function element(body: string): XmlNode | null {
  const text = body.trim();
  let k = 0;
  while (k < text.length && !SPACE.test(text[k] as string)) k++;
  const name = text.slice(0, k);
  if (!name) return null;
  const attrs: Record<string, string> = {};
  while (k < text.length) {
    while (k < text.length && SPACE.test(text[k] as string)) k++;
    if (k >= text.length) break;
    const start = k;
    while (k < text.length && text[k] !== '=' && !SPACE.test(text[k] as string)) k++;
    const attr = text.slice(start, k);
    while (k < text.length && SPACE.test(text[k] as string)) k++;
    if (text[k] !== '=') {
      attrs[attr] = '';
      continue;
    }
    k++;
    while (k < text.length && SPACE.test(text[k] as string)) k++;
    const quote = text[k];
    if (quote !== '"' && quote !== "'") return null;
    const close = text.indexOf(quote, k + 1);
    if (close < 0) return null;
    attrs[attr] = decode(text.slice(k + 1, close));
    k = close + 1;
  }
  return { name, attrs, children: [], text: '' };
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|quot|apos|amp);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return String.fromCodePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return String.fromCodePoint(parseInt(ref.slice(1), 10));
    return ENTITIES[ref] ?? whole;
  });
}
