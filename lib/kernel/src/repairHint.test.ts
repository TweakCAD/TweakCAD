import { describe, expect, it, vi } from 'vitest';
import type { RepairHint } from '@tweakcad/core/src/document/schema.ts';
import { chooseByHint, scoreAgainstHint } from './repairHint.ts';

const topFace: RepairHint = { center: [0, 0, 10], normal: [0, 0, 1], size: 100 };
const xEdge: RepairHint = { center: [5, 0, 10], direction: [1, 0, 0], length: 10 };

describe('scoreAgainstHint', () => {
  it('scores a match by the distance between centres', () => {
    expect(scoreAgainstHint({ center: [3, 4, 10], normal: [0, 0, 1], size: 120 }, topFace)).toBeCloseTo(5);
  });

  it('rejects a centre further than 10 mm away', () => {
    expect(scoreAgainstHint({ center: [0, 0, 20.5], normal: [0, 0, 1], size: 100 }, topFace)).toBeNull();
  });

  it('rejects a face turned the other way', () => {
    expect(scoreAgainstHint({ center: [0, 0, 10], normal: [0, 0, -1], size: 100 }, topFace)).toBeNull();
  });

  it('rejects a size outside half to double', () => {
    expect(scoreAgainstHint({ center: [0, 0, 10], normal: [0, 0, 1], size: 201 }, topFace)).toBeNull();
    expect(scoreAgainstHint({ center: [0, 0, 10], normal: [0, 0, 1], size: 49 }, topFace)).toBeNull();
  });

  it('does not match a curved face to a planar hint', () => {
    // A curved face is described without a normal.
    expect(scoreAgainstHint({ center: [0, 0, 10], size: 100 }, topFace)).toBeNull();
  });

  it('ignores the sign of an edge direction', () => {
    expect(scoreAgainstHint({ center: [5, 0, 10], direction: [-1, 0, 0], length: 10 }, xEdge)).toBe(0);
  });

  it('rejects an edge running another way, or of another length', () => {
    expect(scoreAgainstHint({ center: [5, 0, 10], direction: [0, 0, 1], length: 10 }, xEdge)).toBeNull();
    expect(scoreAgainstHint({ center: [5, 0, 10], direction: [1, 0, 0], length: 25 }, xEdge)).toBeNull();
  });

  it('does not match an arc to a straight-edge hint', () => {
    expect(scoreAgainstHint({ center: [5, 0, 10], length: 10 }, xEdge)).toBeNull();
  });
});

describe('chooseByHint', () => {
  // Candidates as the kernel would describe them; the hint is `picked`.
  const picked = { center: [5, 0, 10], direction: [1, 0, 0], length: 10 } satisfies RepairHint;
  const noise = { center: [5, 0, 10.000001], direction: [1, 0, 0], length: 10.0000001 } satisfies RepairHint;
  const moved = { center: [5, 0, 22], direction: [1, 0, 0], length: 10 } satisfies RepairHint;
  const lookAlike = { center: [5, 0, 1], direction: [1, 0, 0], length: 10 } satisfies RepairHint;
  const far = { center: [40, 0, 10], direction: [1, 0, 0], length: 10 } satisfies RepairHint;
  const pick = (cands: RepairHint[], found: number) => chooseByHint(cands.length, found, picked, (i) => cands[i]!);

  it('takes the id without a hint, and measures nothing', () => {
    const describe = vi.fn();
    expect(chooseByHint(3, 2, undefined, describe)).toBe(2);
    expect(describe).not.toHaveBeenCalled();
  });

  it('keeps the id while it still names the picked geometry', () => {
    expect(pick([picked, noise], 1)).toBe(1);
  });

  it('follows the picked geometry when the id has moved onto something else', () => {
    expect(pick([picked, far], 1)).toBe(0);
    expect(pick([far, moved, noise], 0)).toBe(2);
  });

  it('keeps the id when what it names moved and only a look-alike is near the old spot', () => {
    // A taller block: the picked edge rose 12 mm; the bottom edge, 9 mm from
    // the old spot, runs the same way and is as long — still not evidence.
    expect(pick([lookAlike, moved], 1)).toBe(1);
  });

  it('stands in the closest loose match when the id is gone, or nothing', () => {
    expect(pick([far, lookAlike, moved], -1)).toBe(1);
    expect(pick([far, moved], -1)).toBe(-1);
  });
});
