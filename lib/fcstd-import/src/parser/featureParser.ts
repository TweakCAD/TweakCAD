/**
 * Extract Pad / Pocket / Body properties from a parsed <Object> property bag.
 *
 * The document parser already lowers every <Property> element to a property
 * bag keyed by name (see documentParser.readObjectProperties). This module
 * just interprets the strings as the typed Pad/Pocket properties we care
 * about.
 */

import type { XmlNode } from './xml.ts';
import { findChild, findChildren } from './xml.ts';

export type ObjectProperties = {
  /** Scalar properties, keyed by Property name. Value is the inner attribute that holds the data — e.g. for `<Property type="App::PropertyLength"><Float value="20"/></Property>`, this stores "20". */
  scalars: Record<string, string>;
  /** Properties that are LinkSub / Link references — stores the `value` attr of the inner <Link> or <LinkSub> element. */
  links: Record<string, string>;
  /** LinkList properties — every <Link value="..."/> entry. */
  linkLists: Record<string, string[]>;
};

/**
 * Lower a <Properties> element into a normalized property bag.
 *
 * For each <Property name="X" type="Y">:
 *   - If inner element is <Float value="v"/> / <Bool value="v"/> /
 *     <Integer value="v"/> / <String value="v"/> / <Uuid value="v"/>, store
 *     "v" in scalars[X].
 *   - If inner element is <Link value="v"/> or <LinkSub value="v"/>, store
 *     "v" in links[X].
 *   - If inner element is <LinkList> or <LinkSubList>, push each child link's
 *     value into linkLists[X].
 *   - Anything else (PropertyPlacement, PropertyGeometryList, …) is ignored
 *     here — geometry/constraint parsers consume those directly.
 */
export function readObjectProperties(propertiesNode: XmlNode | undefined): ObjectProperties {
  const out: ObjectProperties = { scalars: {}, links: {}, linkLists: {} };
  if (!propertiesNode) return out;

  for (const prop of findChildren(propertiesNode, 'Property')) {
    const name = prop.attrs['name'];
    if (!name) continue;
    // Use the first element child to figure out the shape.
    const inner = prop.children[0];
    if (!inner) continue;

    switch (inner.name) {
      case 'Float':
      case 'Bool':
      case 'Integer':
      case 'String':
      case 'Uuid': {
        const v = inner.attrs['value'];
        if (v !== undefined) out.scalars[name] = v;
        break;
      }
      case 'Link':
      case 'LinkSub': {
        const v = inner.attrs['value'];
        if (v !== undefined && v.length > 0) out.links[name] = v;
        break;
      }
      case 'LinkList':
      case 'LinkSubList': {
        const items: string[] = [];
        for (const link of inner.children) {
          if (link.name !== 'Link') continue;
          const v = link.attrs['value'] ?? link.attrs['obj'];
          if (v !== undefined && v.length > 0) items.push(v);
        }
        out.linkLists[name] = items;
        break;
      }
      default:
        // Skip Placement / GeometryList / ConstraintList / ExpressionEngine etc.
        break;
    }
  }
  return out;
}

/** Pull the Pad/Pocket properties we map. */
export type ExtrudeProperties = {
  length: number;
  reversed: boolean;
  midplane: boolean;
  type: number;
  profileName: string | undefined;
};

export function parseExtrudeProperties(props: ObjectProperties): ExtrudeProperties {
  return {
    length: toFloat(props.scalars['Length'], 0),
    reversed: toBool(props.scalars['Reversed'], false),
    midplane: toBool(props.scalars['Midplane'], false),
    type: toInt(props.scalars['Type'], 0),
    // The profile sketch link is named `Profile` (App::PropertyLinkSub) in
    // modern FreeCAD (≥ ~0.19) but `Sketch` (App::PropertyLink) in older
    // files. Both decode into `links`, so accept either — preferring the
    // modern name when both are present.
    profileName: props.links['Profile'] ?? props.links['Sketch'],
  };
}

/** Pull the Body group + tip. */
export type BodyProperties = {
  groupLinks: string[];
  tip: string | undefined;
};

export function parseBodyProperties(props: ObjectProperties): BodyProperties {
  // The Body's ordered children live under `Group` (App::PropertyLinkList) in
  // modern FreeCAD but under `Model` in older files. Prefer a non-empty
  // `Group`, falling back to `Model`.
  const group = props.linkLists['Group'];
  const model = props.linkLists['Model'];
  return {
    groupLinks: (group && group.length > 0 ? group : model) ?? [],
    tip: props.links['Tip'],
  };
}

/**
 * First support link target — e.g. "XY_Plane" for a sketch on the XY plane.
 *
 * The attachment link is named `AttachmentSupport` in modern FreeCAD
 * (≥ ~0.21) and `Support` in older files; accept either.
 */
export function parseSketchSupport(propertiesNode: XmlNode | undefined): string | undefined {
  if (!propertiesNode) return undefined;
  for (const prop of findChildren(propertiesNode, 'Property')) {
    const name = prop.attrs['name'];
    if (name !== 'AttachmentSupport' && name !== 'Support') continue;
    const inner = findChild(prop, 'LinkSubList') ?? findChild(prop, 'LinkList');
    if (!inner) return undefined;
    for (const link of inner.children) {
      if (link.name !== 'Link') continue;
      const v = link.attrs['obj'] ?? link.attrs['value'];
      if (v && v.length > 0) return v;
    }
  }
  return undefined;
}

// --- coercion helpers ---

function toFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function toInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? v : fallback;
}

function toBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}
