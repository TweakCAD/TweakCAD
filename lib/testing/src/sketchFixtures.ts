/**
 * Sketch fixtures for tests, described by shape rather than by point graph.
 *
 * Before `buildGeometry` became derived, a test sketch was a flat literal:
 * `{ c: { type: 'circle', center: ['0','0'], diameter: '4' } }`. That form no
 * longer exists in the document — the editor model is the source, and the
 * projection is computed from it — so a fixture now has to supply points,
 * geometries holding point ids, and the constraints between them.
 *
 * Writing that by hand ten times would make the fixtures longer than the
 * assertions and invite transcription mistakes that look like real failures.
 * These helpers keep a test saying "a circle of diameter 4 at the origin"
 * while producing a genuine editor model underneath.
 *
 * Deliberately not a mirror of the retired format: `diameter` is a number
 * here, not an `Expression`. Parameter-driven geometry belongs on a dimension
 * constraint now, and a fixture that wants one should add it explicitly.
 */

import type {
  SketchFeatureInputs,
  SketchEditorSnapshot,
} from '@tweakcad/core/src/document/schema.ts';
import type { PlaneRef } from '@tweakcad/core/src/document/schema.ts';

export type CircleSpec = {
  id: string;
  center: [number, number];
  diameter: number;
  construction?: boolean;
};

export type LineSpec = {
  id: string;
  start: [number, number];
  end: [number, number];
  construction?: boolean;
};

export type SketchSpec = {
  plane?: PlaneRef;
  circles?: CircleSpec[];
  lines?: LineSpec[];
  /** Extra constraints, e.g. a dimension carrying a parameter expression. */
  constraints?: unknown[];
};

const XY: PlaneRef = { type: 'defaultPlane', name: 'XY' };

/**
 * Build a sketch feature's `inputs` from a shape description.
 *
 * Entity ids are preserved as geometry ids, because the derived projection
 * keys on them — a `ProfileRef.wireEntityIds` in the same test still matches.
 */
export function sketchInputs(spec: SketchSpec): SketchFeatureInputs {
  const points: unknown[] = [];
  const geometries: unknown[] = [];

  for (const c of spec.circles ?? []) {
    const pid = `${c.id}_c`;
    points.push({ id: pid, x: c.center[0], y: c.center[1], fixed: false });
    geometries.push({
      id: c.id,
      type: 'circle',
      centerId: pid,
      radius: c.diameter / 2,
      construction: c.construction === true,
    });
  }

  for (const l of spec.lines ?? []) {
    const a = `${l.id}_a`;
    const b = `${l.id}_b`;
    points.push({ id: a, x: l.start[0], y: l.start[1], fixed: false });
    points.push({ id: b, x: l.end[0], y: l.end[1], fixed: false });
    geometries.push({
      id: l.id,
      type: 'line',
      startId: a,
      endId: b,
      construction: l.construction === true,
    });
  }

  const editorModel: SketchEditorSnapshot = {
    points,
    geometries,
    constraints: spec.constraints ?? [],
  };

  return { plane: spec.plane ?? XY, editorModel };
}

/** One circle at the origin — the most common single-profile fixture. */
export function circleSketchInputs(diameter: number, id = 'c1'): SketchFeatureInputs {
  return sketchInputs({ circles: [{ id, center: [0, 0], diameter }] });
}
