import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { fitFraming, homeFraming, lerpFraming, HOME_EMPTY_RADIUS } from './cameraFraming.ts';

const FOV = 45;

function box(min: [number, number, number], max: [number, number, number]): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
}

describe('fitFraming', () => {
  it('centres on the box and backs off by the padded fov distance', () => {
    const f = fitFraming(box([10, 0, -4], [30, 8, 4]), FOV)!;
    expect(f.target.toArray()).toEqual([20, 4, 0]);
    const expected = (20 / (2 * Math.tan((FOV * Math.PI) / 180 / 2))) * 1.5;
    expect(f.radius).toBeCloseTo(expected, 9);
  });

  it('never sits closer than the minimum distance', () => {
    expect(fitFraming(box([0, 0, 0], [0.1, 0.1, 0.1]), FOV)!.radius).toBe(5);
  });

  it('returns null for an empty or non-finite box', () => {
    expect(fitFraming(new THREE.Box3(), FOV)).toBeNull();
    expect(fitFraming(box([0, 0, 0], [NaN, 1, 1]), FOV)).toBeNull();
  });
});

describe('homeFraming', () => {
  it('frames the bodies exactly like Fit All', () => {
    const b = box([-50, 0, -50], [150, 80, 50]);
    const home = homeFraming(b, FOV);
    const fit = fitFraming(b, FOV)!;
    expect(home.target.toArray()).toEqual(fit.target.toArray());
    expect(home.radius).toBe(fit.radius);
  });

  it('falls back to the origin at the default distance with no bodies', () => {
    const home = homeFraming(new THREE.Box3(), FOV);
    expect(home.target.toArray()).toEqual([0, 0, 0]);
    expect(home.radius).toBe(HOME_EMPTY_RADIUS);
  });
});

describe('lerpFraming', () => {
  const from = { target: new THREE.Vector3(0, 0, 0), radius: 50 };
  const to = { target: new THREE.Vector3(20, 4, -10), radius: 200 };

  it('starts at the current framing and ends at the destination', () => {
    const out = { target: new THREE.Vector3(), radius: 0 };
    lerpFraming(from, to, 0, out);
    expect(out.target.toArray()).toEqual([0, 0, 0]);
    expect(out.radius).toBe(50);
    lerpFraming(from, to, 1, out);
    expect(out.target.toArray()).toEqual([20, 4, -10]);
    expect(out.radius).toBe(200);
  });

  it('blends target and radius together mid-way', () => {
    const out = lerpFraming(from, to, 0.5, { target: new THREE.Vector3(), radius: 0 });
    expect(out.target.toArray()).toEqual([10, 2, -5]);
    expect(out.radius).toBe(125);
  });
});
