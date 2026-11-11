import { beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { readAsm } from './parser/asm';
import { AsmBodies } from './parser/asmBodies';
import { asmStream, boxRecords } from './parser/asmBuilder.testHelper';
import { writeStep } from './stepBodies';

let k: OcctKernel;
beforeAll(async () => {
  k = await OcctKernel.init();
});

describe('stored bodies as STEP', { timeout: 60_000 }, () => {
  it('make valid solids of the stored shape, in millimetres', () => {
    const reader = new AsmBodies(readAsm(asmStream([...boxRecords([0, 0, 0], [1, 2, 3])])));
    const text = writeStep([reader.read(reader.bodies()[0] as number)]);
    const shape = k.importStep(text);
    const solids = k.getSubShapes(shape, 'solid');
    expect(solids).toHaveLength(1);
    const solid = solids[0] as NonNullable<(typeof solids)[0]>;
    expect(k.isValid(solid)).toBe(true);
    expect(k.getVolume(solid)).toBeCloseTo(6000, 3);
    const b = k.getBoundingBox(solid);
    expect([b.xmax, b.ymax, b.zmax].map((x) => Math.round(x))).toEqual([10, 20, 30]);
  });

  it('write each body of several as its own solid', () => {
    const a = new AsmBodies(readAsm(asmStream(boxRecords([0, 0, 0], [1, 1, 1]))));
    const b = new AsmBodies(readAsm(asmStream(boxRecords([2, 0, 0], [3, 1, 2]))));
    const shape = k.importStep(writeStep([a.read(a.bodies()[0] as number), b.read(b.bodies()[0] as number)]));
    const volumes = k.getSubShapes(shape, 'solid').map((s) => Math.round(k.getVolume(s)));
    expect(volumes.sort((x, y) => x - y)).toEqual([1000, 2000]);
  });
});
