import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import type { AppServices } from '../services';
import { hoverNote } from './commands';
import { acceptDrawing, bindPendingDrawing, dropPendingDrawing, takePendingDrawing } from './sketchFiles';

const DXF = [
  '0',
  'SECTION',
  '2',
  'ENTITIES',
  '0',
  'LINE',
  '8',
  '0',
  '10',
  '0',
  '20',
  '0',
  '11',
  '30',
  '21',
  '0',
  '0',
  'ENDSEC',
  '0',
  'EOF',
].join('\n');

function app() {
  return createStore(() => ({ panel: null as { kind: string } | null })) as unknown as AppServices['app'];
}

function session() {
  const calls: [string, string][] = [];
  return {
    calls,
    insertDrawing: (text: string, format: 'dxf' | 'svg') => (
      calls.push([text, format]),
      { ok: true as const, label: 'Import DXF', changed: true }
    ),
  };
}

describe('importing a drawing as a new sketch', () => {
  it('asks for a plane, then fills the sketch made on it once', () => {
    const services = { app: app() };
    expect(acceptDrawing(services, 'dxf', DXF, 'plate.dxf')).toBe(true);
    expect(services.app.getState().panel).toEqual({ kind: 'sketchPlane' });
    const s = session();
    // Nothing goes in before the sketch is made, nor into another sketch.
    takePendingDrawing(s, 'feat_1');
    bindPendingDrawing('feat_1');
    takePendingDrawing(s, 'feat_2');
    expect(s.calls).toEqual([]);
    takePendingDrawing(s, 'feat_1');
    takePendingDrawing(s, 'feat_1');
    expect(s.calls).toEqual([[DXF, 'dxf']]);
  });

  it('drops a drawing when the picker closes without a plane, and refuses a file with no curves', () => {
    const services = { app: app() };
    acceptDrawing(services, 'dxf', DXF, 'plate.dxf');
    dropPendingDrawing();
    bindPendingDrawing('feat_1');
    const s = session();
    takePendingDrawing(s, 'feat_1');
    expect(s.calls).toEqual([]);

    const empty = { app: app() };
    expect(acceptDrawing(empty, 'svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'empty.svg')).toBe(false);
    expect(empty.app.getState().panel).toBeNull();
  });
});

describe('the sketch plane picker', () => {
  it('says what the pointer is over', async () => {
    const services = {
      display: createStore(() => ({
        display: { entities: { 1: { kind: 'plane' }, 2: { kind: 'face' }, 3: { kind: 'face' } } },
      })),
      client: { properties: async (key: number) => ({ measures: { surface: key === 2 ? 'plane' : 'cylinder' } }) },
      app: createStore(() => ({ focus: null })),
    } as unknown as AppServices;
    expect(await hoverNote(services, { standard: 'xy' } as never)).toBe('XY highlighted');
    expect(await hoverNote(services, { key: 1 } as never)).toBe('construction plane highlighted');
    expect(await hoverNote(services, { key: 2 } as never)).toBe('face highlighted');
    expect(await hoverNote(services, { key: 3 } as never)).toBe('this face is not flat');
    expect(await hoverNote(services, null)).toBeNull();
  });
});
