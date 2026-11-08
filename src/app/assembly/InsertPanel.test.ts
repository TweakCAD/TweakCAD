import { describe, expect, it } from 'vitest';
import { Editor, seededIds, type EditorCommand, type Json } from '@tweakcad/editor';
import { newDocument } from '../document';
import { createAppStore } from '../appState';
import { createSelectionStore } from '../selection';
import type { AppServices } from '../services';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  parametersOf,
  setConfigurationOverride,
} from '../parameters';
import { newAssemblyCommands } from './assembly';
import { embedDocument } from './library';
import { INSERT_SPEC, sourceConfigurations, type InsertForm } from './InsertPanel';

const ok = (r: { ok: boolean; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
};

/** A component with a public width and a configuration whose Wide row sets it. */
function component(): { doc: Json; input: string } {
  const ids = seededIds(71);
  const editor = new Editor(newDocument({ ids, name: 'Block' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  ok(addParameter(editor, { part }, 'width', 'length', '20'));
  ok(addConfiguration(editor, part));
  for (const p of parametersOf(editor.document, { part }))
    ok(editor.dispatch({ type: 'editParameter', parameter: p.id, set: { public: true } }));
  const width = parametersOf(editor.document, { part }).find((p) => p.name === 'width')!;
  const c = () => configurationsOf(editor.document, part)[0]!;
  ok(addConfigurationRow(editor, c(), 'Wide'));
  ok(setConfigurationOverride(editor, part, c(), 'Wide', width, '40'));
  return { doc: editor.document, input: c().input.id };
}

function run(editor: Editor, commands: readonly EditorCommand[]) {
  editor.transaction('Edit', () => {
    for (const c of commands) ok(editor.dispatch(c));
    return { ok: true, label: 'Edit', changed: true };
  });
}

function host() {
  const ids = seededIds(73);
  const editor = new Editor(newDocument({ ids, name: 'Host' }), { ids });
  const part = ((editor.document.parts as Json[])[0] as Json).id as string;
  const c = component();
  const embedded = embedDocument(c.doc, 'Block', editor.newId('lib'), {
    catalogue: { id: 'block', version: '1', policy: 'pinned' },
  });
  ok(
    editor.dispatch({
      type: 'addLibraryEntry',
      entry: embedded.entry,
      assets: embedded.assets as Record<string, Json>,
    }),
  );
  const made = newAssemblyCommands(editor, 'Assembly 1', [part]);
  run(editor, made.commands);
  return { editor, assembly: made.assembly, source: `component:${String(embedded.entry.id)}`, input: c.input };
}

const form = (source: string, rows: InsertForm['rows'] = {}): InsertForm => ({
  source,
  x: '0',
  y: '0',
  z: '0',
  angle: '0',
  grounded: false,
  rows,
});

describe('Insert', () => {
  it("offers a component's configurations, and inserts in the row chosen", () => {
    const { editor, assembly, source, input } = host();
    expect(sourceConfigurations(editor.document, source).map((c) => c.options)).toEqual([['Default', 'Wide']]);
    const own = INSERT_SPEC.build(editor, assembly, form(source));
    const wide = INSERT_SPEC.build(editor, assembly, form(source, { [input]: 'Wide' }));
    const rowOf = (b: typeof own) =>
      (b.ok && b.commands[0]?.type === 'addAssemblyRow' ? b.commands[0].row : null) as Json | null;
    expect(rowOf(own)?.overrides).toEqual([]);
    const override = (rowOf(wide)?.overrides as Json[])[0] as Json;
    expect((((override.value as Json).def as Json).expr as Json).text).toBe('"Wide"');
  });

  it('opens Drag on the new instance after OK, so it can be placed', () => {
    const { editor, assembly, source } = host();
    const app = createAppStore();
    app.setState({ focus: { assembly } });
    const built = INSERT_SPEC.build(editor, assembly, form(source));
    if (!built.ok) throw new Error(built.message);
    run(editor, built.commands);
    INSERT_SPEC.after?.({ editor, app, selection: createSelectionStore() } as unknown as AppServices, built);
    const row = (built.commands[0] as Extract<EditorCommand, { type: 'addAssemblyRow' }>).row;
    expect(app.getState().panel).toEqual({ kind: 'assembly.move', from: row.id });
  });
});
