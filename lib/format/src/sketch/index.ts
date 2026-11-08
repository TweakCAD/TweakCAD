export type {
  CrossingSense,
  CurveAnchors,
  CurveKey,
  CurveShape,
  Loop,
  RegionFields,
  RegionOrigin,
  RegionRow,
  RegionTable,
  RetiredFate,
  RetiredRow,
  SolvedCurve,
  SolvedSketch,
  Use,
  UseEnd,
  Vec2,
} from './types';
export { regionTolerance } from './arrangement';
export { detectRegions, canonicalStart, cyclePolyline, type DetectedRegion, type Detection } from './detect';
export { matchRegions, type RegionMatching, type RegionPiece, type SideSign } from './match';
export { regionSamplePoint } from './sides';
export { resolveRegion, writePickedRegion, writeRegionFates, type FateOptions } from './fates';
export { bezierShape, conicShape, splineShape } from './equivalents';
export { prepareCurve, type Curve } from './curves';
export { contactsBetween, type Contact } from './intersect';
