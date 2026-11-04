/**
 * What a FreeCAD Document.xml holds, independent of what the importer does
 * with it. Reads the raw XML so that a property the importer has never heard
 * of still shows up here, which is the point: the census is the denominator
 * the import coverage is measured against.
 */

import { parseXml, findChild, findChildren } from '../src/parser/xml.ts';
import type { XmlNode } from '../src/parser/xml.ts';

/** Index = FreeCAD's `Sketcher::ConstraintType`, the `Type` attribute of `<Constrain>`. */
export const FC_CONSTRAINT_TYPES = [
  'None', 'Coincident', 'Horizontal', 'Vertical', 'Parallel', 'Tangent', 'Distance',
  'DistanceX', 'DistanceY', 'Angle', 'Perpendicular', 'Radius', 'Equal', 'PointOnObject',
  'Symmetric', 'InternalAlignment', 'SnellsLaw', 'Block', 'Diameter', 'Weight', 'Group', 'Text',
] as const;

/**
 * Facts a body can hold that the importer does not reproduce yet. A body that
 * fails with one of these has a known cause; a body that fails with none is an
 * importer bug. Remove an entry when a converter starts honouring it.
 */
export const UNHANDLED_FACTS = [
  'body.placement', 'body.baseFeature', 'body.featuresAfterTip', 'suppressed',
  'sketch.none', 'sketch.originPlane', 'sketch.datumPlane', 'sketch.coordinateSystem', 'sketch.face',
  'sketch.otherObject', 'sketch.attachmentOffset', 'sketch.mapReversed', 'sketch.mapMode',
  'extrude.upTo', 'extrude.twoSided', 'extrude.taper', 'extrude.offset', 'extrude.customDirection',
] as const;

/** Sketch geometry the importer reads. */
const HANDLED_GEOMETRY = new Set(['Part::GeomLineSegment', 'Part::GeomCircle', 'Part::GeomArcOfCircle', 'Part::GeomPoint']);

/** Types the importer turns into timeline features. */
const HANDLED_FEATURES = new Set(['Sketcher::SketchObject', 'PartDesign::Pad', 'PartDesign::Pocket']);

/** Reference geometry: only matters through what is attached to it, which is counted there. */
const DATUMS = new Set(['PartDesign::Plane', 'PartDesign::Line', 'PartDesign::Point', 'PartDesign::CoordinateSystem']);

export type ObjectFacts = {
  name: string;
  type: string;
  /** Archive entry holding the object's solved shape, when it stores one. */
  shapeFile: string | undefined;
};

/** A thing with a solved shape that the rebuilt project should reproduce. */
export type CensusUnit = ObjectFacts & {
  kind: 'body' | 'root';
  /** What the body holds that the importer does not reproduce. Empty for a root. */
  blockers: string[];
};

export type DocumentCensus = {
  programVersion: string;
  objects: ObjectFacts[];
  /** FreeCAD constraint type name → count, over every sketch in the document. */
  constraints: Record<string, number>;
  /** FreeCAD geometry type → count, over every sketch in the document. */
  geometry: Record<string, number>;
  /** Sketches by what they are attached to. */
  sketchSupport: Record<string, number>;
  /** Values that change the model and that a converter has to honour, by name. */
  properties: Record<string, number>;
  units: CensusUnit[];
};

/** Link properties through which one shape-bearing object consumes another. */
const CONSUMING_LINKS = [
  'Base', 'Tool', 'Shapes', 'Links', 'Source', 'Objects', 'BaseFeature', 'Sections', 'Spine',
  'Profile', 'Sketch', 'Shape', 'Originals',
];

const DEFAULT_PLANES = new Set(['XY_Plane', 'XZ_Plane', 'YZ_Plane']);

/** Index of the two `Attacher::eMapMode` values a sketch ordinarily has: no attachment, and on a face or plane. */
const MAP_MODE_DEACTIVATED = 0;
const MAP_MODE_FLAT_FACE = 5;

export function censusDocument(xmlText: string): DocumentCensus {
  const parsed = parseXml(xmlText);
  if (!parsed.ok) throw new Error(`Document.xml: ${parsed.error}`);
  const root = parsed.value;

  const typeByName = new Map<string, string>();
  const objectsNode = findChild(root, 'Objects');
  if (objectsNode) {
    for (const o of findChildren(objectsNode, 'Object')) {
      if (o.attrs['name']) typeByName.set(o.attrs['name'], o.attrs['type'] ?? '');
    }
  }

  const census: DocumentCensus = {
    programVersion: root.attrs['ProgramVersion'] ?? '',
    objects: [],
    constraints: {},
    geometry: {},
    sketchSupport: {},
    properties: {},
    units: [],
  };

  const inBody = new Set<string>();
  const consumed = new Set<string>();
  const factsByObject = new Map<string, Set<string>>();
  const childrenOfBody = new Map<string, string[]>();
  const dataNode = findChild(root, 'ObjectData');

  for (const obj of dataNode ? findChildren(dataNode, 'Object') : []) {
    const name = obj.attrs['name'];
    if (!name) continue;
    const type = typeByName.get(name) ?? '';
    const props = propertyMap(findChild(obj, 'Properties'));
    census.objects.push({ name, type, shapeFile: shapeFileOf(props) });
    const facts = new Set<string>();
    factsByObject.set(name, facts);

    const expressions = countExpressions(props);
    if (expressions > 0) bump(census.properties, 'expressions', expressions);
    if (boolOf(props, 'Suppressed')) {
      bump(census.properties, 'suppressed');
      facts.add('suppressed');
    }

    if (type === 'PartDesign::Body') {
      childrenOfBody.set(name, censusBody(props, census, facts, typeByName));
      for (const child of childrenOfBody.get(name) ?? []) inBody.add(child);
    }
    if (type === 'Sketcher::SketchObject') censusSketch(props, census, facts, typeByName);
    if (type === 'PartDesign::Pad' || type === 'PartDesign::Pocket') censusExtrude(type, props, census, facts);

    if (/^(Part|PartDesign)::/.test(type) && type !== 'PartDesign::Body') {
      for (const target of consumedLinks(props)) consumed.add(target);
    }
  }

  for (const o of census.objects) {
    if (o.type === 'PartDesign::Body') {
      const blockers = new Set(factsByObject.get(o.name));
      for (const child of childrenOfBody.get(o.name) ?? []) {
        for (const fact of factsByObject.get(child) ?? []) blockers.add(fact);
        const type = typeByName.get(child) ?? '';
        if (type.startsWith('PartDesign::') && !HANDLED_FEATURES.has(type) && !DATUMS.has(type)) {
          blockers.add(`feature:${type}`);
        }
      }
      census.units.push({ ...o, kind: 'body', blockers: [...blockers].filter(isUnhandled).sort() });
    } else if (/^(Part|PartDesign)::/.test(o.type) && !inBody.has(o.name) && !consumed.has(o.name)) {
      if (o.shapeFile !== undefined) census.units.push({ ...o, kind: 'root', blockers: [] });
    }
  }

  return census;
}

function isUnhandled(fact: string): boolean {
  return fact.startsWith('feature:') || fact.startsWith('geometry:')
    || (UNHANDLED_FACTS as readonly string[]).includes(fact);
}

function censusBody(
  props: Map<string, XmlNode>,
  census: DocumentCensus,
  facts: Set<string>,
  typeByName: Map<string, string>,
): string[] {
  const group = linkListOf(props, 'Group');
  const children = group.length > 0 ? group : linkListOf(props, 'Model');
  if (!placementIsIdentity(props)) {
    bump(census.properties, 'body.placement');
    facts.add('body.placement');
  }
  if (linkOf(props, 'BaseFeature')) {
    bump(census.properties, 'body.baseFeature');
    facts.add('body.baseFeature');
  }
  const tip = linkOf(props, 'Tip');
  const tipIndex = tip === undefined ? -1 : children.indexOf(tip);
  if (tipIndex >= 0) {
    const after = children
      .slice(tipIndex + 1)
      .filter((c) => (typeByName.get(c) ?? '').startsWith('PartDesign::'));
    if (after.length > 0) {
      bump(census.properties, 'body.featuresAfterTip', after.length);
      facts.add('body.featuresAfterTip');
    }
  }
  return children;
}

function censusSketch(
  props: Map<string, XmlNode>,
  census: DocumentCensus,
  facts: Set<string>,
  typeByName: Map<string, string>,
): void {
  const constraintProp = props.get('Constraints');
  const constraintList = constraintProp && findChild(constraintProp, 'ConstraintList');
  for (const c of constraintList ? findChildren(constraintList, 'Constrain') : []) {
    const type = FC_CONSTRAINT_TYPES[Number(c.attrs['Type'])] ?? `Type${c.attrs['Type']}`;
    bump(census.constraints, type);
  }
  const geometryProp = props.get('Geometry');
  const geometryList = geometryProp && findChild(geometryProp, 'GeometryList');
  for (const g of geometryList ? findChildren(geometryList, 'Geometry') : []) {
    const type = g.attrs['type'] ?? '?';
    bump(census.geometry, type);
    const construction = findChild(g, 'Construction')?.attrs['value'] === '1';
    if (!construction && !HANDLED_GEOMETRY.has(type)) facts.add(`geometry:${type}`);
  }

  const support = supportKind(props, typeByName);
  bump(census.sketchSupport, support);
  if (support !== 'defaultPlane') facts.add(`sketch.${support}`);
  if (!placementIsIdentity(props, 'AttachmentOffset')) {
    bump(census.properties, 'sketch.attachmentOffset');
    facts.add('sketch.attachmentOffset');
  }
  if (boolOf(props, 'MapReversed')) {
    bump(census.properties, 'sketch.mapReversed');
    facts.add('sketch.mapReversed');
  }
  const mapMode = Number(props.get('MapMode')?.children[0]?.attrs['value'] ?? MAP_MODE_FLAT_FACE);
  if (mapMode !== MAP_MODE_FLAT_FACE && mapMode !== MAP_MODE_DEACTIVATED) {
    bump(census.properties, `sketch.mapMode.${mapMode}`);
    facts.add('sketch.mapMode');
  }
  const external = props.get('ExternalGeometry')?.children[0];
  if (external && external.children.length > 0) bump(census.properties, 'sketch.externalGeometry');
}

/**
 * What a sketch is attached to. The link is a `LinkSubList` of `<Link obj sub>`
 * in current files and a `LinkSub` with `<Sub value>` children in old ones.
 */
function supportKind(props: Map<string, XmlNode>, typeByName: Map<string, string>): string {
  const list = (props.get('AttachmentSupport') ?? props.get('Support'))?.children[0];
  const link = list?.children.find((c) => c.name === 'Link');
  const target = link?.attrs['obj'] ?? link?.attrs['value'] ?? list?.attrs['value'];
  if (!target) return 'none';
  if (DEFAULT_PLANES.has(target)) return 'defaultPlane';
  const type = typeByName.get(target) ?? '';
  // Only the first Body of a document owns the bare names; the next one's
  // origin holds XY_Plane001 and so on.
  if (type === 'App::Plane') return 'originPlane';
  if (type === 'PartDesign::Plane' || type === 'Part::DatumPlane') return 'datumPlane';
  if (type === 'PartDesign::CoordinateSystem') return 'coordinateSystem';
  const sub = link?.attrs['sub'] ?? list?.children.find((c) => c.name === 'Sub')?.attrs['value'] ?? '';
  return sub.startsWith('Face') ? 'face' : 'otherObject';
}

function censusExtrude(
  type: string,
  props: Map<string, XmlNode>,
  census: DocumentCensus,
  facts: Set<string>,
): void {
  const kind = type === 'PartDesign::Pad' ? 'pad' : 'pocket';
  const number = (name: string): number => Number(props.get(name)?.children[0]?.attrs['value'] ?? 0);
  if (number('Type') !== 0) {
    bump(census.properties, `${kind}.type${number('Type')}`);
    facts.add('extrude.upTo');
  }
  if (number('SideType') !== 0) {
    bump(census.properties, `${kind}.sideType${number('SideType')}`);
    facts.add('extrude.twoSided');
  }
  if (boolOf(props, 'Midplane')) bump(census.properties, `${kind}.midplane`);
  if (number('TaperAngle') !== 0 || number('TaperAngle2') !== 0 || number('TaperAngleRev') !== 0) {
    bump(census.properties, `${kind}.taper`);
    facts.add('extrude.taper');
  }
  if (number('Offset') !== 0) {
    bump(census.properties, `${kind}.offset`);
    facts.add('extrude.offset');
  }
  if (boolOf(props, 'UseCustomVector')) {
    bump(census.properties, `${kind}.customDirection`);
    facts.add('extrude.customDirection');
  }
}

function propertyMap(propertiesNode: XmlNode | undefined): Map<string, XmlNode> {
  const out = new Map<string, XmlNode>();
  for (const p of propertiesNode ? findChildren(propertiesNode, 'Property') : []) {
    if (p.attrs['name']) out.set(p.attrs['name'], p);
  }
  return out;
}

function shapeFileOf(props: Map<string, XmlNode>): string | undefined {
  const shape = props.get('Shape');
  const file = shape && findChild(shape, 'Part')?.attrs['file'];
  return file && file.length > 0 ? file : undefined;
}

function boolOf(props: Map<string, XmlNode>, name: string): boolean {
  return props.get(name)?.children[0]?.attrs['value'] === 'true';
}

function linkOf(props: Map<string, XmlNode>, name: string): string | undefined {
  const v = props.get(name)?.children[0]?.attrs['value'];
  return v && v.length > 0 ? v : undefined;
}

function linkListOf(props: Map<string, XmlNode>, name: string): string[] {
  const out: string[] = [];
  for (const l of props.get(name)?.children[0]?.children ?? []) {
    const v = l.attrs['value'] ?? l.attrs['obj'];
    if (l.name === 'Link' && v) out.push(v);
  }
  return out;
}

function consumedLinks(props: Map<string, XmlNode>): string[] {
  const out: string[] = [];
  for (const name of CONSUMING_LINKS) {
    const inner = props.get(name)?.children[0];
    if (!inner) continue;
    if (inner.name === 'Link' || inner.name === 'LinkSub') {
      const v = inner.attrs['value'];
      if (v) out.push(v);
    } else if (inner.name === 'LinkList' || inner.name === 'LinkSubList') {
      out.push(...linkListOf(props, name));
    }
  }
  return out;
}

function countExpressions(props: Map<string, XmlNode>): number {
  const engine = props.get('ExpressionEngine')?.children[0];
  return engine ? engine.children.filter((c) => c.name === 'Expression').length : 0;
}

function placementIsIdentity(props: Map<string, XmlNode>, name = 'Placement'): boolean {
  const p = props.get(name)?.children[0];
  if (!p) return true;
  const n = (k: string): number => Number(p.attrs[k] ?? 0);
  const eps = 1e-9;
  return Math.abs(n('Px')) < eps && Math.abs(n('Py')) < eps && Math.abs(n('Pz')) < eps
    && Math.abs(n('Q0')) < eps && Math.abs(n('Q1')) < eps && Math.abs(n('Q2')) < eps;
}

function bump(counts: Record<string, number>, key: string, by = 1): void {
  counts[key] = (counts[key] ?? 0) + by;
}
