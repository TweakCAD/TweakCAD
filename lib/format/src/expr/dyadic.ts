/**
 * Exact conversion between doubles and integers scaled by a power of two.
 *
 * Everything here is exact or rounds once to the nearest double, ties to even,
 * so the results do not depend on the platform's floating-point library.
 */

const view = new DataView(new ArrayBuffer(8));
const MANTISSA_BITS = 52n;
const HIDDEN_BIT = 1n << MANTISSA_BITS;
const MIN_LSB = -1074;

/** The magnitude of a finite double as `m · 2^e`, and its sign. */
export interface Dyadic {
  neg: boolean;
  m: bigint;
  e: number;
}

export function decompose(x: number): Dyadic {
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const neg = bits >> 63n === 1n;
  const biased = Number((bits >> MANTISSA_BITS) & 0x7ffn);
  const fraction = bits & (HIDDEN_BIT - 1n);
  return biased === 0 ? { neg, m: fraction, e: MIN_LSB } : { neg, m: fraction | HIDDEN_BIT, e: biased - 1075 };
}

/** `decompose` with `m` made odd; `x` must not be zero. */
export function decomposeOdd(x: number): Dyadic {
  const d = decompose(x);
  const zeros = trailingZeros(d.m);
  return { neg: d.neg, m: d.m >> BigInt(zeros), e: d.e + zeros };
}

function trailingZeros(n: bigint): number {
  let zeros = 0;
  while ((n & 1n) === 0n) {
    n >>= 1n;
    zeros++;
  }
  return zeros;
}

/** The number of bits of a positive integer. */
export function bitLength(n: bigint): number {
  const hex = n.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex.slice(0, 1), 16)));
}

/** The double whose magnitude is `q · 2^lsb`, for `q ≤ 2^53` on the double grid. */
function compose(neg: boolean, q: bigint, lsb: number): number {
  if (q === HIDDEN_BIT << 1n) {
    q = HIDDEN_BIT;
    lsb += 1;
  }
  let bits: bigint;
  if (q < HIDDEN_BIT) {
    bits = q;
  } else {
    const biased = lsb + 1075;
    bits = biased >= 2047 ? 2047n << MANTISSA_BITS : (BigInt(biased) << MANTISSA_BITS) | (q - HIDDEN_BIT);
  }
  view.setBigUint64(0, neg ? bits | (1n << 63n) : bits);
  return view.getFloat64(0);
}

/** The double nearest `n · 2^e`, ties to even; overflow gives an infinity. */
export function roundDyadic(n: bigint, e: number): number {
  if (n === 0n) return 0;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const top = bitLength(a) - 1 + e;
  if (top > 1024) return neg ? -Infinity : Infinity;
  const lsb = Math.max(top - 52, MIN_LSB);
  const shift = lsb - e;
  if (shift <= 0) return compose(neg, a << BigInt(-shift), lsb);
  const s = BigInt(shift);
  let q = a >> s;
  const rest = a - (q << s);
  const half = 1n << (s - 1n);
  if (rest > half || (rest === half && (q & 1n) === 1n)) q += 1n;
  return compose(neg, q, lsb);
}

/** The double nearest `(a / b) · 2^e`, for `b > 0`. */
export function roundRatio(a: bigint, b: bigint, e = 0): number {
  if (a === 0n) return 0;
  const neg = a < 0n;
  const magnitude = neg ? -a : a;
  // Enough quotient bits that the sticky bit below can never look like a tie.
  const shift = Math.max(0, bitLength(b) - bitLength(magnitude) + 66);
  const scaled = magnitude << BigInt(shift);
  const q = scaled / b;
  const sticky = q * b === scaled ? 0n : 1n;
  const value = roundDyadic((q << 1n) | sticky, e - shift - 1);
  return neg ? -value : value;
}

/** `floor(√n)`, for `n ≥ 0`. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLength(n) + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** The double nearest `√(n · 2^e)`, for `n ≥ 0`. */
export function roundSqrt(n: bigint, e: number): number {
  if (n === 0n) return 0;
  // An even exponent, and enough bits that the root has far more than 54.
  let shift = Math.max(0, 130 - bitLength(n));
  if (((e - shift) & 1) !== 0) shift += 1;
  const scaled = n << BigInt(shift);
  const root = isqrt(scaled);
  const sticky = root * root === scaled ? 0n : 1n;
  return roundDyadic((root << 1n) | sticky, (e - shift) / 2 - 1);
}

/**
 * The double nearest a decimal literal: integer digits, fraction digits and
 * a decimal exponent, all read exactly.
 */
export function roundDecimal(digits: string, exponent: number): number {
  const n = BigInt(digits);
  if (n === 0n) return 0;
  // Beyond these bounds the value overflows, or lies below half the smallest double.
  const magnitude = digits.replace(/^0+/, '').length + exponent;
  if (magnitude > 310) return Infinity;
  if (magnitude < -330) return 0;
  return exponent >= 0 ? roundDyadic(n * 10n ** BigInt(exponent), 0) : roundRatio(n, 10n ** BigInt(-exponent));
}
