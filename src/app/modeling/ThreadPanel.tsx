/**
 * The Thread panel: click a cylindrical face (a shaft or a bore), and the
 * size and class follow its diameter from the thread table; the thread
 * runs the whole face, or a length from a circular edge picked next, and is
 * cosmetic or cut into the body. Clicking the picked face or edge again
 * drops it.
 */
import { useState } from 'react';
import { ThreadIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { Actions, Check, ErrorLine, ExprField, Note, PanelCard, PickList, Select, ToggleRow } from './panelKit';
import { inOtherPart, kindOf, OWN_GEOMETRY, pickFor } from './picks';
import {
  buildThread,
  classesFor,
  classOnFace,
  HANDS,
  isBore,
  newThreadForm,
  readThread,
  sizeForDiameter,
  type ThreadForm,
} from './thread';
import { ThreadSizeRows } from './ThreadSizeRows';
import { sameReference } from './feature';
import { useClicks, useFeaturePanel, usePickOutlines, usePicking, useShownPicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<ThreadForm> = {
  type: 'core.thread',
  baseName: 'Thread',
  create: newThreadForm,
  read: readThread,
  build: buildThread,
};

const LENGTHS = [
  { id: 'full' as const, label: 'Full', title: 'The whole face' },
  { id: 'distance' as const, label: 'Length', title: 'A length from an edge' },
];

export function ThreadPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [armed, setArmed] = useState<'face' | 'from'>('face');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: armed === 'face' ? ['face'] : ['edge'], standardPlanes: false });
  const references = [panel?.form.face?.reference, panel?.form.from?.reference].filter((r) => r !== undefined);
  useShownPicks(services, panel?.target.part ?? null, references);
  const outlineAt = usePickOutlines(services, viewport, panel?.target ?? null, references);

  useClicks(services, viewport, (item, e) => {
    if (!panel) return;
    const dropped = outlineAt(e);
    if (dropped) {
      setHint(null);
      panel.update((f) =>
        f.face && sameReference(f.face.reference, dropped)
          ? { face: null }
          : f.from && sameReference(f.from.reference, dropped)
            ? { from: null }
            : {},
      );
      return;
    }
    if (!item || !('key' in item)) return;
    if (inOtherPart(item)) {
      setHint(OWN_GEOMETRY);
      return;
    }
    const kind = kindOf(services.display.getState().display, item);
    if (kind !== (armed === 'face' ? 'face' : 'edge')) {
      setHint(armed === 'face' ? 'Click a cylindrical face' : 'Click a circular edge of the face');
      return;
    }
    const key = item.key;
    void (async () => {
      if (armed === 'face') {
        const info = await services.client.properties(key);
        if (info?.measures.surface !== 'cylinder') {
          setHint('This face is not a cylinder');
          return;
        }
      }
      const picked = await pickFor(services, panel.target, item);
      if (!picked) {
        setHint(`That ${kind} is made by this thread; pick another`);
        return;
      }
      setHint(null);
      // Clicking the picked face or edge again drops it.
      const f = panel.latest.current;
      const again = armed === 'face' ? f.face : f.from;
      if (again && sameReference(again.reference, picked.reference)) {
        panel.update(armed === 'face' ? { face: null } : { from: null });
        return;
      }
      if (armed === 'from') {
        panel.update({ from: picked });
        setArmed('face');
        return;
      }
      const radius = await services.client.measure('radius', [key]);
      const axis = (await services.client.properties(key))?.measures.axis;
      const bore =
        'value' in radius && axis ? isBore(services.display.getState().display, key, radius.value, axis) : null;
      const size = 'value' in radius ? sizeForDiameter(2 * radius.value, bore ?? false) : null;
      if (!size) setHint('No size in the thread table fits this face');
      const internal = bore ?? false;
      panel.update((f) => ({
        face: picked,
        internal,
        threadClass: classOnFace(f.threadClass, internal),
        ...(size ?? {}),
      }));
    })();
  });

  if (!panel) return null;
  const { form } = panel;
  const classes = classesFor(form.internal);
  return (
    <PanelCard title="Thread" icon={<ThreadIcon size={14} color="#f97316" />} onClose={close}>
      <PickList
        label="Face"
        single
        items={form.face ? [form.face] : []}
        armed={armed === 'face'}
        onArm={() => setArmed('face')}
        onRemove={() => panel.update({ face: null })}
        empty="Click a cylindrical face"
      />
      <Note message={hint} />
      <ThreadSizeRows
        designation={form.designation}
        bound={panel.values.boundText(['designation'], form.designation)}
        onChange={(designation) => panel.update({ designation })}
      />
      <Select
        label="Class"
        value={form.threadClass}
        options={classes.map((c) => ({ id: c, label: c }))}
        bound={panel.values.boundText(['class'], form.threadClass)}
        onChange={(threadClass) => panel.update({ threadClass })}
      />
      <ToggleRow
        label="Direction"
        value={form.hand}
        options={HANDS}
        bound={panel.values.boundText(['hand'], form.hand)}
        onChange={(hand) => panel.update({ hand })}
      />
      <ToggleRow
        label="Length"
        value={form.length}
        options={LENGTHS}
        onChange={(length) => {
          panel.update({ length });
          if (length === 'distance' && !form.from) setArmed('from');
        }}
      />
      {form.length === 'distance' && (
        <>
          <PickList
            label="Starts at"
            single
            items={form.from ? [form.from] : []}
            armed={armed === 'from'}
            onArm={() => setArmed('from')}
            onRemove={() => panel.update({ from: null })}
            empty="Click a circular edge of the face"
          />
          <ExprField
            label="Length"
            value={form.distance}
            unit="mm"
            onChange={(distance) => panel.update({ distance })}
            onEnter={panel.confirm}
          />
        </>
      )}
      <Check
        label="Modeled"
        checked={form.modelled}
        bound={panel.values.boundText(['modelled'], form.modelled)}
        onChange={(modelled) => panel.update({ modelled })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
