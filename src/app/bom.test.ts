import { describe, expect, it } from 'vitest';
import type { BomLine } from '@tweakcad/worker/src/v2/service/types';
import { bomCsv } from './bom';

const line = (o: Partial<BomLine> & { part: string; name: string }): BomLine => ({
  kind: 'normal',
  quantity: 1,
  library: false,
  ...o,
});

describe('the bill of materials file', () => {
  it('lists made parts, then purchased ones, with their folders, and leaves reference parts out', () => {
    const doc = {
      folders: [
        { id: 'fld_a', name: 'Arm', members: [], parent: { top: {} } },
        { id: 'fld_b', name: 'Hardware', members: ['part_bolt'], parent: { folder: { id: 'fld_a' } } },
      ],
    };
    const csv = bomCsv(doc, [
      line({ part: 'part_bolt', name: 'Bolt, M3 "x" 10', kind: 'purchased', quantity: 8 }),
      line({ part: 'part_plate', name: 'Plate' }),
      line({ part: 'part_board', name: 'Board', kind: 'reference' }),
      line({ part: 'part_servo', name: 'Servo', kind: 'purchased', quantity: 2, library: true }),
    ]);
    expect(csv.split('\r\n')).toEqual([
      'Item,Part,Kind,Quantity,Folder,Source',
      '1,Plate,Normal,1,,Document',
      '2,"Bolt, M3 ""x"" 10",Purchased,8,Arm / Hardware,Document',
      '3,Servo,Purchased,2,,Library',
      '',
    ]);
  });
});
