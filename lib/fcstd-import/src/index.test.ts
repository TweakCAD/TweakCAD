/**
 * Integration tests for the FreeCAD .fcstd importer.
 *
 * Uses a real .fcstd Document.xml as a fixture. The expected shape was
 * eyeballed from the XML directly:
 *
 *   - One PartDesign::Body with 9 timeline children:
 *       Sketch, Pad, Sketch001, Groove, Sketch002, Pocket,
 *       DatumLine, Sketch003, Groove001.
 *   - Two MVP features: Pad (Length=20, Reversed=true) on Sketch (15 geoms),
 *     Pocket (Length=50, Reversed=true) on Sketch002 (1 circle, radius 2).
 *   - Sketch001 has 8 line segments and feeds the (unsupported) Groove.
 *   - Sketch003 has 4 line segments and feeds the (unsupported) Groove001.
 *   - Total of 4 unsupported items the importer must skip with diagnostics:
 *     Groove, Groove001, DatumLine, plus any leftover (we don't import the
 *     two extra sketches as standalone — they're still in the timeline since
 *     they're Sketcher::SketchObject which IS supported, just unused).
 */

import { sketchBuildGeometry } from '@tweakcad/core/src/sketch/derivedGeometry.ts';
import { CURRENT_SCHEMA_VERSION } from '@tweakcad/core/src/document/version.ts';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { importFcstd, importFcstdFromXml, parseDocumentXml } from './index.ts';
import type {
  SketchFeatureInputs,
  ExtrudeFeatureInputs,
  CadPart,
} from '@tweakcad/core/src/document/schema.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_XML_PATH = join(__dirname, 'fixtures', 'exercise-2d-10.Document.xml');

function loadFixtureXml(): string {
  return readFileSync(FIXTURE_XML_PATH, 'utf8');
}

function onlyPart(parts: Record<string, CadPart>): CadPart {
  const values = Object.values(parts);
  if (values.length !== 1) throw new Error(`expected exactly 1 part, got ${values.length}`);
  return values[0]!;
}

describe('importFcstdFromXml — real Exercise-2D-10 model', () => {
  const xml = loadFixtureXml();
  const result = importFcstdFromXml(xml, { createdAt: '2026-01-01T00:00:00.000Z' });
  if (!result.ok) throw new Error(`importFcstdFromXml failed: ${result.error}`);
  const { project, diagnostics } = result.value;
  const part = onlyPart(project.parts);

  it('produces exactly one part with a sensible name', () => {
    expect(Object.keys(project.parts)).toHaveLength(1);
    expect(part.name).toBe('Body');
  });

  it('emits the correct timeline order for supported features', () => {
    // Body Group order: Sketch, Pad, Sketch001, Groove, Sketch002, Pocket,
    // DatumLine, Sketch003, Groove001. We import sketches + Pad + Pocket;
    // the others become diagnostics.
    const featureTypes = part.timeline.map((f) => f.type);
    expect(featureTypes).toEqual(['sketch', 'extrude', 'sketch', 'sketch', 'extrude', 'sketch']);
    const featureNames = part.timeline.map((f) => f.name);
    expect(featureNames).toEqual(['Sketch', 'Pad', 'Sketch001', 'Sketch002', 'Pocket', 'Sketch003']);
  });

  it('imports the main Pad as a newBody extrude with length 20 reversed', () => {
    const pad = part.timeline.find((f) => f.name === 'Pad');
    expect(pad).toBeDefined();
    expect(pad!.type).toBe('extrude');
    const inputs = pad!.inputs as unknown as ExtrudeFeatureInputs;
    expect(inputs.operation).toBe('newBody');
    expect(inputs.direction).toEqual({ type: 'reversed' });
    expect(inputs.extent).toEqual({ type: 'distance', value: '20' });
    expect(inputs.profiles).toHaveLength(1);
    const sketch = part.timeline.find((f) => f.name === 'Sketch');
    expect(inputs.profiles[0]!.sketchId).toBe(sketch!.id);
  });

  it('imports the Pocket as a cut extrude with length 50 reversed', () => {
    const pocket = part.timeline.find((f) => f.name === 'Pocket');
    expect(pocket).toBeDefined();
    expect(pocket!.type).toBe('extrude');
    const inputs = pocket!.inputs as unknown as ExtrudeFeatureInputs;
    expect(inputs.operation).toBe('cut');
    expect(inputs.direction).toEqual({ type: 'reversed' });
    expect(inputs.extent).toEqual({ type: 'distance', value: '50' });
    const sketch = part.timeline.find((f) => f.name === 'Sketch002');
    expect(inputs.profiles[0]!.sketchId).toBe(sketch!.id);
  });

  it('imports the main Sketch with all 15 geometry entries on XY plane', () => {
    const sketch = part.timeline.find((f) => f.name === 'Sketch');
    expect(sketch).toBeDefined();
    const inputs = sketch!.inputs as unknown as SketchFeatureInputs;
    expect(inputs.plane).toEqual({ type: 'defaultPlane', name: 'XY' });
    const entities = Object.values(sketchBuildGeometry(inputs));
    expect(entities).toHaveLength(15);
    const lines = entities.filter((e) => e.type === 'line');
    expect(lines).toHaveLength(15); // all 15 are line segments in this sketch
    const constructionCount = entities.filter((e) => e.construction === true).length;
    expect(constructionCount).toBe(3); // last 3 lines are construction geometry
  });

  it('imports Sketch002 as a single circle (diameter 4) on YZ', () => {
    const sketch = part.timeline.find((f) => f.name === 'Sketch002');
    expect(sketch).toBeDefined();
    const inputs = sketch!.inputs as unknown as SketchFeatureInputs;
    expect(inputs.plane).toEqual({ type: 'defaultPlane', name: 'YZ' });
    const entities = Object.values(sketchBuildGeometry(inputs));
    expect(entities).toHaveLength(1);
    const circle = entities[0]!;
    expect(circle.type).toBe('circle');
    if (circle.type === 'circle') {
      expect(circle.diameter).toBe('4'); // Radius=2 → diameter=4
      expect(circle.center).toEqual(['-7', '0']);
    }
  });

  it('imports Sketch001 with 8 line segments and Sketch003 with 4', () => {
    const s1 = part.timeline.find((f) => f.name === 'Sketch001');
    const s3 = part.timeline.find((f) => f.name === 'Sketch003');
    const i1 = s1!.inputs as unknown as SketchFeatureInputs;
    const i3 = s3!.inputs as unknown as SketchFeatureInputs;
    expect(Object.values(sketchBuildGeometry(i1))).toHaveLength(8);
    expect(Object.values(sketchBuildGeometry(i3))).toHaveLength(4);
  });

  it('emits diagnostics for Groove, Groove001, and DatumLine', () => {
    const unsupportedMessages = diagnostics
      .filter((d) => d.code === 'unsupported-feature')
      .map((d) => d.message);
    expect(unsupportedMessages.some((m) => m.includes('"Groove"'))).toBe(true);
    expect(unsupportedMessages.some((m) => m.includes('"Groove001"'))).toBe(true);
    expect(unsupportedMessages.some((m) => m.includes('"DatumLine"'))).toBe(true);
  });

  it('emits a constraints-not-imported diagnostic per sketch with constraints', () => {
    const constraintDiagnostics = diagnostics.filter((d) => d.code === 'constraints-not-imported');
    // All four sketches in this file carry constraints.
    expect(constraintDiagnostics).toHaveLength(4);
  });

  it('flags Sketch002 as fallback-onto-default-plane since YZ_Plane is allowed but tagged correctly', () => {
    // Sketch002 is on YZ_Plane — that's a known default plane, so NO
    // sketch-non-default-plane diagnostic should be emitted for it.
    const nonDefaults = diagnostics.filter((d) => d.code === 'sketch-non-default-plane');
    expect(nonDefaults).toHaveLength(0);
  });

  it('produces a CadProject at the current schema version with no unit system', () => {
    // FreeCAD authors in mm, and so do we — there is no document-level unit
    // field to translate into. See the units invariant in `core/src/units.ts`.
    expect(project).not.toHaveProperty('units');
    // Compared against the constant, not a literal: the importer must write
    // whatever this build writes, or its output fails to load.
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('importFcstd — full ZIP round-trip', () => {
  it('unzips a synthesized .fcstd buffer and imports it', async () => {
    const xml = loadFixtureXml();
    const buffer = zipSync({ 'Document.xml': strToU8(xml) });
    const result = await importFcstd(buffer);
    if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.value.project.parts)).toHaveLength(1);
  });

  it('returns an error when the archive lacks Document.xml', async () => {
    const buffer = zipSync({ 'something-else.txt': strToU8('hello') });
    const result = await importFcstd(buffer);
    expect(result.ok).toBe(false);
  });

  it('returns an error when the buffer is not a ZIP', async () => {
    const result = await importFcstd(new Uint8Array([1, 2, 3, 4]));
    expect(result.ok).toBe(false);
  });
});

describe('importFcstdFromXml — Groove-only document', () => {
  // Synthetic document: a body containing only a Sketch001 + Groove. The
  // sketch IS imported (sketches are supported) but the Groove is skipped
  // with a diagnostic and the overall import still succeeds.
  const grooveOnlyXml = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4">
  <Properties Count="0"/>
  <Objects Count="4">
    <Object type="PartDesign::Body" name="Body" />
    <Object type="App::Plane" name="XY_Plane" />
    <Object type="Sketcher::SketchObject" name="Sketch001" />
    <Object type="PartDesign::Groove" name="Groove" />
  </Objects>
  <ObjectData Count="4">
    <Object name="Body">
      <Properties Count="2">
        <Property name="Label" type="App::PropertyString"><String value="Body"/></Property>
        <Property name="Group" type="App::PropertyLinkList">
          <LinkList count="2">
            <Link value="Sketch001"/>
            <Link value="Groove"/>
          </LinkList>
        </Property>
      </Properties>
    </Object>
    <Object name="XY_Plane">
      <Properties Count="1">
        <Property name="Label" type="App::PropertyString"><String value="XY_Plane"/></Property>
      </Properties>
    </Object>
    <Object name="Sketch001">
      <Properties Count="3">
        <Property name="Label" type="App::PropertyString"><String value="Sketch001"/></Property>
        <Property name="Geometry" type="Part::PropertyGeometryList">
          <GeometryList count="1">
            <Geometry type="Part::GeomLineSegment">
              <Construction value="0"/>
              <LineSegment StartX="0.0" StartY="0.0" StartZ="0.0" EndX="1.0" EndY="0.0" EndZ="0.0"/>
            </Geometry>
          </GeometryList>
        </Property>
        <Property name="Support" type="App::PropertyLinkSubList">
          <LinkSubList count="1">
            <Link obj="XY_Plane" sub=""/>
          </LinkSubList>
        </Property>
      </Properties>
    </Object>
    <Object name="Groove">
      <Properties Count="2">
        <Property name="Label" type="App::PropertyString"><String value="Groove"/></Property>
        <Property name="Profile" type="App::PropertyLinkSub"><LinkSub value="Sketch001" count="0"/></Property>
      </Properties>
    </Object>
  </ObjectData>
</Document>`;

  it('skips the Groove and emits a diagnostic but still imports the sketch', () => {
    const result = importFcstdFromXml(grooveOnlyXml);
    if (!result.ok) throw new Error(result.error);
    const { project, diagnostics } = result.value;
    const part = onlyPart(project.parts);
    expect(part.timeline).toHaveLength(1);
    expect(part.timeline[0]!.type).toBe('sketch');
    const grooveDiag = diagnostics.find(
      (d) => d.code === 'unsupported-feature' && d.message.includes('Groove'),
    );
    expect(grooveDiag).toBeDefined();
    expect(grooveDiag!.recoverable).toBe(true);
  });
});

describe('parseDocumentXml — error path', () => {
  it('returns an error for non-Document root', () => {
    const r = parseDocumentXml('<NotADocument/>');
    expect(r.ok).toBe(false);
  });

  it('returns an error for malformed XML', () => {
    const r = parseDocumentXml('<Document><unclosed></Document>');
    expect(r.ok).toBe(false);
  });
});

describe('importFcstdFromXml — older FreeCAD schema (Model / Sketch link / AttachmentSupport)', () => {
  // Pre-~0.19 FreeCAD names the Body's child list `Model` (not `Group`), the
  // Pad's profile link `Sketch` (App::PropertyLink, not `Profile`
  // App::PropertyLinkSub), and the sketch attachment `Support` rather than the
  // modern `AttachmentSupport`. Here the sketch uses the *modern*
  // `AttachmentSupport` while the body/pad use the *older* names — a real mix
  // seen across files. All three must resolve, or the Pad is dropped and the
  // body rebuilds to zero solids.
  const oldSchemaXml = `<?xml version='1.0' encoding='utf-8'?>
<Document SchemaVersion="4">
  <Objects Count="4">
    <Object type="PartDesign::Body" name="Body" />
    <Object type="App::Plane" name="XZ_Plane" />
    <Object type="Sketcher::SketchObject" name="Sketch" />
    <Object type="PartDesign::Pad" name="Pad" />
  </Objects>
  <ObjectData Count="4">
    <Object name="Body">
      <Properties Count="2">
        <Property name="Label" type="App::PropertyString"><String value="Body"/></Property>
        <Property name="Model" type="App::PropertyLinkList">
          <LinkList count="2">
            <Link value="Sketch"/>
            <Link value="Pad"/>
          </LinkList>
        </Property>
      </Properties>
    </Object>
    <Object name="XZ_Plane">
      <Properties Count="1">
        <Property name="Label" type="App::PropertyString"><String value="XZ_Plane"/></Property>
      </Properties>
    </Object>
    <Object name="Sketch">
      <Properties Count="3">
        <Property name="Label" type="App::PropertyString"><String value="Sketch"/></Property>
        <Property name="Geometry" type="Part::PropertyGeometryList">
          <GeometryList count="1">
            <Geometry type="Part::GeomLineSegment">
              <Construction value="0"/>
              <LineSegment StartX="0.0" StartY="0.0" EndX="10.0" EndY="0.0"/>
            </Geometry>
          </GeometryList>
        </Property>
        <Property name="AttachmentSupport" type="App::PropertyLinkSubList">
          <LinkSubList count="1">
            <Link obj="XZ_Plane" sub=""/>
          </LinkSubList>
        </Property>
      </Properties>
    </Object>
    <Object name="Pad">
      <Properties Count="3">
        <Property name="Label" type="App::PropertyString"><String value="Pad"/></Property>
        <Property name="Length" type="App::PropertyLength"><Float value="20"/></Property>
        <Property name="Sketch" type="App::PropertyLink"><Link value="Sketch"/></Property>
      </Properties>
    </Object>
  </ObjectData>
</Document>`;

  const result = importFcstdFromXml(oldSchemaXml);
  if (!result.ok) throw new Error(`import failed: ${result.error}`);
  const part = onlyPart(result.value.project.parts);

  it('reads the Body children from the older `Model` link-list', () => {
    expect(part.timeline.map((f) => `${f.type}:${f.name}`)).toEqual(['sketch:Sketch', 'extrude:Pad']);
  });

  it('resolves the Pad profile from the older `Sketch` link', () => {
    const sketch = part.timeline.find((f) => f.name === 'Sketch')!;
    const pad = part.timeline.find((f) => f.name === 'Pad')!;
    const inputs = pad.inputs as unknown as ExtrudeFeatureInputs;
    expect(inputs.operation).toBe('newBody');
    expect(inputs.extent).toEqual({ type: 'distance', value: '20' });
    expect(inputs.profiles[0]!.sketchId).toBe(sketch.id);
  });

  it('reads the sketch plane from `AttachmentSupport`', () => {
    const sketch = part.timeline.find((f) => f.name === 'Sketch')!;
    const inputs = sketch.inputs as unknown as SketchFeatureInputs;
    expect(inputs.plane).toEqual({ type: 'defaultPlane', name: 'XZ' });
  });
});
