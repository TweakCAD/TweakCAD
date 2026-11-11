import { describe, expect, it } from 'vitest';
import { readAsm } from './asm';
import { AsmBodies } from './asmBodies';
import { asmStream, boxRecords } from './asmBuilder.testHelper';

describe('ASM bodies', () => {
  const stream = readAsm(asmStream(boxRecords([0, 0, 0], [1, 2, 3], 7)));

  it('reads the records of a stream, the header first', () => {
    expect(stream.records[0]?.items.find((x) => x.t === 'str')?.v).toBe('Test');
    expect(stream.records[1]?.classes).toEqual(['body']);
    expect(stream.records.some((r) => r.classes.join('-') === 'plane-surface')).toBe(true);
    expect(stream.entityCount).toBe(2);
  });

  it('reads a solid with its faces, edges and points in millimetres', () => {
    const reader = new AsmBodies(stream);
    const [body] = reader.bodies();
    expect(reader.key(body as number)).toBe(7);
    expect(reader.isSketchRegion(body as number)).toBe(false);
    const read = reader.read(body as number);
    expect(read.solids).toHaveLength(1);
    expect(read.solids[0]?.shells[0]).toHaveLength(6);
    expect(read.edges).toHaveLength(12);
    expect(read.vertices).toHaveLength(8);
    expect(read.vertices).toContainEqual([10, 20, 30]);
    // Every edge is used once each way.
    const uses = read.solids[0]?.shells[0]?.flatMap((f) => f.loops.flatMap((l) => ('edges' in l ? l.edges : [])));
    for (let e = 0; e < 12; e++) {
      expect(
        uses
          ?.filter((u) => u.edge === e)
          .map((u) => u.forward)
          .sort(),
      ).toEqual([false, true]);
    }
  });

  it('places a body by a matrix after the change to millimetres', () => {
    const reader = new AsmBodies(stream);
    const turn = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    const read = reader.read(reader.bodies()[0] as number, turn);
    expect(read.vertices).toContainEqual([10, 30, -20]);
    const top = read.solids[0]?.shells[0]?.find((f) => f.surface.kind === 'plane' && f.surface.normal[1] === 1);
    expect(top).toBeDefined();
  });
});
