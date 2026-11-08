export * from './facts';
export * from './names';
export { NamedState, type NamedEntity } from './state';
export {
  startFeature,
  compareCreation,
  NamingPause,
  type FeatureNamer,
  type FeatureContext,
  type DividerTest,
} from './namer';
export {
  resolve,
  writeRecord,
  containsInOrder,
  type EntityRecord,
  type RecordBranchEntry,
  type Resolution,
  type ResolveOptions,
} from './resolve';
export {
  describeEdge,
  describeEntity,
  describeFace,
  describeFaces,
  describeVertex,
  describeWire,
  diagonal,
  loadTolerance,
  matchesDescription,
  matchesSnapshot,
  partSize,
  tightMatcher,
  tightTolerance,
  writeEdge,
  type CurveDescription,
  type Description,
  type EdgeDescription,
  type FaceDescription,
  type SurfaceDescription,
  type Tolerance,
} from './snapshot';
export {
  checkShapeMap,
  readShapeMap,
  writeShapeMap,
  type CaptureChain,
  type LoadedEntity,
  type LoadedMap,
  type ShapeMapEntry,
  type ShapeMapJson,
  type ShapeMapMismatch,
} from './shapeMap';
