import { describe, expect, it } from 'vitest';
import { Editor, seededIds } from '@tweakcad/editor';
import { Docs } from '@tweakcad/worker/src/v2/assemblyDocs';
import { createAppStore } from '../appState';
import { createSelectionStore } from '../selection';
import type { AppServices } from '../services';
import { standardDocument } from '../../../lib/editor/src/testDocs';
import { activePart, editFeature, startPanel, startProfileFeature } from './commands';

function twoParts() {
  const d = new Docs(7);
  const base = d.part('Base');
  base.box('60 mm', '40 mm', '10 mm');
  const arm = d.part('Arm');
  const box = arm.box('40 mm', '10 mm', '6 mm');
  const editor = new Editor(d.document({ part: { id: base.id } }), { ids: seededIds(5) });
  const services = { editor, app: createAppStore(), selection: createSelectionStore() } as unknown as AppServices;
  return { services, base: base.id, arm: arm.id, box };
}

describe('editing a feature from the browser', () => {
  it("opens the feature's own part before its panel, so the panel works there", () => {
    const { services, base, arm, box } = twoParts();
    expect(activePart(services)).toBe(base);
    expect(editFeature(services, box)).toEqual({ ok: true });
    expect(activePart(services)).toBe(arm);
    expect(services.app.getState().panel).toEqual({ kind: 'primitive', feature: box });
  });
});

describe('starting a profile tool with nothing chosen', () => {
  function withSketch() {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const display = {
      parts: { [ids.part]: 0 },
      definitions: [{ sketches: [{ feature: ids.sketch, regions: [{ key: 1, row: null, loops: [] }] }] }],
    };
    const services = {
      editor,
      app: createAppStore(),
      selection: createSelectionStore(),
      display: { getState: () => ({ display }) },
    } as unknown as AppServices;
    services.app.setState({ focus: { part: ids.part } } as never);
    return { services, ids };
  }

  it('guesses the last sketch with a region for Extrude, but leaves Sweep and Loft without a profile', () => {
    const extrude = withSketch();
    expect(startProfileFeature(extrude.services, 'extrude', 'Extrude')).toEqual({ ok: true });
    expect(extrude.services.app.getState().panel).toEqual({ kind: 'extrude', from: extrude.ids.sketch });
    for (const kind of ['sweep', 'loft']) {
      const other = withSketch();
      expect(startProfileFeature(other.services, kind, kind, undefined, undefined, false)).toEqual({ ok: true });
      expect(other.services.app.getState().panel).toEqual({ kind });
    }
  });
});

describe('a tool that needs a body', () => {
  function shown(evaluating: boolean) {
    const { doc, ids } = standardDocument();
    const editor = new Editor(doc, { ids: seededIds(5) });
    const services = {
      editor,
      app: createAppStore(),
      selection: createSelectionStore(),
      display: { getState: () => ({ display: null, evaluating }) },
    } as unknown as AppServices;
    services.app.setState({ focus: { part: ids.part } } as never);
    return services;
  }

  it('is refused in a part shown with no body', () => {
    const services = shown(false);
    expect(startPanel(services, 'fillet', 'Fillet', { needsBody: true }).ok).toBe(false);
    expect(services.app.getState().panel).toBeNull();
  });

  it('opens while the document is still being evaluated, before its bodies are shown', () => {
    const services = shown(true);
    expect(startPanel(services, 'fillet', 'Fillet', { needsBody: true })).toEqual({ ok: true });
    expect(services.app.getState().panel).toEqual({ kind: 'fillet' });
  });
});
