import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SketchEditorState, PendingDimension } from './SketchEditorStore.ts';
import type {
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';
import { sketchGeometryId, sketchPointId } from '@tweakcad/core/src/sketch/types.ts';
import { handleDimensionClick, closeDimensionPrompt } from './sketchToolsExt.ts';

vi.mock('./sketchDispatch.ts', () => ({}));

/**
 * 100 x 50 rectangle as four lines. Only the slice of the editor store the
 * dimension tool reads and writes is modelled; the selection actions mirror
 * the real store's semantics.
 */
function rectangleStore(): SketchEditorState {
  const corners: [string, number, number][] = [
    ['p0', 0, 0], ['p1', 100, 0], ['p2', 100, 50], ['p3', 0, 50],
  ];
  const points = new Map<SketchPointId, SketchPoint>();
  for (const [id, x, y] of corners) {
    points.set(sketchPointId(id), { id: sketchPointId(id), x, y } as SketchPoint);
  }
  const geometries = new Map<SketchGeometryId, SketchGeometry>();
  const edges: [string, string, string][] = [
    ['bottom', 'p0', 'p1'], ['right', 'p1', 'p2'], ['top', 'p2', 'p3'], ['left', 'p3', 'p0'],
  ];
  for (const [id, a, b] of edges) {
    geometries.set(sketchGeometryId(id), {
      id: sketchGeometryId(id),
      type: 'line',
      startId: sketchPointId(a),
      endId: sketchPointId(b),
      construction: false,
    });
  }

  const store = {
    points,
    geometries,
    pendingDimension: null as PendingDimension | null,
    selectedGeometryIds: new Set<SketchGeometryId>(),
    setPendingDimension(p: PendingDimension | null) { store.pendingDimension = p; },
    selectGeometry(id: SketchGeometryId, additive: boolean) {
      const next = additive ? new Set(store.selectedGeometryIds) : new Set<SketchGeometryId>();
      if (next.has(id)) next.delete(id); else next.add(id);
      store.selectedGeometryIds = next;
    },
    clearSelection() { store.selectedGeometryIds = new Set<SketchGeometryId>(); },
  };
  return store as unknown as SketchEditorState;
}

const TOP = { x: 50, y: 50 };
const RIGHT = { x: 100, y: 25 };
const EMPTY = { x: 50, y: 25 };

describe('handleDimensionClick', () => {
  let store: SketchEditorState;
  beforeEach(() => { store = rectangleStore(); });

  it('picks a length for the next line after a length is committed', () => {
    handleDimensionClick(store, TOP.x, TOP.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'length', geometryId: 'top' });

    // Commit path of the prompt.
    closeDimensionPrompt(store);
    expect(store.selectedGeometryIds.size).toBe(0);

    handleDimensionClick(store, RIGHT.x, RIGHT.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'length', geometryId: 'right', current: 50 });
  });

  it('ignores a line left selected outside the tool', () => {
    store.selectGeometry(sketchGeometryId('top'), false);
    handleDimensionClick(store, RIGHT.x, RIGHT.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'length', geometryId: 'right' });
  });

  it('picks an angle when a second line is clicked while the first length prompt is open', () => {
    handleDimensionClick(store, TOP.x, TOP.y);
    handleDimensionClick(store, RIGHT.x, RIGHT.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'angle', geometryA: 'top', geometryB: 'right' });
    expect(Math.abs((store.pendingDimension as { current: number }).current)).toBeCloseTo(Math.PI / 2);
    expect([...store.selectedGeometryIds].sort()).toEqual(['right', 'top']);
  });

  it('clicking empty space closes the prompt and drops its highlight', () => {
    handleDimensionClick(store, TOP.x, TOP.y);
    expect([...store.selectedGeometryIds]).toEqual(['top']);

    handleDimensionClick(store, EMPTY.x, EMPTY.y);
    expect(store.pendingDimension).toBeNull();
    expect(store.selectedGeometryIds.size).toBe(0);

    handleDimensionClick(store, RIGHT.x, RIGHT.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'length', geometryId: 'right' });
  });

  it('re-picking the same line keeps a length prompt', () => {
    handleDimensionClick(store, TOP.x, TOP.y);
    handleDimensionClick(store, TOP.x, TOP.y);
    expect(store.pendingDimension).toMatchObject({ kind: 'length', geometryId: 'top' });
  });
});
