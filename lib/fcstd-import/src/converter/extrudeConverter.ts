/**
 * Convert a FreeCAD Pad / Pocket into a CadProject extrude FeatureNode.
 *
 * Operation mapping:
 *   - PartDesign::Pad    → operation: 'newBody' (first Pad in a body) or 'join' (subsequent)
 *   - PartDesign::Pocket → operation: 'cut'
 *
 * The FreeCAD Pad/Pocket `Type` enum (from FreeCAD's PartDesign Pad
 * feature) is:
 *   0 = Length / Dimension, 1 = UpToLast, 2 = UpToFirst,
 *   3 = UpToFace, 4 = TwoLengths (deprecated), 5 = UpToShape.
 * Only Type=0 is mapped to a real extent; everything else maps to a Distance
 * extent at the recorded Length and yields a diagnostic to the caller.
 *
 * Direction: Reversed=true maps to DirectionSpec { type: 'reversed' }.
 * Midplane=true maps to ExtentSpec { type: 'symmetric', value }.
 */

import type { EntityId, FeatureId } from '@tweakcad/core/src/ids.ts';
import { featureId, generateId } from '@tweakcad/core/src/ids.ts';
import type {
  ExtrudeFeatureInputs,
  ExtentSpec,
  DirectionSpec,
  ProfileRef,
  FeatureNode,
} from '@tweakcad/core/src/document/schema.ts';
import type { FcPadObject, FcPocketObject } from '../types/fcstdTypes.ts';

export type ExtrudeConversionResult = {
  feature: FeatureNode;
  /** Set when the FreeCAD Type enum is anything other than Dimension (Type=0). */
  unsupportedTypeWarning: string | undefined;
};

/**
 * Convert a Pad.
 *
 * @param pad - The parsed Pad object
 * @param sketchFeatureId - The FeatureId of the converted profile sketch
 * @param wireEntityIds - The entity IDs that form the wire boundary
 * @param operation - 'newBody' for the first Pad in a body, 'join' otherwise
 * @param createdAt - ISO timestamp for the feature
 */
export function convertPad(
  pad: FcPadObject,
  sketchFeatureId: FeatureId,
  wireEntityIds: EntityId[],
  operation: 'newBody' | 'join',
  createdAt: string,
): ExtrudeConversionResult {
  return buildExtrudeFeature({
    label: pad.label ?? pad.name,
    sketchFeatureId,
    wireEntityIds,
    operation,
    length: pad.length,
    reversed: pad.reversed,
    midplane: pad.midplane,
    fcType: pad.padType,
    createdAt,
  });
}

/** Convert a Pocket — always operation: 'cut'. */
export function convertPocket(
  pocket: FcPocketObject,
  sketchFeatureId: FeatureId,
  wireEntityIds: EntityId[],
  createdAt: string,
): ExtrudeConversionResult {
  return buildExtrudeFeature({
    label: pocket.label ?? pocket.name,
    sketchFeatureId,
    wireEntityIds,
    operation: 'cut',
    length: pocket.length,
    reversed: pocket.reversed,
    midplane: pocket.midplane,
    fcType: pocket.pocketType,
    createdAt,
  });
}

type BuildArgs = {
  label: string;
  sketchFeatureId: FeatureId;
  wireEntityIds: EntityId[];
  operation: 'newBody' | 'join' | 'cut';
  length: number;
  reversed: boolean;
  midplane: boolean;
  fcType: number;
  createdAt: string;
};

function buildExtrudeFeature(args: BuildArgs): ExtrudeConversionResult {
  const direction: DirectionSpec = args.reversed ? { type: 'reversed' } : { type: 'normal' };

  let extent: ExtentSpec;
  let warning: string | undefined;

  if (args.midplane) {
    extent = { type: 'symmetric', value: String(args.length) };
  } else {
    switch (args.fcType) {
      case 0: // Dimension / Length
        extent = { type: 'distance', value: String(args.length) };
        break;
      case 1: // UpToLast
      case 2: // UpToFirst
      case 3: // UpToFace
      case 5: // UpToShape
        // No equivalent ExtentSpec yet — fall back to the recorded numeric
        // length so the imported geometry is at least plausible, and warn.
        extent = { type: 'distance', value: String(args.length) };
        warning = `Extrude Type=${args.fcType} (Up-To-*) not supported yet; imported as distance ${args.length}`;
        break;
      case 4: // TwoLengths (deprecated by FreeCAD #21794)
        extent = { type: 'distance', value: String(args.length) };
        warning = `Extrude Type=4 (TwoLengths) not supported; only Length side used`;
        break;
      default:
        extent = { type: 'distance', value: String(args.length) };
        warning = `Unknown extrude Type=${args.fcType}; falling back to distance ${args.length}`;
        break;
    }
  }

  const profile: ProfileRef = {
    sketchId: args.sketchFeatureId,
    wireEntityIds: args.wireEntityIds,
  };

  const inputs: ExtrudeFeatureInputs = {
    profiles: [profile],
    operation: args.operation,
    direction,
    extent,
  };

  const fid = featureId(generateId('feat'));
  const feature: FeatureNode = {
    id: fid,
    type: 'extrude',
    name: args.label,
    version: 1,
    enabled: true,
    visible: true,
    inputs: inputs as unknown as Record<string, unknown>,
    dependsOn: [args.sketchFeatureId],
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  };

  return { feature, unsupportedTypeWarning: warning };
}
