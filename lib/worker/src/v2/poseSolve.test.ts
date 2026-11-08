import { describe, expect, it } from 'vitest';
import { IDENTITY, apply, type Rigid } from './rigid';
import { jointMotion, solvePose, type SolveInput, type SolveJoint } from './poseSolve';

const at = (x: number, y = 0, z = 0): Rigid => ({ position: [x, y, z], rotation: [0, 0, 0, 1] });
const revolute = (
  id: string,
  a: SolveJoint['a'],
  b: SolveJoint['b'],
  rz: number,
  limit?: [number, number],
): SolveJoint => ({
  id,
  dofs: ['rz'],
  a,
  b,
  start: [rz],
  limits: [limit ?? null],
});
const distance = (p: readonly number[], q: readonly number[]) => Math.hypot(...p.map((v, i) => v - (q[i] as number)));

describe('the pose solve', () => {
  it('turns about z first, then y, then x, after the translations', () => {
    const m = jointMotion(['tx', 'rz', 'rx'], [5, 90, 90]);
    // After the turn about z, the turn about the moved x takes z to the opposite of the moved y.
    expect(apply(m, [1, 0, 0]).map((v) => +v.toFixed(12) + 0)).toEqual([5, 1, 0]);
    expect(apply(m, [0, 0, 1]).map((v) => +v.toFixed(12) + 0)).toEqual([6, 0, 0]);
  });

  it('moves by every initial joint kind', () => {
    const moved = (dofs: string[], q: number[], p: [number, number, number]) =>
      apply(jointMotion(dofs, q), p).map((v) => +v.toFixed(12) + 0);
    expect(moved(['tz'], [3], [1, 0, 0])).toEqual([1, 0, 3]);
    expect(moved(['tx', 'rz'], [2, 90], [1, 0, 0])).toEqual([2, 1, 0]);
    expect(moved(['tx', 'ty', 'rz'], [1, 2, 180], [1, 0, 0])).toEqual([0, 2, 0]);
    expect(moved(['rz', 'ry', 'rx'], [90, 90, 0], [0, 0, 1])).toEqual([0, 1, 0]);
    expect(moved([], [], [1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('places a chain exactly at its starting states, and a group joined to nothing grounded where it is', () => {
    const input: SolveInput = {
      bodies: [
        { stored: at(0), grounded: true },
        { stored: at(99, 99), grounded: false },
        { stored: at(-50), grounded: false },
        { stored: at(7, 7, 7), grounded: false },
      ],
      nodes: [0, 1, 2, 3].map((body) => ({ body, offset: IDENTITY })),
      joints: [
        revolute('j1', { node: 0, frame: at(10) }, { node: 1, frame: IDENTITY }, 90),
        revolute('j2', { node: 1, frame: at(10) }, { node: 2, frame: IDENTITY }, -90),
      ],
      relations: [],
    };
    const out = solvePose(input);
    expect(out.unsatisfied).toEqual([]);
    expect(out.values).toEqual([[90], [-90]]);
    expect(distance(out.placements[1]?.position as number[], [10, 0, 0])).toBeLessThan(1e-12);
    expect(distance(out.placements[2]?.position as number[], [10, 10, 0])).toBeLessThan(1e-12);
    expect(out.placements[3]).toEqual(at(7, 7, 7));
  });

  it('closes a four-bar linkage with the crank held, moving the rest as little as it can', () => {
    // Ground pivots 40 mm apart; a 10 mm crank, a 40 mm coupler and a 20 mm rocker, each along its own x.
    const input: SolveInput = {
      bodies: [
        { stored: IDENTITY, grounded: false },
        { stored: IDENTITY, grounded: false },
        { stored: IDENTITY, grounded: false },
      ],
      nodes: [0, 1, 2].map((body) => ({ body, offset: IDENTITY })),
      joints: [
        revolute('crank', { node: null, frame: IDENTITY }, { node: 0, frame: IDENTITY }, 60, [60, 60]),
        revolute('pin', { node: 0, frame: at(10) }, { node: 1, frame: IDENTITY }, 0),
        revolute('close', { node: 1, frame: at(40) }, { node: 2, frame: at(20) }, 0),
        revolute('rocker', { node: null, frame: at(40) }, { node: 2, frame: IDENTITY }, 90),
      ],
      relations: [],
    };
    const out = solvePose(input);
    expect(out.unsatisfied).toEqual([]);
    expect(out.values[0]).toEqual([60]);
    const [crank, coupler, rocker] = out.placements as [Rigid, Rigid, Rigid];
    expect(distance(apply(crank, [10, 0, 0]), apply(coupler, [0, 0, 0]))).toBeLessThan(1e-9);
    expect(distance(apply(coupler, [40, 0, 0]), apply(rocker, [20, 0, 0]))).toBeLessThan(1e-9);
    expect(distance(apply(rocker, [0, 0, 0]), [40, 0, 0])).toBeLessThan(1e-9);
    // The rocker stays on the branch it started near: its tip above the ground line.
    expect(apply(rocker, [20, 0, 0])[1]).toBeGreaterThan(0);
  });

  it('drives a screw and a rack from their relations, and reports a loop that cannot close', () => {
    const screw: SolveJoint = {
      id: 's',
      dofs: ['tz', 'rz'],
      a: { node: null, frame: IDENTITY },
      b: { node: 0, frame: IDENTITY },
      start: [0, 720],
      limits: [null, null],
    };
    const out = solvePose({
      bodies: [{ stored: IDENTITY, grounded: false }],
      nodes: [{ body: 0, offset: IDENTITY }],
      joints: [screw],
      relations: [{ id: 'lead', a: { joint: 0, dof: 1 }, b: { joint: 0, dof: 0 }, ratio: 1.5 / 360 }],
    });
    expect(out.values[0]?.[0]).toBeCloseTo(3, 12);

    const stuck = solvePose({
      bodies: [
        { stored: IDENTITY, grounded: true },
        { stored: IDENTITY, grounded: false },
      ],
      nodes: [0, 1].map((body) => ({ body, offset: IDENTITY })),
      joints: [
        revolute('hinge', { node: 0, frame: IDENTITY }, { node: 1, frame: IDENTITY }, 0),
        {
          id: 'slide',
          dofs: ['tz'],
          a: { node: 0, frame: IDENTITY },
          b: { node: 1, frame: IDENTITY },
          start: [5],
          limits: [[5, 5]],
        },
      ],
      relations: [],
    });
    expect(stuck.unsatisfied).toEqual(['slide']);
    expect(stuck.values).toEqual([[0], [5]]);
  });

  it('moves a copy with its seed', () => {
    const shift = (p: Rigid): Rigid => ({ ...p, position: [p.position[0] + 100, p.position[1], p.position[2]] });
    const back = (p: Rigid): Rigid => ({ ...p, position: [p.position[0] - 100, p.position[1], p.position[2]] });
    // The copy is jointed to the ground; its seed follows.
    const out = solvePose({
      bodies: [{ stored: at(3, 3), grounded: false }],
      nodes: [
        { body: 0, offset: IDENTITY },
        { seed: 0, follow: shift, unfollow: back },
      ],
      joints: [revolute('j', { node: null, frame: at(150) }, { node: 1, frame: IDENTITY }, 0)],
      relations: [],
    });
    expect(distance(out.placements[1]?.position as number[], [150, 0, 0])).toBeLessThan(1e-12);
    expect(distance(out.placements[0]?.position as number[], [50, 0, 0])).toBeLessThan(1e-12);
  });
});
