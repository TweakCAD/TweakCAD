import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SketchEditorState } from './SketchEditorStore.ts';
import type {
  SketchGeometry,
  SketchGeometryId,
  SketchPoint,
  SketchPointId,
} from '@tweakcad/core/src/sketch/types.ts';
import { sketchGeometryId, sketchPointId } from '@tweakcad/core/src/sketch/types.ts';
import { dispatchOffset } from './sketchDispatch.ts';
import { getOffsetDistance, getToolSession, resetToolSession, setOffsetDistance } from './sketchTools.ts';
import { handleOffsetClick } from './sketchToolsExt.ts';
import { parseOffsetDistance } from './OffsetDistanceInput.tsx';

vi.mock('./sketchDispatch.ts', () => ({ dispatchOffset: vi.fn(() => true) }));

/** One horizontal line from (0, 0) to (100, 0). */
function lineStore(): SketchEditorState {
  const points = new Map<SketchPointId, SketchPoint>([
    [sketchPointId('a'), { id: sketchPointId('a'), x: 0, y: 0 } as SketchPoint],
    [sketchPointId('b'), { id: sketchPointId('b'), x: 100, y: 0 } as SketchPoint],
  ]);
  const geometries = new Map<SketchGeometryId, SketchGeometry>([
    [sketchGeometryId('edge'), {
      id: sketchGeometryId('edge'),
      type: 'line',
      startId: sketchPointId('a'),
      endId: sketchPointId('b'),
      construction: false,
    }],
  ]);
  return { points, geometries, constructionMode: false } as unknown as SketchEditorState;
}

function sessionDistance(): number | undefined {
  const s = getToolSession();
  return s?.tool === 'offset' ? s.distance : undefined;
}

describe('offset tool distance', () => {
  beforeEach(() => {
    vi.mocked(dispatchOffset).mockClear();
    setOffsetDistance(5);
    resetToolSession('offset');
  });

  it('dispatches the typed distance for the clicked edge', () => {
    expect(setOffsetDistance(1)).toBe(true);
    handleOffsetClick(lineStore(), 50, 0);
    expect(dispatchOffset).toHaveBeenCalledWith('edge', 1, [50, 0], false);
  });

  it('keeps the last distance across tool switches', () => {
    setOffsetDistance(0.4);
    resetToolSession('line');
    resetToolSession('offset');
    expect(sessionDistance()).toBe(0.4);
    expect(getOffsetDistance()).toBe(0.4);
  });

  it('rejects zero, negative and non-finite distances', () => {
    setOffsetDistance(2);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(setOffsetDistance(bad)).toBe(false);
    }
    expect(sessionDistance()).toBe(2);
    handleOffsetClick(lineStore(), 50, 0);
    expect(dispatchOffset).toHaveBeenCalledWith('edge', 2, [50, 0], false);
  });
});

describe('parseOffsetDistance', () => {
  it('accepts positive decimals', () => {
    expect(parseOffsetDistance('1')).toBe(1);
    expect(parseOffsetDistance('0.4')).toBe(0.4);
    expect(parseOffsetDistance('.5')).toBe(0.5);
    expect(parseOffsetDistance('0,4')).toBe(0.4);
    expect(parseOffsetDistance(' 2.5 ')).toBe(2.5);
  });

  it('rejects zero, negatives and junk', () => {
    for (const bad of ['', '0', '0.0', '-1', '1x', 'abc', '1e3', '.']) {
      expect(parseOffsetDistance(bad)).toBeNull();
    }
  });
});
