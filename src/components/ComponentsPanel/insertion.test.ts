/**
 * The catalog-insertion flow, below the React layer.
 *
 * The panel turns a downloaded component document into a `CreateComponent`
 * dispatch; these check that what it hands the command bus is right, and that
 * what lands in the document stays parametric afterwards — which is the whole
 * point of a component catalog rather than a shape library.
 *
 * The command's own behaviour (validation, naming, undo) is covered by
 * `core/commands/handlers/componentCommands.test.ts`. The form helpers are
 * covered by `parameters.test.ts`.
 *
 * Why not Playwright: this codebase has no e2e infrastructure and the
 * supply-chain policy keeps dependencies minimal, so pure vitest against the
 * command bus is the established pattern here.
 */

import { describe, expect, it } from 'vitest';
import { DocumentStore } from '@tweakcad/core/src/store/documentStore.ts';
import { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import { createComponentHandler } from '@tweakcad/core/src/commands/handlers/featureCommands.ts';
import { newProjectWithPart } from '@tweakcad/core/src/document/factory.ts';
import { hashComponentSource } from '@tweakcad/core/src/document/contentHash.ts';
import { hexBoltComponent } from '@tweakcad/testing/src/componentFixtures.ts';
import type {
  CadPart,
  CadProject,
  ComponentFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import { componentPart, initialParameterValues, overridesFrom } from './parameters.ts';

const AT_ORIGIN = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
};

function sourcePart(source: CadProject): CadPart {
  const part = componentPart(source);
  if (!part) throw new Error('test setup: component has no part');
  return part;
}

function buildWiredApp() {
  const project = newProjectWithPart('Test Project', 'Part 1');
  const partId = Object.keys(project.parts)[0]! as PartId;
  const store = new DocumentStore(project);
  const bus = new CommandBus(store);
  bus.register('CreateComponent', createComponentHandler);
  return { store, bus, partId };
}

/**
 * Same data, every object's keys in the opposite order. Rebuilt recursively
 * rather than via `JSON.stringify`'s replacer array — that argument is a
 * key *allowlist* applied at every depth, which silently drops nested keys
 * and would make this assert the wrong thing.
 */
function withReversedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withReversedKeys) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object).reverse()) {
    out[key] = withReversedKeys((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

/** What the panel builds after the user picks a size and edits a field. */
function catalogInsert(source: CadProject, hash: string, configurationId: string | null, values: Record<string, string>) {
  return {
    type: 'CreateComponent' as const,
    component: {
      hash,
      name: 'M5 hex bolt — ISO 4017',
      origin: 'catalog:iso-4017-hex-bolt-m5',
      embeddedAt: '2026-10-25T00:00:00.000Z',
      source,
    },
    inputs: {
      transform: AT_ORIGIN,
      parameterOverrides: overridesFrom(sourcePart(source), configurationId, values),
      configurationId,
      boolean: 'newBody' as const,
    },
  };
}

describe('component insertion', () => {
  it('embeds the downloaded document and places it, still parametric', async () => {
    const { store, bus, partId } = buildWiredApp();
    const source = hexBoltComponent();
    const hash = await hashComponentSource(source);

    const result = bus.dispatch({
      partId,
      ...catalogInsert(source, hash, 'cfg_m5x40', { length: '40', grade: '12.9' }),
    });
    expect(result.ok).toBe(true);

    const state = store.getState();
    // The definition travels with the host document — no catalog lookup on
    // reopen, and the project still opens offline.
    expect(state.embeddedComponents?.[hash]?.source).toBeDefined();
    expect(state.embeddedComponents?.[hash]?.origin).toBe('catalog:iso-4017-hex-bolt-m5');

    const feature = state.parts[partId]!.timeline[0]!;
    expect(feature.type).toBe('component');
    const inputs = feature.inputs as unknown as ComponentFeatureInputs;
    expect(inputs.componentRef).toBe(hash);
    // The size the user picked and the one field they changed — both stored as
    // editable state, not baked into geometry.
    expect(inputs.configurationId).toBe('cfg_m5x40');
    expect(inputs.parameterOverrides).toEqual({ grade: '12.9' });
  });

  it('carries no overrides when the user accepted the defaults', async () => {
    const { store, bus, partId } = buildWiredApp();
    const source = hexBoltComponent();
    const hash = await hashComponentSource(source);
    const part = sourcePart(source);

    bus.dispatch({
      partId,
      ...catalogInsert(source, hash, 'cfg_m5x20', initialParameterValues(part, 'cfg_m5x20')),
    });

    const inputs = store.getState().parts[partId]!.timeline[0]!
      .inputs as unknown as ComponentFeatureInputs;
    expect(inputs.parameterOverrides).toEqual({});
    expect(inputs.configurationId).toBe('cfg_m5x20');
  });

  it('inserting the same catalog component twice stores one definition', async () => {
    const { store, bus, partId } = buildWiredApp();
    const source = hexBoltComponent();
    const hash = await hashComponentSource(source);
    const command = catalogInsert(source, hash, null, {});

    bus.dispatch({ partId, ...command });
    bus.dispatch({ partId, ...command });

    const state = store.getState();
    expect(Object.keys(state.embeddedComponents ?? {})).toHaveLength(1);
    expect(state.parts[partId]!.timeline).toHaveLength(2);
  });

  it('hashes on content, so key order in the served bytes does not fork identity', async () => {
    // The catalog serves whatever bytes were published; the same component
    // saved from disk may order its keys differently. Canonical JSON sorts
    // them, so both collapse to one `embeddedComponents` entry.
    const source = hexBoltComponent();
    expect(await hashComponentSource(withReversedKeys(source)))
      .toBe(await hashComponentSource(source));
  });

  it('a different component gets a different hash', async () => {
    const a = hexBoltComponent();
    const b = hexBoltComponent();
    Object.values(b.parts)[0]!.parameters.values.length!.expression = '25';
    expect(await hashComponentSource(a)).not.toBe(await hashComponentSource(b));
  });
});
