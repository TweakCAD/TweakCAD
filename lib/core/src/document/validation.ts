/**
 * Zod schemas for .cadjson validation.
 * Every document type has a corresponding Zod schema for runtime validation.
 */

import { z } from 'zod';
import type { FeatureType as FeatureTypeName } from './schema.ts';

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

// --- Sketch editor model ---
//
// `editorModel` is the sketch's source of truth — the point-based form the
// editor manipulates and the solver reads, with `buildGeometry` derived from
// it. It was `z.array(z.unknown())` three times over, which meant the most
// intricate structure in the document was the one part validation could not
// see. A malformed constraint reached planegcs instead of being rejected at
// the door.

const EditorPointSchema = z.object({
  id: z.string(),
  x: z.number().finite(),
  y: z.number().finite(),
  fixed: z.boolean(),
});

const EditorGeometrySchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('line'), startId: z.string(), endId: z.string(), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('circle'), centerId: z.string(), radius: z.number().finite(), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('arc'), centerId: z.string(), startId: z.string(), endId: z.string(), radius: z.number().finite(), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('ellipse'), centerId: z.string(), majorId: z.string(), minorRadius: z.number().finite(), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('spline'), pointIds: z.array(z.string()), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('bezier'), startId: z.string(), cp1Id: z.string(), cp2Id: z.string(), endId: z.string(), construction: z.boolean() }),
  z.object({ id: z.string(), type: z.literal('point'), pointId: z.string(), construction: z.boolean() }),
]);

/** Dimensional constraints carry `driven`: false drives geometry, true just reports. */
/** Dimensional constraints carry `driven` and an optional parameter
 *  `expression` that drives the value at build time. */
const driven = {
  driven: z.boolean().optional(),
  expression: z.string().optional(),
};
const cid = { id: z.string() };

const EditorConstraintSchema = z.discriminatedUnion('type', [
  z.object({ ...cid, type: z.literal('coincident'), pointA: z.string(), pointB: z.string() }),
  z.object({ ...cid, type: z.literal('horizontal'), geometryId: z.string() }),
  z.object({ ...cid, type: z.literal('vertical'), geometryId: z.string() }),
  z.object({ ...cid, type: z.literal('fixed'), pointId: z.string(), x: z.number().finite(), y: z.number().finite() }),
  z.object({ ...cid, type: z.literal('distance'), pointA: z.string(), pointB: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('distanceX'), pointA: z.string(), pointB: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('distanceY'), pointA: z.string(), pointB: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('radius'), geometryId: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('length'), geometryId: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('parallel'), geometryA: z.string(), geometryB: z.string() }),
  z.object({ ...cid, type: z.literal('perpendicular'), geometryA: z.string(), geometryB: z.string() }),
  z.object({ ...cid, type: z.literal('angle'), geometryA: z.string(), geometryB: z.string(), value: z.number().finite(), ...driven }),
  z.object({ ...cid, type: z.literal('tangent'), lineId: z.string().optional(), circleId: z.string(), secondCircleId: z.string().optional(), internal: z.boolean().optional() }),
  z.object({ ...cid, type: z.literal('pointOnLine'), pointId: z.string(), geometryId: z.string() }),
  z.object({ ...cid, type: z.literal('pointOnCircle'), pointId: z.string(), geometryId: z.string() }),
  z.object({ ...cid, type: z.literal('symmetric'), pointA: z.string(), pointB: z.string(), geometryId: z.string() }),
  z.object({ ...cid, type: z.literal('equal'), geometryA: z.string(), geometryB: z.string() }),
  z.object({ ...cid, type: z.literal('concentric'), geometryA: z.string(), geometryB: z.string() }),
  z.object({ ...cid, type: z.literal('midpoint'), pointId: z.string(), geometryId: z.string() }),
]);

const SketchEditorSnapshotSchema = z.object({
  points: z.array(EditorPointSchema),
  geometries: z.array(EditorGeometrySchema),
  constraints: z.array(EditorConstraintSchema),
});

const SketchFeatureInputsSchema = z.object({
  plane: PlaneRefSchema,
  // No `buildGeometry`: derived from `editorModel`, not stored. Validating
  // a derived projection would only let a document claim one inconsistent
  // with its source.
  /** The editing source of truth; `buildGeometry` above is derived from it. */
  editorModel: SketchEditorSnapshotSchema,
});

const BodyRefSchema = z.object({ partId: z.string(), bodyId: z.string() });

const BooleanOperationSchema = z.union([
  z.literal('newBody'),
  z.literal('join'),
  z.literal('cut'),
]);

const ExtrudeFeatureInputsSchema = z.object({
  profiles: z.array(ProfileRefSchema),
  operation: BooleanOperationSchema,
  direction: DirectionSpecSchema,
  extent: ExtentSpecSchema,
  startOffset: ExpressionSchema.optional(),
  targetBodies: z.array(BodyRefSchema).optional(),
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
  targetBody: BodyRefSchema.optional(),
});

/**
 * AxisSpec schema. Used by pattern and revolve features for direction
 * (linear) or rotation axis (circular). Mirrors `AxisSpec` in schema.ts.
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
const Transform3DSchemaRef = z.object({
  position: Vec3Schema,
  rotation: QuaternionSchema,
});

/**
 * Imported bytes: embedded, or referenced out of the document.
 *
 * A discriminated union from the start — adding the discriminator to a bare
 * string later is the breaking part, while the size threshold and the `ref`
 * resolver are both additive.
 */
const ImportedGeometryDataSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline'),
    base64: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('ref'),
    referenceId: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  }),
]);

const ImportedGeometryFeatureInputsSchema = z.object({
  fileName: z.string().min(1),
  format: z.union([z.literal('step'), z.literal('stl'), z.literal('brep')]),
  data: ImportedGeometryDataSchema,
  /** Group placement for the whole import. */
  transform: Transform3DSchemaRef.optional(),
  /** Per-body placement, keyed by the body's index in the imported set. */
  bodyTransforms: z.record(z.string(), Transform3DSchemaRef).optional(),
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

/**
 * Primitive dimensions, discriminated on `shape.kind`. Positivity is not
 * checked here — the fields are `Expression`s, so `"wallThickness * 2"` is a
 * legal value and its sign is only known once parameters resolve. The builder
 * rejects non-positive results, where the number actually exists.
 */
const PrimitiveShapeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('box'),
    width: ExpressionSchema,
    height: ExpressionSchema,
    depth: ExpressionSchema,
  }),
  z.object({
    kind: z.literal('cylinder'),
    radius: ExpressionSchema,
    height: ExpressionSchema,
  }),
  z.object({
    kind: z.literal('sphere'),
    radius: ExpressionSchema,
  }),
  z.object({
    kind: z.literal('cone'),
    bottomRadius: ExpressionSchema,
    topRadius: ExpressionSchema,
    height: ExpressionSchema,
  }),
  z.object({
    kind: z.literal('torus'),
    majorRadius: ExpressionSchema,
    minorRadius: ExpressionSchema,
  }),
]);

const PrimitiveFeatureInputsSchema = z.object({
  shape: PrimitiveShapeSchema,
  transform: Transform3DSchema,
  operation: BooleanOperationSchema,
  targetBodies: z.array(BodyRefSchema).optional(),
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


/** Mirrors ChamferFeatureInputsSchema field-for-field; `radius` not `distance`. */
const FilletFeatureInputsSchema = z.object({
  edges: z.array(EdgeRefSchema).min(1),
  radius: ExpressionSchema,
  targetBody: BodyRefSchema.optional(),
});

const RevolveFeatureInputsSchema = z.object({
  profile: ProfileRefSchema,
  axis: AxisSpecSchema,
  angle: ExpressionSchema,
  operation: BooleanOperationSchema,
  startOffset: ExpressionSchema.optional(),
  targetBodies: z.array(BodyRefSchema).optional(),
});

/**
 * Loft takes 2..16 ordered sections. The bound is the builder's, restated
 * here so a malformed file is rejected at the door rather than reaching the
 * kernel — one profile cannot describe a loft, and the upper limit keeps a
 * corrupt or hostile file from handing OCCT an unbounded section list.
 */
const LoftFeatureInputsSchema = z.object({
  profiles: z.array(ProfileRefSchema).min(2).max(16),
  operation: BooleanOperationSchema,
  ruled: z.boolean().optional(),
  closed: z.boolean().optional(),
  targetBodies: z.array(BodyRefSchema).optional(),
});

/**
 * A component linked from the SaaS catalog, as opposed to `importedComponent`
 * which embeds its source. `parameters` stays `unknown` per value: the
 * component's own manifest defines them, and this document cannot see it.
 */
const ComponentInstanceFeatureInputsSchema = z.object({
  componentProjectId: z.string().min(1),
  componentSlug: z.string().min(1),
  componentName: z.string(),
  manifestVersion: z.number(),
  parameters: z.record(z.string(), z.unknown()),
  boolean: BooleanOperationSchema.optional(),
  placement: z
    .object({
      plane: PlaneRefSchema.optional(),
      offset: Vec3Schema.optional(),
    })
    .optional(),
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
  z.literal('primitive'),
]);

/**
 * Which schema validates a given feature's `inputs`.
 *
 * `inputs` used to be `z.record(z.unknown())`, so a feature could carry
 * anything at all and still pass. That is why six component fixtures using a
 * retired sketch shape validated cleanly while being unbuildable — the
 * loader said yes and the worker then threw. Keyed by `type` so adding a
 * FeatureType without a schema is a compile error, not a silent hole.
 */
const FEATURE_INPUT_SCHEMAS: Record<FeatureTypeName, z.ZodTypeAny> = {
  sketch: SketchFeatureInputsSchema,
  extrude: ExtrudeFeatureInputsSchema,
  revolve: RevolveFeatureInputsSchema,
  loft: LoftFeatureInputsSchema,
  hole: HoleFeatureInputsSchema,
  shell: ShellFeatureInputsSchema,
  sweep: SweepFeatureInputsSchema,
  linearPattern: LinearPatternInputsSchema,
  circularPattern: CircularPatternInputsSchema,
  fillet: FilletFeatureInputsSchema,
  chamfer: ChamferFeatureInputsSchema,
  mirror: MirrorFeatureInputsSchema,
  componentInstance: ComponentInstanceFeatureInputsSchema,
  importedComponent: ImportedComponentFeatureInputsSchema,
  constructionPlane: ConstructionPlaneFeatureInputsSchema,
  importedGeometry: ImportedGeometryFeatureInputsSchema,
  primitive: PrimitiveFeatureInputsSchema,
};

/** The envelope every feature shares, regardless of type. */
const FeatureNodeEnvelopeSchema = z.object({
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

/**
 * A feature validated envelope-first, then `inputs` against the schema its
 * `type` selects.
 *
 * Split in two deliberately. A document can legitimately contain a feature
 * this build does not know — written by a newer client, or by a plugin — and
 * the right response is to keep it and mark it unsupported, not to reject the
 * whole file. `loadCadDocument` needs to tell "the envelope is broken" (fatal)
 * apart from "the inputs are wrong for this type" (degrade this one feature),
 * and a single schema cannot express that difference.
 *
 * So this schema is strict, and the loader is what decides how to react.
 */
const FeatureNodeSchema = FeatureNodeEnvelopeSchema.superRefine((node, ctx) => {
  const schema = FEATURE_INPUT_SCHEMAS[node.type as FeatureTypeName];
  if (!schema) return; // unknown type — the loader handles it, not Zod
  const result = schema.safeParse(node.inputs);
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({
      code: 'custom',
      path: ['inputs', ...issue.path],
      message: issue.message,
    });
  }
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
  parameters: ParameterTableSchema,
  timeline: z.array(FeatureNodeSchema),
  defaultPlanes: DefaultPlaneSetSchema,
  configurations: ConfigurationTableSchema.optional(),
});

// --- Assemblies ---
//
// Validated for real rather than left as `z.unknown()`: the app writes `{}`
// today, so the only documents that could carry instances are hand-authored
// or from a future version, and those are exactly the ones worth rejecting
// early rather than letting a malformed tree reach a builder.

const AssemblyInstanceSchema = z.object({
  instanceId: z.string(),
  of: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('part'), partId: z.string() }),
    z.object({ kind: z.literal('assembly'), assemblyId: z.string() }),
  ]),
  transform: Transform3DSchema,
});

const CadAssemblySchema = z.object({
  id: z.string(),
  name: z.string(),
  root: z.boolean(),
  instances: z.array(AssemblyInstanceSchema),
});

// --- References ---
//
// Validated for real rather than left as `z.unknown()`. Nothing populates
// this map today, so any document that does carry entries is hand-authored
// or from a future build — exactly the ones worth checking at the door,
// since a malformed asset otherwise surfaces as an import that silently
// produces no geometry.

const ReferenceAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.union([z.literal('step'), z.literal('stl'), z.literal('brep')]),
  sizeBytes: z.number().int().nonnegative(),
  hash: z.string().min(1),
  /** Absent when the bytes live outside whatever produced this document. */
  bytes: z.string().optional(),
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
  schemaVersion: z.number().int().positive(),
  metadata: ProjectMetadataSchema,
  parameters: ParameterTableSchema,
  parts: z.record(z.string(), CadPartSchema),
  references: z.record(z.string(), ReferenceAssetSchema),
  assemblies: z.record(z.string(), CadAssemblySchema),
  embeddedComponents: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The project without its timeline contents — same shape, but each feature is
 * `unknown`.
 *
 * `loadCadDocument` validates in two passes so one bad feature cannot cost the
 * user the rest of the document. This pass answers "is this a CAD file at
 * all?"; the loader then validates features one at a time and degrades the
 * ones that fail. Using `CadProjectSchema` for both would collapse that
 * distinction into a single yes/no.
 */
const CadPartEnvelopeSchema = CadPartSchema.extend({
  timeline: z.array(z.unknown()),
});

export const CadProjectEnvelopeSchema = CadProjectSchema.extend({
  parts: z.record(z.string(), CadPartEnvelopeSchema),
});

// --- Export all schemas ---

export {
  ParameterTableSchema,
  ParameterValueSchema,
  FeatureNodeSchema,
  FeatureTypeSchema,
  CadPartSchema,
  CadAssemblySchema,
  AssemblyInstanceSchema,
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
