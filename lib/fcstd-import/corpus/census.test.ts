import { describe, expect, it } from 'vitest';
import { censusDocument } from './census.ts';
import type { DocumentCensus } from './census.ts';

type DocumentCensusSupport = DocumentCensus['sketchSupport'];

const DOC = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4" ProgramVersion="1.0R1" FileVersion="1">
  <Objects Count="6">
    <Object type="PartDesign::Body" name="Body"/>
    <Object type="Sketcher::SketchObject" name="Sketch"/>
    <Object type="PartDesign::Pad" name="Pad"/>
    <Object type="PartDesign::Fillet" name="Fillet"/>
    <Object type="Part::Box" name="Box"/>
    <Object type="Part::Cut" name="Cut"/>
  </Objects>
  <ObjectData Count="6">
    <Object name="Body"><Properties>
      <Property name="Group" type="App::PropertyLinkList"><LinkList count="3">
        <Link value="Sketch"/><Link value="Pad"/><Link value="Fillet"/>
      </LinkList></Property>
      <Property name="Tip" type="App::PropertyLink"><Link value="Pad"/></Property>
      <Property name="Placement" type="App::PropertyPlacement">
        <PropertyPlacement Px="5" Py="0" Pz="0" Q0="0" Q1="0" Q2="0" Q3="1"/>
      </Property>
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape.brp"/></Property>
    </Properties></Object>
    <Object name="Sketch"><Properties>
      <Property name="AttachmentSupport" type="App::PropertyLinkSubList"><LinkSubList count="1">
        <Link obj="XY_Plane" sub=""/>
      </LinkSubList></Property>
      <Property name="Constraints" type="Sketcher::PropertyConstraintList"><ConstraintList count="2">
        <Constrain Type="2"/><Constrain Type="10"/>
      </ConstraintList></Property>
      <Property name="Geometry" type="Part::PropertyGeometryList"><GeometryList count="1">
        <Geometry type="Part::GeomEllipse"/>
      </GeometryList></Property>
      <Property name="ExpressionEngine" type="App::PropertyExpressionEngine"><ExpressionEngine count="1">
        <Expression path="Constraints.w" expression="2"/>
      </ExpressionEngine></Property>
    </Properties></Object>
    <Object name="Pad"><Properties>
      <Property name="Type" type="App::PropertyEnumeration"><Integer value="1"/></Property>
      <Property name="TaperAngle" type="App::PropertyAngle"><Float value="3"/></Property>
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape1.brp"/></Property>
    </Properties></Object>
    <Object name="Fillet"><Properties/></Object>
    <Object name="Box"><Properties>
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape2.brp"/></Property>
    </Properties></Object>
    <Object name="Cut"><Properties>
      <Property name="Base" type="App::PropertyLink"><Link value="Box"/></Property>
      <Property name="Shape" type="Part::PropertyPartShape"><Part file="PartShape3.brp"/></Property>
    </Properties></Object>
  </ObjectData>
</Document>`;

function sketchAttachedBy(attachment: string, extraObject = ''): DocumentCensusSupport {
  const doc = `<Document>
    <Objects>
      <Object type="Sketcher::SketchObject" name="Sketch"/>
      ${extraObject}
    </Objects>
    <ObjectData>
      <Object name="Sketch"><Properties>${attachment}</Properties></Object>
    </ObjectData>
  </Document>`;
  return censusDocument(doc).sketchSupport;
}

describe('sketch attachment', () => {
  it('tells a later Body origin plane from the bare default names', () => {
    const support = sketchAttachedBy(
      `<Property name="AttachmentSupport"><LinkSubList><Link obj="XY_Plane001" sub=""/></LinkSubList></Property>`,
      `<Object type="App::Plane" name="XY_Plane001"/>`,
    );
    expect(support).toEqual({ originPlane: 1 });
  });

  it('reads a face from the LinkSub form old files use', () => {
    const support = sketchAttachedBy(
      `<Property name="Support"><LinkSub value="Pad" count="1"><Sub value="Face3"/></LinkSub></Property>`,
      `<Object type="PartDesign::Pad" name="Pad"/>`,
    );
    expect(support).toEqual({ face: 1 });
  });

  it('counts a sketch with no attachment', () => {
    expect(sketchAttachedBy('')).toEqual({ none: 1 });
  });
});

describe('censusDocument', () => {
  const census = censusDocument(DOC);

  it('names constraints by their FreeCAD enum value', () => {
    expect(census.constraints).toEqual({ Horizontal: 1, Perpendicular: 1 });
  });

  it('counts geometry the importer does not read', () => {
    expect(census.geometry).toEqual({ 'Part::GeomEllipse': 1 });
  });

  it('does not mistake the usual flat-face attachment for an unusual map mode', () => {
    const flat = censusDocument(DOC.replace(
      '<Property name="Constraints"',
      '<Property name="MapMode" type="App::PropertyEnumeration"><Integer value="5"/></Property><Property name="Constraints"',
    ));
    expect(flat.units[0]?.blockers).not.toContain('sketch.mapMode');
    const axis = censusDocument(DOC.replace(
      '<Property name="Constraints"',
      '<Property name="MapMode" type="App::PropertyEnumeration"><Integer value="2"/></Property><Property name="Constraints"',
    ));
    expect(axis.units[0]?.blockers).toContain('sketch.mapMode');
  });

  it('counts values a straight import would lose', () => {
    expect(census.properties).toMatchObject({
      'body.placement': 1,
      'body.featuresAfterTip': 1,
      'pad.type1': 1,
      'pad.taper': 1,
      expressions: 1,
    });
    expect(census.sketchSupport).toEqual({ defaultPlane: 1 });
  });

  it('names what stands between a body and its stored shape', () => {
    expect(census.units[0]?.blockers).toEqual([
      'body.featuresAfterTip',
      'body.placement',
      'extrude.taper',
      'extrude.upTo',
      'feature:PartDesign::Fillet',
      'geometry:Part::GeomEllipse',
    ]);
  });

  it('takes the body and the unconsumed Part result as units, not what they consumed', () => {
    expect(census.units.map((u) => [u.name, u.kind, u.shapeFile])).toEqual([
      ['Body', 'body', 'PartShape.brp'],
      ['Cut', 'root', 'PartShape3.brp'],
    ]);
  });
});
