import { describe, it, expect } from 'vitest';
import type { CadProject, ConstructionPlaneDisplay, FeatureId } from '@tweakcad/core/src/document/schema.ts';
import { withDocumentVisibility } from './planeVisibility.ts';

const plane = (id: string, visible: boolean): ConstructionPlaneDisplay => ({
  featureId: id as FeatureId,
  name: id,
  visible,
  origin: [0, 0, 0],
  uAxis: [1, 0, 0],
  vAxis: [0, 1, 0],
  normal: [0, 0, 1],
});

// Only what the helper reads: each part's timeline of {id, type, visible}.
const project = (features: Array<{ id: string; type: string; visible: boolean }>) =>
  ({ parts: { p1: { timeline: features } } }) as unknown as CadProject;

describe('withDocumentVisibility', () => {
  it('hides a plane the document hid, before any rebuild', () => {
    const built = [plane('cp1', true), plane('cp2', true)];
    const out = withDocumentVisibility(built, project([
      { id: 'cp1', type: 'constructionPlane', visible: false },
      { id: 'cp2', type: 'constructionPlane', visible: true },
    ]));
    expect(out.map((p) => p.visible)).toEqual([false, true]);
  });

  it('shows a plane the document showed again', () => {
    const out = withDocumentVisibility([plane('cp1', false)], project([
      { id: 'cp1', type: 'constructionPlane', visible: true },
    ]));
    expect(out[0]!.visible).toBe(true);
  });

  it('returns the same array when nothing differs', () => {
    const built = [plane('cp1', true)];
    const out = withDocumentVisibility(built, project([
      { id: 'cp1', type: 'constructionPlane', visible: true },
      { id: 's1', type: 'sketch', visible: false },
    ]));
    expect(out).toBe(built);
  });

  it('keeps the built flag for a plane the document no longer has', () => {
    const built = [plane('gone', true)];
    expect(withDocumentVisibility(built, project([]))).toBe(built);
  });
});
