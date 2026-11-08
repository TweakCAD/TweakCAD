/**
 * Correctly rounded elementary functions: each returns the double nearest the
 * exact value, ties to even, for every finite input, so all readers compute
 * the same bits. Angles are exact in degrees, with true π.
 *
 * Each function evaluates in fixed-point integers with a stated error bound,
 * giving an interval around the exact value, and retries with twice the
 * precision until both ends of the interval round to one double. The retry
 * always ends because the exact value is never a double or a midpoint between
 * two doubles, except for the inputs handled exactly up front:
 * - by Niven's theorem an angle in rational degrees has a rational sine or
 *   cosine only for 0, ±1/2 and ±1, and a rational tangent only for 0 and ±1;
 *   every other value, forward or inverse, is irrational;
 * - a power is either exactly dyadic, computed as an integer power below, or
 *   irrational.
 *
 * Fixed-point values are integers scaled by `2^w`.
 */

import { bitLength, decompose, decomposeOdd, isqrt, roundDyadic, roundRatio, roundSqrt, type Dyadic } from './dyadic';

/** The nearest double to π. */
export const PI = 3.141592653589793;

/** Starting precision in fraction bits; hard cases double it. */
const START_BITS = 192;
const MAX_BITS = 1 << 20;

/** Error bounds, in units of the last fixed-point place, with a wide margin. */
const TRIG_ERROR = 1n << 16n;
const DEGREE_ERROR = 1n << 24n;
const POWER_ERROR = 1n << 20n;

/** An integer power is computed exactly up to this many bits of result. */
const EXACT_POWER_BITS = 1 << 14;

let startBits = START_BITS;

/** Runs `body` with a different starting precision; hard cases then retry more often. */
export function withStartBits<T>(bits: number, body: () => T): T {
  const saved = startBits;
  startBits = bits;
  try {
    return body();
  } finally {
    startBits = saved;
  }
}

type Interval = readonly [lo: bigint, hi: bigint, exponent: number] | null;

/** Doubles the precision until `compute` gives an interval rounding to one double. */
function refine(compute: (bits: number) => Interval): number {
  for (let bits = startBits; bits <= MAX_BITS; bits *= 2) {
    const interval = compute(bits);
    if (interval === null) continue;
    const [lo, hi, exponent] = interval;
    const a = roundDyadic(lo, exponent);
    if (a === roundDyadic(hi, exponent)) return a;
  }
  throw new Error('rounding did not converge');
}

/** `Σ sign^k · z^(2k+1) / (2k+1)` for `|z| ≤ 1/2`: atan with sign −1, atanh with +1. */
function oddSeries(z: bigint, w: number, sign: 1n | -1n): bigint {
  const shift = BigInt(w);
  const z2 = (z * z) >> shift;
  let power = z;
  let sum = z;
  let term = z;
  for (let k = 3n; term !== 0n; k += 2n) {
    power = (power * z2 * sign) >> shift;
    term = power / k;
    sum += term;
  }
  return sum;
}

/** `atan(1/n)` or `atanh(1/n)` at `w` bits. */
function inverseSeries(n: bigint, w: number, sign: 1n | -1n): bigint {
  const square = n * n;
  let power = (1n << BigInt(w)) / n;
  let sum = power;
  for (let k = 3n; power !== 0n; k += 2n) {
    power /= square;
    sum += sign === -1n && k % 4n === 3n ? -power / k : power / k;
  }
  return sum;
}

function memoized(compute: (w: number) => bigint): (w: number) => bigint {
  let bits = 0;
  let value = 0n;
  return (w) => {
    if (w > bits) {
      bits = w + 64;
      value = compute(bits);
    }
    return value >> BigInt(bits - w);
  };
}

/** π at `w` bits, within one unit in the last place. */
export const piFixed = memoized((w) => {
  const guard = w + 32;
  const value = 16n * inverseSeries(5n, guard, -1n) - 4n * inverseSeries(239n, guard, -1n);
  return value >> 32n;
});

/** ln 2 at `w` bits, within one unit in the last place. */
const ln2Fixed = memoized((w) => (2n * inverseSeries(3n, w + 32, 1n)) >> 32n);

/** An angle of `90 · quadrant + r / 2^s` degrees, with `|r / 2^s| ≤ 45`. */
interface ReducedAngle {
  quadrant: number;
  r: bigint;
  s: number;
}

/** Reduces the magnitude of a double in degrees, exactly. */
function reduceDegrees(d: Dyadic): ReducedAngle {
  const s = Math.max(-d.e, 0);
  const right = 90n << BigInt(s);
  const inTurn = (d.m << BigInt(Math.max(d.e, 0))) % (4n * right);
  const quadrant = (2n * inTurn + right) / (2n * right);
  return { quadrant: Number(quadrant & 3n), r: inTurn - quadrant * right, s };
}

/** Fraction bits giving a non-zero reduced angle `bits` of relative precision in radians. */
function angleBits(a: ReducedAngle, bits: number): number {
  const magnitude = a.r < 0n ? -a.r : a.r;
  return bits + Math.max(0, a.s - bitLength(magnitude) + 7);
}

/** sin and cos of a reduced angle's `r / 2^s` degrees at `w` bits, within `TRIG_ERROR`. */
function sinCos(a: ReducedAngle, w: number): { s: bigint; c: bigint } {
  const t = (a.r * piFixed(w)) / (180n << BigInt(a.s));
  const bits = BigInt(w);
  const t2 = (t * t) >> bits;
  let sinTerm = t;
  let sinSum = t;
  let cosTerm = 1n << bits;
  let cosSum = cosTerm;
  for (let n = 1n; sinTerm !== 0n || cosTerm !== 0n; n += 2n) {
    cosTerm = -((cosTerm * t2) >> bits) / (n * (n + 1n));
    cosSum += cosTerm;
    sinTerm = -((sinTerm * t2) >> bits) / ((n + 1n) * (n + 2n));
    sinSum += sinTerm;
  }
  return { s: sinSum, c: cosSum };
}

/** The double nearest sin of a reduced angle's `r / 2^s` degrees. */
function reducedSin(a: ReducedAngle): number {
  if (a.r === 0n) return 0;
  const thirty = 30n << BigInt(a.s);
  if (a.r === thirty) return 0.5;
  if (a.r === -thirty) return -0.5;
  return refine((bits) => {
    const w = angleBits(a, bits);
    const { s } = sinCos(a, w);
    return [s - TRIG_ERROR, s + TRIG_ERROR, -w];
  });
}

/** The double nearest cos of a reduced angle's `r / 2^s` degrees. */
function reducedCos(a: ReducedAngle): number {
  if (a.r === 0n) return 1;
  return refine((bits) => {
    const w = angleBits(a, bits);
    const { c } = sinCos(a, w);
    return [c - TRIG_ERROR, c + TRIG_ERROR, -w];
  });
}

/** The sine of exactly `x · π/180`. */
export function sinDegrees(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const d = decompose(x);
  const a = reduceDegrees(d);
  const value = a.quadrant % 2 === 0 ? reducedSin(a) : reducedCos(a);
  return (a.quadrant >= 2 !== d.neg ? -value : value) + 0;
}

/** The cosine of exactly `x · π/180`. */
export function cosDegrees(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const a = reduceDegrees(decompose(x));
  const value = a.quadrant % 2 === 0 ? reducedCos(a) : reducedSin(a);
  return (a.quadrant === 1 || a.quadrant === 2 ? -value : value) + 0;
}

/** The tangent of exactly `x · π/180`; NaN at a pole. */
export function tanDegrees(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const d = decompose(x);
  const a = reduceDegrees(d);
  // tan(90° + r) is −cot r, so an odd quadrant swaps the ratio and its sign.
  const odd = a.quadrant % 2 === 1;
  if (a.r === 0n) return odd ? NaN : 0;
  const forty = 45n << BigInt(a.s);
  if (a.r === forty || a.r === -forty) return (a.r < 0n !== odd) !== d.neg ? -1 : 1;
  return refine((bits) => {
    const w = angleBits(a, bits);
    const { s, c } = sinCos(a, w);
    const absS = s < 0n ? -s : s;
    const [top, bottom] = odd ? [c, absS] : [absS, c];
    if (top <= TRIG_ERROR || bottom <= TRIG_ERROR) return null;
    const shift = BigInt(w);
    const lo = ((top - TRIG_ERROR) << shift) / (bottom + TRIG_ERROR);
    const hi = ((top + TRIG_ERROR) << shift) / (bottom - TRIG_ERROR) + 1n;
    return (a.r < 0n !== odd) !== d.neg ? [-hi, -lo, -w] : [lo, hi, -w];
  });
}

/** atan of a fixed-point `z` in `[0, 1]`, within a few hundred units in the last place. */
function atanFixed(z: bigint, w: number): bigint {
  const bits = BigInt(w);
  const one = 1n << bits;
  let halvings = 0n;
  // atan z = 2 atan(z / (1 + √(1 + z²))) brings z below 1/8 in three steps.
  while (z > one >> 3n) {
    const root = isqrt((one + ((z * z) >> bits)) << bits);
    z = (z << bits) / (one + root);
    halvings += 1n;
  }
  return oddSeries(z, w, -1n) << halvings;
}

/** The angle in `[0, π/2]` whose tangent is `y / x`, for fixed-point `y, x ≥ 0`, not both zero. */
function angleOf(y: bigint, x: bigint, w: number): bigint {
  const bits = BigInt(w);
  if (y <= x) return atanFixed((y << bits) / x, w);
  return (piFixed(w) >> 1n) - atanFixed((x << bits) / y, w);
}

function toDegrees(radians: bigint, w: number): bigint {
  return ((radians * 180n) << BigInt(w)) / piFixed(w);
}

/** `|x|` and `√(1 − x²)` at `w` bits, for `0 < |x| < 1`; `w` must be large enough to hold `x` exactly. */
function sineAndCosine(d: Dyadic, w: number): { sine: bigint; cosine: bigint } {
  const sine = d.m << BigInt(d.e + w);
  return { sine, cosine: isqrt((1n << BigInt(2 * w)) - sine * sine) };
}

/** Precision that holds `x` exactly and keeps its full relative precision. */
function exactArgumentBits(d: Dyadic, bits: number): number {
  return bits + Math.max(-d.e, 0);
}

/** asin of a double, in degrees. */
export function asinDegrees(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  if (x === 0) return x;
  if (Math.abs(x) === 1) return x * 90;
  if (Math.abs(x) === 0.5) return x * 60;
  const d = decompose(x);
  return refine((bits) => {
    const w = exactArgumentBits(d, bits);
    const { sine, cosine } = sineAndCosine(d, w);
    const degrees = toDegrees(angleOf(sine, cosine, w), w);
    const lo = degrees - DEGREE_ERROR;
    const hi = degrees + DEGREE_ERROR;
    return d.neg ? [-hi, -lo, -w] : [lo, hi, -w];
  });
}

/** acos of a double, in degrees. */
export function acosDegrees(x: number): number {
  if (!(Math.abs(x) <= 1)) return NaN;
  if (x === 1) return 0;
  if (x === -1) return 180;
  if (x === 0.5) return 60;
  if (x === -0.5) return 120;
  if (x === 0) return 90;
  const d = decompose(x);
  return refine((bits) => {
    const w = exactArgumentBits(d, bits);
    const { sine, cosine } = sineAndCosine(d, w);
    const degrees = toDegrees(angleOf(cosine, sine, w), w);
    const value = d.neg ? (180n << BigInt(w)) - degrees : degrees;
    return [value - DEGREE_ERROR, value + DEGREE_ERROR, -w];
  });
}

/**
 * atan2 of two doubles, in degrees, in `(−180, 180]`. A zero of either sign
 * is zero; `atan2Degrees(0, 0)` is NaN.
 */
export function atan2Degrees(y: number, x: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(x) || (y === 0 && x === 0)) return NaN;
  if (y === 0) return x > 0 ? 0 : 180;
  if (x === 0) return y > 0 ? 90 : -90;
  if (Math.abs(y) === Math.abs(x)) return (y > 0 ? 1 : -1) * (x > 0 ? 45 : 135);

  const dy = decompose(y);
  const dx = decompose(x);
  const low = Math.min(dy.e, dx.e);
  const a = dy.m << BigInt(dy.e - low);
  const b = dx.m << BigInt(dx.e - low);
  const spread = Math.abs(bitLength(a) - bitLength(b));
  return refine((bits) => {
    const w = bits + spread;
    const degrees = toDegrees(angleOf(a, b, w), w);
    const value = dx.neg ? (180n << BigInt(w)) - degrees : degrees;
    const lo = value - DEGREE_ERROR;
    const hi = value + DEGREE_ERROR;
    return dy.neg ? [-hi, -lo, -w] : [lo, hi, -w];
  });
}

/** sqrt of a double; NaN for a negative one. */
export function sqrt(x: number): number {
  if (x === 0) return x;
  if (!(x > 0) || x === Infinity) return NaN;
  const d = decompose(x);
  return roundSqrt(d.m, d.e);
}

/** The Euclidean norm of three doubles, rounded once. */
export function norm3(a: number, b: number, c: number): number {
  const parts = [a, b, c].filter((v) => v !== 0).map(decompose);
  if (parts.length === 0) return 0;
  const low = Math.min(...parts.map((p) => p.e));
  let sum = 0n;
  for (const p of parts) {
    const scaled = p.m << BigInt(p.e - low);
    sum += scaled * scaled;
  }
  return roundSqrt(sum, 2 * low);
}

/** ln of `m · 2^e` at `w` bits, within `TRIG_ERROR`. */
function lnFixed(m: bigint, e: number, w: number): bigint {
  const length = bitLength(m);
  let exponent = e + length;
  let f = m << BigInt(w - length);
  const bits = BigInt(w);
  const one = 1n << bits;
  // f in [0.75, 1.5), so a base near 1 keeps its small logarithm exact.
  if (f < (3n * one) >> 2n) {
    f <<= 1n;
    exponent -= 1;
  }
  const z = ((f - one) << bits) / (f + one);
  return 2n * oddSeries(z, w, 1n) + BigInt(exponent) * ln2Fixed(w);
}

/** `e^p` for a fixed-point `p`, as a fixed-point value in `[0.7, 1.5]` and a binary exponent. */
function expFixed(p: bigint, w: number): { value: bigint; exponent: number } {
  const ln2 = ln2Fixed(w);
  const n = (2n * p + ln2) / (2n * ln2) - (2n * p + ln2 < 0n ? 1n : 0n);
  const r = p - n * ln2;
  const bits = BigInt(w);
  let term = 1n << bits;
  let sum = term;
  for (let k = 1n; term !== 0n; k += 1n) {
    term = ((term * r) >> bits) / k;
    sum += term;
  }
  return { value: sum, exponent: Number(n) };
}

/** `base^exponent` for a positive odd-or-one `m · 2^e` and an integer exponent, when small enough to be exact. */
function exactIntegerPower(m: bigint, e: number, y: number): number | undefined {
  const count = Math.abs(y);
  if (count * bitLength(m) > EXACT_POWER_BITS) return undefined;
  const power = m ** BigInt(count);
  return y >= 0 ? roundDyadic(power, e * count) : roundRatio(1n, power, -e * count);
}

/** Whether a positive `m · 2^e` with odd `m` is the square of a dyadic number. */
function squareRootOf(m: bigint, e: number): { m: bigint; e: number } | undefined {
  if (e % 2 !== 0) return undefined;
  const root = isqrt(m);
  return root * root === m ? { m: root, e: e / 2 } : undefined;
}

/**
 * The positive power `|x|^y`, or its limit when it overflows or vanishes. `x`
 * is not zero and `y` is not zero.
 */
function positivePower(x: number, y: number): number {
  const base = decomposeOdd(x);
  const power = decomposeOdd(y);

  // A power with a dyadic exponent is exact only through exact square roots.
  let root: { m: bigint; e: number } = base;
  let halvings = power.e < 0 ? -power.e : 0;
  while (halvings > 0) {
    const next = squareRootOf(root.m, root.e);
    if (next === undefined) break;
    root = next;
    halvings -= 1;
  }

  // A coarse log2 of the result: within a factor of 1.5 for every base.
  const full = decompose(x);
  const fullLength = bitLength(full.m);
  const mantissa = Number(full.m) / 2 ** (fullLength - 1);
  const logEstimate = (fullLength - 1 + full.e + (mantissa - 1)) * y;
  if (logEstimate > 2200) return Infinity;
  if (logEstimate < -2200) return 0;

  if (halvings === 0) {
    const exponent = power.e < 0 ? Number(power.m) : y;
    const exact = exactIntegerPower(root.m, root.e, power.neg && power.e < 0 ? -exponent : exponent);
    if (exact !== undefined) return exact;
  }

  const topY = Math.max(bitLength(power.m) + power.e, 0);
  return refine((bits) => {
    const w = bits + topY + 64;
    const logarithm = lnFixed(base.m, base.e, w);
    const shifted = logarithm * power.m;
    // y · ln x, brought back to `bits` fraction bits.
    const shift = w - power.e - bits;
    const product = shift >= 0 ? shifted >> BigInt(shift) : shifted << BigInt(-shift);
    const { value, exponent } = expFixed(power.neg ? -product : product, bits);
    return [value - POWER_ERROR, value + POWER_ERROR, exponent - bits];
  });
}

/**
 * `x^y`. `0^0` is 1, a zero base with a negative exponent is an infinity, and
 * a negative base with a non-integer exponent is NaN.
 */
export function pow(x: number, y: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
  if (y === 0) return 1;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0 && !Number.isInteger(y)) return NaN;
  if (Math.abs(x) === 1) return x > 0 || Math.abs(y) % 2 === 0 ? 1 : -1;
  const magnitude = positivePower(x, y);
  return x < 0 && Math.abs(y) % 2 === 1 ? -magnitude : magnitude;
}
