import { describe, expect, it } from 'vitest';
import {
  nextOpenGroup,
  opensToolbox,
  ribbonFit,
  ribbonGroupWidth,
  toolboxMatches,
  type RibbonToolGroup,
} from './MainToolbar';

const widthOf = (shown: number[]) => shown.reduce((sum, n) => sum + ribbonGroupWidth(n), 0);

describe('the ribbon layout', () => {
  const counts = [6, 4, 2, 4, 2];

  it('shows every button when they fit', () => {
    expect(ribbonFit(counts, widthOf(counts))).toEqual(counts);
    expect(ribbonFit(counts, 5000)).toEqual(counts);
  });

  it('moves buttons into the menus from the fullest group, keeping one in each', () => {
    const fit = ribbonFit(counts, widthOf(counts) - 1);
    expect(fit).toEqual([5, 4, 2, 4, 2]);
    expect(ribbonFit(counts, 0)).toEqual([1, 1, 1, 1, 1]);
    const narrow = ribbonFit(counts, 800);
    expect(widthOf(narrow)).toBeLessThanOrEqual(800);
    expect(narrow.every((n) => n >= 1)).toBe(true);
  });

  it('shows the buttons again when the ribbon widens', () => {
    const narrow = ribbonFit(counts, 400);
    expect(narrow).toEqual([1, 1, 1, 1, 1]);
    // The layout depends on the width alone, not on what showed before.
    expect(ribbonFit(counts, 1366)).toEqual(counts);
  });
});

describe('switching group menus', () => {
  it('opens another group on a press of its label while one is open', () => {
    expect(nextOpenGroup('CREATE', 'MODIFY', 'press')).toBe('MODIFY');
  });

  it('closes on a press of the open label or anywhere else', () => {
    expect(nextOpenGroup('CREATE', 'CREATE', 'press')).toBeNull();
    expect(nextOpenGroup('CREATE', null, 'press')).toBeNull();
  });

  it('follows the pointer onto another label while a menu is open', () => {
    expect(nextOpenGroup('CREATE', 'INSPECT', 'move')).toBe('INSPECT');
    expect(nextOpenGroup('CREATE', null, 'move')).toBe('CREATE');
    expect(nextOpenGroup(null, 'INSPECT', 'move')).toBeNull();
  });
});

describe('the toolbox', () => {
  const tool = (id: string, label: string, o: { disabled?: boolean; menuLabel?: string } = {}) => ({
    id,
    label,
    icon: null,
    onClick: () => undefined,
    ...o,
  });
  const groups: RibbonToolGroup[] = [
    { label: 'CREATE', tools: [tool('sketch', 'Sketch'), tool('extrude', 'Extrude'), tool('pattern', 'Pattern')] },
    {
      label: 'MODIFY',
      tools: [
        tool('fillet', 'Fillet'),
        tool('parameters', 'Parameters', { menuLabel: 'Change Parameters' }),
        tool('off', 'Offset', { disabled: true }),
      ],
    },
  ];
  const ids = (q: string) => toolboxMatches(groups, q).map((e) => e.tool.id);

  it('lists every enabled tool for an empty query', () => {
    expect(ids('')).toEqual(['sketch', 'extrude', 'pattern', 'fillet', 'parameters']);
  });

  it('lists names starting with the query first, then words starting with it, then names holding it', () => {
    expect(ids('pa')).toEqual(['pattern', 'parameters']);
    expect(ids('change')).toEqual(['parameters']);
    expect(ids('ude')).toEqual(['extrude']);
    expect(ids('off')).toEqual([]);
  });

  it('opens on a bare S outside text fields', () => {
    const key = (o: Partial<Parameters<typeof opensToolbox>[0]>) => ({
      key: 's',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      defaultPrevented: false,
      target: null,
      ...o,
    });
    expect(opensToolbox(key({}))).toBe(true);
    expect(opensToolbox(key({ key: 'S' }))).toBe(true);
    expect(opensToolbox(key({ ctrlKey: true }))).toBe(false);
    expect(opensToolbox(key({ target: { tagName: 'INPUT' } as unknown as EventTarget }))).toBe(false);
    expect(opensToolbox(key({ key: 'e' }))).toBe(false);
  });
});
