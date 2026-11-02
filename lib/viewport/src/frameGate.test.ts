import { describe, expect, it } from 'vitest';
import { FrameGate } from './frameGate.ts';

describe('FrameGate', () => {
  it('draws the first tick, then only after a request', () => {
    const gate = new FrameGate();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    expect(gate.take()).toBe(false);
    gate.request();
    gate.request();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  it('draws every tick while held, and once more after the last release', () => {
    const gate = new FrameGate();
    gate.take();
    const releaseA = gate.hold();
    const releaseB = gate.hold();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(true);
    releaseA();
    expect(gate.take()).toBe(true);
    releaseB();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
  });

  it('ignores a second release of the same hold', () => {
    const gate = new FrameGate();
    gate.take();
    const releaseA = gate.hold();
    const releaseB = gate.hold();
    releaseA();
    releaseA();
    gate.take();
    expect(gate.take()).toBe(true);
    releaseB();
    gate.take();
    expect(gate.take()).toBe(false);
  });
});
