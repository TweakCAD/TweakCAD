import { describe, expect, it } from 'vitest';
import { buffers } from './transfer';

describe('buffers', () => {
  it('lists each buffer once, a shared one too', () => {
    const shared = new Float32Array(4);
    const own = new Uint32Array(2);
    expect(buffers({ a: shared, b: [shared, { c: own }], d: 'text', e: null })).toEqual([shared.buffer, own.buffer]);
  });

  it('walks a display-sized object once: thousands of buffers among tens of thousands of objects', () => {
    // As a large assembly's display: 8000 buffers in sketches and meshes, 70 000 small objects beside them.
    const display = {
      entities: Array.from({ length: 70_000 }, (_, key) => ({ key, scope: { definition: key % 13 }, shown: true })),
      definitions: Array.from({ length: 8000 }, () => ({ points: new Float32Array(3) })),
    };
    const t = performance.now();
    expect(buffers(display)).toHaveLength(8000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
