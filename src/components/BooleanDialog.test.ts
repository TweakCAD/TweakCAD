/**
 * Tool-body selection for the Combine / Cut / Intersect dialog.
 *
 * After a pattern there can be a dozen tool bodies; the header toggle ticks
 * them in one click. The target is never a tool, so its id must never end up
 * in the selection, whichever order the user picks things in.
 */
import { describe, expect, it } from 'vitest';
import { retargetTools, toggleAllTools, toolSelection } from './BooleanDialog.tsx';

const BODIES = ['b1', 'b2', 'b3', 'b4'];
/** Candidates when b1 is the target. */
const TOOLS = BODIES.filter(id => id !== 'b1');

describe('toolSelection', () => {
  it('is none, some or all against the candidate list', () => {
    expect(toolSelection(TOOLS, [])).toBe('none');
    expect(toolSelection(TOOLS, ['b3'])).toBe('some');
    expect(toolSelection(TOOLS, ['b4', 'b2', 'b3'])).toBe('all');
  });

  it('ignores selected ids that are not candidates', () => {
    expect(toolSelection(TOOLS, ['b1'])).toBe('none');
  });
});

describe('toggleAllTools', () => {
  it('selects every candidate from none', () => {
    expect(toggleAllTools(TOOLS, [])).toEqual(TOOLS);
  });

  it('selects every candidate from a partial pick', () => {
    expect(toggleAllTools(TOOLS, ['b3'])).toEqual(TOOLS);
  });

  it('clears when every candidate is already selected', () => {
    expect(toggleAllTools(TOOLS, TOOLS)).toEqual([]);
  });

  it('never selects the target', () => {
    expect(toggleAllTools(TOOLS, [])).not.toContain('b1');
  });
});

describe('retargetTools', () => {
  it('drops the new target from the selection', () => {
    const all = toggleAllTools(TOOLS, []);
    expect(retargetTools(all, 'b3')).toEqual(['b2', 'b4']);
  });

  it('leaves the selection alone when the target was not a tool', () => {
    expect(retargetTools(['b2', 'b3'], 'b4')).toEqual(['b2', 'b3']);
  });

  it('reads as partial against the new candidates once the old target is free', () => {
    // b1 was the target with every tool ticked; making b3 the target frees b1
    // as an unticked candidate and removes b3 from the selection.
    const selected = retargetTools(toggleAllTools(TOOLS, []), 'b3');
    const candidates = BODIES.filter(id => id !== 'b3');
    expect(toolSelection(candidates, selected)).toBe('some');
    expect(toggleAllTools(candidates, selected)).toEqual(['b1', 'b2', 'b4']);
  });
});
