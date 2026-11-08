import { describe, expect, it } from 'vitest';
import { animationFrames } from './jointActions';

describe('joint animation', () => {
  it('runs a limited turn from where it stands to each limit and back', () => {
    const frames = animationFrames(['rz'], { rz: 10 }, { rz: { min: -30, max: 90 } }, 6);
    expect(frames.map((f) => Math.round(f.rz as number))).toEqual([10, 50, 90, 30, -30, -10, 10]);
  });

  it('turns a free turn once round, and swings a free slide 20 mm each way', () => {
    const turn = animationFrames(['rz'], { rz: 0 }, { rz: null }, 4);
    expect(turn.map((f) => f.rz)).toEqual([0, 90, 180, 270, 360]);
    const slide = animationFrames(['tz'], { tz: 5 }, {}, 4);
    expect(slide.map((f) => Math.round(f.tz as number))).toEqual([5, 25, 5, -15, 5]);
  });
});
