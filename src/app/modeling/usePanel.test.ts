import { describe, expect, it } from 'vitest';
import { pausedLine } from './usePanel';

describe('pausedLine', () => {
  it("says the feature does not build, with the evaluator's reason as a sentence", () => {
    expect(pausedLine('the kernel could not build the feature: BRep_API: command not done')).toBe(
      'The feature does not build. The kernel could not build the feature: BRep_API: command not done.',
    );
    expect(pausedLine('A wall is too thick.')).toBe('The feature does not build. A wall is too thick.');
    expect(pausedLine(null)).toBeNull();
  });
});
