import { describe, expect, it } from 'vitest';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { BODY_COLOR_PATTERN } from '@tweakcad/core/src/document/schema.ts';
import { bodyColorMap, BODY_COLOR_SWATCHES } from './bodyColors.ts';

describe('bodyColorMap', () => {
  it('collects every part\'s colours and skips malformed ones', () => {
    const project = newProjectWithPart('Test');
    const part = Object.values(project.parts)[0]!;
    part.bodyColors = { body_a: '#ff0000', body_b: 'red', body_c: '#00FF00' };
    expect([...bodyColorMap(project)]).toEqual([['body_a', '#ff0000']]);
  });

  it('offers only colours the command accepts', () => {
    for (const { color } of BODY_COLOR_SWATCHES) expect(BODY_COLOR_PATTERN.test(color)).toBe(true);
  });
});
