/**
 * Minimal, dependency-free XML parser.
 *
 * Built deliberately small for the predictable XML subsets we import
 * (FreeCAD `Document.xml`, SVG): no namespaces beyond plain prefixes, no
 * CDATA, no entity refs beyond the standard five. Rolling a focused parser
 * avoids pulling a DOM library and keeps packages dependency-light per the
 * supply-chain stance. Works in both the browser and Node (no `DOMParser`).
 */

import type { Result } from './result.ts';
import { ok, err } from './result.ts';

export type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

/**
 * Parse an XML string into a tree. Discards XML declarations, comments, and
 * processing instructions. Whitespace-only text nodes are coalesced.
 *
 * @param source - The XML text to parse
 * @returns The root element, or an error message on malformed input
 */
export function parseXml(source: string): Result<XmlNode, string> {
  let i = 0;
  const len = source.length;

  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  const skipWhitespace = (): void => {
    while (i < len) {
      const c = source.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
      } else {
        break;
      }
    }
  };

  const startsWith = (s: string): boolean => source.startsWith(s, i);

  while (i < len) {
    // Outside any tag: collect text up to the next '<'.
    const lt = source.indexOf('<', i);
    if (lt < 0) break;

    if (lt > i && stack.length > 0) {
      const text = source.slice(i, lt);
      if (text.trim().length > 0) {
        stack[stack.length - 1]!.text += decodeEntities(text);
      }
    }
    i = lt;

    if (startsWith('<!--')) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) return err('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (startsWith('<?')) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) return err('Unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (startsWith('<!')) {
      // DOCTYPE etc. — consume to next '>'.
      const end = source.indexOf('>', i + 2);
      if (end < 0) return err('Unterminated declaration');
      i = end + 1;
      continue;
    }

    if (source[i + 1] === '/') {
      // End tag </name>.
      const end = source.indexOf('>', i + 2);
      if (end < 0) return err('Unterminated end tag');
      const name = source.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) {
        return err(`Mismatched end tag </${name}> (expected </${top?.name ?? '?'}>)`);
      }
      i = end + 1;
      continue;
    }

    // Start tag or self-closing tag.
    const tagEnd = findTagEnd(source, i + 1);
    if (tagEnd < 0) return err('Unterminated start tag');
    const tagBody = source.slice(i + 1, tagEnd);
    const selfClosing = tagBody.endsWith('/');
    const body = selfClosing ? tagBody.slice(0, -1) : tagBody;

    const parsed = parseTagBody(body);
    if (!parsed.ok) return parsed;

    const node: XmlNode = { name: parsed.value.name, attrs: parsed.value.attrs, children: [], text: '' };
    if (stack.length === 0) {
      root = node;
    } else {
      stack[stack.length - 1]!.children.push(node);
    }
    if (!selfClosing) stack.push(node);
    i = tagEnd + 1;
    skipWhitespace();
  }

  if (stack.length > 0) return err(`Unclosed elements: ${stack.map((n) => n.name).join(', ')}`);
  if (!root) return err('No root element');
  return ok(root);
}

function findTagEnd(source: string, from: number): number {
  let inQuote: '"' | "'" | null = null;
  for (let j = from; j < source.length; j++) {
    const ch = source[j]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '>') return j;
  }
  return -1;
}

function parseTagBody(body: string): Result<{ name: string; attrs: Record<string, string> }, string> {
  const trimmed = body.trimStart();
  let j = 0;
  while (
    j < trimmed.length &&
    trimmed[j] !== ' ' &&
    trimmed[j] !== '\t' &&
    trimmed[j] !== '\n' &&
    trimmed[j] !== '\r' &&
    trimmed[j] !== '/' &&
    trimmed[j] !== '>'
  ) {
    j++;
  }
  const name = trimmed.slice(0, j);
  if (!name) return err('Empty tag name');

  const attrs: Record<string, string> = {};
  let k = j;
  while (k < trimmed.length) {
    // skip whitespace
    while (k < trimmed.length && (trimmed[k] === ' ' || trimmed[k] === '\t' || trimmed[k] === '\n' || trimmed[k] === '\r')) {
      k++;
    }
    if (k >= trimmed.length) break;
    // attr name
    const attrStart = k;
    while (k < trimmed.length && trimmed[k] !== '=' && trimmed[k] !== ' ' && trimmed[k] !== '\t' && trimmed[k] !== '\n' && trimmed[k] !== '\r') {
      k++;
    }
    const attrName = trimmed.slice(attrStart, k);
    if (!attrName) break;
    // skip ws then '='
    while (k < trimmed.length && (trimmed[k] === ' ' || trimmed[k] === '\t')) k++;
    if (trimmed[k] !== '=') {
      // boolean attribute with no value — tolerate it.
      attrs[attrName] = '';
      continue;
    }
    k++;
    while (k < trimmed.length && (trimmed[k] === ' ' || trimmed[k] === '\t')) k++;
    const quote = trimmed[k];
    if (quote !== '"' && quote !== "'") return err(`Unquoted attribute value for "${attrName}"`);
    k++;
    const valueStart = k;
    while (k < trimmed.length && trimmed[k] !== quote) k++;
    if (k >= trimmed.length) return err(`Unterminated attribute value for "${attrName}"`);
    attrs[attrName] = decodeEntities(trimmed.slice(valueStart, k));
    k++;
  }

  return ok({ name, attrs });
}

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Find the first direct child element with a given name. */
export function findChild(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
  }
  return undefined;
}

/** All direct child elements matching a name. */
export function findChildren(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}

/** Every descendant element (depth-first), including nested ones. */
export function descendants(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  const walk = (n: XmlNode): void => {
    for (const c of n.children) {
      out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
}
