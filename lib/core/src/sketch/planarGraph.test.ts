/**
 * Face coverage for `detectIntersectionRegions`: every bounded area of a
 * sketch whose entities cross comes back as its own face, including faces
 * whose boundary runs through a circle's 0° sample point.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyEditorState,
  drawCircle,
  drawLine,
  makeCounterIdFactory,
  type EditorState,
} from './operations.ts';
import { editorModelToBuildGeometry } from './serialization.ts';
import { detectIntersectionRegions, type PlanarFace } from './planarGraph.ts';

const facesOf = (
  build: (s: EditorState, idFactory: ReturnType<typeof makeCounterIdFactory>) => EditorState,
): PlanarFace[] => {
  const idFactory = makeCounterIdFactory();
  return detectIntersectionRegions(editorModelToBuildGeometry(build(emptyEditorState(), idFactory)));
};

/** Area of the part of a radius-`r` disc beyond a chord `d` from its centre. */
const capArea = (r: number, d: number): number => r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d);

const byArea = (faces: PlanarFace[]): PlanarFace[] => [...faces].sort((a, b) => a.area - b.area);

describe('detectIntersectionRegions — circle faces', () => {
  it('a line across a circle gives both caps', () => {
    const faces = byArea(facesOf((s, idFactory) => {
      const st = drawCircle(s, { center: [0, 0], radius: 10 }, { idFactory }).state;
      return drawLine(st, [-20, 2], [20, 2], { idFactory }).state;
    }));
    expect(faces).toHaveLength(2);
    const [upper, lower] = faces;
    expect(upper!.area).toBeCloseTo(capArea(10, 2), -0.5);
    expect(upper!.centroid[1]).toBeGreaterThan(2);
    expect(lower!.area).toBeCloseTo(Math.PI * 100 - capArea(10, 2), -0.5);
    expect(lower!.centroid[1]).toBeLessThan(2);
  });

  it('a chord ending on the circle gives both caps', () => {
    const x = Math.sqrt(96);
    const faces = byArea(facesOf((s, idFactory) => {
      const st = drawCircle(s, { center: [0, 0], radius: 10 }, { idFactory }).state;
      return drawLine(st, [-x, 2], [x, 2], { idFactory }).state;
    }));
    expect(faces).toHaveLength(2);
    expect(faces[0]!.centroid[1]).toBeGreaterThan(2);
    expect(faces[1]!.centroid[1]).toBeLessThan(2);
  });

  it('two overlapping circles give the lens and both crescents', () => {
    const faces = byArea(facesOf((s, idFactory) => {
      const st = drawCircle(s, { center: [0, 0], radius: 8 }, { idFactory }).state;
      return drawCircle(st, { center: [10, 0], radius: 8 }, { idFactory }).state;
    }));
    expect(faces).toHaveLength(3);
    const lens = 2 * capArea(8, 5);
    const crescent = Math.PI * 64 - lens;
    const [lensFace, ...crescents] = faces;
    expect(lensFace!.area).toBeCloseTo(lens, -0.5);
    expect(lensFace!.centroid[0]).toBeCloseTo(5, 3);
    expect(crescents.map(f => f.area)).toEqual([
      expect.closeTo(crescent, -0.5),
      expect.closeTo(crescent, -0.5),
    ]);
    expect(crescents.map(f => Math.sign(f.centroid[0] - 5)).sort()).toEqual([-1, 1]);
  });

  it('an arc through the circle\'s 0° point stays one arc bounded by the crossings', () => {
    const faces = facesOf((s, idFactory) => {
      const st = drawCircle(s, { center: [0, 0], radius: 10 }, { idFactory }).state;
      return drawLine(st, [-20, 2], [20, 2], { idFactory }).state;
    });
    for (const face of faces) {
      expect(face.edges.filter(e => e.curveType === 'arc')).toHaveLength(1);
      for (const edge of face.edges) expect(edge.identity).not.toContain('?');
    }
    const lower = faces.find(f => f.centroid[1] < 0)!;
    const arc = lower.edges.find(e => e.curveType === 'arc')!;
    // The lower arc runs the long way round, through 0°.
    expect(Math.abs(arc.endAngle! - arc.startAngle!)).toBeGreaterThan(Math.PI);
  });
});
