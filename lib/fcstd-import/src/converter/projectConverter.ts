/**
 * Walk a parsed FCDocument and build a CadProject.
 *
 * Strategy:
 *   1. Find every PartDesign::Body. Each one becomes a single CadPart whose
 *      timeline is the converted ordered Group of the body.
 *   2. If no PartDesign::Body exists, fall back to scanning the top-level
 *      object list. (Rare — FreeCAD models authored with the PartDesign
 *      workbench always have a Body.)
 *   3. Within each body, walk the Group LinkList in declaration order. For
 *      each Sketcher::SketchObject convert it; for each Pad/Pocket convert
 *      it referencing the most recently converted sketch matching its
 *      Profile link. Anything else (Groove, DatumLine, Revolution, …) is
 *      skipped with a Diagnostic.
 *   4. The first Pad in a body becomes operation: 'newBody'; subsequent
 *      Pads become operation: 'join'. Pockets are always 'cut'.
 *
 * Diagnostics use the document/schema Diagnostic type so consumers can
 * surface them uniformly with build-time warnings.
 */

import { partId as makePartId, generateId } from '@tweakcad/core/src/ids.ts';
import { CURRENT_SCHEMA_VERSION } from '@tweakcad/core/src/document/version.ts';
import type {
  CadProject,
  CadPart,
  FeatureNode,
  Diagnostic,
} from '@tweakcad/core/src/document/schema.ts';
import type {
  FcDocument,
  FcBodyObject,
  FcSketchObject,
  FcPadObject,
  FcPocketObject,
  FcObject,
} from '../types/fcstdTypes.ts';
import { convertSketch, isKnownDefaultPlane } from './sketchConverter.ts';
import type { SketchEntityMapping } from './sketchConverter.ts';
import { convertPad, convertPocket } from './extrudeConverter.ts';

const APP_VERSION = '0.1.0-fcstd-import';

/** Result of a full document → project conversion. */
export type ProjectConversionResult = {
  project: CadProject;
  diagnostics: Diagnostic[];
};

/**
 * Convert a parsed FreeCAD document into a CadProject.
 *
 * @param doc - The parsed FCDocument
 * @param options - Optional metadata overrides. createdAt defaults to "now".
 */
export function convertDocument(
  doc: FcDocument,
  options: { name?: string; createdAt?: string } = {},
): ProjectConversionResult {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const diagnostics: Diagnostic[] = [];
  const parts: CadProject['parts'] = {};

  const bodies = doc.objectsOrder
    .filter((h) => h.type === 'PartDesign::Body')
    .map((h) => doc.objects[h.name])
    .filter((o): o is FcBodyObject => o !== undefined && o.kind === 'body');

  if (bodies.length === 0) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'no-body',
      message: 'No PartDesign::Body found in document — nothing was imported.',
      recoverable: true,
    });
  }

  for (const body of bodies) {
    const partResult = convertBody(body, doc, createdAt);
    diagnostics.push(...partResult.diagnostics);
    const pid = makePartId(generateId('part'));
    const part: CadPart = {
      id: pid,
      name: body.label ?? body.name,
      parameters: { values: {} },
      timeline: partResult.timeline,
      defaultPlanes: {
        XY: { type: 'defaultPlane', name: 'XY' },
        XZ: { type: 'defaultPlane', name: 'XZ' },
        YZ: { type: 'defaultPlane', name: 'YZ' },
      },
    };
    parts[pid] = part;
  }

  const project: CadProject = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    metadata: {
      name: options.name ?? doc.objects['Body']?.label ?? 'Imported FreeCAD model',
      description: `Imported from FreeCAD .fcstd (ProgramVersion=${doc.programVersion ?? 'unknown'})`,
      createdAt,
      updatedAt: createdAt,
      appVersion: APP_VERSION,
    },
    parameters: { values: {} },
    parts,
    references: {},
    assemblies: {},
  };

  return { project, diagnostics };
}

type BodyConversion = {
  timeline: FeatureNode[];
  diagnostics: Diagnostic[];
};

function convertBody(body: FcBodyObject, doc: FcDocument, createdAt: string): BodyConversion {
  const timeline: FeatureNode[] = [];
  const diagnostics: Diagnostic[] = [];
  const sketchMappings = new Map<string, SketchEntityMapping>();
  let padCountInBody = 0;

  for (const childName of body.groupLinks) {
    const obj: FcObject | undefined = doc.objects[childName];
    if (!obj) {
      diagnostics.push({
        id: generateId('diag'),
        severity: 'warning',
        code: 'missing-object',
        message: `Body references "${childName}" but it is not in the document.`,
        recoverable: true,
      });
      continue;
    }

    switch (obj.kind) {
      case 'sketch':
        handleSketch(obj, timeline, sketchMappings, diagnostics, createdAt);
        break;
      case 'pad':
        padCountInBody = handlePad(
          obj,
          timeline,
          sketchMappings,
          diagnostics,
          createdAt,
          padCountInBody,
        );
        break;
      case 'pocket':
        handlePocket(obj, timeline, sketchMappings, diagnostics, createdAt);
        break;
      case 'body':
      case 'generic':
        diagnostics.push({
          id: generateId('diag'),
          severity: 'warning',
          code: 'unsupported-feature',
          message: `Skipped unsupported feature "${childName}" of type "${obj.type}". MVP supports Pad, Pocket, and Sketcher::SketchObject only.`,
          recoverable: true,
        });
        break;
    }
  }

  return { timeline, diagnostics };
}

function handleSketch(
  sketch: FcSketchObject,
  timeline: FeatureNode[],
  mappings: Map<string, SketchEntityMapping>,
  diagnostics: Diagnostic[],
  createdAt: string,
): void {
  const result = convertSketch(sketch, createdAt);
  timeline.push(result.feature);
  mappings.set(sketch.name, {
    sketchFeatureId: result.feature.id,
    wireEntityIds: result.wireEntityIds,
  });

  if (!isKnownDefaultPlane(sketch.supportName)) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'sketch-non-default-plane',
      message: `Sketch "${sketch.name}" is attached to "${sketch.supportName ?? '(none)'}" which is not a default plane — imported on XY as a fallback.`,
      featureId: result.feature.id,
      recoverable: true,
    });
  }

  if (sketch.constraints.length > 0) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'info',
      code: 'constraints-not-imported',
      message: `Sketch "${sketch.name}" has ${sketch.constraints.length} constraint(s); constraint import is a Phase 3 feature. Geometry coordinates are already solved so the imported sketch is geometrically correct.`,
      featureId: result.feature.id,
      recoverable: true,
    });
  }

  for (const skipped of result.skippedGeometry) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'unsupported-geometry',
      message: `Sketch "${sketch.name}" geometry[${skipped.index}] (type "${skipped.rawType}") is not supported yet and was skipped.`,
      featureId: result.feature.id,
      recoverable: true,
    });
  }
}

function handlePad(
  pad: FcPadObject,
  timeline: FeatureNode[],
  mappings: Map<string, SketchEntityMapping>,
  diagnostics: Diagnostic[],
  createdAt: string,
  padCountInBody: number,
): number {
  const mapping = pad.profileName ? mappings.get(pad.profileName) : undefined;
  if (!mapping) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'pad-missing-profile',
      message: `Pad "${pad.name}" references profile "${pad.profileName ?? '(none)'}" which is not a Body-local sketch — Pad skipped.`,
      recoverable: true,
    });
    return padCountInBody;
  }
  const operation: 'newBody' | 'join' = padCountInBody === 0 ? 'newBody' : 'join';
  const result = convertPad(pad, mapping.sketchFeatureId, mapping.wireEntityIds, operation, createdAt);
  timeline.push(result.feature);
  if (result.unsupportedTypeWarning) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'extrude-unsupported-type',
      message: `Pad "${pad.name}": ${result.unsupportedTypeWarning}`,
      featureId: result.feature.id,
      recoverable: true,
    });
  }
  return padCountInBody + 1;
}

function handlePocket(
  pocket: FcPocketObject,
  timeline: FeatureNode[],
  mappings: Map<string, SketchEntityMapping>,
  diagnostics: Diagnostic[],
  createdAt: string,
): void {
  const mapping = pocket.profileName ? mappings.get(pocket.profileName) : undefined;
  if (!mapping) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'pocket-missing-profile',
      message: `Pocket "${pocket.name}" references profile "${pocket.profileName ?? '(none)'}" which is not a Body-local sketch — Pocket skipped.`,
      recoverable: true,
    });
    return;
  }
  const result = convertPocket(pocket, mapping.sketchFeatureId, mapping.wireEntityIds, createdAt);
  timeline.push(result.feature);
  if (result.unsupportedTypeWarning) {
    diagnostics.push({
      id: generateId('diag'),
      severity: 'warning',
      code: 'extrude-unsupported-type',
      message: `Pocket "${pocket.name}": ${result.unsupportedTypeWarning}`,
      featureId: result.feature.id,
      recoverable: true,
    });
  }
}
