/**
 * The Fillet and Chamfer panels: edges and faces clicked in the viewport
 * (a face stands for its creased edges; with Tangent chain on, as it is
 * until turned off, an edge brings the edges that continue it smoothly;
 * clicking a picked one again drops it, also where the preview has
 * replaced it), with the size, a live preview, and one undo step on OK.
 */
import { useState } from 'react';
import { ChamferIcon, FilletIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import {
  buildChamfer,
  buildFillet,
  flipChamfer,
  newChamferForm,
  newFilletForm,
  readChamfer,
  readFillet,
  type ChamferForm,
  type ChamferSize,
  type FilletForm,
} from './blends';
import { tangentChain } from './edgeChains';
import { sameReference, type FeatureTarget, type PickedRef } from './feature';
import { Actions, Check, ErrorLine, ExprField, Note, PanelCard, PickList, Row, styles, ToggleRow } from './panelKit';
import { inOtherPart, kindOf, OWN_GEOMETRY, pickFor } from './picks';
import type { Toggle } from './profiles';
import {
  useClicks,
  useFeaturePanel,
  usePickOutlines,
  usePicking,
  useShownPicks,
  type FeaturePanel,
  type PanelSpec,
} from './usePanel';

const FILLET: PanelSpec<FilletForm> = {
  type: 'core.fillet',
  baseName: 'Fillet',
  create: newFilletForm,
  read: readFillet,
  build: buildFillet,
};
const CHAMFER: PanelSpec<ChamferForm> = {
  type: 'core.chamfer',
  baseName: 'Chamfer',
  create: newChamferForm,
  read: readChamfer,
  build: buildChamfer,
};

/**
 * What a click adds to or drops from the targets: the face, or the edge
 * and, with `chain`, its tangent chain. A pick that is already there is
 * dropped. The toggle applies to the targets as they are once the picks
 * are known, so clicks whose picks overlap all count.
 */
export async function toggleTargets(
  services: AppServices,
  target: FeatureTarget,
  item: SelectionItem,
  chain: boolean,
): Promise<Toggle<PickedRef>> {
  const display = services.display.getState().display;
  const kind = kindOf(display, item);
  if (kind !== 'edge' && kind !== 'face') return { hint: 'Pick an edge or a face' };
  if (inOtherPart(item)) return { hint: OWN_GEOMETRY };
  const first = await pickFor(services, target, item);
  if (!first) return { hint: `That ${kind} is made by this feature; pick another` };
  const chained: PickedRef[] = [];
  if (kind === 'edge' && chain && 'key' in item) {
    for (const key of tangentChain(display, item.key).slice(1)) {
      const p = await pickFor(services, target, { key });
      if (p) chained.push(p);
    }
  }
  return {
    toggle: (now) => {
      const present = now.find((t) => sameReference(t.reference, first.reference));
      if (present) return now.filter((t) => t !== present);
      const added: PickedRef[] = [];
      for (const p of [first, ...chained]) {
        if (
          !now.some((t) => sameReference(t.reference, p.reference)) &&
          !added.some((t) => sameReference(t.reference, p.reference))
        )
          added.push(p);
      }
      return [...now, ...added];
    },
  };
}

/** The Tangent chain setting both panels share, kept from one opening to the next; on until it is turned off. */
export const tangentChainSetting = { on: true };

/** The edge picking both panels share. */
function useTargets<F extends { targets: PickedRef[] }>(props: PanelProps, panel: FeaturePanel<F> | null) {
  const { services, viewport } = props;
  const [chain, setChainState] = useState(tangentChainSetting.on);
  const setChain = (on: boolean) => {
    tangentChainSetting.on = on;
    setChainState(on);
  };
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: ['edge', 'face'], standardPlanes: false });
  const references = (panel?.form.targets ?? []).map((t) => t.reference);
  useShownPicks(services, panel?.target.part ?? null, references);
  const outlineAt = usePickOutlines(services, viewport, panel?.target ?? null, references);
  useClicks(services, viewport, (item, e) => {
    if (!panel) return;
    const dropped = outlineAt(e);
    if (dropped) {
      setHint(null);
      panel.update((f) => ({ targets: f.targets.filter((t) => !sameReference(t.reference, dropped)) }) as Partial<F>);
      return;
    }
    if (!item) return;
    void toggleTargets(services, panel.target, item, chain).then((r) => {
      if ('hint' in r) setHint(r.hint);
      else {
        setHint(null);
        panel.update((f) => ({ targets: r.toggle(f.targets) }) as Partial<F>);
      }
    });
  });
  const list = panel ? (
    <>
      <PickList
        label="Edges"
        items={panel.form.targets}
        armed
        onRemove={(i) => panel.update((f) => ({ targets: f.targets.filter((_, j) => j !== i) }) as Partial<F>)}
        empty="Click edges, or a face for its edges"
      />
      <Check label="Tangent chain" checked={chain} onChange={setChain} />
      <Note message={hint} />
    </>
  ) : null;
  return list;
}

export function FilletPanel(props: PanelProps) {
  const panel = useFeaturePanel(props, FILLET);
  const list = useTargets(props, panel);
  if (!panel) return null;
  return (
    <PanelCard title="Fillet" icon={<FilletIcon size={14} color="#06b6d4" />} onClose={props.close}>
      {list}
      <ExprField
        label="Radius"
        value={panel.form.radius}
        unit="mm"
        onChange={(radius) => panel.update({ radius })}
        onEnter={panel.confirm}
        invalid={panel.error !== null}
        autoFocus
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={props.close} onOk={panel.confirm} blocked={panel.blocked} okTitle="Apply fillet" />
    </PanelCard>
  );
}

const SIZES: { id: ChamferSize; label: string; title: string }[] = [
  { id: 'distance', label: 'Equal', title: 'One distance' },
  { id: 'twoDistances', label: 'Two', title: 'Two distances' },
  { id: 'distanceAngle', label: 'Angle', title: 'A distance and an angle' },
];

/**
 * Flip: two distances swap faces at each click; a distance and an angle
 * stays flipped, the button pressed, until clicked again.
 */
function FlipRow({ form, onFlip }: { form: ChamferForm; onFlip: () => void }) {
  const angled = form.size === 'distanceAngle';
  const on = angled && form.flipped;
  return (
    <Row label="Flip">
      <button
        type="button"
        aria-pressed={angled ? on : undefined}
        style={{
          ...styles.toggleBtn,
          background: on ? '#e3effb' : '#f7f7f7',
          color: on ? '#1a6fd1' : '#555',
          borderColor: on ? '#a8cef0' : '#e0e0e0',
        }}
        title={angled ? 'Put the distance on the other face' : 'Swap which face takes each distance'}
        onClick={onFlip}
      >
        Flip
      </button>
    </Row>
  );
}

export function ChamferPanel(props: PanelProps) {
  const panel = useFeaturePanel(props, CHAMFER);
  const list = useTargets(props, panel);
  if (!panel) return null;
  const { form } = panel;
  return (
    <PanelCard title="Chamfer" icon={<ChamferIcon size={14} color="#06b6d4" />} onClose={props.close}>
      {list}
      <ToggleRow label="Type" value={form.size} options={SIZES} onChange={(size) => panel.update({ size })} />
      <ExprField
        label={form.size === 'twoDistances' ? 'Distance 1' : 'Distance'}
        value={form.distance}
        unit="mm"
        onChange={(distance) => panel.update({ distance })}
        onEnter={panel.confirm}
        invalid={panel.error !== null}
        autoFocus
      />
      {form.size === 'twoDistances' && (
        <ExprField
          label="Distance 2"
          value={form.second}
          unit="mm"
          onChange={(second) => panel.update({ second })}
          onEnter={panel.confirm}
        />
      )}
      {form.size === 'distanceAngle' && (
        <ExprField
          label="Angle"
          value={form.angle}
          unit="°"
          onChange={(angle) => panel.update({ angle })}
          onEnter={panel.confirm}
        />
      )}
      {form.size !== 'distance' && <FlipRow form={form} onFlip={() => panel.update((f) => flipChamfer(f))} />}
      <ErrorLine message={panel.error} />
      <Actions onCancel={props.close} onOk={panel.confirm} blocked={panel.blocked} okTitle="Apply chamfer" />
    </PanelCard>
  );
}
