import { describe, expect, it } from 'vitest';
import {
  acosDegrees,
  asinDegrees,
  atan2Degrees,
  cosDegrees,
  norm3,
  pow,
  sinDegrees,
  sqrt,
  tanDegrees,
  withStartBits,
} from './rounded-math';
import { isqrt, roundDecimal, roundDyadic, roundRatio, roundSqrt } from './dyadic';
import vectorsJson from './rounded-math.vectors.json';

const view = new DataView(new ArrayBuffer(8));

function fromHex(hex: string): number {
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

function toHex(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

const vectors = vectorsJson as Record<string, string[][]>;

function checkUnary(name: string, fn: (x: number) => number): void {
  for (const [input, expected] of vectors[name]!) {
    const x = fromHex(input!);
    expect(`${name}(${x}) = ${toHex(fn(x))}`).toBe(`${name}(${x}) = ${expected}`);
  }
}

function checkBinary(name: string, fn: (a: number, b: number) => number): void {
  for (const [first, second, expected] of vectors[name]!) {
    const a = fromHex(first!);
    const b = fromHex(second!);
    expect(`${name}(${a}, ${b}) = ${toHex(fn(a, b))}`).toBe(`${name}(${a}, ${b}) = ${expected}`);
  }
}

describe('correct rounding against the reference vectors', () => {
  it('sin in degrees', () => checkUnary('sin', sinDegrees));
  it('cos in degrees', () => checkUnary('cos', cosDegrees));
  it('tan in degrees', () => checkUnary('tan', tanDegrees));
  it('sqrt', () => checkUnary('sqrt', sqrt));
  it('asin in degrees', () => checkUnary('asin', asinDegrees));
  it('acos in degrees', () => checkUnary('acos', acosDegrees));
  it('atan2 in degrees', () => checkBinary('atan2', atan2Degrees));
  it('pow', () => checkBinary('pow', pow));
});

describe('the precision retry', () => {
  // Starting far below what the hard cases need makes every call retry.
  it('reaches the same bits from a low starting precision', () => {
    withStartBits(40, () => {
      checkUnary('sin', sinDegrees);
      checkUnary('cos', cosDegrees);
      checkUnary('tan', tanDegrees);
      checkUnary('asin', asinDegrees);
      checkUnary('acos', acosDegrees);
      checkBinary('atan2', atan2Degrees);
      checkBinary('pow', pow);
    });
  });

  it('restores the starting precision after a failure', () => {
    expect(() =>
      withStartBits(40, () => {
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(sinDegrees(1)).toBe(0.01745240643728351);
  });
});

describe('exact cases', () => {
  it('inverse functions land exactly on rational degrees', () => {
    expect(asinDegrees(1)).toBe(90);
    expect(asinDegrees(-1)).toBe(-90);
    expect(asinDegrees(0.5)).toBe(30);
    expect(asinDegrees(-0.5)).toBe(-30);
    expect(asinDegrees(0)).toBe(0);
    expect(acosDegrees(1)).toBe(0);
    expect(acosDegrees(0.5)).toBe(60);
    expect(acosDegrees(0)).toBe(90);
    expect(acosDegrees(-0.5)).toBe(120);
    expect(acosDegrees(-1)).toBe(180);
  });

  it('atan2 covers the axes and diagonals', () => {
    expect(atan2Degrees(0, 5)).toBe(0);
    expect(atan2Degrees(0, -5)).toBe(180);
    expect(atan2Degrees(-0, -5)).toBe(180);
    expect(atan2Degrees(5, 0)).toBe(90);
    expect(atan2Degrees(-5, 0)).toBe(-90);
    expect(atan2Degrees(2, 2)).toBe(45);
    expect(atan2Degrees(2, -2)).toBe(135);
    expect(atan2Degrees(-2, 2)).toBe(-45);
    expect(atan2Degrees(-2, -2)).toBe(-135);
    expect(atan2Degrees(0, 0)).toBeNaN();
  });

  it('forward functions land exactly on the angles with rational values', () => {
    const signs = [1, -1];
    for (const turn of [0, 360, -360, 3600]) {
      for (const sign of signs) {
        expect(sinDegrees(turn + sign * 30)).toBe(sign * 0.5);
        expect(sinDegrees(turn + sign * 150)).toBe(sign * 0.5);
        expect(sinDegrees(turn + sign * 90)).toBe(sign);
        expect(cosDegrees(turn + sign * 60)).toBe(0.5);
        expect(cosDegrees(turn + sign * 120)).toBe(-0.5);
        expect(cosDegrees(turn + sign * 180)).toBe(-1);
        expect(tanDegrees(turn + sign * 45)).toBe(sign);
        expect(tanDegrees(turn + sign * 135)).toBe(-sign);
      }
      expect(sinDegrees(turn)).toBe(0);
      expect(sinDegrees(turn + 180)).toBe(0);
      expect(cosDegrees(turn)).toBe(1);
      expect(cosDegrees(turn + 90)).toBe(0);
      expect(cosDegrees(turn - 90)).toBe(0);
      expect(tanDegrees(turn)).toBe(0);
      expect(tanDegrees(turn + 180)).toBe(0);
    }
  });

  it('tan has no value at a pole', () => {
    for (const x of [90, -90, 270, 450, 90 + 180 * 2 ** 40]) expect(tanDegrees(x)).toBeNaN();
    expect(tanDegrees(89.99999999999999)).toBe(4031832051015932);
  });

  it('reduces exactly however large the angle', () => {
    expect(sinDegrees(360 * 2 ** 1000)).toBe(0);
    expect(cosDegrees(360 * 2 ** 1000)).toBe(1);
    expect(sinDegrees(30 + 360 * 2 ** 44)).toBe(0.5);
  });

  it('gives zero one sign', () => {
    for (const value of [sinDegrees(180), sinDegrees(-360), cosDegrees(90), cosDegrees(270), tanDegrees(-180)]) {
      expect(Object.is(value, 0)).toBe(true);
    }
  });

  it('non-finite angles are NaN', () => {
    expect(sinDegrees(Infinity)).toBeNaN();
    expect(cosDegrees(NaN)).toBeNaN();
    expect(tanDegrees(-Infinity)).toBeNaN();
  });

  it('outside the domain is NaN', () => {
    expect(asinDegrees(1.0000000000000002)).toBeNaN();
    expect(acosDegrees(-2)).toBeNaN();
    expect(sqrt(-1)).toBeNaN();
    expect(pow(-8, 0.5)).toBeNaN();
  });

  it('powers', () => {
    expect(pow(0, 0)).toBe(1);
    expect(pow(5, 0)).toBe(1);
    expect(pow(0, 3)).toBe(0);
    expect(pow(0, -1)).toBe(Infinity);
    expect(pow(-2, 3)).toBe(-8);
    expect(pow(-2, 2)).toBe(4);
    expect(pow(-1, 1e300)).toBe(1);
    expect(pow(4, 0.5)).toBe(2);
    expect(pow(4, -1.5)).toBe(0.125);
    expect(pow(256, 0.125)).toBe(2);
    expect(pow(10, 400)).toBe(Infinity);
    expect(pow(10, -400)).toBe(0);
    expect(pow(-10, 401)).toBe(-Infinity);
    expect(pow(1.5, 1e300)).toBe(Infinity);
  });

  it('a square that falls on a tie rounds to even', () => {
    // (2^27 − 1)² = 2^54 − 2^28 + 1, one bit too long and odd.
    expect(pow(134217727, 2)).toBe(18014398241046528);
  });

  it('the norm of three numbers is rounded once and never overflows early', () => {
    expect(norm3(3, 4, 0)).toBe(5);
    expect(norm3(0, 0, 0)).toBe(0);
    expect(norm3(1e300, 1e300, 0)).toBe(1.4142135623730952e300);
    expect(norm3(3e-320, 4e-320, 0)).toBe(5e-320);
    expect(norm3(1, 1, 1)).toBe(1.7320508075688772);
  });
});

describe('exact rounding helpers', () => {
  it('rounds dyadic values to nearest, ties to even', () => {
    expect(roundDyadic(1n, 0)).toBe(1);
    expect(roundDyadic((1n << 53n) + 1n, 0)).toBe(2 ** 53);
    expect(roundDyadic((1n << 53n) + 3n, 0)).toBe(2 ** 53 + 4);
    expect(roundDyadic(-5n, -1)).toBe(-2.5);
  });

  it('handles subnormals and overflow', () => {
    expect(roundDyadic(1n, -1074)).toBe(5e-324);
    expect(roundDyadic(1n, -1075)).toBe(0);
    expect(roundDyadic(3n, -1075)).toBe(1e-323);
    expect(roundDyadic((1n << 54n) - 1n, -1076)).toBe(2.2250738585072014e-308);
    expect(roundDyadic(1n, 1023)).toBe(8.98846567431158e307);
    expect(roundDyadic(1n, 1024)).toBe(Infinity);
    expect(roundDyadic(-1n, 5000)).toBe(-Infinity);
    expect(roundDyadic((1n << 54n) - 1n, 970)).toBe(Infinity);
  });

  it('rounds ratios once', () => {
    expect(roundRatio(1n, 3n)).toBe(1 / 3);
    expect(roundRatio(-1n, 1000n)).toBe(-0.001);
    expect(roundRatio(127n, 5n)).toBe(25.4);
    expect(roundRatio(1n, 1n, -1074)).toBe(5e-324);
  });

  it('takes square roots of integers', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(99n)).toBe(9n);
    expect(isqrt(100n)).toBe(10n);
    expect(isqrt(10n ** 60n)).toBe(10n ** 30n);
    expect(roundSqrt(2n, 0)).toBe(1.4142135623730951);
    expect(roundSqrt(1n, -2)).toBe(0.5);
    expect(roundSqrt(0n, 0)).toBe(0);
  });

  it('reads decimals exactly, beyond the digits a double holds', () => {
    expect(roundDecimal('1', 0)).toBe(1);
    expect(roundDecimal('25', -1)).toBe(2.5);
    expect(roundDecimal('1', 400)).toBe(Infinity);
    expect(roundDecimal('1', -400)).toBe(0);
    expect(roundDecimal('0', 999999)).toBe(0);
    expect(roundDecimal('5', -324)).toBe(5e-324);
    // The midpoint of 2^53 and 2^53 + 2 ties to even; a digit far past it does not.
    expect(roundDecimal('9007199254740993', 0)).toBe(9007199254740992);
    expect(roundDecimal(`9007199254740993${'0'.repeat(22)}1`, -23)).toBe(9007199254740994);
  });
});
