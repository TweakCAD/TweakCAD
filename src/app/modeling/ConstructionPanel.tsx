/**
 * The construction panels: a plane, axis, point or frame, made from picked
 * planes, points and lines in one of the attachment modes, or at
 * coordinates, with the offset and flip of the attached frame. One panel
 * serves the four kinds; the ribbon's CONSTRUCT group opens it on one.
 *
 * Offset Plane and Plane from Face open it on an offset plane whose base is
 * a plane (a standard or construction plane) or a flat face of a body;
 * Midplane, Axis Through Cylinder and Point at Center open it on those
 * types. An offset plane shows a handle on the canvas: dragging it along the
 * offset direction sets the offset.
 *
 * Every part of an attached frame's offset shows: the offset along the
 * normal, the shift along the frame's x and y, and one turn about its x
 * axis, its y axis or its normal.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformGizmo } from '@tweakcad/viewport/src/TransformGizmo';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { AxisIcon, ConstructionPointIcon, FrameIcon, PlaneIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import type { Picking } from '../appState';
import { useSlice } from '../hooks';
import type { SelectionItem } from '../selection';
import type { Viewport } from '../viewport/Viewport';
import {
  buildConstruction,
  clickedSupport,
  CONSTRUCTION_NAMES,
  CONSTRUCTION_TYPES,
  MODES,
  newConstructionForm,
  offsetDirection,
  readConstruction,
  SUPPORTS,
  withMode,
  type ConstructionForm,
  type ConstructionKind,
  type ConstructionMode,
  type SupportSlot,
  type TurnAxis,
} from './construction';
import {
  Actions,
  Check,
  ErrorLine,
  ExprField,
  Note,
  PanelCard,
  PickList,
  Row,
  ToggleRow,
  type ToggleOption,
} from './panelKit';
import { sameReference } from './feature';
import { kindOf, pickFor } from './picks';
import {
  useClicks,
  useFeaturePanel,
  usePicking,
  useShownPicks,
  useTreeClicks,
  type FeaturePanel,
  type PanelSpec,
} from './usePanel';

const MODE_LABELS: Record<ConstructionMode, string> = {
  plane: 'Offset',
  planeAtPoint: 'At point',
  threePoints: '3 points',
  twoPoints: '2 points',
  point: 'At point',
  alongLine: 'Along line',
  midplane: 'Midplane',
  faceAxis: 'Through cylinder',
  center: 'At center',
  fixed: 'Coordinates',
};

/** Where a kind reads a mode differently. */
const KIND_LABELS: Partial<Record<ConstructionKind, Partial<Record<ConstructionMode, string>>>> = {
  plane: { alongLine: 'Normal to line' },
  axis: { plane: 'Normal', planeAtPoint: 'Normal at point' },
  point: { planeAtPoint: 'On plane' },
};

const modeLabel = (kind: ConstructionKind, mode: ConstructionMode): string =>
  KIND_LABELS[kind]?.[mode] ?? MODE_LABELS[mode];

const CONSTRUCTION_ICONS: Record<ConstructionKind, React.ReactNode> = {
  plane: <PlaneIcon size={14} color="#3b82f6" />,
  axis: <AxisIcon size={14} color="#3b82f6" />,
  point: <ConstructionPointIcon size={14} color="#3b82f6" />,
  frame: <FrameIcon size={14} color="#3b82f6" />,
};

const SLOT_LABELS: Record<SupportSlot, string> = {
  plane: 'Plane',
  point: 'Point',
  line: 'Line',
  round: 'Face',
  center: 'Circle or sphere',
};
const SLOT_EMPTY: Record<SupportSlot, string> = {
  plane: 'Click a plane or a flat face',
  point: 'Click a point or a circular edge',
  line: 'Click a straight edge, line or axis',
  round: 'Click a cylindrical, conical or toroidal face',
  center: 'Click a circular edge, a sphere or a torus',
};
const PICKING: Record<SupportSlot, Picking> = {
  plane: { kinds: ['standard', 'construction', 'face'], standardPlanes: true },
  point: { kinds: ['sketchPoint', 'construction', 'edge'], standardPlanes: false },
  line: { kinds: ['sketchCurve', 'construction', 'edge'], standardPlanes: false },
  round: { kinds: ['face'], standardPlanes: false },
  center: { kinds: ['edge', 'face'], standardPlanes: false },
};

const TURN_OPTIONS: ToggleOption<TurnAxis>[] = [
  { id: 'x', label: 'X', title: 'About the x axis of the frame it attaches to' },
  { id: 'y', label: 'Y', title: 'About the y axis of the frame it attaches to' },
  { id: 'z', label: 'Normal', title: 'About the normal: a turn within the plane' },
];

/** A type the ribbon opens the panel on: Midplane, Axis Through Cylinder, Point at Center. */
const PRESET_MODES: Record<string, ConstructionMode> = {
  'construction.midplane': 'midplane',
  'construction.axisThroughCylinder': 'faceAxis',
  'construction.pointAtCenter': 'center',
};

const PRESET_TITLES: Record<string, string> = {
  'construction.midplane': 'Midplane',
  'construction.axisThroughCylinder': 'Axis Through Cylinder',
  'construction.pointAtCenter': 'Point at Center',
};

/** The type a ribbon request opens the panel on, or null for the kind's first. */
export const modeOfRequest = (kind: string): ConstructionMode | null => PRESET_MODES[kind] ?? null;

/** An offset plane on one kind of base, as the ribbon's Offset Plane and Plane from Face open the panel. */
type Base = 'plane' | 'face';

const BASES: Record<Base, { title: string; slot: string; empty: string; hint: string; picking: Picking }> = {
  plane: {
    title: 'Offset Plane',
    slot: 'Base plane',
    empty: 'Click a default plane (XY/XZ/YZ) or an existing construction plane',
    hint: 'Click a default plane (XY/XZ/YZ) or a construction plane',
    picking: { kinds: ['standard', 'construction'], standardPlanes: true },
  },
  face: {
    title: 'Plane from Face',
    slot: 'Face',
    empty: 'Click a planar face on a body',
    hint: 'Click a planar face on a body',
    picking: { kinds: ['face'], standardPlanes: false },
  },
};

/** The base an Offset Plane or Plane from Face request fixes, or null for the general panel. */
export const baseOfRequest = (kind: string): Base | null =>
  kind === 'construction.offsetPlane' ? 'plane' : kind === 'construction.planeFromFace' ? 'face' : null;

const smallButton = {
  fontSize: 11,
  border: '1px solid #e0e0e0',
  borderRadius: 4,
  background: '#f7f7f7',
  height: 24,
  cursor: 'pointer',
} as const;

function specOf(kind: ConstructionKind): PanelSpec<ConstructionForm> {
  return {
    type: CONSTRUCTION_TYPES[kind],
    baseName: CONSTRUCTION_NAMES[kind],
    create: (_services, _part, request) => {
      const form = newConstructionForm(kind);
      const mode = modeOfRequest(request.kind);
      return mode && MODES[kind].includes(mode) ? withMode(form, mode) : form;
    },
    read: readConstruction(kind),
    build: buildConstruction,
  };
}

const SPECS: Record<ConstructionKind, PanelSpec<ConstructionForm>> = {
  plane: specOf('plane'),
  axis: specOf('axis'),
  point: specOf('point'),
  frame: specOf('frame'),
};

/** The construction kind of a panel request: `construction.plane` and so on. */
export const kindOfRequest = (kind: string): ConstructionKind => {
  const k = kind.replace(/^construction\./, '');
  if (k === 'axisThroughCylinder') return 'axis';
  if (k === 'pointAtCenter') return 'point';
  return k === 'axis' || k === 'point' || k === 'frame' ? k : 'plane';
};

export function ConstructionPanel(props: PanelProps) {
  // The kind is fixed for the panel's life: it is keyed by its request.
  const [kind] = useState(() => kindOfRequest(props.request.kind));
  const [base] = useState(() => (props.request.feature ? null : baseOfRequest(props.request.kind)));
  return <ConstructionKindPanel {...props} spec={SPECS[kind]} base={base} />;
}

const num = (t: string): number | null => {
  const v = Number(t.trim() === '' ? '0' : t);
  return Number.isFinite(v) ? v : null;
};

/** The frame the display shows for construction feature `feature`, or null. */
function shownFrame(display: Display | null, feature: string) {
  for (const d of display?.definitions ?? []) {
    const c = d.construction.find((x) => x.feature === feature);
    if (c) return c.frame;
  }
  return null;
}

/**
 * The handle that drags an offset plane's offset: an arrow at the plane
 * the panel makes, along the offset direction. A drag writes the offset
 * field as it goes; the preview follows the field. Returns whether it is
 * being dragged.
 */
function useOffsetHandle(
  viewport: Viewport | null,
  display: Display | null,
  panel: FeaturePanel<ConstructionForm> | null,
  on: boolean,
): () => boolean {
  const gizmo = useRef<TransformGizmo | null>(null);
  const proxy = useRef(new THREE.Object3D());
  const drag = useRef<{ from: THREE.Vector3; offset: number; direction: THREE.Vector3 } | null>(null);
  const live = panel !== null && on;

  useEffect(() => {
    if (!viewport || !live) return;
    const g = new TransformGizmo(viewport.getScene(), viewport.getCamera(), viewport.getCanvas(), () => undefined);
    gizmo.current = g;
    const scene = viewport.getScene();
    const object = proxy.current;
    scene.add(object);
    return () => {
      g.dispose();
      scene.remove(object);
      gizmo.current = null;
      viewport.requestRender();
    };
  }, [viewport, live]);

  const form = panel?.form;
  const feature = panel?.target.feature;
  useEffect(() => {
    const g = gizmo.current;
    if (!g || !viewport || !form || !feature) return;
    if (g.isDragging()) return;
    const frame = shownFrame(display, feature);
    const angle = num(form.angle);
    const offset = num(form.offset);
    if (!frame || angle === null || offset === null) {
      g.detach();
      viewport.requestRender();
      return;
    }
    const direction = new THREE.Vector3(...offsetDirection(frame, angle, form.flip, form.about)).normalize();
    proxy.current.position.set(...frame.origin);
    proxy.current.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    proxy.current.updateMatrixWorld();
    g.attach(
      proxy.current,
      { mode: 'translate', space: 'local', showX: false, showY: false, showZ: true },
      {
        onDragStart: (o) => {
          drag.current = { from: o.position.clone(), offset: num(panel.latest.current.offset) ?? 0, direction };
        },
        onChange: (o) => {
          const d = drag.current;
          if (!d) return;
          const moved = o.position.clone().sub(d.from).dot(d.direction);
          panel.update({ offset: String(Math.round((d.offset + moved) * 100) / 100 + 0) });
          viewport.requestRender();
        },
        onCommit: () => {
          drag.current = null;
        },
      },
    );
    viewport.requestRender();
  }, [display, form, feature, viewport, panel, live]);

  return () => gizmo.current?.isDragging() ?? false;
}

function ConstructionKindPanel(props: PanelProps & { spec: PanelSpec<ConstructionForm>; base: Base | null }) {
  const { services, viewport, close, base } = props;
  const panel = useFeaturePanel(props, props.spec);
  const display = useSlice(services.display, (s) => s.display);
  const [armed, setArmed] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const form = panel?.form;
  const slots = form ? SUPPORTS[form.mode] : [];
  const slotKind = slots[armed] ?? 'plane';
  const fixedBase = base && slotKind === 'plane' ? BASES[base] : null;
  usePicking(services, fixedBase ? fixedBase.picking : PICKING[slotKind]);
  useShownPicks(
    services,
    panel?.target.part ?? null,
    (form?.supports ?? []).flatMap((s) => (s ? [s.reference] : [])),
  );
  const usesOffset = form !== undefined && form.mode !== 'fixed' && !form.kept?.offset;
  const dragging = useOffsetHandle(viewport, display, panel, usesOffset && form.kind === 'plane');

  const onClick = (item: SelectionItem | null) => {
    if (!panel || !item || slots.length === 0) return;
    void (async () => {
      const display = services.display.getState().display;
      const kind = kindOf(display, item);
      if (slotKind === 'plane') {
        const face = kind === 'face' && 'key' in item;
        const plane = kind === 'standard' || kind === 'plane';
        if (base === 'plane' && !plane) {
          setHint(BASES.plane.hint);
          return;
        }
        if (base === 'face' && !face) {
          setHint(BASES.face.hint);
          return;
        }
        const flat = face ? (await services.client.properties(item.key))?.measures.surface === 'plane' : plane;
        if (!flat) {
          setHint(base === 'face' ? 'This face is not flat' : 'Pick a plane or a flat face');
          return;
        }
      } else if (slotKind === 'round') {
        const surface =
          kind === 'face' && 'key' in item ? (await services.client.properties(item.key))?.measures.surface : undefined;
        if (surface !== 'cylinder' && surface !== 'cone' && surface !== 'torus') {
          setHint('Pick a cylindrical, conical or toroidal face');
          return;
        }
      } else if (slotKind === 'center') {
        const measures =
          'key' in item && (kind === 'face' || kind === 'edge')
            ? (await services.client.properties(item.key))?.measures
            : undefined;
        const round =
          kind === 'edge'
            ? measures?.curve === 'circle'
            : measures?.surface === 'sphere' || measures?.surface === 'torus';
        if (!round) {
          setHint('Pick a circular edge, a sphere or a torus');
          return;
        }
      } else if (slotKind === 'line') {
        const straight =
          kind === 'edge' && 'key' in item
            ? (await services.client.properties(item.key))?.measures.curve === 'line'
            : kind === 'axis' || kind === 'curve';
        if (!straight) {
          setHint('Pick a straight edge, a sketch line or an axis');
          return;
        }
      } else if (
        kind === 'edge' &&
        'key' in item &&
        (await services.client.properties(item.key))?.measures.curve !== 'circle'
      ) {
        setHint('Pick a point, or a circular edge for its center');
        return;
      }
      const picked = await pickFor(services, panel.target, item);
      if (!picked) {
        setHint('Pick it again');
        return;
      }
      setHint(null);
      // Clicking a picked support again drops it.
      const next = clickedSupport(panel.latest.current.supports, armed, picked, (a, b) =>
        sameReference(a.reference, b.reference),
      );
      panel.update({ supports: next.supports });
      setArmed(next.armed);
    })();
  };
  useClicks(services, viewport, onClick, dragging);
  // A standard plane clicked in the browser fills a plane slot, a standard axis a line slot, the origin a point slot.
  useTreeClicks(services, (item) => {
    if ('standard' in item && slotKind === 'plane' && base !== 'face') onClick(item);
    if ('datum' in item && slotKind === (item.datum === 'origin' ? 'point' : 'line')) onClick(item);
  });

  if (!panel || !form) return null;
  const name = base
    ? BASES[base].title
    : (!props.request.feature && PRESET_TITLES[props.request.kind]) || CONSTRUCTION_NAMES[form.kind];
  // A plane or a frame shows its whole offset; an axis or a point shows the shift and turn when it has one.
  const placed =
    form.kind === 'plane' ||
    form.kind === 'frame' ||
    form.shiftX.trim() !== '0' ||
    form.shiftY.trim() !== '0' ||
    form.angle.trim() !== '0';
  const modes = MODES[form.kind].map((m) => ({ id: m, label: modeLabel(form.kind, m) }));
  const setSlot = (slot: SupportSlot, reference: { standard: { name: string } }, label: string) => {
    const index = slots[armed] === slot ? armed : slots.indexOf(slot);
    panel.update({ supports: form.supports.map((s, j) => (j === index ? { reference, names: {}, label } : s)) });
  };
  return (
    <PanelCard title={name} icon={CONSTRUCTION_ICONS[form.kind]} onClose={close}>
      {modes.length > 1 && !base && (
        <ToggleRow
          label="Type"
          value={form.mode}
          options={modes}
          bound={panel.values.boundText(['frame', 'attach', 'mode'], form.mode)}
          onChange={(mode) => {
            panel.update(withMode(form, mode));
            setArmed(0);
          }}
        />
      )}
      {slots.map((slot, i) => (
        <PickList
          key={`${form.mode}|${i}`}
          label={
            base && slot === 'plane'
              ? BASES[base].slot
              : slots.filter((k) => k === slot).length > 1
                ? `${SLOT_LABELS[slot]} ${i + 1}`
                : SLOT_LABELS[slot]
          }
          single
          items={form.supports[i] ? [form.supports[i] as { label: string }] : []}
          armed={armed === i}
          onArm={() => setArmed(i)}
          onRemove={() => panel.update({ supports: form.supports.map((s, j) => (j === i ? null : s)) })}
          empty={base && slot === 'plane' ? BASES[base].empty : SLOT_EMPTY[slot]}
        />
      ))}
      {slots.includes('point') && (
        <Row label="">
          <button
            type="button"
            style={smallButton}
            onClick={() => setSlot('point', { standard: { name: 'origin' } }, 'Origin')}
          >
            Use the origin
          </button>
        </Row>
      )}
      {slots.includes('line') && (
        <Row label="Part axis">
          <span style={{ display: 'flex', gap: 4 }}>
            {(['x', 'y', 'z'] as const).map((name) => (
              <button
                key={name}
                type="button"
                style={{ ...smallButton, width: 28 }}
                onClick={() => setSlot('line', { standard: { name } }, `${name.toUpperCase()} axis`)}
              >
                {name.toUpperCase()}
              </button>
            ))}
          </span>
        </Row>
      )}
      <Note message={hint} />
      {form.mode === 'fixed' && !form.kept?.fixed && (
        <>
          <ExprField label="X" value={form.x} unit="mm" onChange={(x) => panel.update({ x })} onEnter={panel.confirm} />
          <ExprField label="Y" value={form.y} unit="mm" onChange={(y) => panel.update({ y })} onEnter={panel.confirm} />
          <ExprField label="Z" value={form.z} unit="mm" onChange={(z) => panel.update({ z })} onEnter={panel.confirm} />
        </>
      )}
      {usesOffset && (
        <ExprField
          label="Offset"
          value={form.offset}
          unit="mm"
          onChange={(offset) => panel.update({ offset })}
          onEnter={panel.confirm}
          autoFocus
        />
      )}
      {usesOffset && placed && (
        <ExprField
          label="Shift X"
          value={form.shiftX}
          unit="mm"
          onChange={(shiftX) => panel.update({ shiftX })}
          onEnter={panel.confirm}
        />
      )}
      {usesOffset && placed && (
        <ExprField
          label="Shift Y"
          value={form.shiftY}
          unit="mm"
          onChange={(shiftY) => panel.update({ shiftY })}
          onEnter={panel.confirm}
        />
      )}
      {usesOffset && placed && (
        <ExprField
          label="Angle"
          value={form.angle}
          unit="°"
          onChange={(angle) => panel.update({ angle })}
          onEnter={panel.confirm}
        />
      )}
      {usesOffset && placed && (
        <ToggleRow
          label="About"
          value={form.about}
          options={TURN_OPTIONS}
          onChange={(about) => panel.update({ about })}
        />
      )}
      {form.mode !== 'fixed' && (
        <Check
          label="Flip"
          checked={form.flip}
          bound={panel.values.boundText(['frame', 'attach', 'flip'], form.flip)}
          onChange={(flip) => panel.update({ flip })}
        />
      )}
      <ErrorLine message={panel.error} />
      <Actions
        onCancel={close}
        onOk={panel.confirm}
        blocked={panel.blocked}
        okTitle={form.kind === 'plane' ? 'Create plane' : undefined}
      />
    </PanelCard>
  );
}
