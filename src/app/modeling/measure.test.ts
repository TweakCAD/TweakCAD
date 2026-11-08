import { describe, expect, it } from 'vitest';
import { measureSelections } from './measure';

describe('Measure selections', () => {
  const same = (a: number, b: number) => a === b;
  it('fill Selection 1 on the first click and Selection 2 on the second, without a modifier key', () => {
    const one = measureSelections<number>([], 7, same);
    expect(one).toEqual([7]);
    expect(measureSelections(one, 9, same)).toEqual([7, 9]);
  });

  it('drop a selection clicked again, start over on a third, and ignore a click on nothing', () => {
    expect(measureSelections([7, 9], 7, same)).toEqual([9]);
    expect(measureSelections([7, 9], 9, same)).toEqual([7]);
    expect(measureSelections([7, 9], 4, same)).toEqual([4]);
    expect(measureSelections([7, 9], null, same)).toEqual([7, 9]);
  });
});
