import { describe, expect, it } from 'vitest';
import type { Display, SketchDisplay } from '@tweakcad/worker/src/v2/service/types';
import type { AppServices } from '../services';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MISSING_COLOR } from './panelKit';
import { ProfileRow } from './ProfileRow';
import {
  clickedProfile,
  isMissingProfile,
  profilesLabel,
  regionKeysAt,
  toggleProfile,
  type ExtrudeProfile,
} from './profiles';

/** A square loop in the part frame on the plane z = 5, from sketch-frame corners. */
const square = (x0: number, y0: number, x1: number, y1: number) =>
  new Float32Array([x0, y0, 5, x1, y0, 5, x1, y1, 5, x0, y1, 5, x0, y0, 5]);

function displayWith(sketch: Partial<SketchDisplay>): Display {
  const s = {
    feature: 'feat_s',
    frame: { origin: [0, 0, 5], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
    visible: true,
    curves: [],
    externals: [],
    points: [],
    regions: [],
    ...sketch,
  };
  return {
    parts: { part_1: 0 },
    definitions: [
      { index: 0, part: 'part_1', variant: '', rollback: null, bodies: [], sketches: [s], construction: [] },
    ],
  } as unknown as Display;
}

describe('regionKeysAt', () => {
  const display = displayWith({
    regions: [
      { key: 7, row: null, loops: [square(0, 0, 100, 100), square(40, 40, 60, 60)] },
      { key: 8, row: null, loops: [square(40, 40, 60, 60)] },
      { key: 9, row: null, loops: [square(200, 0, 220, 20)] },
    ],
  });

  it('finds the smallest region holding each point, outside its holes', () => {
    expect(regionKeysAt(display, 'part_1', 'feat_s', [[10, 10]])).toEqual([7]);
    expect(regionKeysAt(display, 'part_1', 'feat_s', [[50, 50]])).toEqual([8]);
    expect(
      regionKeysAt(display, 'part_1', 'feat_s', [
        [50, 50],
        [210, 10],
        [10, 10],
        [11, 11],
      ]),
    ).toEqual([8, 9, 7]);
  });

  it('finds nothing outside every region, or for another sketch', () => {
    expect(regionKeysAt(display, 'part_1', 'feat_s', [[150, 150]])).toEqual([]);
    expect(regionKeysAt(display, 'part_1', 'feat_other', [[10, 10]])).toEqual([]);
  });
});

const row = (r: string): ExtrudeProfile => ({ sketch: 'feat_s', row: r });
const lost = (): ExtrudeProfile => ({
  kept: { entity: { id: [], branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } },
});

describe('profilesLabel', () => {
  it('names the sketch, then counts the profiles', () => {
    expect(profilesLabel([], 'Sketch 2')).toBeNull();
    expect(profilesLabel([row('a')], 'Sketch 2')).toBe('Sketch 2');
    expect(profilesLabel([row('a'), row('b')], 'Sketch 2')).toBe('2 profiles from Sketch 2');
  });

  it('says how many are missing, never counting them as found', () => {
    expect(profilesLabel([lost()], 'Sketch')).toBe('1 profile missing');
    expect(profilesLabel([lost(), lost()], 'Sketch')).toBe('2 profiles missing');
    expect(profilesLabel([lost(), row('a')], 'Sketch 2')).toBe('1 profile from Sketch 2, 1 missing');
    expect(profilesLabel([row('a'), lost(), row('b'), lost()], 'Sketch 2')).toBe('2 profiles from Sketch 2, 2 missing');
  });
});

describe('clickedProfile', () => {
  it('puts a clicked region in place of the first missing profile', () => {
    const first = lost();
    const second = lost();
    const once = clickedProfile([row('a'), first, second], row('b'));
    expect(once).toEqual([row('a'), row('b'), second]);
    expect(clickedProfile(once, row('c'))).toEqual([row('a'), row('b'), row('c')]);
    expect(once.filter(isMissingProfile)).toHaveLength(1);
  });

  it('adds a region when none is missing, and drops one clicked again', () => {
    expect(clickedProfile([row('a')], row('b'))).toEqual([row('a'), row('b')]);
    const missing = lost();
    expect(clickedProfile([row('a'), missing], row('a'))).toEqual([missing]);
  });
});

describe('ProfileRow', () => {
  const html = (profiles: ExtrudeProfile[]) =>
    renderToStaticMarkup(createElement(ProfileRow, { profiles, sketchName: 'Sketch 2', onRemove: () => undefined }));

  it('lists each missing profile in red with a remove button', () => {
    const out = html([lost(), row('a')]);
    expect(out).toContain('1 profile from Sketch 2, 1 missing');
    expect(out.match(/Missing profile/g)).toHaveLength(1);
    expect(out).toMatch(new RegExp(`color:${MISSING_COLOR}[^>]*>Missing profile`));
    expect(out).toMatch(/title="Remove"/);
  });

  it('shows no missing rows when every profile is found, and the hint when there is none', () => {
    expect(html([row('a')])).not.toContain('Missing profile');
    expect(html([])).toContain('Click a closed region');
  });
});

describe('toggleProfile', () => {
  it('counts every click when the picks of two clicks overlap', async () => {
    const display = displayWith({
      regions: [
        { key: 7, row: null, loops: [square(0, 0, 10, 10)] },
        { key: 9, row: null, loops: [square(20, 0, 30, 10)] },
      ],
    });
    const waiting: (() => void)[] = [];
    let n = 0;
    const services = {
      display: { getState: () => ({ display }) },
      editor: { newId: () => `reg_${++n}` },
      pick: ({ key }: { key: number }) =>
        new Promise((resolve) => waiting.push(() => resolve({ region: { sketch: 'feat_s', loop: [key], holes: [] } }))),
    } as unknown as AppServices;
    let profiles: ExtrudeProfile[] = [];
    const first = toggleProfile(services, 'part_1', profiles, 7);
    const second = toggleProfile(services, 'part_1', profiles, 9);
    waiting[1]!();
    waiting[0]!();
    for (const r of [await second, await first]) if (r && 'toggle' in r) profiles = r.toggle(profiles);
    expect(profiles.map((p) => ('detected' in p ? p.detected?.loop : null))).toEqual([[9], [7]]);
  });
});
