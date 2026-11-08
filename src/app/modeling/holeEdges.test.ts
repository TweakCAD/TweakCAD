import { describe, expect, it } from 'vitest';
import type { BodyMesh, Display, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { distanceFrom, edgeLineOf, fieldNumber, footOn, measuredAt, shownAt } from './holeEdges';

/** The top of a 60 × 40 plate at z = 5, face key 1, as two triangles, with edges 2 (x = 0), 3 (y = 0), 4 (x = 60) and 5, an arc. */
const plate: BodyMesh = {
  positions: new Float32Array([0, 0, 5, 60, 0, 5, 60, 40, 5, 0, 40, 5]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  faces: new Uint32Array([0, 2, 1]),
  // Segment pairs: edge 2 in two pieces, edge 3, edge 4, edge 5 off the line.
  segments: new Float32Array([
    0, 0, 5, 0, 20, 5, 0, 20, 5, 0, 40, 5, 0, 0, 5, 60, 0, 5, 60, 0, 5, 60, 40, 5, 10, 10, 5, 12, 11, 5, 12, 11, 5, 13,
    13, 5,
  ]),
  edges: new Uint32Array([0, 2, 2, 2, 1, 3, 3, 1, 4, 4, 2, 5]),
  points: new Float32Array(),
  vertices: new Uint32Array(),
} as BodyMesh;
const display = { definitions: [{ bodies: [{ key: 9, mesh: plate }] }] } as unknown as Display;
const frame: FrameDisplay = { origin: [0, 0, 5], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };

describe('a reference edge', () => {
  it('is a straight edge of the face, its inward normal pointing into the face', () => {
    const left = edgeLineOf(display, 2, 1, frame);
    expect(left?.inward).toEqual([expect.closeTo(1, 9), expect.closeTo(0, 9)]);
    const right = edgeLineOf(display, 4, 1, frame);
    expect(right?.inward).toEqual([expect.closeTo(-1, 9), expect.closeTo(0, 9)]);
    expect(distanceFrom(left!, [10, 15])).toBeCloseTo(10, 9);
    expect(distanceFrom(right!, [10, 15])).toBeCloseTo(50, 9);
    expect(footOn(left!, [10, 15])).toEqual([expect.closeTo(0, 9), expect.closeTo(15, 9)]);
  });

  it('is not a curved edge, one off the face plane, or one the display does not show', () => {
    expect(edgeLineOf(display, 5, 1, frame)).toBeNull();
    expect(edgeLineOf(display, 2, 1, { ...frame, origin: [0, 0, 6] })).toBeNull();
    expect(edgeLineOf(display, 7, 1, frame)).toBeNull();
    // Face 8 is on neither side.
    expect(edgeLineOf(display, 2, 8, frame)).toBeNull();
  });
});

describe('a measured position', () => {
  const left = edgeLineOf(display, 2, 1, frame)!;
  const front = edgeLineOf(display, 3, 1, frame)!;
  const right = edgeLineOf(display, 4, 1, frame)!;

  it('takes the coordinate across one edge from its distance and keeps the other', () => {
    expect(measuredAt([30, 25], [{ line: left, d: 10 }])).toEqual([expect.closeTo(10, 9), expect.closeTo(25, 9)]);
  });

  it('lies at both distances from two edges, and nowhere for two parallel ones', () => {
    expect(
      measuredAt(
        [30, 25],
        [
          { line: left, d: 10 },
          { line: front, d: 15 },
        ],
      ),
    ).toEqual([expect.closeTo(10, 9), expect.closeTo(15, 9)]);
    expect(
      measuredAt(
        [30, 25],
        [
          { line: right, d: 12 },
          { line: front, d: 8 },
        ],
      ),
    ).toEqual([expect.closeTo(48, 9), expect.closeTo(8, 9)]);
    expect(
      measuredAt(
        [30, 25],
        [
          { line: left, d: 10 },
          { line: right, d: 10 },
        ],
      ),
    ).toBeNull();
  });

  it('is read off the fields, where they are numbers', () => {
    expect(fieldNumber('10')).toBe(10);
    expect(fieldNumber('-2.5 mm')).toBe(-2.5);
    expect(fieldNumber('w / 2')).toBeNull();
    const p = { x: '30', y: '25', from: [{ distance: '10' }, { distance: '15 mm' }] };
    expect(shownAt(p, [left, front])).toEqual([expect.closeTo(10, 9), expect.closeTo(15, 9)]);
    expect(shownAt({ ...p, from: [{ distance: '10' }] }, [left])).toEqual([
      expect.closeTo(10, 9),
      expect.closeTo(25, 9),
    ]);
    expect(shownAt({ ...p, x: 'w', from: [] }, [])).toBeNull();
    // Two edges place a linked point too.
    expect(shownAt({ ...p, kept: {} }, [left, front])).toEqual([expect.closeTo(10, 9), expect.closeTo(15, 9)]);
  });
});
