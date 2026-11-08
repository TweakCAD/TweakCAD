import { describe, expect, it } from 'vitest';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { STANDARD_FRAMES } from './ModelScene';
import { lookAtSketch, sketchViewFollower } from './ViewportView';
import { SECTION_FRAMES, sectionCut, sectionDistance } from './sectionCut';
import { viewAlong, type Viewport } from './Viewport';

/** A viewport that records what it is told, for a sketch drawn in `frame`. */
function recorder(frame: FrameDisplay | null) {
  const calls: unknown[][] = [];
  const viewport = {
    model: { sketchFrame: () => frame },
    setCameraUp: (up: unknown) => calls.push(['up', up]),
    goToView: (theta: number, phi: number, framed: boolean) => calls.push(['view', theta, phi, framed]),
    restoreViewState: (state: unknown) => calls.push(['restore', state]),
  } as unknown as Viewport;
  return { viewport, calls };
}

describe('the sketch view', () => {
  it('looks at a sketch head-on, its y axis up, framing the model (entering it, and Home while in it)', () => {
    const frame = STANDARD_FRAMES.xz;
    const { viewport, calls } = recorder(frame);
    lookAtSketch(viewport, 'feat_s');
    const { theta, phi } = viewAlong(frame.normal);
    expect(calls).toEqual([
      ['up', frame.y],
      ['view', theta, phi, true],
    ]);
  });

  it('keeps the view where it is on leaving the sketch, and looks at it the same way each time it is entered', () => {
    const frame = STANDARD_FRAMES.xz;
    const { viewport, calls } = recorder(frame);
    const follow = sketchViewFollower(viewport);
    follow('feat_s');
    const entering = calls.splice(0);
    follow('feat_s');
    expect(calls).toEqual([]);
    follow(null);
    expect(calls.splice(0)).toEqual([['up', [0, 1, 0]]]);
    follow('feat_s');
    expect(calls).toEqual(entering);
  });

  it('leaves the view alone for a sketch the scene does not show', () => {
    const { viewport, calls } = recorder(null);
    lookAtSketch(viewport, 'feat_s');
    expect(calls).toEqual([]);
  });
});

describe('the section view', () => {
  it('cuts parallel to the chosen standard plane, keeping the side its normal points to', () => {
    for (const [name, frame] of [
      ['XY', STANDARD_FRAMES.xy],
      ['XZ', STANDARD_FRAMES.xz],
      ['YZ', STANDARD_FRAMES.yz],
    ] as const) {
      expect(SECTION_FRAMES[name]).toEqual({ normal: frame.normal, x: frame.x });
    }
  });

  it('moves the cut by its distance, turns it by its angle, flips it, and reads a dragged cut back as a distance', () => {
    const close = (a: readonly number[] | undefined, b: number[]) =>
      b.forEach((v, i) => expect(a?.[i]).toBeCloseTo(v, 9));
    const view = { plane: 'XY' as const, distance: 5, angle: 0, flipped: false };
    expect(sectionCut({ ...view, distance: null })).toEqual({ normal: [0, 0, 1] });
    close(sectionCut(view).point, [0, 0, 5]);
    close(sectionCut({ ...view, flipped: true }).normal, [0, 0, -1]);
    // Turned 90 degrees about the plane's x axis, the XY cut stands like XZ, its normal along -y.
    close(sectionCut({ ...view, angle: 90 }).normal, [0, -1, 0]);
    const face = {
      plane: { label: 'Face', origin: [0, 0, 10] as const, normal: [1, 0, 0] as const, x: [0, 1, 0] as const },
      distance: 2,
      angle: 0,
      flipped: false,
    };
    close(sectionCut(face).point, [2, 0, 10]);
    expect(sectionDistance(face, [7, 3, -4])).toBeCloseTo(7, 9);
    // A turned cut dragged through a point gives the distance whose cut passes through it.
    const turned = { ...view, angle: 30 };
    const d = sectionDistance(turned, [0, 4, 6]);
    const cut = sectionCut({ ...turned, distance: d });
    const p = cut.point as number[];
    expect(
      cut.normal[0] * (0 - (p[0] as number)) +
        cut.normal[1] * (4 - (p[1] as number)) +
        cut.normal[2] * (6 - (p[2] as number)),
    ).toBeCloseTo(0, 9);
  });
});
