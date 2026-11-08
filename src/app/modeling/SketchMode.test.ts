import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openTestSession } from '../../sketcher/testKit';
import { loadTestSolver } from '../../sketcher/testSetup';
import { clearConsole, consoleStore } from '../console';
import { closeSketchSession } from './SketchMode';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});
beforeEach(() => clearConsole());

const sketchLines = () =>
  consoleStore
    .getState()
    .entries.filter((e) => e.source === 'sketch')
    .map((e) => e.message);

describe('the console while sketching', () => {
  it('stays quiet while the sketch is edited, and says once on leaving how far it is from defined', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 12);
    t.click(40, 30);
    t.key('Escape');
    expect(sketchLines()).toEqual([]);
    closeSketchSession(t.session);
    expect(sketchLines()).toEqual(['Sketch under-constrained: 4 DOF remaining. Undimensioned: Line 1, Line 2.']);
  });

  it('says nothing on leaving a sketch with no degrees of freedom left', () => {
    const t = openTestSession(gcs);
    closeSketchSession(t.session);
    expect(sketchLines()).toEqual([]);
  });
});
