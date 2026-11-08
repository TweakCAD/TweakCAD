import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { openTestSession } from '../../sketcher/testKit';
import { loadTestSolver } from '../../sketcher/testSetup';
import { modelToolGroups, sketchRibbon } from './ribbons';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

describe('the sketch ribbon', () => {
  it('lays out its groups in order, with menus on Select and Dimension, and the point-on constraints', () => {
    const t = openTestSession(gcs);
    const groups = sketchRibbon(t.session, t.session.getState());
    expect(groups.map((g) => g.label)).toEqual(['SELECT', 'CREATE', 'CONSTRAINTS', 'DIMENSION', 'MODIFY', 'INSERT']);
    expect(groups.filter((g) => g.menu).map((g) => g.label)).toEqual(['SELECT', 'DIMENSION']);
    expect(groups[0]?.tools[0]?.menuLabel).toBe('Select (Esc)');
    const constraints = groups.find((g) => g.label === 'CONSTRAINTS')?.tools.map((c) => c.label) ?? [];
    expect(constraints.slice(6, 10)).toEqual(['Horizontal', 'Vertical', 'Point on line', 'Point on circle']);
  });

  it('offers every constraint with nothing selected, and shows the one chosen as active', () => {
    const t = openTestSession(gcs);
    const before = sketchRibbon(t.session, t.session.getState()).find((g) => g.label === 'CONSTRAINTS')?.tools ?? [];
    expect(before.filter((c) => c.disabled)).toEqual([]);
    before.find((c) => c.id === 'coincident')?.onClick();
    const after = sketchRibbon(t.session, t.session.getState()).find((g) => g.label === 'CONSTRAINTS')?.tools ?? [];
    expect(after.filter((c) => c.active).map((c) => c.id)).toEqual(['coincident']);
    expect(t.session.getState().prompt).toBe('Click a point, then a point or curve');
  });

  it('letters P to Project, and the key picks it', () => {
    const t = openTestSession(gcs);
    const create = sketchRibbon(t.session, t.session.getState()).find((g) => g.label === 'CREATE');
    expect(create?.tools.find((c) => c.shortcut === 'P')?.id).toBe('project');
    t.session.key({ key: 'p', target: null } as unknown as KeyboardEvent);
    expect(t.session.getState().tool).toBe('project');
  });
});

describe('modelling ribbon', () => {
  it('lays the groups out as CREATE, MODIFY, CONSTRUCT, ASSEMBLE, INSPECT', () => {
    expect(modelToolGroups().map((g) => g.label)).toEqual(['CREATE', 'MODIFY', 'CONSTRUCT', 'ASSEMBLE', 'INSPECT']);
  });

  it('orders MODIFY as Fillet, Chamfer, Shell, Combine, then Move, Parameters, Remove Body, with one Combine for join, cut and intersect', () => {
    const modify = modelToolGroups().find((g) => g.label === 'MODIFY');
    expect(modify?.tools.map((t) => t.label)).toEqual([
      'Fillet',
      'Chamfer',
      'Shell',
      'Combine',
      'Move',
      'Parameters',
      'Remove Body',
    ]);
    expect(modify?.tools.filter((t) => t.primary !== false).map((t) => t.label)).toEqual([
      'Fillet',
      'Chamfer',
      'Shell',
      'Combine',
    ]);
    const all = modelToolGroups().flatMap((g) => g.tools.map((t) => t.id));
    expect(all).not.toContain('cut');
    expect(all).not.toContain('intersect');
  });

  it('keeps Pattern and Mirror in CREATE', () => {
    const create = modelToolGroups().find((g) => g.label === 'CREATE');
    expect(create?.tools.map((t) => t.label)).toEqual(expect.arrayContaining(['Pattern', 'Mirror']));
  });

  it('letters tools: no S (the toolbox), I for Measure', () => {
    const lettered = Object.fromEntries(
      modelToolGroups().flatMap((g) => g.tools.filter((t) => t.shortcut).map((t) => [t.shortcut, t.label])),
    );
    expect(lettered).toMatchObject({ E: 'Extrude', H: 'Hole', F: 'Fillet', M: 'Move', J: 'Joint', I: 'Measure' });
    expect(lettered.S).toBeUndefined();
    const inspect = modelToolGroups().find((g) => g.label === 'INSPECT');
    expect(inspect?.tools.filter((t) => t.primary !== false).map((t) => t.label)).toEqual(['Measure', 'Section']);
  });

  it('offers Offset Plane and Plane from Face as buttons in CONSTRUCT, with the other construction tools, Midplane, Axis Through Cylinder and Point at Center among them, in its menu', () => {
    const construct = modelToolGroups().find((g) => g.label === 'CONSTRUCT');
    expect(construct?.tools.filter((t) => t.primary !== false).map((t) => t.label)).toEqual([
      'Offset Plane',
      'Plane from Face',
    ]);
    expect(construct?.tools.map((t) => t.panel)).toEqual([
      'construction.offsetPlane',
      'construction.planeFromFace',
      'construction.plane',
      'construction.midplane',
      'construction.axis',
      'construction.axisThroughCylinder',
      'construction.point',
      'construction.pointAtCenter',
      'construction.frame',
    ]);
  });
});
