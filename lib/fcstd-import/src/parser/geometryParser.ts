/**
 * Parse the <GeometryList> of a FreeCAD sketch into typed FcGeometry items.
 *
 * Supported MVP types: Part::GeomLineSegment, Part::GeomCircle,
 * Part::GeomArcOfCircle. Anything else lands as { kind: 'unsupported' } and
 * is flagged as a diagnostic by the converter.
 */

import type { XmlNode } from './xml.ts';
import { findChild } from './xml.ts';
import type {
  FcGeometry,
  FcGeomLineSegment,
  FcGeomCircle,
  FcGeomArcOfCircle,
  FcGeomUnsupported,
} from '../types/fcstdTypes.ts';

/** Parse a single <Geometry type="..."> element. */
export function parseGeometry(node: XmlNode): FcGeometry {
  const rawType = node.attrs['type'] ?? '';
  const construction = readConstructionFlag(node);

  switch (rawType) {
    case 'Part::GeomLineSegment':
      return parseLineSegment(node, construction);
    case 'Part::GeomCircle':
      return parseCircle(node, construction);
    case 'Part::GeomArcOfCircle':
      return parseArcOfCircle(node, construction);
    default:
      return { kind: 'unsupported', construction, rawType } satisfies FcGeomUnsupported;
  }
}

/** Parse every <Geometry> child of a <GeometryList>. */
export function parseGeometryList(geometryListNode: XmlNode | undefined): FcGeometry[] {
  if (!geometryListNode) return [];
  const out: FcGeometry[] = [];
  for (const child of geometryListNode.children) {
    if (child.name === 'Geometry') out.push(parseGeometry(child));
  }
  return out;
}

function readConstructionFlag(node: XmlNode): boolean {
  const c = findChild(node, 'Construction');
  if (!c) return false;
  return c.attrs['value'] === '1' || c.attrs['value'] === 'true';
}

function parseLineSegment(node: XmlNode, construction: boolean): FcGeomLineSegment {
  const ls = findChild(node, 'LineSegment');
  return {
    kind: 'lineSegment',
    construction,
    startX: numAttr(ls, 'StartX'),
    startY: numAttr(ls, 'StartY'),
    endX: numAttr(ls, 'EndX'),
    endY: numAttr(ls, 'EndY'),
  };
}

function parseCircle(node: XmlNode, construction: boolean): FcGeomCircle {
  const c = findChild(node, 'Circle');
  return {
    kind: 'circle',
    construction,
    centerX: numAttr(c, 'CenterX'),
    centerY: numAttr(c, 'CenterY'),
    radius: numAttr(c, 'Radius'),
  };
}

function parseArcOfCircle(node: XmlNode, construction: boolean): FcGeomArcOfCircle {
  const a = findChild(node, 'ArcOfCircle');
  return {
    kind: 'arcOfCircle',
    construction,
    centerX: numAttr(a, 'CenterX'),
    centerY: numAttr(a, 'CenterY'),
    radius: numAttr(a, 'Radius'),
    startAngle: numAttr(a, 'StartAngle'),
    endAngle: numAttr(a, 'EndAngle'),
  };
}

function numAttr(node: XmlNode | undefined, name: string): number {
  if (!node) return 0;
  const raw = node.attrs[name];
  if (raw === undefined) return 0;
  const v = Number(raw);
  return Number.isFinite(v) ? v : 0;
}
