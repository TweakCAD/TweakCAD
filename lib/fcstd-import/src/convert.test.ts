import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { importFcstd } from './index';
import type { Json } from './writer';

const options = () => ({ ids: seededIds(5), writer: { app: 'test', version: '0' }, now: '2026-11-06T00:00:00Z' });

const prop = (name: string, inner: string) => `<Property name="${name}">${inner}</Property>`;
const float = (name: string, v: number | string) => prop(name, `<Float value="${v}"/>`);
/** A shape FreeCAD stored for the object, in a file of the archive. */
const shape = (file: string) => prop('Shape', `<Part file="${file}"/>`);
const body = (members: string[], tip: string) => ({
  name: 'Body',
  type: 'PartDesign::Body',
  props:
    prop(
      'Group',
      `<LinkList count="${members.length}">${members.map((m) => `<Link value="${m}"/>`).join('')}</LinkList>`,
    ) + prop('Tip', `<Link value="${tip}"/>`),
});
type Obj = { name: string; type: string; props: string };
const xmlOf = (objects: Obj[]) =>
  `<Document ProgramVersion="1.1"><Objects>${objects.map((o) => `<Object type="${o.type}" name="${o.name}"/>`).join('')}</Objects><ObjectData>${objects
    .map((o) => `<Object name="${o.name}"><Properties>${o.props}</Properties></Object>`)
    .join('')}</ObjectData></Document>`;
/** A file of `objects`, each shape it names stored as a placeholder. */
const file = (objects: Obj[]) => {
  const files: Record<string, Uint8Array> = { 'Document.xml': strToU8(xmlOf(objects)) };
  for (const o of objects)
    for (const m of o.props.matchAll(/<Part file="([^"]+)"/g)) files[m[1] as string] = strToU8('brep');
  return zipSync(files);
};

const timeline = (doc: Json) => ((doc.parts as Json[])[0] as Json).timeline as Json[];

describe('importing PartDesign primitives', () => {
  for (const [what, type, props] of [
    [
      'a part of a cylinder of radius 0',
      'PartDesign::AdditiveCylinder',
      float('Radius', 0) + float('Height', 10) + float('Angle', 90),
    ],
    [
      'a sphere between two equal latitudes',
      'PartDesign::AdditiveSphere',
      float('Radius', 5) + float('Angle1', 10) + float('Angle2', 10) + float('Angle3', 90),
    ],
    [
      'a part of a torus of minor radius 0',
      'PartDesign::AdditiveTorus',
      float('Radius1', 5) + float('Radius2', 0) + float('Angle3', 90),
    ],
  ] as const) {
    it(`takes the stored shape for ${what}, whose section encloses nothing`, () => {
      const result = importFcstd(
        file([body(['P'], 'P'), { name: 'P', type, props: props + shape('P.brp') }]),
        options(),
      );
      if (!result.ok) throw new Error(result.error);
      const { document, notes, steps } = result.value;
      expect(timeline(document).map((f) => f.type)).toEqual([]);
      expect(steps.map((s) => [s.kind, s.object])).toEqual([['shape', 'P']]);
      expect(notes.filter((n) => n.severity === 'warning').map((n) => n.message)).toEqual([
        `${type.replace('PartDesign::', '')} came in as the shape FreeCAD stored`,
      ]);
      expect(readDocument(document).refused).toBe(false);
    });
  }
});

describe('importing prisms', () => {
  const prism = (sides: number) => ({
    name: 'Prism',
    type: 'PartDesign::AdditivePrism',
    props:
      prop('Polygon', `<Integer value="${sides}"/>`) +
      float('Circumradius', 5) +
      float('Height', 3) +
      shape('Prism.brp'),
  });

  it('draws a prism of many sides as one closed outline', () => {
    const result = importFcstd(file([body(['Prism'], 'Prism'), prism(1000)]), options());
    if (!result.ok) throw new Error(result.error);
    const { document } = result.value;
    const [sketch, extrude] = timeline(document);
    expect([sketch?.type, extrude?.type]).toEqual(['core.sketch', 'core.extrude']);
    const inputs = sketch?.inputs as Json;
    expect([
      (inputs.points as Json[]).length,
      (inputs.curves as Json[]).length,
      (inputs.regions as Json[]).length,
    ]).toEqual([1000, 1000, 1]);
    expect(readDocument(document).refused).toBe(false);
  });

  it('takes the stored shape for a prism of more sides than that', () => {
    const result = importFcstd(file([body(['Prism'], 'Prism'), prism(20000)]), options());
    if (!result.ok) throw new Error(result.error);
    expect(timeline(result.value.document)).toEqual([]);
    expect(result.value.steps.map((s) => [s.kind, s.object])).toEqual([['shape', 'Prism']]);
  });
});

describe('importing holes', () => {
  it('takes the stored shape for a drilled hole whose point angle is not between 0 and 180 degrees', () => {
    const sketch = {
      name: 'Sketch',
      type: 'Sketcher::SketchObject',
      props:
        prop(
          'Geometry',
          '<GeometryList count="1"><Geometry type="Part::GeomCircle" id="1"><Circle CenterX="0" CenterY="0" CenterZ="0" NormalX="0" NormalY="0" NormalZ="1" AngleXU="0" Radius="2"/><Construction value="0"/></Geometry></GeometryList>',
        ) + prop('Constraints', '<ConstraintList count="0"></ConstraintList>'),
    };
    const hole = (angle: number) => ({
      name: 'Hole',
      type: 'PartDesign::Hole',
      props:
        prop('Profile', '<LinkSub value="Sketch" count="0"/>') +
        float('Diameter', 4) +
        float('Depth', 10) +
        prop('DrillPoint', '<Integer value="1"/>') +
        float('DrillPointAngle', angle) +
        prop('DrillForDepth', '<Bool value="true"/>') +
        shape('Hole.brp'),
    });
    const holes = (angle: number) => {
      const result = importFcstd(file([body(['Sketch', 'Hole'], 'Hole'), sketch, hole(angle)]), options());
      if (!result.ok) throw new Error(result.error);
      expect(readDocument(result.value.document).refused).toBe(false);
      return timeline(result.value.document).filter((f) => f.type === 'core.hole').length;
    };
    expect(holes(118)).toBe(1);
    expect(holes(0)).toBe(0);
    expect(holes(180)).toBe(0);
  });
});

describe('importing App::Part containers', () => {
  const group = (...names: string[]) =>
    prop('Group', `<LinkList count="${names.length}">${names.map((n) => `<Link value="${n}"/>`).join('')}</LinkList>`);
  const box = {
    name: 'Box',
    type: 'PartDesign::AdditiveBox',
    props: float('Length', 10) + float('Width', 10) + float('Height', 10),
  };

  it('places a Body whose containers hold each other in a ring, directly and through a link', () => {
    const objects = [
      { name: 'P1', type: 'App::Part', props: group('P2', 'Body') },
      { name: 'P2', type: 'App::Part', props: group('P1') },
      { ...body(['Box'], 'Box') },
      box,
      { name: 'Link', type: 'App::Link', props: prop('LinkedObject', '<Link value="P1"/>') },
    ];
    const result = importFcstd(file(objects), options());
    if (!result.ok) throw new Error(result.error);
    const { document } = result.value;
    expect(timeline(document).map((f) => f.type)).toEqual(['core.primitive']);
    const assembly = (document.assemblies as Json[])[0] as Json;
    expect((assembly.instances as Json[]).length).toBe(2);
    expect(readDocument(document).refused).toBe(false);
  });
});
