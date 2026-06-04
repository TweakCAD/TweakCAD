/**
 * TypeScript types for the subset of the FreeCAD .fcstd Document.xml schema
 * that the importer touches. Mirrors the geometry, constraint and feature
 * representations the importer reads.
 *
 * These types are intentionally lossy: properties we don't import (mesh
 * shapes, expression engines, attachment offsets) are kept as raw strings on
 * `properties` rather than getting their own typed slots.
 */

/** Default planes baked into every PartDesign::Body. */
export type FcDefaultPlane = 'XY_Plane' | 'XZ_Plane' | 'YZ_Plane';

/** Top-level entry in <Objects>: type + name only. */
export type FcObjectHeader = {
  type: string;
  name: string;
};

/**
 * Per-object data parsed from <ObjectData>. The raw property bag is kept
 * as a name→string map for unknown property types; structured properties
 * are surfaced as typed fields on subtypes below.
 */
export type FcObject =
  | FcSketchObject
  | FcPadObject
  | FcPocketObject
  | FcBodyObject
  | FcGenericObject;

export type FcObjectCommon = {
  name: string;
  /** Raw FreeCAD object type, e.g. "Sketcher::SketchObject", "PartDesign::Pad". */
  type: string;
  label: string | undefined;
  /** Raw scalar property values keyed by property name (e.g. "Length" → "20.000000000000"). */
  properties: Record<string, string>;
};

export type FcBodyObject = FcObjectCommon & {
  kind: 'body';
  groupLinks: string[];
  tip: string | undefined;
};

export type FcSketchObject = FcObjectCommon & {
  kind: 'sketch';
  geometry: FcGeometry[];
  constraints: FcConstraint[];
  /** First <Support> link target if the sketch is attached to a single named plane. */
  supportName: string | undefined;
};

export type FcPadObject = FcObjectCommon & {
  kind: 'pad';
  length: number;
  reversed: boolean;
  midplane: boolean;
  /** FreeCAD Type enum: 0=Dimension, 1=ToLast, 2=ToFirst, 3=ToFace, 4=TwoLengths, 5=ToShape. */
  padType: number;
  profileName: string | undefined;
};

export type FcPocketObject = FcObjectCommon & {
  kind: 'pocket';
  length: number;
  reversed: boolean;
  midplane: boolean;
  pocketType: number;
  profileName: string | undefined;
};

export type FcGenericObject = FcObjectCommon & {
  kind: 'generic';
};

// --- Geometry ---

export type FcGeometry =
  | FcGeomLineSegment
  | FcGeomCircle
  | FcGeomArcOfCircle
  | FcGeomUnsupported;

export type FcGeomLineSegment = {
  kind: 'lineSegment';
  construction: boolean;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type FcGeomCircle = {
  kind: 'circle';
  construction: boolean;
  centerX: number;
  centerY: number;
  radius: number;
};

export type FcGeomArcOfCircle = {
  kind: 'arcOfCircle';
  construction: boolean;
  centerX: number;
  centerY: number;
  radius: number;
  startAngle: number;
  endAngle: number;
};

export type FcGeomUnsupported = {
  kind: 'unsupported';
  construction: boolean;
  /** Raw FreeCAD type, e.g. "Part::GeomEllipse" or "Part::GeomBSplineCurve". */
  rawType: string;
};

// --- Constraints (parsed but not converted in this phase) ---

export type FcConstraint = {
  /** FreeCAD Constraint.h enum value (1=Coincident, 2=Horizontal, …). */
  type: number;
  name: string | undefined;
  value: number;
  first: number;
  firstPos: number;
  second: number;
  secondPos: number;
  third: number;
  thirdPos: number;
};

// --- Parsed document ---

export type FcDocument = {
  schemaVersion: string | undefined;
  programVersion: string | undefined;
  fileVersion: string | undefined;
  /** Ordered list mirroring <Objects>. */
  objectsOrder: FcObjectHeader[];
  /** Lookup of fully-parsed objects keyed by name. */
  objects: Record<string, FcObject>;
};
