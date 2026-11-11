/**
 * Plain decoded data from a `.f3d` design. Lengths are centimetres and angles
 * radians, as in the file; the converter changes them to millimetres and degrees.
 */

import type { BodySource } from './bodyMap';
import type { FaceIndex } from './brep';

/** Row-major 4 × 4 rigid transform. */
export type F3dMatrix = number[];

export type F3dParameter = {
  id: number;
  /** `d12`, or the name a person gave a user parameter. */
  name: string;
  /** Slot it fills in its owner: `Radius`, `Linear Dimension-3`, `AlongDistance`. Localized. */
  role: string;
  expression: string;
  /** Unit text as written: `mm`, `in`, `deg`, or empty. */
  unit: string;
  /** Solved value, in centimetres or radians. */
  value: number;
  isUser: boolean;
  /** The owner record linking this parameter to the dimension or feature it drives. */
  ownerId: number | null;
};

export type F3dPoint = { id: number; x: number; y: number; z: number };

/** Ids a curve keeps through edits: what profile selections name it by. */
export type F3dCurveKey = { primaryId: number; secondaryId: number };

export type F3dLine = F3dCurveKey & {
  kind: 'line';
  id: number;
  startId: number;
  endId: number;
  construction: boolean;
};

export type F3dCircle = F3dCurveKey & {
  kind: 'circle';
  id: number;
  centerId: number;
  radius: number;
  construction: boolean;
};

export type F3dArc = F3dCurveKey & {
  kind: 'arc';
  id: number;
  centerId: number;
  startId: number;
  endId: number;
  /** Positions from the arc's own angles. A file can reference a point that isn't on the arc. */
  center: [number, number];
  start: [number, number];
  end: [number, number];
  radius: number;
  /** True when the arc runs anticlockwise from start to end, seen from the sketch's +Z. */
  counterClockwise: boolean;
  construction: boolean;
};

export type F3dEllipse = F3dCurveKey & {
  kind: 'ellipse';
  id: number;
  centerId: number;
  center: [number, number];
  majorAxis: [number, number];
  minorAxis: [number, number];
  majorRadius: number;
  minorRadius: number;
  startAngle: number;
  endAngle: number;
  construction: boolean;
};

export type F3dSpline = F3dCurveKey & {
  kind: 'spline';
  id: number;
  startId: number;
  endId: number;
  degree: number;
  knots: number[];
  /** Empty, or all 1, unless the curve is rational. */
  weights: number[];
  poles: [number, number][];
  construction: boolean;
};

export type F3dCurve = F3dLine | F3dCircle | F3dArc | F3dEllipse | F3dSpline;

export type F3dRelationKind =
  | 'coincident'
  | 'collinear'
  | 'concentric'
  | 'parallel'
  | 'perpendicular'
  | 'horizontal'
  | 'vertical'
  | 'tangent'
  | 'symmetric'
  | 'equal'
  | 'midpoint';

export type F3dRelation = {
  id: number;
  kind: F3dRelationKind | 'unknown';
  /** Points and curves it binds, in the file's order. */
  loci: number[];
};

export type F3dDimensionKind = 'linear' | 'diameter' | 'radial' | 'angular';

export type F3dDimension = {
  id: number;
  kind: F3dDimensionKind;
  /** Linear only: measured along the sketch's X or Y, or straight between the loci. */
  direction: 'aligned' | 'horizontal' | 'vertical';
  loci: number[];
  parameter: F3dParameter | null;
};

export type F3dSketch = {
  id: number;
  name: string;
  /** Sketch to model, with its component's placement applied. Null when the record reads as identity. */
  placement: F3dMatrix | null;
  componentName: string | null;
  /** The component it is in, or null for the root. */
  componentId: number | null;
  points: Map<number, F3dPoint>;
  curves: F3dCurve[];
  relations: F3dRelation[];
  dimensions: F3dDimension[];
  /** Records of this sketch the reader could not decode, by what they were. */
  skipped: Record<string, number>;
};

export type F3dProfileRegion = {
  /** The curves around the region, by the ids a curve keeps through edits. */
  curves: { primary: number; secondary: number }[];
};

export type F3dProfile = {
  sketchId: number;
  regions: F3dProfileRegion[];
};

export type F3dSketchFeature = { kind: 'sketch'; id: number; sketchId: number };

export type F3dExtrude = {
  kind: 'extrude';
  id: number;
  operation: 'newBody' | 'join' | 'cut' | 'intersect';
  sides: 'one' | 'two' | 'symmetric';
  reversed: boolean;
  /** False for a surface. */
  solid: boolean;
  start: 'plane' | 'offset' | 'face';
  /** Unit vector in model space. */
  vector: [number, number, number];
  profiles: F3dProfile[];
  along: F3dParameter | null;
  against: F3dParameter | null;
  side1Offset: F3dParameter | null;
  side2Offset: F3dParameter | null;
  profileOffset: F3dParameter | null;
  taper: F3dParameter | null;
  side2Taper: F3dParameter | null;
  /** Wall thickness of a thin extrude. */
  wall: F3dParameter | null;
  /** Faces the extrude starts from or runs up to, in that order. */
  faces: F3dFaceName[];
};

export type F3dRevolve = {
  kind: 'revolve';
  id: number;
  operation: 'newBody' | 'join' | 'cut' | 'intersect';
  profiles: F3dProfile[];
  /** Axis in model space, in centimetres: a point and a direction. */
  axis: { origin: [number, number, number]; direction: [number, number, number] } | null;
  angle: F3dParameter | null;
};

/** A face as a recipe names it: by the tags it carried when the feature picked it. */
export type F3dFaceName = { token: string; ops: number[] };

/** An edge: its two faces, then any neighbours the recipe lists. */
export type F3dEdgeRecipe = { faces: F3dFaceName[] };

export type F3dRoundSet = { size: F3dParameter | null; edges: F3dEdgeRecipe[] };

export type F3dFillet = { kind: 'fillet'; id: number; sets: F3dRoundSet[] };

export type F3dChamfer = {
  kind: 'chamfer';
  id: number;
  sets: F3dRoundSet[];
  /** True when the two sides differ, which a single distance can't express. */
  uneven: boolean;
};

/** A body, by the operations in its recipe: the first made it. */
export type F3dBodyOps = { ops: number[] };

export type F3dCombine = {
  kind: 'combine';
  id: number;
  op: 'join' | 'cut' | 'intersect';
  keepTools: boolean;
  newComponent: boolean;
  target: F3dBodyOps;
  tools: F3dBodyOps[];
};

export type F3dRemoveBody = { kind: 'removeBody'; id: number; bodies: F3dBodyOps[] };

export type F3dMove = {
  kind: 'move';
  id: number;
  /** Row-major rigid transform, in centimetres. */
  matrix: F3dMatrix | null;
  bodies: F3dBodyOps[];
};

/** What a mirror or pattern copies. `other` is set when it copies anything but bodies and features. */
export type F3dCopySource = { bodies: F3dBodyOps[]; features: number[]; other: boolean };

/** A stored plane, in centimetres. */
export type F3dPlane = {
  origin: [number, number, number];
  normal: [number, number, number];
  x: [number, number, number];
};

export type F3dMirror = {
  kind: 'mirror';
  id: number;
  of: F3dCopySource;
  /** The origin plane it mirrors in, if it is one. */
  plane: 'xy' | 'xz' | 'yz' | null;
  /** Otherwise the plane it stored, or the face it picked. */
  frame: F3dPlane | null;
  planeFace: F3dFaceName | null;
};

/** A stored line: a point and a vector, in centimetres. */
export type F3dLine3 = { origin: [number, number, number]; direction: [number, number, number] };

export type F3dPattern = {
  kind: 'pattern';
  id: number;
  layout: 'rectangular' | 'circular';
  of: F3dCopySource;
  directions: (F3dLine3 | null)[];
  counts: number[];
  uSpacing: F3dParameter | null;
  vSpacing: F3dParameter | null;
  angle: F3dParameter | null;
};

export type F3dShell = {
  kind: 'shell';
  id: number;
  faces: F3dFaceName[];
  bodies: F3dBodyOps[];
  inner: F3dParameter | null;
};

/** A box, cylinder, sphere or torus on a frame, with its sizes by role. */
export type F3dPrimitive = {
  kind: 'primitive';
  id: number;
  shape: 'box' | 'cylinder' | 'sphere' | 'torus';
  operation: F3dExtrude['operation'];
  /** The plane it was drawn on, and where it stands on that plane. */
  plane: F3dMatrix;
  onPlane: F3dMatrix;
  sizes: Record<string, F3dParameter>;
};

export type F3dFeature =
  | F3dSketchFeature
  | F3dExtrude
  | F3dRevolve
  | F3dFillet
  | F3dChamfer
  | F3dCombine
  | F3dRemoveBody
  | F3dMove
  | F3dMirror
  | F3dPattern
  | F3dShell
  | F3dPrimitive;

export type F3dComponent = {
  id: number;
  name: string | null;
  /** Component to model, through its first occurrence: where sketches are placed by. */
  world: F3dMatrix;
  /** Component to model, once per occurrence. */
  placements: F3dMatrix[];
};

/** What a design's stored bodies and unresolved links are counted as in `leftOut`. */
export const STORED_BODY = 'stored body';
export const UNLINKED = 'linked component';

/** A design a `.f3z` links to, with each place it sits in the linking design's model. */
export type F3dLink = {
  design: F3dDesign;
  name: string | null;
  placements: F3dMatrix[];
};

export type F3dDesign = {
  parameters: F3dParameter[];
  sketches: F3dSketch[];
  features: F3dFeature[];
  /** Feature record ids in the order to replay them. */
  order: number[];
  /** Stored faces by tag. Empty unless a feature needs them. */
  faces: FaceIndex;
  /** Timeline items no converter reads, by what they are. */
  leftOut: Record<string, number>;
  /** Components besides the root, with each place the design puts them. */
  components: F3dComponent[];
  /** Bodies with no history, by the component holding them. */
  storedBodies: Map<number | null, number>;
  /** Where each of those bodies' shapes is stored, by component; null for one the file does not say. */
  storedShapes: Map<number | null, (BodySource | null)[]>;
  /** A B-rep stream of the design by its file name. */
  brep(name: string): Uint8Array | undefined;
  /** The designs this one links to. */
  links: F3dLink[];
  /** The axis the design was modelled with up, from its saved views; null when it has none. */
  upAxis: 'y' | 'z' | null;
  /** The component each feature works in, for those that name bodies. */
  componentOf: Map<number, number>;
  /** The record behind an operation id. */
  recordOfOp(op: number): number | undefined;
};
