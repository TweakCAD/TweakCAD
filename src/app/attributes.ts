/**
 * Body colours and visibility, and the visibility of what a feature shows
 * (a sketch, a construction plane), as attributes (16.1) the browser's eye
 * toggles and colour menu write.
 *
 * One attribute per target holds every property set on it, so setting a
 * property edits the attribute already there, and clearing the last one
 * removes it. A body target is the record a pick of the body writes; two
 * records name the same body when their finest names agree.
 */
import { isPlainObject } from '@tweakcad/format';
import type { CommandResult, Doc, Editor, Json } from '@tweakcad/editor';
import { partOf } from './features';

/** The swatches the body menu offers. */
export const BODY_COLOR_SWATCHES: readonly { color: string; name: string }[] = [
  { color: '#e53935', name: 'Red' },
  { color: '#fb8c00', name: 'Orange' },
  { color: '#fdd835', name: 'Yellow' },
  { color: '#43a047', name: 'Green' },
  { color: '#00acc1', name: 'Teal' },
  { color: '#1e88e5', name: 'Blue' },
  { color: '#8e24aa', name: 'Purple' },
  { color: '#d81b60', name: 'Pink' },
  { color: '#6d4c41', name: 'Brown' },
  { color: '#757575', name: 'Grey' },
  { color: '#212121', name: 'Black' },
  { color: '#fafafa', name: 'White' },
];

export type AttributeTarget = { feature: string } | { reference: Json; names: Json };

function attributesOf(doc: Doc, part: string): Json[] {
  const row = partOf(doc, part);
  return Array.isArray(row?.attributes) ? (row.attributes as Json[]) : [];
}

function finestOf(reference: unknown): string | undefined {
  const id = isPlainObject(reference) && isPlainObject(reference.entity) ? reference.entity.id : undefined;
  return Array.isArray(id) && typeof id.at(-1) === 'string' ? (id.at(-1) as string) : undefined;
}

/** The attribute of `part` whose target is `target`, if any. */
export function attributeFor(doc: Doc, part: string, target: AttributeTarget): Json | undefined {
  return attributesOf(doc, part).find((a) => {
    const t = a.target as Json | undefined;
    if ('feature' in target)
      return isPlainObject(t?.object) && isPlainObject(t.object.feature) && t.object.feature.id === target.feature;
    const standard =
      isPlainObject(target.reference) && isPlainObject(target.reference.standard)
        ? target.reference.standard.name
        : undefined;
    if (standard !== undefined) return isPlainObject(t?.standard) && t.standard.name === standard;
    const finest = finestOf(target.reference);
    return finest !== undefined && finestOf(t) === finest;
  });
}

function literal(editor: Editor, text: string): Json {
  return { id: editor.newId('val'), def: { expr: { text, grammar: 1, refs: {} } } };
}

/**
 * Sets one property of `target`'s attribute to the literal `text`, or with
 * null clears it: an edit of the attribute already there, a new attribute,
 * or the attribute removed when it would set nothing.
 */
export function setProperty(
  editor: Editor,
  part: string,
  target: AttributeTarget,
  property: string,
  text: string | null,
  label: string,
): CommandResult {
  const doc = editor.document;
  const existing = attributeFor(doc, part, target);
  const names = 'feature' in target ? undefined : target.names;
  if (existing) {
    const props = (existing.properties as Json | undefined) ?? {};
    if (text === null) {
      if (!(property in props)) return { ok: true, label, changed: false };
      if (Object.keys(props).length === 1)
        return editor.dispatch({ type: 'removeAttribute', attribute: String(existing.id) });
      return editor.dispatch({ type: 'editAttribute', attribute: String(existing.id), unset: [property] });
    }
    return editor.dispatch({
      type: 'editAttribute',
      attribute: String(existing.id),
      set: { [property]: literal(editor, text) },
      ...(names ? { names } : {}),
    });
  }
  if (text === null) return { ok: true, label, changed: false };
  const attribute = {
    id: editor.newId('attr'),
    target: 'feature' in target ? { object: { feature: { id: target.feature } } } : target.reference,
    properties: { [property]: literal(editor, text) },
  };
  return editor.dispatch({ type: 'addAttribute', owner: part, attribute, ...(names ? { names } : {}) });
}

/** Hides or shows a body or what a feature shows; shown is the default, so showing clears the property. */
export function setVisible(editor: Editor, part: string, target: AttributeTarget, visible: boolean): CommandResult {
  return setProperty(editor, part, target, 'visible', visible ? null : 'false', visible ? 'Show' : 'Hide');
}

/** Colours a body, or with null gives it the default colour again. */
export function setColor(editor: Editor, part: string, target: AttributeTarget, color: string | null): CommandResult {
  return setProperty(
    editor,
    part,
    target,
    'color',
    color === null ? null : JSON.stringify(color.toLowerCase()),
    'Color',
  );
}

/** Names a body; an empty name, or null, gives it its numbered name again. */
export function setName(editor: Editor, part: string, target: AttributeTarget, name: string | null): CommandResult {
  const text = name === null || name.trim() === '' ? null : JSON.stringify(name.trim());
  return setProperty(editor, part, target, 'name', text, 'Rename');
}

/** Whether an attribute on the feature hides what it shows. */
export function featureHidden(doc: Doc, part: string, feature: string): boolean {
  const props = attributeFor(doc, part, { feature })?.properties as Json | undefined;
  const v = props?.visible as Json | undefined;
  const text = ((v?.def as Json | undefined)?.expr as Json | undefined)?.text;
  return typeof text === 'string' && text.trim() === 'false';
}

/** The standard planes of a part's origin, whose visibility the browser's Origin eye sets. */
const ORIGIN_PLANES = ['xy', 'xz', 'yz'] as const;

const originTarget = (name: string): AttributeTarget => ({ reference: { standard: { name } }, names: {} });

/** Whether a part's origin planes show: an attribute on its XY plane says so (hidden is the default). */
export function originShown(doc: Doc, part: string): boolean {
  const props = attributeFor(doc, part, originTarget('xy'))?.properties as Json | undefined;
  const v = props?.visible as Json | undefined;
  const text = ((v?.def as Json | undefined)?.expr as Json | undefined)?.text;
  return typeof text === 'string' && text.trim() === 'true';
}

/** Shows or hides a part's origin planes, kept in the document as attributes on them, as one undo step. */
export function setOriginShown(editor: Editor, part: string, shown: boolean): CommandResult {
  const label = shown ? 'Show origin planes' : 'Hide origin planes';
  return editor.transaction(label, () => {
    let last: CommandResult = { ok: true, label, changed: false };
    for (const name of ORIGIN_PLANES) {
      last = setProperty(editor, part, originTarget(name), 'visible', shown ? 'true' : null, label);
      if (!last.ok) return last;
    }
    return last;
  });
}
