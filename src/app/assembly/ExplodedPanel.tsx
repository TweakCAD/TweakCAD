/**
 * An exploded view (12.1): named steps, each moving the instances clicked
 * for it by a distance along X, Y and Z, the steps composed in order. The
 * panel shows the view while it is open; the browser shows it again later.
 */
import { useEffect, useState } from 'react';
import { Expand, Plus } from 'lucide-react';
import { isPlainObject } from '@tweakcad/format';
import type { Json } from '@tweakcad/editor';
import type { PanelProps } from '../AppShell';
import { withDefaultUnit } from '@tweakcad/editor';
import { useClicks, usePicking } from '../modeling/usePanel';
import { vectorParts } from '../modeling/hole';
import { exprText, fieldText } from '../modeling/feature';
import { Actions, ErrorLine, ExprField, PanelCard, PickList, Row, styles } from '../modeling/panelKit';
import { assemblyOf, explodedRow, instanceAt, instanceLabel, instanceOfPath, nextName, rowsOf } from './assembly';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

interface Step {
  instances: string[];
  x: string;
  y: string;
  z: string;
}

interface ExplodedForm {
  /** The view edited, or null for a new one. */
  edits: string | null;
  id: string;
  name: string;
  steps: Step[];
}

const moveText = (s: Step) =>
  `placement(vector(${[s.x, s.y, s.z].map((t) => withDefaultUnit(t.trim() === '' ? '0' : t, 'mm')).join(', ')}), rotate(vector(0, 0, 1), 0 deg))`;

function readSteps(row: Json): Step[] {
  return (Array.isArray(row.steps) ? (row.steps as Json[]) : []).map((s) => {
    const text = exprText(s.transform);
    const m = /^\s*placement\((vector\(.*?\)),/s.exec(text);
    const parts = (m ? vectorParts(m[1] as string) : null) ?? ['0', '0', '0'];
    const members = isPlainObject(s.instances) && Array.isArray(s.instances.set) ? (s.instances.set as Json[]) : [];
    return {
      instances: members.flatMap((p) => instanceOfPath(p) ?? []),
      x: fieldText(parts[0] ?? '0'),
      y: fieldText(parts[1] ?? '0'),
      z: fieldText(parts[2] ?? '0'),
    };
  });
}

const SPEC: AssemblyPanelSpec<ExplodedForm> = {
  title: 'Exploded View',
  create(services, assembly, request) {
    const asm = assemblyOf(services.editor.document, assembly);
    const row = request.from ? rowsOf(asm, 'explodedViews').find((e) => e.id === request.from) : undefined;
    if (row) return { edits: row.id as string, id: row.id as string, name: String(row.name), steps: readSteps(row) };
    return {
      edits: null,
      id: services.editor.newId('exp'),
      name: nextName(
        rowsOf(asm, 'explodedViews').map((e) => e.name),
        'Exploded View',
      ),
      steps: [{ instances: [], x: '0', y: '0', z: '50' }],
    };
  },
  build(editor, assembly, form) {
    const steps = form.steps.filter((s) => s.instances.length > 0);
    if (steps.length === 0) return { ok: false, message: 'Click the instances the first step moves', quiet: true };
    const row = explodedRow(
      editor,
      form.name,
      steps.map((s) => ({
        instances: s.instances,
        move: { id: editor.newId('val'), def: { expr: { text: moveText(s), grammar: 1, refs: {} } } },
      })),
    );
    row.id = form.id;
    if (form.edits)
      return {
        ok: true,
        commands: [{ type: 'editAssemblyRow', row: form.edits, set: { name: form.name, steps: row.steps as Json } }],
        label: `Edit ${form.name}`,
      };
    return {
      ok: true,
      commands: [{ type: 'addAssemblyRow', assembly, table: 'explodedViews', row }],
      label: `Add ${form.name}`,
    };
  },
};

export function ExplodedPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useAssemblyPanel(props, SPEC);
  const [active, setActive] = useState(0);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });

  // The view shows while the panel is open; afterwards, the one shown before.
  const id = panel?.form.id;
  useEffect(() => {
    if (!id) return;
    const before = services.app.getState().exploded;
    services.app.setState({ exploded: id });
    return () => services.app.setState({ exploded: before === id ? id : before });
  }, [id, services]);

  useClicks(services, viewport, (item) => {
    if (!panel || !item || !('key' in item) || item.instance?.assembly !== panel.assembly) return;
    const instance = instanceAt(services.display.getState().display, panel.assembly, item.instance.index);
    if (!instance) return;
    panel.update((f) => ({
      steps: f.steps.map((s, i) =>
        i !== active
          ? s
          : {
              ...s,
              instances: s.instances.includes(instance)
                ? s.instances.filter((x) => x !== instance)
                : [...s.instances, instance],
            },
      ),
    }));
  });

  if (!panel) return null;
  const { form } = panel;
  const asm = assemblyOf(services.editor.document, panel.assembly);
  const setStep = (i: number, patch: Partial<Step>) =>
    panel.update((f) => ({ steps: f.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  return (
    <PanelCard title={form.name} icon={<Expand size={14} color="#6366f1" />} onClose={close}>
      <Row label="Name">
        <input
          aria-label="Name"
          value={form.name}
          onChange={(e) => panel.update({ name: e.target.value })}
          style={{ ...styles.input, width: 150 }}
        />
      </Row>
      {form.steps.map((s, i) => (
        <div key={i} onClick={() => setActive(i)} style={{ borderTop: '1px solid #eee', paddingTop: 4 }}>
          <PickList
            label={`Step ${i + 1}`}
            items={s.instances.map((inst) => ({
              label: asm ? instanceLabel(services.editor.document, asm, inst) : 'Instance',
            }))}
            armed={active === i}
            onArm={() => setActive(i)}
            onRemove={(k) => setStep(i, { instances: s.instances.filter((_, j) => j !== k) })}
            empty="Click the instances this step moves"
          />
          <ExprField label="X" value={s.x} unit="mm" onChange={(x) => setStep(i, { x })} />
          <ExprField label="Y" value={s.y} unit="mm" onChange={(y) => setStep(i, { y })} />
          <ExprField label="Z" value={s.z} unit="mm" onChange={(z) => setStep(i, { z })} />
        </div>
      ))}
      <button
        type="button"
        style={{ ...styles.cancelBtn, display: 'flex', alignItems: 'center', gap: 4, margin: '6px 0' }}
        onClick={() => {
          panel.update((f) => ({ steps: [...f.steps, { instances: [], x: '0', y: '0', z: '50' }] }));
          setActive(form.steps.length);
        }}
      >
        <Plus size={12} /> Add step
      </button>
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
