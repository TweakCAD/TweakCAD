import { describe, expect, it } from 'vitest';
import { distinctLabels } from './pickLabels';

describe('pick list labels', () => {
  it('numbers labels that repeat, in list order, and keeps the others', () => {
    expect(distinctLabels(['Edge of Body 4', 'Face of Body 1', 'Edge of Body 4'])).toEqual([
      'Edge 1 of Body 4',
      'Face of Body 1',
      'Edge 2 of Body 4',
    ]);
    expect(distinctLabels(['Vertex', 'Vertex'])).toEqual(['Vertex 1', 'Vertex 2']);
    expect(distinctLabels(['Edge of Body 4'])).toEqual(['Edge of Body 4']);
  });
});
