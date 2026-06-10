/**
 * Zod schemas for .cadjson validation.
 * Every document type has a corresponding Zod schema for runtime validation.
 */

import { z } from 'zod';

// --- Primitives ---

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
const QuaternionSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const ExpressionSchema = z.string();
const ExpressionPairSchema = z.tuple([z.string(), z.string()]);

const Transform3DSchema = z.object({
  position: Vec3Schema,
  rotation: QuaternionSchema,
});

// --- Parameter ---

const ParameterUnitSchema = z.union([
  z.literal('mm'),
  z.literal('deg'),
  z.literal('count'),
  z.literal('none'),
]);

const ParameterValueSchema = z.object({
  name: z.string(),
  expression: ExpressionSchema,
  unit: ParameterUnitSchema,
  public: z.boolean().optional(),
  description: z.string().optional(),
  kind: z.union([z.literal('number'), z.literal('choice')]).optional(),
  options: z.array(z.string()).optional(),
});

const ParameterTableSchema = z.object({
  values: z.record(z.string(), ParameterValueSchema),
});

// --- References ---

const PlaneRefSchema: z.ZodType = z.discriminatedUnion('type', [
  z.object({ type: z.literal('defaultPlane'), name: z.union([z.literal('XY'), z.literal('YZ'), z.literal('XZ')]) }),
  z.object({ type: z.literal('constructionPlane'), planeId: z.string() }),
  z.object({ type: z.literal('featureOutput'), featureId: z.string(), output: z.string() }),
  z.object({
    type: z.literal('stableTopology'),
    bodyRef: z.object({ partId: z.string(), bodyId: z.string() }),
    stableFaceId: z.string(),
    repairHint: z.object({
      geometrySignature: z.string().optional(),
      centroid: Vec3Schema.optional(),
      normal: Vec3Schema.optional(),
      area: z.number().optional(),
    }).optional(),
  }),
]);

const DirectionSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('normal') }),
  z.object({ type: z.literal('reversed') }),
  z.object({ type: z.literal('custom'), vector: Vec3Schema }),
]);

const ExtentSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('distance'), value: ExpressionSchema }),
  z.object({ type: z.literal('throughAll') }),
  z.object({ type: z.literal('toPlane'), plane: PlaneRefSchema }),
  z.object({ type: z.literal('symmetric'), value: ExpressionSchema }),
]);

const ProfileRefSchema = z.object({
  sketchId: z.string(),
  wireEntityIds: z.array(z.string()),
  interiorPoint: z.tuple([z.number(), z.number()]).optional(),
});

// --- Sketch Entities ---
//
// `rectangle` / `slot` composite schemas were dropped during the
// sketch-commands unification. Per invariant
// #11 ("there is no rectangle"), every sketch shape is curves + constraints
// — the in-editor drawRectangle / drawSlot primitives emit 4 lines or 2
// lines + 2 arcs decompositions directly, and the serializer no longer
// collapses them back. Only true primitive curves remain.

const SketchCircleSchema = z.object({
  id: z.string(),
  type: z.literal('circle'),
  center: ExpressionPairSchema,
  diameter: ExpressionSchema,
  construction: z.boolean().optional(),
});

const SketchLineSchema = z.object({
  id: z.string(),
  type: z.literal('line'),
  start: ExpressionPairSchema,
  end: ExpressionPairSchema,
  construction: z.boolean().optional(),
});

const SketchArcSchema = z.object({
  id: z.string(),
  type: z.literal('arc'),
  center: ExpressionPairSchema,
  radius: ExpressionSchema,
  startAngle: ExpressionSchema,
  endAngle: ExpressionSchema,
  construction: z.boolean().optional(),
});

const SketchEllipseSchema = z.object({
  id: z.string(),
  type: z.literal('ellipse'),
  center: ExpressionPairSchema,
  majorEnd: ExpressionPairSchema,
  minorRadius: ExpressionSchema,
  construction: z.boolean().optional(),
});

const SketchSplineSchema = z.object({
  id: z.string(),
  type: z.literal('spline'),
  points: z.array(ExpressionPairSchema).min(2),
  construction: z.boolean().optional(),
});

const SketchBezierSchema = z.object({
  id: z.string(),
  type: z.literal('bezier'),
  start: ExpressionPairSchema,
  cp1: ExpressionPairSchema,
  cp2: ExpressionPairSchema,
  end: ExpressionPairSchema,
  construction: z.boolean().optional(),
});

const SketchPointEntitySchema = z.object({
  id: z.string(),
  type: z.literal('point'),
  at: ExpressionPairSchema,
  construction: z.boolean().optional(),
});

const SketchEntitySchema = z.discriminatedUnion('type', [
  SketchCircleSchema,
  SketchLineSchema,
  SketchArcSchema,
  SketchEllipseSchema,
  SketchSplineSchema,
  SketchBezierSchema,
  SketchPointEntitySchema,
]);

// --- Feature Inputs ---

const SketchFeatureInputsSchema = z.object({
  plane: PlaneRefSchema,
  buildGeometry: z.record(z.string(), SketchEntitySchema),
  entityOrder: z.array(z.string()).optional(),
  // The editing source of truth — opaque to validation since the editor
  // owns its shape. Its `constraints` array is the LIVE constraint store
  // the solver uses. Required: every sketch carries its editor model.
  editorModel: z.object({
    points: z.array(z.unknown()),
    geometries: z.array(z.unknown()),
    constraints: z.array(z.unknown()),
  }),
});

const ExtrudeFeatureInputsSchema = z.object({
  profiles: z.array(ProfileRefSchema),
  operation: z.union([z.literal('newBody'), z.literal('join'), z.literal('cut')]),
  direction: DirectionSpecSchema,
  extent: ExtentSpecSchema,
  targetBodies: z.array(z.object({ partId: z.string(), bodyId: z.string() })).optional(),
});

const FaceRefSchema: z.ZodType = z.discriminatedUnion('type', [
  z.object({ type: z.literal('defaultPlane'), name: z.union([z.literal('XY'), z.literal('YZ'), z.literal('XZ')]) }),
  z.object({ type: z.literal('constructionPlane'), planeId: z.string() }),
  z.object({ type: z.literal('featureOutput'), featureId: z.string(), output: z.string() }),
  z.object({
    type: z.literal('stableTopology'),
    bodyRef: z.object({ partId: z.string(), bodyId: z.string() }),
    stableFaceId: z.string(),
    repairHint: z.object({
      geometrySignature: z.string().optional(),
      centroid: Vec3Schema.optional(),
      normal: Vec3Schema.optional(),
      area: z.number().optional(),
    }).optional(),
  }),
]);

const ConstructionPlaneFeatureInputsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('offsetFromPlane'),
    basePlane: PlaneRefSchema,
    offset: ExpressionSchema,
  }),
  z.object({
    kind: z.literal('offsetFromFace'),
    face: FaceRefSchema,
    offset: ExpressionSchema,
  }),
]);

/**
 * Edge ref schema reused by Fillet + Chamfer. Mirrors `EdgeRef` in
 * schema.ts — only the `stableTopology` variant carries the
 * cross-rebuild identity needed by these features; the others are
 * reserved for future symmetry with construction-edge constructs.
 */
const EdgeRefSchema: z.ZodType = z.discriminatedUnion('type', [
  z.object({ type: z.literal('featureOutput'), featureId: z.string(), output: z.string() }),
  z.object({
    type: z.literal('stableTopology'),
    bodyRef: z.object({ partId: z.string(), bodyId: z.string() }),
    stableEdgeId: z.string(),
    repairHint: z.object({
      geometrySignature: z.string().optional(),
      centroid: Vec3Schema.optional(),
      normal: Vec3Schema.optional(),
      area: z.number().optional(),
    }).optional(),
  }),
]);

const ChamferFeatureInputsSchema = z.object({
  edges: z.array(EdgeRefSchema).min(1),
  distance: ExpressionSchema,
  targetBody: z.object({ partId: z.string(), bodyId: z.string() }).optional(),
});

/**
 * AxisSpec schema. Used by pattern features for direction (linear) or
 * rotation axis (circular). Mirrors `AxisSpec` in schema.ts.
 */
const AxisSpecSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('x') }),
  z.object({ type: z.literal('y') }),
  z.object({ type: z.literal('z') }),
  z.object({ type: z.literal('custom'), origin: Vec3Schema, direction: Vec3Schema }),
]);

/**
 * ImportedGeometry schema. The base64-encoded `data` is held as a
 * plain string — we don't try to round-trip-validate the bytes (they
 * can be arbitrarily large STEP/STL/BREP content). `format` is the
 * discriminator the builder uses to pick the right kernel call.
 */
const ImportedGeometryFeatureInputsSchema = z.object({
  fileName: z.string().min(1),
  format: z.union([z.literal('step'), z.literal('stl'), z.literal('brep')]),
  data: z.string().min(1),
});

/**
 * ImportedComponent feature inputs schema. `componentRef` is the
 * hash key into `project.embeddedComponents`; the builder fails the
 * feature if that key is missing at rebuild time (no schema-level
 * cross-validation since Zod can't see the project root from here).
 */
const ImportedComponentFeatureInputsSchema = z.object({
  componentRef: z.string().min(1),
  transform: Transform3DSchema,
  parameterOverrides: z.record(z.string(), ExpressionSchema),
  configurationId: z.union([z.string(), z.null()]).optional(),
  boolean: z.union([z.literal('newBody'), z.literal('cut'), z.literal('join')]),
});

/**
 * Sweep schema. Profile + path are both `ProfileRef`s (closed sketch
 * regions in v1). `operation` is locked to `'newBody'` for v1; the
 * union exists so adding `'join'` / `'cut'` later is just a schema
 * edit, no code-shape change.
 */
const SweepFeatureInputsSchema = z.object({
  profile: ProfileRefSchema,
  path: ProfileRefSchema,
  operation: z.literal('newBody'),
  targetBodies: z.array(z.object({ partId: z.string(), bodyId: z.string() })).optional(),
});

/**
 * Linear pattern (rectangular array) schema. Body-level v1; the
 * builder rejects feature-mode requests via a missing `sourceBody`.
 */
const LinearPatternInputsSchema = z.object({
  patternType: z.literal('linear'),
  sourceBody: z.object({ partId: z.string(), bodyId: z.string() }),
  direction: AxisSpecSchema,
  count: ExpressionSchema,
  spacing: ExpressionSchema,
});

/**
 * Circular pattern (polar array) schema.
 */
const CircularPatternInputsSchema = z.object({
  patternType: z.literal('circular'),
  sourceBody: z.object({ partId: z.string(), bodyId: z.string() }),
  axis: AxisSpecSchema,
  count: ExpressionSchema,
  fullAngle: ExpressionSchema.optional(),
});

/**
 * Pattern feature inputs discriminated by `patternType`. The
 * `FeatureType` lookup is `'linearPattern'` or `'circularPattern'`
 * (the patternType field discriminates the inputs payload, the
 * FeatureType discriminates the feature node itself).
 */
const PatternFeatureInputsSchema = z.discriminatedUnion('patternType', [
  LinearPatternInputsSchema,
  CircularPatternInputsSchema,
]);

/**
 * Shell schema. `removedFaces` must contain at least one FaceRef and
 * each must reference the same body as `sourceBody` (the builder
 * enforces the cross-field constraint). `thickness` is a positive
 * expression evaluated at build time; the builder negates before
 * calling OCCT so the wall grows inward.
 */
const ShellFeatureInputsSchema = z.object({
  sourceBody: z.object({ partId: z.string(), bodyId: z.string() }),
  removedFaces: z.array(FaceRefSchema).min(1),
  thickness: ExpressionSchema,
  tolerance: z.number().optional(),
});

/**
 * Mirror Body schema. `plane` accepts the same PlaneRef variants the
 * resolver supports (default planes, construction planes, etc.). v1
 * uses single-source `sourceBody`; `targetBodies` is reserved for the
 * eventual multi-body case and ignored by the builder today.
 */
const MirrorFeatureInputsSchema = z.object({
  sourceBody: z.object({ partId: z.string(), bodyId: z.string() }),
  plane: PlaneRefSchema,
  operation: z.union([z.literal('newBody'), z.literal('join')]),
  targetBodies: z.array(z.object({ partId: z.string(), bodyId: z.string() })).optional(),
});

const HoleFeatureInputsSchema = z.object({
  // The hole is anchored to a face, not a plane — the FaceRef's
  // stableTopology variant carries the bodyId so the builder knows what
  // to cut from. Earlier this used PlaneRefSchema which compiled but
  // would have rejected any real document at parse time. The matching
  // TS type in `schema.ts` has always been `FaceRef`.
  face: FaceRefSchema,
  // Sketch-local 2D offset of the hole center in the face's (u, v)
  // basis. v1 always passes [0, 0] (auto-center on the face's surface
  // centroid); the field exists for the eventual click-to-position UX.
  center: ExpressionPairSchema,
  direction: DirectionSpecSchema,
  diameter: ExpressionSchema,
  extent: ExtentSpecSchema,
  kind: z.union([z.literal('simple'), z.literal('counterbore'), z.literal('countersink')]),
  // Counterbore / countersink shape parameters. Each is required when
  // `kind` matches; for `kind === 'simple'` they're ignored. We keep
  // them at the top level (rather than a discriminated union per kind)
  // so the dialog can preserve user-entered values when the user toggles
  // the kind dropdown.
  counterboreDiameter: ExpressionSchema.optional(),
  counterboreDepth: ExpressionSchema.optional(),
  countersinkDiameter: ExpressionSchema.optional(),
  countersinkAngle: ExpressionSchema.optional(),
  targetBodies: z.array(z.object({ partId: z.string(), bodyId: z.string() })).optional(),
});

// --- Feature Node ---

const FeatureTypeSchema = z.union([
  z.literal('sketch'),
  z.literal('extrude'),
  z.literal('revolve'),
  z.literal('loft'),
  z.literal('hole'),
  z.literal('shell'),
  z.literal('sweep'),
  z.literal('linearPattern'),
  z.literal('circularPattern'),
  z.literal('fillet'),
  z.literal('chamfer'),
  z.literal('mirror'),
  z.literal('componentInstance'),
  z.literal('importedComponent'),
  z.literal('constructionPlane'),
  z.literal('importedGeometry'),
]);

const FeatureNodeSchema = z.object({
  id: z.string(),
  type: FeatureTypeSchema,
  name: z.string(),
  version: z.number(),
  enabled: z.boolean(),
  visible: z.boolean().default(true),
  inputs: z.record(z.string(), z.unknown()),
  dependsOn: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// --- Part ---

const DefaultPlaneSetSchema = z.object({
  XY: PlaneRefSchema,
  XZ: PlaneRefSchema,
  YZ: PlaneRefSchema,
});

const ConfigurationRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  overrides: z.record(z.string(), ExpressionSchema),
});

const ConfigurationTableSchema = z.object({
  active: z.union([z.string(), z.null()]),
  rows: z.array(ConfigurationRowSchema),
});

const CadPartSchema = z.object({
  id: z.string(),
  name: z.string(),
  transform: Transform3DSchema,
  parameters: ParameterTableSchema,
  timeline: z.array(FeatureNodeSchema),
  defaultPlanes: DefaultPlaneSetSchema,
  configurations: ConfigurationTableSchema.optional(),
});

// --- Project Metadata ---

const ProjectMetadataSchema = z.object({
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  appVersion: z.string(),
});

// --- Top-Level Project ---

export const CadProjectSchema = z.object({
  schemaVersion: z.union([z.literal('0.1'), z.literal('0.2')]),
  units: z.union([z.literal('mm'), z.literal('inch')]),
  metadata: ProjectMetadataSchema,
  parameters: ParameterTableSchema,
  parts: z.record(z.string(), CadPartSchema),
  references: z.record(z.string(), z.unknown()),
  assemblies: z.record(z.string(), z.unknown()),
  embeddedComponents: z.record(z.string(), z.unknown()).optional(),
});

// --- Export all schemas ---

export {
  ParameterTableSchema,
  ParameterValueSchema,
  FeatureNodeSchema,
  FeatureTypeSchema,
  CadPartSchema,
  PlaneRefSchema,
  DirectionSpecSchema,
  ExtentSpecSchema,
  ProfileRefSchema,
  SketchEntitySchema,
  SketchFeatureInputsSchema,
  ExtrudeFeatureInputsSchema,
  HoleFeatureInputsSchema,
  ChamferFeatureInputsSchema,
  MirrorFeatureInputsSchema,
  ShellFeatureInputsSchema,
  SweepFeatureInputsSchema,
  ImportedGeometryFeatureInputsSchema,
  ImportedComponentFeatureInputsSchema,
  PatternFeatureInputsSchema,
  LinearPatternInputsSchema,
  CircularPatternInputsSchema,
  AxisSpecSchema,
  ConstructionPlaneFeatureInputsSchema,
  Transform3DSchema,
};
