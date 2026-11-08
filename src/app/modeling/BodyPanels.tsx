/**
 * The panels of the commands that act on bodies or copy them: Shell,
 * Pattern, Mirror, Combine (boolean) and Remove Body. Bodies are picked by
 * clicking any face or edge of them, or their row in the browser; features
 * to copy by clicking geometry they made, or the feature in the browser or
 * the timeline (before or while the panel is open). Clicking a picked one
 * again drops it.
 */
import { useEffect, useState } from 'react';
import { CutIcon, FuseIcon, MirrorIcon, PatternIcon, ShellIcon } from '../../icons/cadIcons.tsx';
import type { ViewportPointer } from '../viewport/Viewport';
import type { PanelProps } from '../AppShell';
import type { Doc, Json } from '@tweakcad/editor';
import { findFeature, partOf } from '../features';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import {
  BOOLEAN_OPS,
  CIRCULAR_DISTRIBUTIONS,
  DIRECTION_TYPES,
  suppressHint,
  withDistribution,
  buildBoolean,
  buildMirror,
  buildPattern,
  buildRemoveBody,
  buildShell,
  newBooleanForm,
  newDirection,
  newMirrorForm,
  newPatternForm,
  newRemoveBodyForm,
  newShellForm,
  readBoolean,
  readMirror,
  readPattern,
  readRemoveBody,
  readShell,
  clickBooleanBody,
  COPY_OPS,
  type BooleanForm,
  type CopiedKind,
  type MirrorForm,
  type PatternDirection,
  type PatternForm,
  type RemoveBodyForm,
  type ShellDirection,
  type ShellForm,
  type ShellOwner,
  toggledShellBody,
  withShellFaces,
} from './bodyFeatures';
import { recordOf } from './beforeState';
import { at, sameReference, type FeatureTarget, type PickedRef, type ValueSlots } from './feature';
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
  ToggleRow,
  Toggles,
} from './panelKit';
import { tangentFaces } from './edgeChains';
import { bodyItem, bodyName, entityOf, inOtherPart, kindOf, OWN_GEOMETRY, pickFor } from './picks';
import type { AxisChoice, StandardAxis } from './revolve';
import {
  useClicks,
  useFeaturePanel,
  usePickOutlines,
  usePicking,
  useShownPicks,
  useTreeClicks,
  type PanelSpec,
} from './usePanel';

/** The body a click lands on, as a reference; null for a body of another part, which a feature reads but never changes. */
export async function pickBody(
  services: AppServices,
  target: FeatureTarget,
  item: SelectionItem,
): Promise<PickedRef | null> {
  if (inOtherPart(item)) return null;
  const { display, before } = services.display.getState();
  // A body of the state the panel works in that the shown display lacks (one its preview consumes), clicked in the browser.
  const listed =
    'key' in item && before && before.generation === display?.generation
      ? before.bodies.find((b) => b.key === item.key)
      : undefined;
  if (listed) return pickFor(services, target, { key: listed.key }, listed.name);
  const body = kindOf(display, item) === 'body' ? item : bodyItem(display, item);
  if (!body || !('key' in body)) return null;
  return pickFor(services, target, body, bodyName(display, body.key));
}

/** The feature that made what a click lands on, as a reference. */
export function pickFeature(services: AppServices, item: SelectionItem): PickedRef | null {
  if (inOtherPart(item)) return null;
  const id = 'feature' in item ? item.feature : entityOf(services.display.getState().display, item)?.feature;
  if (!id) return null;
  return {
    reference: { object: { feature: { id } } },
    names: {},
    label: String(findFeature(services.editor.document, id)?.name ?? 'Feature'),
  };
}

/** `list` with `pick` added, or dropped when it is there already. */
export function toggled(list: readonly PickedRef[], pick: PickedRef): PickedRef[] {
  const present = list.find((p) => sameReference(p.reference, pick.reference));
  return present ? list.filter((p) => p !== present) : [...list, pick];
}

/** The features selected when the panel opened, for a copy of features. */
function selectedFeatures(services: AppServices): PickedRef[] {
  return services.selection.getState().items.flatMap((i) => ('feature' in i ? (pickFeature(services, i) ?? []) : []));
}

const AXES: { id: StandardAxis; label: string }[] = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'z', label: 'Z' },
];

const OF: { id: CopiedKind; label: string }[] = [
  { id: 'bodies', label: 'Bodies' },
  { id: 'features', label: 'Features' },
];

/** An axis or direction: one of the part's axes, or a line picked while its slot is armed. */
/**
 * The expressions an axis or direction input stores at `path` that its
 * rows show beside them: the part axis chosen (a direction's), and the
 * reverse flag. `circular` is an axis input (7.3 Axis), whose part axis is
 * a reference, not a value.
 */
export function axisBounds(
  values: ValueSlots,
  path: (string | number)[],
  axis: AxisChoice,
  reversed: boolean,
  circular = false,
): { axisBound: string | null; reversedBound: string | null } {
  const standard = !circular && axis !== null && 'standard' in axis;
  return {
    axisBound: standard ? values.boundText([...path, 'axis', 'axis'], axis.standard) : null,
    reversedBound: values.boundText([...path, standard ? 'axis' : 'along', 'reversed'], reversed),
  };
}

export function AxisRows({
  label,
  axis,
  reversed,
  armed,
  onArm,
  onAxis,
  onReversed,
  axisBound = null,
  reversedBound = null,
}: {
  label: string;
  axis: AxisChoice;
  reversed: boolean;
  armed: boolean;
  onArm: () => void;
  onAxis: (a: AxisChoice) => void;
  onReversed: (r: boolean) => void;
  axisBound?: string | null;
  reversedBound?: string | null;
}) {
  return (
    <>
      <Row label={label} note={axisBound}>
        <Toggles
          value={axis && 'standard' in axis ? axis.standard : ('' as StandardAxis)}
          options={AXES}
          onChange={(a) => onAxis({ standard: a })}
        />
      </Row>
      <PickList
        label={`${label} line`}
        single
        items={axis && 'picked' in axis ? [axis.picked] : []}
        armed={armed}
        onArm={onArm}
        onRemove={() => onAxis(null)}
        empty={armed ? 'Click an edge, a sketch line or an axis' : 'Click here, then a line in the view'}
      />
      <Check label="Flip" checked={reversed} onChange={onReversed} bound={reversedBound} />
    </>
  );
}

// ---- Shell ----

const SHELL: PanelSpec<ShellForm> = {
  type: 'core.shell',
  baseName: 'Shell',
  create: newShellForm,
  read: readShell,
  build: buildShell,
};

/** The Shell panel's Tangent chain setting, kept from one opening to the next; on until it is turned off. */
export const shellChainSetting = { on: true };

/** `faces` with `picked` dropped when it is there, otherwise with it and the rest of its tangent chain added. */
export function toggledChain(faces: readonly PickedRef[], picked: PickedRef, chain: readonly PickedRef[]): PickedRef[] {
  if (faces.some((f) => sameReference(f.reference, picked.reference))) return toggled(faces, picked);
  const out = [...faces, picked];
  for (const c of chain) if (!out.some((f) => sameReference(f.reference, c.reference))) out.push(c);
  return out;
}

/**
 * The bodies stored faces to remove lie on, as the worker places them in the
 * part just before the feature: an owner for each face it finds there.
 */
export async function shellOwnersBefore(
  services: AppServices,
  target: FeatureTarget,
  faces: readonly PickedRef[],
): Promise<ShellOwner[]> {
  const stored = faces.flatMap((f) => {
    const record = recordOf(f.reference);
    return record ? [{ face: f.reference, record }] : [];
  });
  if (stored.length === 0 || !services.client.bodiesBefore) return [];
  try {
    const listed = await services.client.bodiesBefore(
      { part: target.part, feature: target.feature },
      stored.map((f) => f.record),
      { picks: true },
    );
    return stored.flatMap((f, i) => {
      const id = listed.references[i]?.body;
      const body = id === null || id === undefined ? undefined : listed.bodies.find((b) => b.id === id);
      return body?.picked ? [{ face: f.face, body: body.picked.reference as unknown as Json }] : [];
    });
  } catch {
    // Nothing evaluated holds the part: the faces keep no known body.
    return [];
  }
}

const SHELL_DIRECTIONS: { id: ShellDirection; label: string }[] = [
  { id: 'inside', label: 'Inside' },
  { id: 'outside', label: 'Outside' },
  { id: 'both', label: 'Both' },
];

export function ShellPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, SHELL);
  const [hint, setHint] = useState<string | null>(null);
  const [armed, setArmed] = useState<'faces' | 'bodies'>('faces');
  const [chain, setChainState] = useState(shellChainSetting.on);
  const setChain = (on: boolean) => {
    shellChainSetting.on = on;
    setChainState(on);
  };
  usePicking(services, { kinds: armed === 'faces' ? ['face'] : ['face', 'edge'], standardPlanes: false });
  const references = [...(panel?.form.faces ?? []), ...(panel?.form.bodies ?? [])].map((f) => f.reference);
  useShownPicks(services, panel?.target.part ?? null, references);
  const outlineAt = usePickOutlines(services, viewport, panel?.target ?? null, references);
  // A stored face's body comes from where the worker places the face, never from its label.
  const unowned = panel
    ? panel.form.faces.filter((f) => !panel.form.owners.some((o) => sameReference(o.face, f.reference)))
    : [];
  const unownedKey = JSON.stringify(unowned.map((f) => f.reference));
  useEffect(() => {
    if (!panel || panel.target.base === undefined || unowned.length === 0) return;
    let live = true;
    void shellOwnersBefore(services, panel.target, unowned).then((found) => {
      if (!live || found.length === 0) return;
      panel.update((f) => ({
        owners: [...f.owners, ...found.filter((o) => !f.owners.some((x) => sameReference(x.face, o.face)))],
      }));
    });
    return () => {
      live = false;
    };
    // Again only when the faces with no known body change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unownedKey]);
  const takeBody = (item: SelectionItem) => {
    if (!panel) return;
    void pickBody(services, panel.target, item).then((body) => {
      if (!body) {
        setHint(inOtherPart(item) ? OWN_GEOMETRY : 'Click a body');
        return;
      }
      setHint(null);
      panel.update((f) => toggledShellBody(f, body));
    });
  };
  useClicks(services, viewport, (item, e) => {
    if (!panel) return;
    const dropped = outlineAt(e);
    if (dropped) {
      setHint(null);
      panel.update((f) => {
        const body = f.bodies.find((b) => sameReference(b.reference, dropped));
        return body
          ? toggledShellBody(f, body)
          : withShellFaces(
              f,
              f.faces.filter((x) => !sameReference(x.reference, dropped)),
            );
      });
      return;
    }
    if (!item) return;
    if (armed === 'bodies') {
      takeBody(item);
      return;
    }
    if (kindOf(services.display.getState().display, item) !== 'face') return;
    if (inOtherPart(item)) {
      setHint(OWN_GEOMETRY);
      return;
    }
    void (async () => {
      const face = await pickFor(services, panel.target, item);
      const body = await pickBody(services, panel.target, item);
      if (!face || !body) {
        setHint('That face is made by this shell; pick another');
        return;
      }
      const chained: PickedRef[] = [];
      if (chain && 'key' in item) {
        for (const key of tangentFaces(services.display.getState().display, item.key).slice(1)) {
          const p = await pickFor(services, panel.target, { key });
          if (p) chained.push(p);
        }
      }
      setHint(null);
      panel.update((f) => withShellFaces(f, toggledChain(f.faces, face, chained), body));
    })();
  });
  // A body clicked in the browser is shelled as a body.
  useTreeClicks(services, (item) => {
    if (!('key' in item)) return;
    setArmed('bodies');
    takeBody(item);
  });
  if (!panel) return null;
  const { form } = panel;
  const both = form.direction === 'both';
  return (
    <PanelCard title="Shell" icon={<ShellIcon size={14} color="#64748b" />} onClose={close}>
      <PickList
        label="Faces to remove"
        items={form.faces}
        armed={armed === 'faces'}
        onArm={() => setArmed('faces')}
        onRemove={(i) =>
          panel.update((f) =>
            withShellFaces(
              f,
              f.faces.filter((_, j) => j !== i),
            ),
          )
        }
        empty="Click the faces to open"
      />
      <Check label="Tangent chain" checked={chain} onChange={setChain} />
      <PickList
        label="Bodies"
        items={form.bodies}
        armed={armed === 'bodies'}
        onArm={() => setArmed('bodies')}
        onRemove={(i) => panel.update((f) => toggledShellBody(f, f.bodies[i] as PickedRef))}
        empty={armed === 'bodies' ? 'Click a body to hollow it closed' : 'The bodies of the faces'}
      />
      <Note message={hint} />
      <ExprField
        label={both ? 'Inside thickness' : 'Thickness'}
        value={form.thickness}
        unit="mm"
        onChange={(thickness) => panel.update({ thickness })}
        onEnter={panel.confirm}
        invalid={panel.error !== null}
        autoFocus
      />
      {both && (
        <ExprField
          label="Outside thickness"
          value={form.outside}
          unit="mm"
          onChange={(outside) => panel.update({ outside })}
          onEnter={panel.confirm}
        />
      )}
      <ToggleRow
        label="Direction"
        value={form.direction}
        options={SHELL_DIRECTIONS}
        bound={panel.values.boundText(['direction'], form.direction)}
        onChange={(direction) => panel.update({ direction })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}

// ---- copies: the items list both pattern and mirror use ----

/** Whether `feature` stands before the feature `target` writes, in its part's timeline. */
export function standsBefore(doc: Doc, target: FeatureTarget, feature: string): boolean {
  const rows = partOf(doc, target.part)?.timeline;
  if (!Array.isArray(rows)) return false;
  const ids = (rows as { id?: unknown }[]).map((r) => r.id);
  const at = ids.indexOf(feature);
  if (at < 0) return false;
  const end =
    target.base !== undefined
      ? ids.indexOf(target.feature)
      : target.before !== undefined
        ? ids.indexOf(target.before)
        : ids.length;
  return at < (end < 0 ? ids.length : end);
}

interface Copied {
  of: CopiedKind;
  items: PickedRef[];
}

/**
 * What a click on `item` makes of the items to copy: its body, or the
 * feature that made it, added or dropped. A feature clicked in the browser
 * or the timeline turns an empty list of bodies into a list of features.
 * A string says why the click was not taken.
 */
async function clickCopied(
  services: AppServices,
  target: FeatureTarget,
  f: Copied,
  item: SelectionItem,
): Promise<Copied | string> {
  if (inOtherPart(item)) return OWN_GEOMETRY;
  const fromTree = 'feature' in item;
  const of: CopiedKind = fromTree && f.of === 'bodies' && f.items.length === 0 ? 'features' : f.of;
  if (fromTree && of === 'bodies') return 'Set Of to Features to copy a feature';
  if (of === 'bodies') {
    const body = await pickBody(services, target, item);
    return body ? { of, items: toggled(f.items, body) } : 'Click a body';
  }
  const pick = pickFeature(services, item);
  const id = (pick?.reference.object as { feature?: { id?: string } } | undefined)?.feature?.id ?? null;
  if (!pick || id === null) return 'Click a feature, or geometry it made';
  if (!standsBefore(services.editor.document, target, id)) return 'Pick a feature before this one';
  return { of, items: toggled(of === f.of ? f.items : [], pick) };
}

// ---- Pattern ----

const PATTERN: PanelSpec<PatternForm> = {
  type: 'core.pattern',
  baseName: 'Pattern',
  create: (services) => {
    const form = newPatternForm();
    const features = selectedFeatures(services);
    return features.length > 0 ? { ...form, of: 'features', items: features } : form;
  },
  read: readPattern,
  build: buildPattern,
};

type PatternSlot = 'items' | 'dir0' | 'dir1' | 'axis';

export function PatternPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, PATTERN);
  const [armed, setArmed] = useState<PatternSlot>('items');
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, {
    kinds: armed === 'items' ? ['face', 'edge'] : ['edge', 'sketchCurve', 'construction'],
    standardPlanes: false,
  });
  const form = panel?.form;
  const axisRefs = form
    ? [...form.directions.map((d) => d.axis), form.circular.axis].flatMap((a) =>
        a && 'picked' in a ? [a.picked.reference] : [],
      )
    : [];
  useShownPicks(services, panel?.target.part ?? null, [...(form?.items ?? []).map((i) => i.reference), ...axisRefs]);

  const onClick = (item: SelectionItem | null) => {
    if (!panel || !item) return;
    void (async () => {
      const f = panel.latest.current;
      if (armed === 'items') {
        const next = await clickCopied(services, panel.target, f, item);
        if (typeof next !== 'string') panel.update(next);
        setHint(typeof next === 'string' ? next : null);
        return;
      }
      if ('feature' in item) return;
      let axis: AxisChoice;
      if ('datum' in item) {
        // A standard axis clicked in the browser is that axis; the origin is no direction.
        if (item.datum === 'origin') return;
        axis = { standard: item.datum };
      } else {
        const picked = await pickFor(services, panel.target, item);
        if (!picked) {
          setHint('Pick a line that is there before this pattern');
          return;
        }
        axis = { picked };
      }
      setHint(null);
      if (armed === 'axis') panel.update({ circular: { ...f.circular, axis } });
      else {
        const index = armed === 'dir0' ? 0 : 1;
        panel.update({ directions: f.directions.map((d, i) => (i === index ? { ...d, axis } : d)) });
      }
      setArmed('items');
    })();
  };
  useClicks(services, viewport, onClick);
  useTreeClicks(services, onClick);

  if (!panel || !form) return null;
  const setDirection = (i: number, patch: Partial<PatternDirection>) =>
    panel.update({ directions: form.directions.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  return (
    <PanelCard title="Pattern" icon={<PatternIcon size={14} color="#eab308" />} onClose={close}>
      <ToggleRow
        label="Of"
        value={form.of}
        options={OF}
        onChange={(of) =>
          panel.update({ of, items: of === form.of ? form.items : of === 'features' ? selectedFeatures(services) : [] })
        }
      />
      <PickList
        label={form.of === 'bodies' ? 'Bodies' : 'Features'}
        items={form.items}
        armed={armed === 'items'}
        onArm={() => setArmed('items')}
        onRemove={(i) => panel.update({ items: form.items.filter((_, j) => j !== i) })}
        empty={form.of === 'bodies' ? 'Click the bodies to copy' : 'Click features, in the timeline or the view'}
      />
      <Note message={hint} />
      {form.layout !== 'kept' && (
        <ToggleRow
          label="Type"
          value={form.layout}
          options={[
            { id: 'linear', label: 'Linear' },
            { id: 'circular', label: 'Circular' },
          ]}
          onChange={(layout) => panel.update({ layout })}
        />
      )}
      {form.layout === 'linear' && (
        <ToggleRow
          label="Distance"
          value={form.distance}
          options={[
            { id: 'spacing', label: 'Spacing', title: 'The distance between neighbouring copies' },
            {
              id: 'extent',
              label: 'Extent',
              title: 'The distance from the original to the last copy; when symmetric, to the farthest one',
            },
          ]}
          onChange={(distance) => panel.update({ distance })}
        />
      )}
      {form.layout === 'linear' &&
        form.directions.map((d, i) => (
          <div key={i}>
            <AxisRows
              label={`Direction ${i + 1}`}
              axis={d.axis}
              reversed={d.reversed}
              armed={armed === (i === 0 ? 'dir0' : 'dir1')}
              onArm={() => setArmed(i === 0 ? 'dir0' : 'dir1')}
              onAxis={(axis) => setDirection(i, { axis })}
              onReversed={(reversed) => setDirection(i, { reversed })}
              {...axisBounds(panel.values, ['layout', 'linear', 'directions', i, 'direction'], d.axis, d.reversed)}
            />
            <Select
              label="Direction Type"
              value={d.symmetric ? 'symmetric' : 'one'}
              options={DIRECTION_TYPES}
              bound={panel.values.boundText(['layout', 'linear', 'directions', i, 'symmetric'], d.symmetric)}
              onChange={(type) => setDirection(i, { symmetric: type === 'symmetric' })}
            />
            <ExprField
              label="Count"
              value={d.count}
              onChange={(count) => setDirection(i, { count })}
              onEnter={panel.confirm}
            />
            <ExprField
              label={form.distance === 'extent' ? 'Extent' : 'Spacing'}
              value={d.spacing}
              unit="mm"
              onChange={(spacing) => setDirection(i, { spacing })}
              onEnter={panel.confirm}
            />
          </div>
        ))}
      {form.layout === 'linear' && (
        <Check
          label="Second direction"
          checked={form.directions.length > 1}
          onChange={(on) =>
            panel.update({
              directions: on ? [...form.directions.slice(0, 1), newDirection('y')] : form.directions.slice(0, 1),
            })
          }
        />
      )}
      {form.layout === 'circular' && (
        <>
          <AxisRows
            label="Axis"
            axis={form.circular.axis}
            reversed={form.circular.reversed}
            armed={armed === 'axis'}
            onArm={() => setArmed('axis')}
            onAxis={(axis) => panel.update({ circular: { ...form.circular, axis } })}
            onReversed={(reversed) => panel.update({ circular: { ...form.circular, reversed } })}
            {...axisBounds(
              panel.values,
              ['layout', 'circular', 'axis'],
              form.circular.axis,
              form.circular.reversed,
              true,
            )}
          />
          <Select
            label="Distribution"
            value={form.circular.distribution}
            options={CIRCULAR_DISTRIBUTIONS}
            bound={panel.values.boundText(
              ['layout', 'circular', 'symmetric'],
              form.circular.distribution === 'symmetric',
            )}
            onChange={(distribution) => panel.update({ circular: withDistribution(form.circular, distribution) })}
          />
          <ExprField
            label="Count"
            value={form.circular.count}
            onChange={(count) => panel.update({ circular: { ...form.circular, count } })}
            onEnter={panel.confirm}
          />
          {form.circular.distribution !== 'full' && (
            <ExprField
              label="Angle"
              value={form.circular.angle}
              unit="°"
              onChange={(angle) => panel.update({ circular: { ...form.circular, angle } })}
              onEnter={panel.confirm}
            />
          )}
        </>
      )}
      {form.layout !== 'kept' && (
        <ExprField
          label="Suppress"
          value={form.suppress}
          placeholder={suppressHint(form)}
          onChange={(suppress) => panel.update({ suppress })}
          onEnter={panel.confirm}
        />
      )}
      {form.of === 'bodies' && (
        <ToggleRow
          label="Operation"
          value={form.operation}
          options={COPY_OPS}
          bound={panel.values.boundText(['operation', 'op'], form.operation)}
          onChange={(operation) => panel.update({ operation })}
        />
      )}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}

// ---- Mirror ----

const MIRROR: PanelSpec<MirrorForm> = {
  type: 'core.mirror',
  baseName: 'Mirror',
  create: (services) => {
    const form = newMirrorForm();
    const features = selectedFeatures(services);
    return features.length > 0 ? { ...form, of: 'features', items: features, operation: 'new' } : form;
  },
  read: readMirror,
  build: buildMirror,
};

type MirrorPlane = 'xy' | 'xz' | 'yz';

const MIRROR_PLANES: { id: MirrorPlane; label: string }[] = [
  { id: 'xy', label: 'XY' },
  { id: 'xz', label: 'XZ' },
  { id: 'yz', label: 'YZ' },
];

export function MirrorPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, MIRROR);
  // Opened with features already picked, it waits for the plane.
  const [armed, setArmed] = useState<'items' | 'plane'>(() =>
    panel && panel.form.items.length > 0 && !panel.form.plane ? 'plane' : 'items',
  );
  const [hint, setHint] = useState<string | null>(null);
  usePicking(
    services,
    armed === 'items'
      ? { kinds: ['face', 'edge'], standardPlanes: false }
      : { kinds: ['standard', 'construction', 'face'], standardPlanes: true },
  );
  const form = panel?.form;
  useShownPicks(services, panel?.target.part ?? null, [
    ...(form?.items ?? []).map((i) => i.reference),
    ...(form?.plane ? [form.plane.reference] : []),
  ]);

  const onClick = (item: SelectionItem | null) => {
    if (!panel || !item) return;
    void (async () => {
      const f = panel.latest.current;
      // A standard plane clicked in the browser is the mirror plane, whichever list is armed.
      if (armed === 'items' && !('standard' in item)) {
        const next = await clickCopied(services, panel.target, f, item);
        if (typeof next !== 'string') panel.update(next);
        setHint(typeof next === 'string' ? next : null);
        return;
      }
      const kind = kindOf(services.display.getState().display, item);
      if (
        kind === 'face' &&
        'key' in item &&
        (await services.client.properties(item.key))?.measures.surface !== 'plane'
      ) {
        setHint('This face is not flat');
        return;
      }
      if (kind !== 'standard' && kind !== 'plane' && kind !== 'face') {
        setHint('Pick a plane or a flat face');
        return;
      }
      const plane = await pickFor(services, panel.target, item);
      if (!plane) return;
      setHint(null);
      panel.update({ plane });
      setArmed('items');
    })();
  };
  useClicks(services, viewport, onClick);
  useTreeClicks(services, onClick);

  if (!panel || !form) return null;
  const standard = form.plane ? at(form.plane.reference, 'standard', 'name') : undefined;
  const picked = form.plane && standard === undefined ? [form.plane] : [];
  return (
    <PanelCard
      title={form.of === 'bodies' ? 'Mirror Body' : 'Mirror'}
      icon={<MirrorIcon size={14} color="#a855f7" />}
      onClose={close}
    >
      <ToggleRow
        label="Of"
        value={form.of}
        options={OF}
        onChange={(of) =>
          panel.update({
            of,
            items: of === form.of ? form.items : of === 'features' ? selectedFeatures(services) : [],
            ...(of === form.of ? {} : { operation: of === 'bodies' ? 'join' : 'new' }),
          })
        }
      />
      <PickList
        label={form.of === 'bodies' ? 'Bodies' : 'Features'}
        items={form.items}
        armed={armed === 'items'}
        onArm={() => setArmed('items')}
        onRemove={(i) => panel.update({ items: form.items.filter((_, j) => j !== i) })}
        empty={form.of === 'bodies' ? 'Click the bodies to mirror' : 'Click features, in the timeline or the view'}
      />
      <Row label="Plane">
        <Toggles
          value={(typeof standard === 'string' ? standard : '') as MirrorPlane}
          options={MIRROR_PLANES}
          onChange={(name) => {
            panel.update({
              plane: { reference: { standard: { name } }, names: {}, label: `${name.toUpperCase()} plane` },
            });
            setArmed('items');
          }}
        />
      </Row>
      <PickList
        label="Or a plane or face"
        single
        items={picked}
        armed={armed === 'plane'}
        onArm={() => setArmed('plane')}
        onRemove={() => panel.update({ plane: null })}
        empty="Click a construction plane or a flat face"
      />
      <Note message={hint} />
      {form.of === 'bodies' && (
        <ToggleRow
          label="Operation"
          value={form.operation}
          options={COPY_OPS}
          bound={panel.values.boundText(['operation', 'op'], form.operation)}
          onChange={(operation) => panel.update({ operation })}
        />
      )}
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} okTitle="Apply mirror" />
    </PanelCard>
  );
}

// ---- Combine ----

const BOOLEAN: PanelSpec<BooleanForm> = {
  type: 'core.boolean',
  baseName: 'Combine',
  create: (_services, _part, request) =>
    newBooleanForm(request.kind === 'cut' || request.kind === 'intersect' ? request.kind : 'join'),
  read: readBoolean,
  build: buildBoolean,
};

/**
 * The Combine panel: the target body and the tool bodies picked in the view
 * or the browser (the target first, then the tools; clicking a slot arms it,
 * clicking a picked tool again drops it), the operation (Join, Cut or
 * Intersect). Cut and Intersect in the menu open it with that operation
 * chosen, and Keep Tools (the tool bodies stay).
 */
export function BooleanPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const panel = useFeaturePanel(props, BOOLEAN);
  const [armed, setArmed] = useState<'target' | 'tools'>(() => (panel?.form.target ? 'tools' : 'target'));
  const [hint, setHint] = useState<string | null>(null);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });
  const form = panel?.form;
  const references = [...(form?.target ? [form.target.reference] : []), ...(form?.tools ?? []).map((t) => t.reference)];
  useShownPicks(services, panel?.target.part ?? null, references);
  const outlineAt = usePickOutlines(services, viewport, panel?.target ?? null, references);

  const take = (body: PickedRef) => {
    if (!panel) return;
    const next = clickBooleanBody(panel.latest.current, body, armed);
    if (typeof next === 'string') {
      setHint(next);
      return;
    }
    setHint(null);
    panel.update(next);
    if (armed === 'target') setArmed('tools');
  };
  const onClick = (item: SelectionItem | null, e?: ViewportPointer) => {
    if (!panel) return;
    const dropped = e ? outlineAt(e) : null;
    if (dropped) {
      const f = panel.latest.current;
      take(
        f.target && sameReference(f.target.reference, dropped)
          ? f.target
          : (f.tools.find((t) => sameReference(t.reference, dropped)) ?? { reference: dropped, names: {}, label: '' }),
      );
      return;
    }
    if (!item || 'feature' in item) return;
    void pickBody(services, panel.target, item).then((picked) => {
      if (!picked) setHint(inOtherPart(item) ? OWN_GEOMETRY : 'Click a body');
      else take(picked);
    });
  };
  useClicks(services, viewport, onClick);
  useTreeClicks(services, onClick);
  if (!panel || !form) return null;
  return (
    <PanelCard title="Combine" icon={<FuseIcon size={14} color="#8b5cf6" />} onClose={close}>
      <PickList
        label="Target body"
        single
        items={form.target ? [form.target] : []}
        armed={armed === 'target'}
        onArm={() => setArmed('target')}
        onRemove={() => {
          panel.update({ target: null });
          setArmed('target');
        }}
        empty="Click the body to keep"
      />
      <PickList
        label="Tool bodies"
        items={form.tools}
        armed={armed === 'tools'}
        onArm={() => setArmed('tools')}
        onRemove={(i) => panel.update((f) => ({ tools: f.tools.filter((_, j) => j !== i) }))}
        empty="Click the bodies to combine with it"
      />
      <Note message={hint} />
      <ToggleRow
        label="Operation"
        value={form.op}
        options={BOOLEAN_OPS}
        bound={panel.values.boundText(['op'], form.op)}
        onChange={(op) => panel.update({ op })}
      />
      <Check
        label="Keep Tools"
        checked={form.keepTools}
        bound={panel.values.boundText(['keepTools'], form.keepTools)}
        onChange={(keepTools) => panel.update({ keepTools })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}

// ---- Remove Body ----

const REMOVE: PanelSpec<RemoveBodyForm> = {
  type: 'core.removeBody',
  baseName: 'Remove',
  create: newRemoveBodyForm,
  read: readRemoveBody,
  build: (doc, target, form) => buildRemoveBody(doc, target, form),
};

export function RemoveBodyPanel(props: PanelProps) {
  const { services, viewport, close } = props;
  // The selection as the panel opened, before the panel shows its own picks selected.
  const [opened] = useState(() => services.selection.getState().items);
  const panel = useFeaturePanel(props, REMOVE);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });
  const bodyRefs = (panel?.form.bodies ?? []).map((b) => b.reference);
  useShownPicks(services, panel?.target.part ?? null, bodyRefs);
  const outlineAt = usePickOutlines(services, viewport, panel?.target ?? null, bodyRefs);
  const onClick = (item: SelectionItem | null, e?: ViewportPointer) => {
    if (!panel) return;
    const dropped = e ? outlineAt(e) : null;
    if (dropped) {
      panel.update((f) => ({ bodies: f.bodies.filter((b) => !sameReference(b.reference, dropped)) }));
      return;
    }
    if (!item || 'feature' in item) return;
    void pickBody(services, panel.target, item).then((body) => {
      if (body) panel.update((f) => ({ bodies: toggled(f.bodies, body) }));
    });
  };
  useClicks(services, viewport, onClick);
  useTreeClicks(services, onClick);
  // Bodies selected in the browser when the panel opens are taken.
  useEffect(() => {
    if (!panel || props.request.feature) return;
    const display = services.display.getState().display;
    const keys = opened.flatMap((i) => ('key' in i && kindOf(display, i) === 'body' ? [i] : []));
    void Promise.all(keys.map((k) => pickBody(services, panel.target, k))).then((bodies) => {
      const found = bodies.filter((b): b is PickedRef => b !== null);
      if (found.length > 0) panel.update((f) => ({ bodies: f.bodies.length > 0 ? f.bodies : found }));
    });
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!panel) return null;
  return (
    <PanelCard title="Remove Body" icon={<CutIcon size={14} color="#ef4444" />} onClose={close}>
      <PickList
        label="Bodies"
        items={panel.form.bodies}
        armed
        onRemove={(i) => panel.update((f) => ({ bodies: f.bodies.filter((_, j) => j !== i) }))}
        empty="Click the bodies to remove"
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
