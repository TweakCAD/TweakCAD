/**
 * FreeCAD's `Document.xml`, read into objects with their properties kept as
 * XML, and typed readers for the property kinds the importer uses. Every
 * object keeps its whole property bag, so a converter can read what it needs
 * without the parser knowing each feature type.
 */
import { findChild, findChildren, parseXml, type Result, type XmlNode } from './xml';

export interface FcObject {
  name: string;
  /** FreeCAD's type, e.g. `PartDesign::Pad`. */
  type: string;
  /** What the tree shows, else the name. */
  label: string;
  props: ReadonlyMap<string, XmlNode>;
}

export interface FcDocument {
  programVersion: string | undefined;
  /** Objects in the order of `<Objects>`. */
  objects: FcObject[];
  byName: ReadonlyMap<string, FcObject>;
}

/** Position in mm and rotation as a unit quaternion `[x, y, z, w]`. */
export interface FcPlacement {
  position: [number, number, number];
  rotation: [number, number, number, number];
}

export type Vec3 = [number, number, number];

export interface FcLink {
  obj: string;
  /** Sub-element names (`Edge3`, `Face1`, `V_Axis`), in FreeCAD's index form. */
  subs: string[];
}

export function parseDocument(text: string): Result<FcDocument> {
  const xml = parseXml(text);
  if (!xml.ok) return { ok: false, error: `Document.xml: ${xml.error}` };
  const root = xml.value;
  if (root.name !== 'Document')
    return { ok: false, error: `Document.xml has <${root.name}> at its root, not <Document>` };
  const types = new Map<string, string>();
  const order: string[] = [];
  const list = findChild(root, 'Objects');
  for (const o of list ? findChildren(list, 'Object') : []) {
    const name = o.attrs.name;
    if (!name) continue;
    types.set(name, o.attrs.type ?? '');
    order.push(name);
  }
  const data = new Map<string, Map<string, XmlNode>>();
  const objectData = findChild(root, 'ObjectData');
  for (const o of objectData ? findChildren(objectData, 'Object') : []) {
    const name = o.attrs.name;
    if (!name) continue;
    const props = new Map<string, XmlNode>();
    const bag = findChild(o, 'Properties');
    for (const p of bag ? findChildren(bag, 'Property') : []) if (p.attrs.name) props.set(p.attrs.name, p);
    data.set(name, props);
  }
  const objects: FcObject[] = order.map((name) => {
    const props = data.get(name) ?? new Map<string, XmlNode>();
    const label = stringOf(props.get('Label'));
    return { name, type: types.get(name) ?? '', label: label && label.length > 0 ? label : name, props };
  });
  return {
    ok: true,
    value: { programVersion: root.attrs.ProgramVersion, objects, byName: new Map(objects.map((o) => [o.name, o])) },
  };
}

function stringOf(p: XmlNode | undefined): string | undefined {
  return p ? findChild(p, 'String')?.attrs.value : undefined;
}

function num(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

/** The first element child of a property. */
function inner(o: FcObject, name: string): XmlNode | undefined {
  return o.props.get(name)?.children[0];
}

export function has(o: FcObject, name: string): boolean {
  return o.props.has(name);
}

export function float(o: FcObject, name: string, fallback = 0): number {
  const n = inner(o, name);
  return n && (n.name === 'Float' || n.name === 'Integer') ? num(n.attrs.value, fallback) : fallback;
}

export function integer(o: FcObject, name: string, fallback = 0): number {
  const n = inner(o, name);
  return n && n.name === 'Integer' ? Math.trunc(num(n.attrs.value, fallback)) : fallback;
}

export function bool(o: FcObject, name: string, fallback = false): boolean {
  const n = inner(o, name);
  if (!n || n.name !== 'Bool') return fallback;
  return n.attrs.value === 'true' || n.attrs.value === '1';
}

export function string(o: FcObject, name: string): string | undefined {
  const n = inner(o, name);
  return n && n.name === 'String' ? n.attrs.value : undefined;
}

/**
 * An enumeration's index, with its name when the file lists the enumeration
 * (FreeCAD writes the list only for enumerations whose items are not fixed).
 */
export function enumeration(o: FcObject, name: string): { index: number; name: string | undefined } {
  const p = o.props.get(name);
  const index = Math.trunc(num(p && findChild(p, 'Integer')?.attrs.value, 0));
  const list = p && findChild(p, 'CustomEnumList');
  const items = list ? findChildren(list, 'Enum').map((e) => e.attrs.value ?? '') : [];
  return { index, name: items[index] };
}

export function vector(o: FcObject, name: string): Vec3 | undefined {
  const n = inner(o, name);
  if (!n || n.name !== 'PropertyVector') return undefined;
  return [num(n.attrs.valueX), num(n.attrs.valueY), num(n.attrs.valueZ)];
}

export const IDENTITY: FcPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

export function placement(o: FcObject, name = 'Placement'): FcPlacement {
  const n = inner(o, name);
  if (!n || n.name !== 'PropertyPlacement') return IDENTITY;
  const q: [number, number, number, number] = [num(n.attrs.Q0), num(n.attrs.Q1), num(n.attrs.Q2), num(n.attrs.Q3, 1)];
  const len = Math.hypot(...q);
  return {
    position: [num(n.attrs.Px), num(n.attrs.Py), num(n.attrs.Pz)],
    rotation: len > 0 ? (q.map((c) => c / len) as [number, number, number, number]) : [0, 0, 0, 1],
  };
}

/** The name FreeCAD gives a sub-element in its index form (`Edge3`), whichever attribute holds it. */
function subName(s: XmlNode): string {
  const value = s.attrs.value ?? '';
  const shadowed = s.attrs.shadowed;
  // Files that write element-map names keep the index form in `shadowed`.
  if (shadowed && !/^(Edge|Face|Vertex)\d+$/.test(value)) return shadowed;
  return value;
}

/** A link (`App::PropertyLink`) or link with sub-elements (`App::PropertyLinkSub`). */
export function link(o: FcObject, name: string): FcLink | undefined {
  const n = inner(o, name);
  if (!n) return undefined;
  if (n.name === 'XLink') {
    // A link into another file names no object of this document.
    if (n.attrs.file || !n.attrs.name) return undefined;
    return { obj: n.attrs.name, subs: [] };
  }
  if (n.name === 'Link' || n.name === 'LinkSub') {
    const obj = n.attrs.value ?? n.attrs.obj ?? '';
    if (obj.length === 0) return undefined;
    return {
      obj,
      subs: findChildren(n, 'Sub')
        .map(subName)
        .filter((s) => s.length > 0),
    };
  }
  const all = links(o, name);
  return all[0];
}

/** A link list (`App::PropertyLinkList`) or a list of links with sub-elements, one entry per object. */
export function links(o: FcObject, name: string): FcLink[] {
  const n = inner(o, name);
  if (!n || (n.name !== 'LinkList' && n.name !== 'LinkSubList')) return [];
  const out: FcLink[] = [];
  for (const l of findChildren(n, 'Link')) {
    const obj = l.attrs.obj ?? l.attrs.value ?? '';
    if (obj.length === 0) continue;
    const sub =
      l.attrs.shadowed && !/^(Edge|Face|Vertex)\d+$/.test(l.attrs.sub ?? '') ? l.attrs.shadowed : (l.attrs.sub ?? '');
    const last = out[out.length - 1];
    if (last && last.obj === obj && n.name === 'LinkSubList') {
      if (sub) last.subs.push(sub);
    } else out.push({ obj, subs: sub ? [sub] : [] });
  }
  return out;
}

/** The archive file a shape property is stored in (`Pad.Shape.brp`). */
export function shapeFile(o: FcObject, name = 'Shape'): string | undefined {
  const p = o.props.get(name);
  const part = p && findChild(p, 'Part');
  const file = part?.attrs.file;
  return file && file.length > 0 ? file : undefined;
}

/** The element list a geometry or constraint property holds. */
export function listOf(o: FcObject, name: string, list: string): XmlNode[] {
  const p = o.props.get(name);
  const n = p && findChild(p, list);
  return n ? n.children : [];
}
