/**
 * The Joint panel: a joint kind, then where the first and the second instance
 * join (a flat face's centre or a round edge's centre, or a default plane of
 * the assembly), an offset and angle between them, and limits per degree of
 * freedom. The preview shows the second instance moved onto the first; OK
 * writes both joint origins and the joint, with the pose it solves to. Opened
 * on an existing joint (Edit Joint), it reads the joint back and rewrites
 * what changed.
 */
import { useState } from 'react';
import { Link2 } from 'lucide-react';
import type { PanelProps } from '../AppShell';
import { useClicks, usePicking } from '../modeling/usePanel';
import {
  Actions,
  Check,
  ErrorLine,
  ExprField,
  Note,
  PanelCard,
  PickList,
  Row,
  Select,
  styles,
} from '../modeling/panelKit';
import type { SelectionItem } from '../selection';
import { JOINT_KINDS, DOF_LABELS, assemblyOf, instanceAt, instanceLabel, jointLabel, type JointKind } from './assembly';
import { jointCommands, jointEnd, newJointForm, readJoint, type JointForm } from './joints';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

const SPEC: AssemblyPanelSpec<JointForm> = {
  title: 'Joint',
  create: (services, assembly, request) =>
    request.from
      ? readJoint(services.editor.document, services.display.getState().display, assembly, request.from)
      : newJointForm(),
  refusal: 'This joint was not made in the Joint panel; it can be driven, suppressed or deleted',
  build(editor, assembly, form) {
    const built = jointCommands(editor, assembly, form);
    if (!built.ok) return { ok: false, message: built.message, quiet: !form.a || !form.b };
    const asm = assemblyOf(editor.document, assembly);
    const label = form.editing
      ? `Edit ${asm ? jointLabel(asm, form.editing.joint) : 'joint'}`
      : `Add ${JOINT_KINDS[form.kind].label} joint`;
    return { ok: true, commands: built.commands, label };
  },
};

const KIND_OPTIONS = (Object.keys(JOINT_KINDS) as JointKind[]).map((id) => ({ id, label: JOINT_KINDS[id].label }));

export function JointPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useAssemblyPanel(props, SPEC);
  // An edited joint has both ends: a click replaces the first until another end is armed.
  const [armed, setArmed] = useState<'a' | 'b'>('a');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: ['face', 'edge', 'standard'], standardPlanes: true });

  useClicks(services, viewport, (item: SelectionItem | null) => {
    if (!panel || !item) return;
    const doc = services.editor.document;
    const asm = assemblyOf(doc, panel.assembly);
    const index = 'key' in item ? item.instance?.index : undefined;
    const id = index === undefined ? null : instanceAt(services.display.getState().display, panel.assembly, index);
    const label = asm && id ? instanceLabel(doc, asm, id) : 'instance';
    const slot = armed;
    void jointEnd(services, item, label).then((end) => {
      if ('problem' in end) {
        setHint(end.problem);
        return;
      }
      setHint(null);
      panel.update(slot === 'a' ? { a: end } : { b: end });
      if (slot === 'a') setArmed('b');
    });
  });

  if (!panel) return null;
  const { form } = panel;
  const dofs = JOINT_KINDS[form.kind].dofs;
  const asm = assemblyOf(services.editor.document, panel.assembly);
  const next = form.editing
    ? asm
      ? `Edit ${jointLabel(asm, form.editing.joint)}`
      : 'Edit Joint'
    : asm
      ? jointLabel({ ...asm, joints: [...(asm.joints as unknown[]), { id: '', kind: form.kind }] }, '')
      : 'Joint';
  return (
    <PanelCard title={next} icon={<Link2 size={14} color="#6366f1" />} onClose={close}>
      <Select
        label="Type"
        value={form.kind}
        options={KIND_OPTIONS}
        onChange={(kind) => panel.update({ kind, limits: {} })}
      />
      <PickList
        label="Component 1"
        single
        items={form.a ? [form.a] : []}
        armed={armed === 'a'}
        onArm={() => setArmed('a')}
        onRemove={() => panel.update({ a: null })}
        empty="Click a flat face or round edge"
      />
      <PickList
        label="Component 2"
        single
        items={form.b ? [form.b] : []}
        armed={armed === 'b'}
        onArm={() => setArmed('b')}
        onRemove={() => panel.update({ b: null })}
        empty="Click where it joins the first"
      />
      <Check
        label="Face to face"
        checked={form.flip}
        bound={form.editing && form.flip === form.editing.read.flip ? (form.editing.read.flipBound ?? null) : null}
        onChange={(flip) => panel.update({ flip })}
      />
      <ExprField
        label="Offset"
        value={form.offset}
        unit="mm"
        onChange={(offset) => panel.update({ offset })}
        onEnter={panel.confirm}
      />
      <ExprField
        label="Angle"
        value={form.angle}
        unit="°"
        onChange={(angle) => panel.update({ angle })}
        onEnter={panel.confirm}
      />
      {dofs.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Limits</div>
          {dofs.map((dof) => {
            const l = form.limits[dof] ?? { min: '', max: '' };
            const set = (patch: Partial<typeof l>) =>
              panel.update({ limits: { ...form.limits, [dof]: { ...l, ...patch } } });
            const unit = dof.startsWith('t') ? 'mm' : '°';
            return (
              <Row key={dof} label={DOF_LABELS[dof] ?? dof}>
                <div style={styles.inputGroup}>
                  <input
                    aria-label={`${dof} lowest`}
                    placeholder="free"
                    value={l.min}
                    onChange={(e) => set({ min: e.target.value })}
                    style={{ ...styles.input, width: 52 }}
                  />
                  <input
                    aria-label={`${dof} highest`}
                    placeholder="free"
                    value={l.max}
                    onChange={(e) => set({ max: e.target.value })}
                    style={{ ...styles.input, width: 52 }}
                  />
                  <span style={styles.unit}>{unit}</span>
                </div>
              </Row>
            );
          })}
        </div>
      )}
      <Note message={hint} />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
