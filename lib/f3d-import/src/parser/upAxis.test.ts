import { describe, expect, it } from 'vitest';
import { buildDesign, head } from './designBuilder.testHelper';
import { parseDesignIndex } from './designIndex';
import { readUpAxis } from './upAxis';

const CAMERA = '736DEAAF';
const VIEW = '1787C882';

/** A design holding saved views, each a view record naming the camera before it. */
function withViews(views: { name: string; up: [number, number, number] }[]) {
  const records = views.flatMap(({ name, up }, i) => {
    const camera = 10 + 2 * i;
    return [
      {
        id: camera,
        type: CAMERA,
        // A field angle, the eye, the target, then the up vector.
        primary: (w: Parameters<typeof head>[0]) => {
          head(w, camera).f64(0.395);
          for (const v of [0, -20, 2.5, 0, -1.3, 2.5, ...up]) w.f64(v);
        },
      },
      {
        id: camera + 1,
        type: VIEW,
        primary: (w: Parameters<typeof head>[0]) => head(w, camera + 1).wstr(name).ref(camera).zeros(4),
      },
    ];
  });
  const { meta, bulk } = buildDesign(records);
  return parseDesignIndex(meta, bulk);
}

describe('readUpAxis', () => {
  it('reads Z up from the FRONT view', () => {
    const index = withViews([
      { name: 'TOP', up: [0, 1, 0] },
      { name: 'FRONT', up: [0, 0, 1] },
    ]);
    expect(readUpAxis(index)).toBe('z');
  });

  it('reads Y up', () => {
    expect(readUpAxis(withViews([{ name: 'FRONT', up: [0, 1, 0] }]))).toBe('y');
  });

  it('says nothing for a design with no FRONT view, or one turned off the axes', () => {
    expect(readUpAxis(withViews([{ name: 'TOP', up: [0, 1, 0] }]))).toBeNull();
    expect(readUpAxis(withViews([{ name: 'FRONT', up: [0, Math.SQRT1_2, Math.SQRT1_2] }]))).toBeNull();
  });
});
