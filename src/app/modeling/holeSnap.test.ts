import { describe, expect, it } from 'vitest';
import type { BodyMesh, Display, FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import {
  circleCentres,
  circleThrough,
  fromFrame,
  inFrame,
  snapAt,
  snapOnFace,
  snapTargets,
  type SnapTarget,
  type Vec2,
} from './holeSnap';

/** A face plane at z = 2, its frame's x along the part's x. */
const FRAME: FrameDisplay = { origin: [0, 0, 2], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };

/** Points of a circle (or an arc of `sweep` radians) as a polyline. */
function arc(cx: number, cy: number, r: number, z: number, sweep = Math.PI * 2, n = 48): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * sweep;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return out;
}

/** A mesh holding only edges, each a polyline, keyed 100, 101, ... */
function edgesMesh(polylines: number[][][]): Pick<BodyMesh, 'segments' | 'edges'> {
  const segments: number[] = [];
  const edges: number[] = [];
  polylines.forEach((points, i) => {
    edges.push(segments.length / 6, points.length - 1, 100 + i);
    for (let j = 0; j + 1 < points.length; j++)
      segments.push(...(points[j] as number[]), ...(points[j + 1] as number[]));
  });
  return { segments: new Float32Array(segments), edges: new Uint32Array(edges) };
}

const close = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 4);
  expect(a[1]).toBeCloseTo(b[1], 4);
};

describe('hole position snapping', () => {
  it('reads points in a face frame and back', () => {
    const frame: FrameDisplay = { origin: [0, 64, 0], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] };
    expect(inFrame(frame, [3, 64, -4])).toEqual({ uv: [3, 4], height: 0 });
    expect(fromFrame(frame, [3, 4])).toEqual([3, 64, -4]);
  });

  it('fits a circle through points on one, and none through a line or an ellipse', () => {
    const circle = circleThrough(arc(5, -3, 10, 0).map((p) => [p[0], p[1]] as Vec2));
    close(circle!.centre, [5, -3]);
    expect(circle!.radius).toBeCloseTo(10, 4);
    // A quarter arc gives its whole circle's centre.
    close(circleThrough(arc(1, 1, 4, 0, Math.PI / 2, 8).map((p) => [p[0], p[1]] as Vec2))!.centre, [1, 1]);
    expect(
      circleThrough([
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBeNull();
    expect(circleThrough(arc(0, 0, 1, 0).map((p) => [3 * (p[0] as number), p[1] as number] as Vec2))).toBeNull();
    expect(
      circleThrough([
        [0, 0],
        [1, 0],
      ]),
    ).toBeNull();
  });

  it("takes the centres of the circular edges lying in the face's plane only", () => {
    const mesh = edgesMesh([
      arc(5, -3, 10, 2),
      [
        [0, 0, 2],
        [20, 0, 2],
      ],
      arc(30, 30, 3, 0),
      arc(-20, 0, 2, 2, Math.PI),
    ]);
    const centres = circleCentres(mesh, FRAME);
    expect(centres).toHaveLength(2);
    close(centres[0]!.uv, [5, -3]);
    expect(centres[0]!.radius).toBeCloseTo(10, 3);
    close(centres[1]!.uv, [-20, 0]);
  });

  it("snaps near a circle's edge or centre to the centre, near a point to it, and nowhere else", () => {
    const targets: SnapTarget[] = [
      { kind: 'centre', uv: [5, -3], radius: 10 },
      { kind: 'point', uv: [-8, 6] },
      { kind: 'origin', uv: [0, 0] },
    ];
    // Near the circular edge, far from its centre.
    expect(snapAt([14.6, -3], targets, 0.5)?.uv).toEqual([5, -3]);
    expect(snapAt([5, 7.3], targets, 0.5)?.kind).toBe('centre');
    // Near the centre.
    expect(snapAt([5.2, -3.1], targets, 0.5)?.kind).toBe('centre');
    expect(snapAt([-7.8, 6.1], targets, 0.5)?.uv).toEqual([-8, 6]);
    expect(snapAt([0.3, 0.2], targets, 0.5)?.kind).toBe('origin');
    // Inside the circle, near nothing: the point clicked.
    expect(snapAt([9, 0], targets, 0.5)).toBeNull();
    // The nearest wins: the origin lies 1.4 from the circle here, but the pointer is on it.
    expect(snapAt([0.05, 0], targets, 2)?.kind).toBe('origin');
  });

  it("gathers a face's targets from the shown display: circles of its body, sketch points in its plane, the origin", () => {
    const mesh = {
      ...edgesMesh([arc(5, -3, 10, 2)]),
      positions: new Float32Array(),
      normals: new Float32Array(),
      indices: new Uint32Array(),
      faces: new Uint32Array(),
      points: new Float32Array(),
      vertices: new Uint32Array(),
    };
    const display = {
      generation: 1,
      definitions: [
        {
          index: 0,
          part: 'part_1',
          variant: '',
          rollback: null,
          bodies: [
            {
              key: 7,
              id: 'b',
              feature: 'f',
              name: 'Body 1',
              color: '#888888',
              opacity: 1,
              visible: true,
              faceStyles: [],
              mesh,
            },
          ],
          sketches: [
            {
              feature: 's',
              frame: FRAME,
              visible: true,
              curves: [],
              externals: [],
              points: [
                { key: 20, id: 'p1', at: [-8, 6, 2] },
                { key: 21, id: 'p2', at: [-8, 6, 9] },
              ],
              regions: [],
            },
            {
              feature: 'hidden',
              frame: FRAME,
              visible: false,
              curves: [],
              externals: [],
              points: [{ key: 22, id: 'p3', at: [12, 12, 2] }],
              regions: [],
            },
          ],
          construction: [],
        },
      ],
      parts: { part_1: 0 },
      assemblies: [],
      entities: [{ key: 9, kind: 'face', scope: { definition: 0 }, body: 7, feature: 'f', shown: true }],
      pauses: [],
      stale: [],
      outOfDate: [],
      timing: { evaluate: 0, display: 0, resumed: 0 },
    } as unknown as Display;
    // Entities are looked up by key, so the face sits at index 9.
    (display.entities as unknown[])[9] = display.entities[0];
    const targets = snapTargets(display, 7, FRAME);
    expect(targets.map((t) => t.kind)).toEqual(['centre', 'point', 'origin']);
    close(targets[1]!.uv, [-8, 6]);
    expect(snapTargets(display, 99, FRAME).map((t) => t.kind)).toEqual(['origin']);

    const onEdge = snapOnFace(display, { key: 9 }, FRAME, [14.8, -3.2], 0.5);
    close(onEdge.uv, [5, -3]);
    expect(onEdge.target?.kind).toBe('centre');
    expect(snapOnFace(display, { key: 9 }, FRAME, [9, 0], 0.5)).toEqual({ uv: [9, 0], target: null });
    // Through another instance only the origin is offered.
    expect(
      snapOnFace(display, { key: 9, instance: { assembly: 'a', index: 0 } }, FRAME, [14.8, -3.2], 0.5).target,
    ).toBeNull();
  });
});
