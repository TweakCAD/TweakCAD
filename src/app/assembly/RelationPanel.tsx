/**
 * Motion Link: a gear (two turning joints, the second turning `ratio` times
 * the first), a rack and pinion (a turn drives a slide, mm per degree) or a
 * screw (one cylindrical joint whose slide follows its turn). The first joint
 * drives (12.2).
 */
import { Cog } from 'lucide-react';
import type { PanelProps } from '../AppShell';
import { literal } from '../modeling/common';
import { Actions, ErrorLine, ExprField, PanelCard, Select } from '../modeling/panelKit';
import { RELATION_KINDS, assemblyOf, jointLabel, relationRow, rowsOf, type RelationKind } from './assembly';
import { numberOf } from './joints';
import { useAssemblyPanel, type AssemblyPanelSpec } from './usePanel';

interface RelationForm {
  kind: RelationKind;
  first: string;
  second: string;
  ratio: string;
}

const KIND_OPTIONS = (Object.keys(RELATION_KINDS) as RelationKind[]).map((id) => ({
  id,
  label: RELATION_KINDS[id].label,
}));

const SPEC: AssemblyPanelSpec<RelationForm> = {
  title: 'Motion Link',
  create(services, assembly) {
    const joints = rowsOf(assemblyOf(services.editor.document, assembly), 'joints').map((j) => j.id as string);
    return { kind: 'gear', first: joints[0] ?? '', second: joints[1] ?? '', ratio: '1' };
  },
  build(editor, assembly, form) {
    const ratio = numberOf(form.ratio);
    if (ratio === null || ratio === 0) return { ok: false, message: 'The ratio is a number other than 0' };
    const count = RELATION_KINDS[form.kind].joints;
    const joints = count === 1 ? [form.first] : [form.first, form.second];
    if (joints.some((j) => j === '')) return { ok: false, message: 'Choose the joints to link' };
    if (count === 2 && form.first === form.second) return { ok: false, message: 'Link two different joints' };
    const text = form.kind === 'gear' ? String(ratio) : `${ratio} [mm/deg]`;
    const row = relationRow(editor, form.kind, joints, literal(editor, text));
    return {
      ok: true,
      commands: [{ type: 'addAssemblyRow', assembly, table: 'relations', row }],
      label: `Add ${RELATION_KINDS[form.kind].label}`,
    };
  },
};

export function RelationPanel(props: PanelProps) {
  const { services, close } = props;
  const panel = useAssemblyPanel(props, SPEC);
  if (!panel) return null;
  const { form } = panel;
  const asm = assemblyOf(services.editor.document, panel.assembly);
  const joints = rowsOf(asm, 'joints').map((j) => ({
    id: j.id as string,
    label: asm ? jointLabel(asm, j.id as string) : 'Joint',
  }));
  const two = RELATION_KINDS[form.kind].joints === 2;
  return (
    <PanelCard title="Motion Link" icon={<Cog size={14} color="#6366f1" />} onClose={close}>
      <Select label="Type" value={form.kind} options={KIND_OPTIONS} onChange={(kind) => panel.update({ kind })} />
      {joints.length === 0 ? (
        <div style={{ fontSize: 12, color: '#666' }}>Add joints first.</div>
      ) : (
        <>
          <Select
            label={two ? 'Driving joint' : 'Joint'}
            value={form.first}
            options={joints}
            onChange={(first) => panel.update({ first })}
          />
          {two && (
            <Select
              label="Driven joint"
              value={form.second}
              options={joints}
              onChange={(second) => panel.update({ second })}
            />
          )}
        </>
      )}
      <ExprField
        label="Ratio"
        value={form.ratio}
        unit={RELATION_KINDS[form.kind].unit}
        onChange={(ratio) => panel.update({ ratio })}
        onEnter={panel.confirm}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} />
    </PanelCard>
  );
}
