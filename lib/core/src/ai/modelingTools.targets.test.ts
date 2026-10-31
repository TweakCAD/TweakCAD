/**
 * `targetBodies` on `feature_extrude`, `feature_revolve` and `feature_loft`,
 * over a real CommandBus: bodyId strings become BodyRefs in the sketch's part,
 * and leaving them out stores no pick.
 */
import { describe, expect, it } from 'vitest';
import { CommandBus } from '../commands/bus.ts';
import { DocumentStore } from '../store/documentStore.ts';
import { newProjectWithPart } from '../document/factory.ts';
import {
  createSketchHandler,
  createExtrudeHandler,
  createRevolveHandler,
  createLoftHandler,
} from '../commands/handlers/featureCommands.ts';
import { sketchDrawCircleHandler } from '../commands/handlers/sketchDrawCommands.ts';
import type { PartId } from '../ids.ts';
import { executeTool, type ToolHost } from './toolExecutor.ts';

function newHost(): { host: ToolHost; store: DocumentStore; partId: PartId } {
  const project = newProjectWithPart('Targets');
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateSketch', createSketchHandler);
  bus.register('CreateExtrude', createExtrudeHandler);
  bus.register('CreateRevolve', createRevolveHandler);
  bus.register('CreateLoft', createLoftHandler);
  bus.register('SketchDrawCircle', sketchDrawCircleHandler);
  const host: ToolHost = {
    getDocument: () => store.getState(),
    getDiagnostics: () => ({ diagnostics: [], featureResults: {} }),
    dispatchCommand: async (cmd) => {
      const r = bus.dispatch(cmd as never);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return store.getState();
    },
    beginTransaction: async () => {},
    endTransaction: async () => {},
  };
  return { host, store, partId: Object.keys(project.parts)[0] as PartId };
}

async function call<T>(host: ToolHost, name: string, args: Record<string, unknown>): Promise<T> {
  const r = await executeTool(name, args, host);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function circleSketch(host: ToolHost, partId: PartId, center: [number, number]) {
  const { sketchId } = await call<{ sketchId: string }>(host, 'sketch_create', { partId, plane: 'XZ' });
  await call(host, 'sketch_draw_circle', { sketchId, center, radius: 2 });
  return sketchId;
}

function inputsOf(store: DocumentStore, partId: PartId, featureId: string): Record<string, unknown> {
  return store.getState().parts[partId]!.timeline.find(f => f.id === featureId)!.inputs;
}

/** Each tool, with the arguments that build it from fresh circle sketches. */
const TOOLS: {
  name: string;
  args: (host: ToolHost, partId: PartId) => Promise<Record<string, unknown>>;
}[] = [
  {
    name: 'feature_extrude',
    args: async (host, partId) => ({ sketchId: await circleSketch(host, partId, [0, 0]), distance: 5 }),
  },
  {
    name: 'feature_revolve',
    args: async (host, partId) => ({
      sketchId: await circleSketch(host, partId, [10, 0]), axis: 'z', angle: 360,
    }),
  },
  {
    name: 'feature_loft',
    args: async (host, partId) => ({
      profiles: [
        { sketchId: await circleSketch(host, partId, [0, 0]) },
        { sketchId: await circleSketch(host, partId, [0, 10]) },
      ],
    }),
  },
];

describe.each(TOOLS)('$name targetBodies', ({ name, args }) => {
  it('stores picked bodyIds as BodyRefs in the sketch part', async () => {
    const { host, store, partId } = newHost();
    const { featureId } = await call<{ featureId: string }>(host, name, {
      ...(await args(host, partId)),
      operation: 'join',
      targetBodies: ['body_a', 'body_b'],
    });

    expect(inputsOf(store, partId, featureId)['targetBodies']).toEqual([
      { partId, bodyId: 'body_a' },
      { partId, bodyId: 'body_b' },
    ]);
  });

  it('stores no pick when targetBodies is absent or empty', async () => {
    const { host, store, partId } = newHost();
    const absent = await call<{ featureId: string }>(host, name, {
      ...(await args(host, partId)), operation: 'cut',
    });
    const empty = await call<{ featureId: string }>(host, name, {
      ...(await args(host, partId)), operation: 'cut', targetBodies: [],
    });

    expect(inputsOf(store, partId, absent.featureId)).not.toHaveProperty('targetBodies');
    expect(inputsOf(store, partId, empty.featureId)).not.toHaveProperty('targetBodies');
  });

  it('rejects targetBodies that are not bodyId strings', async () => {
    const { host, partId } = newHost();
    const r = await executeTool(name, {
      ...(await args(host, partId)), operation: 'join', targetBodies: [42],
    }, host);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/targetBodies/);
  });
});
