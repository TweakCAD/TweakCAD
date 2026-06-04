/**
 * Core math types for CAD operations.
 * Plain data types - no classes, no methods.
 */

/** 2D vector as [x, y] tuple */
export type Vec2 = [number, number];

/** 3D vector as [x, y, z] tuple */
export type Vec3 = [number, number, number];

/** Quaternion as [x, y, z, w] tuple */
export type Quaternion = [number, number, number, number];

/** 4x4 matrix as flat 16-element array (column-major) */
export type Matrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** 3D transform with position and rotation */
export type Transform3D = {
  position: Vec3;
  rotation: Quaternion;
};

/** Axis-aligned bounding box in 3D */
export type BoundingBox3D = {
  min: Vec3;
  max: Vec3;
};

/** Mass properties of a solid body */
export type MassProperties = {
  volume: number;
  surfaceArea: number;
  centerOfMass: Vec3;
};

// --- Vec2 operations ---

/** @param a - First vector @param b - Second vector @returns Sum of a and b */
export function vec2Add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

/** @param a - First vector @param b - Second vector @returns Difference a - b */
export function vec2Sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

/** @param v - Vector @param s - Scalar @returns Scaled vector */
export function vec2Scale(v: Vec2, s: number): Vec2 {
  return [v[0] * s, v[1] * s];
}

/** @param a - First point @param b - Second point @returns Midpoint of a and b */
export function vec2Midpoint(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** @param v - Vector @returns Length of the vector */
export function vec2Length(v: Vec2): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

/** @param a - First point @param b - Second point @returns Distance between a and b */
export function vec2Distance(a: Vec2, b: Vec2): number {
  return vec2Length(vec2Sub(a, b));
}

// --- Vec3 operations ---

/** @param a - First vector @param b - Second vector @returns Sum of a and b */
export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** @param a - First vector @param b - Second vector @returns Difference a - b */
export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

/** @param v - Vector @param s - Scalar @returns Scaled vector */
export function vec3Scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** @param v - Vector @returns Length of the vector */
export function vec3Length(v: Vec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

/** @param v - Vector @returns Normalized unit vector */
export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** @param a - First vector @param b - Second vector @returns Dot product */
export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** @param a - First vector @param b - Second vector @returns Cross product a x b */
export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// --- Transform helpers ---

/** @returns Identity transform at origin with no rotation */
export function identityTransform(): Transform3D {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0, 1],
  };
}

/** @returns An empty bounding box (will be expanded with first point) */
export function emptyBoundingBox(): BoundingBox3D {
  return {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
}

/**
 * Expand a bounding box to include a point.
 * @param box - Bounding box to expand
 * @param point - Point to include
 * @returns New expanded bounding box
 */
export function expandBoundingBox(box: BoundingBox3D, point: Vec3): BoundingBox3D {
  return {
    min: [
      Math.min(box.min[0], point[0]),
      Math.min(box.min[1], point[1]),
      Math.min(box.min[2], point[2]),
    ],
    max: [
      Math.max(box.max[0], point[0]),
      Math.max(box.max[1], point[1]),
      Math.max(box.max[2], point[2]),
    ],
  };
}
