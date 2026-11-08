/**
 * Insert: an instance of a part or an assembly of this document, or of a
 * component already in its library, placed in the shown assembly at a
 * position and a turn about Z, optionally grounded; a component with
 * configurations is inserted in the one chosen (its own by default). A
 * component from the catalogue comes in through the Components panel.
 *
 * On OK the Drag panel opens on the new instance, its gizmo on it, so it
 * can be placed at once.
 */
import { PackagePlus } from 'lucide-react';
import type { Json } from '@tweakcad/editor';
import type { PanelProps } from '../AppShell';
import { partsOf } from '../features';
import { Actions, Check, ErrorLine, ExprField, PanelCard, Select } from '../modeling/panelKit';
import { assembliesOf, definitionName, instanceRow, libraryOf, libraryValue } from './assembly';
import { startAssemblyPanel } from './commands';
import { numberOf } from './joints';
import { componentConfigurations, rowOverrides, type ComponentConfiguration } from './library';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

/** The select entry that keeps a component's own configuration row. */
const OWN_ROW = '\u0000own';

export interface InsertForm {
  source: string;
  x: string;
  y: string;
  z: string;
  angle: string;
  grounded: boolean;
  /** The configuration row chosen by input id; null or absent keeps the component's own. */
  rows: Record<string, string | null>;
}

/** The configurations of a library component, by its `component:<entry>` source; none for a part or an assembly. */
export function sourceConfigurations(doc: Json, source: string): ComponentConfiguration[] {
  const [kind, id] = source.split(':');
  if (kind !== 'component') return [];
  const entry = libraryOf(doc).find((e) => e.id === id);
  const definition = ((entry?.content as Json | undefined)?.inline as Json | undefined)?.definition as Json | undefined;
  return definition ? componentConfigurations(definition) : [];
}

function sources(doc: Json, assembly: string): { id: string; label: string }[] {
  return [
    ...partsOf(doc).map((p) => ({ id: `part:${String(p.id)}`, label: String(p.name) })),
    ...assembliesOf(doc)
      .filter((a) => a.id !== assembly)
      .map((a) => ({ id: `assembly:${String(a.id)}`, label: `${String(a.name)} (assembly)` })),
    ...libraryOf(doc)
      .filter((e) => e.kind === 'document')
      .map((e) => ({ id: `component:${String(e.id)}`, label: `${String(e.name)} (component)` })),
  ];
}

export const INSERT_SPEC: AssemblyPanelSpec<InsertForm> = {
  title: 'Insert',
  create(services, assembly) {
    const first = sources(services.editor.document, assembly)[0];
    return { source: first?.id ?? '', x: '0', y: '0', z: '0', angle: '0', grounded: false, rows: {} };
  },
  build(editor, assembly, form) {
    const [kind, id] = form.source.split(':');
    if (!kind || !id) return { ok: false, message: 'Choose what to insert' };
    const of: Json =
      kind === 'part'
        ? { part: { id } }
        : kind === 'assembly'
          ? { assembly: { id } }
          : { component: { value: libraryValue(editor, id) } };
    const x = numberOf(form.x);
    const y = numberOf(form.y);
    const z = numberOf(form.z);
    const angle = numberOf(form.angle);
    if (x === null || y === null || z === null) return { ok: false, message: 'The position is in numbers of mm' };
    if (angle === null) return { ok: false, message: 'The angle is a number of degrees' };
    const h = (angle * Math.PI) / 360;
    const overrides = rowOverrides(sourceConfigurations(editor.document, form.source), form.rows);
    const row = instanceRow(editor, of, {
      placement: { position: [x, y, z], rotation: [0, 0, Math.sin(h), Math.cos(h)] },
      grounded: form.grounded,
      overrides,
    });
    return {
      ok: true,
      commands: [{ type: 'addAssemblyRow', assembly, table: 'instances', row }],
      label: `Insert ${definitionName(editor.document, of)}`,
    };
  },
  after(services, built) {
    const command = built.commands[0];
    const id = command && command.type === 'addAssemblyRow' ? String(command.row.id) : null;
    if (!id) return;
    startAssemblyPanel(services, 'assembly.move', 'Drag', id);
  },
};

export function InsertPanel(props: PanelProps) {
  const { services, close } = props;
  const panel = useAssemblyPanel(props, INSERT_SPEC);
  if (!panel) return null;
  const { form } = panel;
  const options = sources(services.editor.document, panel.assembly);
  const configurations = sourceConfigurations(services.editor.document, form.source);
  return (
    <PanelCard title="Insert" icon={<PackagePlus size={14} color="#6366f1" />} onClose={close}>
      {options.length === 0 ? (
        <div style={{ fontSize: 12, color: '#666' }}>There is nothing to insert yet.</div>
      ) : (
        <Select
          label="Insert"
          value={form.source}
          options={options}
          onChange={(source) => panel.update({ source, rows: {} })}
        />
      )}
      {configurations.map((c) => (
        <Select
          key={c.input.id}
          label={configurations.length > 1 ? c.input.name : 'Configuration'}
          value={form.rows[c.input.id] ?? OWN_ROW}
          options={[
            { id: OWN_ROW, label: c.own ? `Component's own (${c.own})` : "Component's own" },
            ...c.options.map((o) => ({ id: o, label: o })),
          ]}
          onChange={(row) => panel.update((f) => ({ rows: { ...f.rows, [c.input.id]: row === OWN_ROW ? null : row } }))}
        />
      ))}
      <ExprField label="X" value={form.x} unit="mm" onChange={(x) => panel.update({ x })} onEnter={panel.confirm} />
      <ExprField label="Y" value={form.y} unit="mm" onChange={(y) => panel.update({ y })} onEnter={panel.confirm} />
      <ExprField label="Z" value={form.z} unit="mm" onChange={(z) => panel.update({ z })} onEnter={panel.confirm} />
      <ExprField
        label="Turn Z"
        value={form.angle}
        unit="°"
        onChange={(angle) => panel.update({ angle })}
        onEnter={panel.confirm}
      />
      <Check label="Ground it" checked={form.grounded} onChange={(grounded) => panel.update({ grounded })} />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
