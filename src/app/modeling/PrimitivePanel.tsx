/**
 * The primitive panel: the plane it stands on (picked in the view or the
 * browser; the XY plane until then), then, for a new primitive, its base
 * drawn on that plane with clicks (two corners of a box, or a centre and a
 * size; see `primitiveDraw.ts`) with the outline following the pointer, then
 * its height dragged by the arrow on top or typed. The fields fill from the
 * clicks and stay editable: the shape, its dimensions, the position of its
 * centre in the plane's frame, and the operation. Typing in a field before
 * the base is drawn places it from the fields instead. The ribbon opens it on
 * one shape; the shape can be changed in the panel, keeping what was typed.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Json } from '@tweakcad/editor';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import { BoxIcon, ConeIcon, CylinderIcon, SphereIcon, TorusIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import type { ViewportPointer } from '../viewport/Viewport';
import { STANDARD_FRAMES } from '../viewport/ModelScene';
import { useArrowHandle } from './arrowHandle';
import { OutlineLoop } from './outlineLoop';
import { Actions, ErrorLine, ExprField, Note, PanelCard, PickList, Row, ToggleRow, XyzRow } from './panelKit';
import { kindOf, pickFor, planeFrameOf } from './picks';
import { TARGET_PICKING, TargetBodies, toggleTarget } from './TargetBodies';
import {
  buildPrimitive,
  newPrimitiveForm,
  readPrimitive,
  SHAPE_FIELDS,
  SHAPE_NAMES,
  withDims,
  withShape,
  XY_PLANE,
  type PrimitiveForm,
  type PrimitiveShape,
} from './primitive';
import { baseOutline, drawnBase, heightArrow, nextClick, onPlane, placedByFirst, type UV } from './primitiveDraw';
import { OPERATION_OPTIONS } from './RevolvePanel';
import { SnapMarker } from './snapMarker';
import {
  keysOf,
  useClicks,
  useFeaturePanel,
  usePicking,
  useShownPicks,
  useTreeClicks,
  type PanelSpec,
} from './usePanel';

const SHAPES = Object.keys(SHAPE_FIELDS) as PrimitiveShape[];

/** The panel kind of each shape's ribbon tool. */
export const shapeOfKind = (kind: string): PrimitiveShape => SHAPES.find((s) => kind === `primitive.${s}`) ?? 'box';

/** A new primitive is named by its shape ("Box 1", "Cylinder 1"), and waits for its base to be drawn. */
const specOf = (shape: PrimitiveShape): PanelSpec<PrimitiveForm> => ({
  type: 'core.primitive',
  baseName: SHAPE_NAMES[shape],
  create: (_services, _part, request) => ({ ...newPrimitiveForm(shapeOfKind(request.kind)), drawing: true }),
  read: readPrimitive,
  build: buildPrimitive,
});

const SPECS = Object.fromEntries(SHAPES.map((s) => [s, specOf(s)])) as Record<PrimitiveShape, PanelSpec<PrimitiveForm>>;

export const SHAPE_ICONS: Record<PrimitiveShape, (size: number, color: string) => React.ReactNode> = {
  box: (size, color) => <BoxIcon size={size} color={color} />,
  cylinder: (size, color) => <CylinderIcon size={size} color={color} />,
  sphere: (size, color) => <SphereIcon size={size} color={color} />,
  cone: (size, color) => <ConeIcon size={size} color={color} />,
  torus: (size, color) => <TorusIcon size={size} color={color} />,
};

/**
 * The frame of the plane a primitive stands on: a standard plane's at
 * once, another found again in each new display, keeping the last one
 * found (the preview may cover the face it was picked on). `found` sets it
 * for a plane just picked.
 */
function usePlaneFrame(
  services: AppServices,
  part: string | null,
  reference: Json | null,
): [FrameDisplay | null, (reference: Json, frame: FrameDisplay) => void] {
  const key = reference ? JSON.stringify(reference) : '';
  const [state, setState] = useState<{ key: string; frame: FrameDisplay } | null>(null);
  const refs = useRef(reference);
  useLayoutEffect(() => {
    refs.current = reference;
  });
  useEffect(() => {
    const ref = refs.current;
    if (!part || !ref) return;
    const standard = (ref.standard as { name?: string } | undefined)?.name;
    if (standard === 'xy' || standard === 'xz' || standard === 'yz') {
      setState({ key, frame: STANDARD_FRAMES[standard] });
      return;
    }
    let live = true;
    const find = async () => {
      const item = (await keysOf(services, part, [ref]).catch(() => []))[0];
      const frame = item ? await planeFrameOf(services, item).catch(() => null) : null;
      if (live && frame) setState({ key, frame });
    };
    void find();
    const off = services.display.subscribe((s, prev) => {
      if (s.display !== prev.display) void find();
    });
    return () => {
      live = false;
      off();
    };
  }, [services, part, key]);
  return [state?.key === key ? state.frame : null, (r, frame) => setState({ key: JSON.stringify(r), frame })];
}

export function PrimitivePanel(props: PanelProps) {
  const { services, viewport } = props;
  const panel = useFeaturePanel(props, SPECS[shapeOfKind(props.request.kind)]);
  // A new primitive waits for its plane, then its base; an edited one for nothing.
  const [armed, setArmed] = useState<'plane' | 'base' | 'targets' | null>(() =>
    props.request.feature ? null : 'plane',
  );
  const [first, setFirst] = useState<UV | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [frame, setFrame] = usePlaneFrame(
    services,
    panel?.target.part ?? null,
    panel && !panel.form.keptFrame ? panel.form.plane.reference : null,
  );
  const targeting = armed === 'targets' && panel !== null && panel.form.operation !== 'new';
  usePicking(
    services,
    targeting
      ? TARGET_PICKING
      : armed === 'plane'
        ? { kinds: ['standard', 'construction', 'face'], standardPlanes: true }
        : { kinds: [], standardPlanes: false },
  );
  useShownPicks(
    services,
    panel?.target.part ?? null,
    panel
      ? [
          ...(armed === 'plane' || armed === 'base' ? [panel.form.plane.reference] : []),
          ...(panel.form.operation !== 'new' ? panel.form.targets.map((t) => t.reference) : []),
        ]
      : [],
  );

  // What the base looks like while it is drawn: a marker where the next click lands, then the outline from the first click.
  const marker = useRef<SnapMarker | null>(null);
  const outline = useRef<OutlineLoop | null>(null);
  useEffect(() => {
    if (!viewport) return;
    const m = new SnapMarker(viewport.getScene());
    const o = new OutlineLoop(viewport.getScene());
    marker.current = m;
    outline.current = o;
    return () => {
      m.dispose();
      o.dispose();
      marker.current = null;
      outline.current = null;
      viewport.requestRender();
    };
  }, [viewport]);
  const drawingBase = armed === 'base' && frame !== null;
  useEffect(() => {
    if (drawingBase) return;
    marker.current?.hide();
    outline.current?.hide();
    viewport?.requestRender();
  }, [drawingBase, viewport]);

  const onMove = (e: ViewportPointer) => {
    if (!panel || !viewport || !drawingBase || !frame) return;
    const hit = viewport.planePoint(e.clientX, e.clientY, frame);
    if (!hit) return;
    if (first) {
      marker.current?.hide();
      outline.current?.show(baseOutline(panel.form.shape, first, hit.uv).map((p) => onPlane(frame, p)));
    } else marker.current?.show(onPlane(frame, hit.uv), frame.normal, hit.pixel);
    viewport.requestRender();
  };

  const onClick = (item: SelectionItem | null, e?: ViewportPointer) => {
    if (!panel) return;
    if (armed === 'base') {
      const hit = e && viewport && frame ? viewport.planePoint(e.clientX, e.clientY, frame) : null;
      if (!hit) return;
      if (!first) {
        setFirst(hit.uv);
        return;
      }
      const patch = drawnBase(panel.latest.current, first, hit.uv);
      if (!patch) return;
      panel.update(patch);
      setFirst(null);
      setArmed(null);
      return;
    }
    if (!item) return;
    if (armed === 'plane') {
      void (async () => {
        const kind = kindOf(services.display.getState().display, item);
        if (kind !== 'standard' && kind !== 'plane' && kind !== 'face') {
          setHint('Pick a plane or a flat face');
          return;
        }
        const picked = await planeFrameOf(services, item);
        if (!picked) {
          setHint(kind === 'face' ? 'This face is not flat' : 'Pick a plane or a flat face');
          return;
        }
        const plane = await pickFor(services, panel.target, item);
        if (!plane) return;
        setHint(null);
        setFrame(plane.reference, picked);
        panel.update({ plane, keptFrame: undefined });
        setFirst(null);
        setArmed(panel.latest.current.drawing ? 'base' : null);
      })();
      return;
    }
    if (!targeting) return;
    void toggleTarget(services, panel.target, item).then((r) => {
      if ('hint' in r) setHint(r.hint);
      else {
        setHint(null);
        panel.update((f) => ({ targets: r.toggle(f.targets) }));
      }
    });
  };

  const arrow =
    panel && frame && !panel.form.drawing && !panel.form.keptFrame && armed !== 'base'
      ? heightArrow(panel.form, frame)
      : null;
  const dragging = useArrowHandle(viewport, arrow, (height) =>
    panel?.update((f) => withDims(f, { ...f.dims, height })),
  );
  useClicks(services, viewport, onClick, dragging, onMove);
  useTreeClicks(services, onClick);
  if (!panel) return null;
  const { form } = panel;
  /** A field typed in: the base is placed from the fields, centred on a first click if there was one. */
  const set = (patch: Partial<PrimitiveForm>) => {
    if (!form.drawing) {
      panel.update(patch);
      return;
    }
    const next = { ...form, ...patch, drawing: false };
    panel.update({ ...patch, drawing: false, ...(first ? placedByFirst(next, first) : {}) });
    setFirst(null);
    if (armed === 'base') setArmed(null);
  };
  const note = drawingBase ? nextClick(form.shape, first) : hint;
  return (
    <PanelCard title={SHAPE_NAMES[form.shape]} icon={SHAPE_ICONS[form.shape](14, '#14b8a6')} onClose={props.close}>
      {!form.keptFrame && (
        <PickList
          label="Plane"
          single
          items={[form.plane]}
          armed={armed === 'plane'}
          onArm={() => setArmed('plane')}
          onRemove={() => {
            panel.update({ plane: XY_PLANE });
            setFirst(null);
            setArmed('plane');
          }}
          empty="Click a plane or a flat face"
        />
      )}
      <ToggleRow
        label="Shape"
        value={form.shape}
        options={SHAPES.map((s) => ({ id: s, label: SHAPE_NAMES[s] }))}
        onChange={(shape) => panel.update(withShape(form, shape))}
      />
      {SHAPE_FIELDS[form.shape].map((f, i) => (
        <ExprField
          key={`${form.shape}|${f.field}`}
          label={f.label}
          value={form.dims[f.field] ?? ''}
          unit="mm"
          onChange={(text) => set(withDims(form, { ...form.dims, [f.field]: text }))}
          onEnter={panel.confirm}
          autoFocus={i === 0 && !form.drawing}
        />
      ))}
      {form.keptFrame ? (
        <Row label="Position">
          <span style={{ fontSize: 12, color: '#555' }}>Attached</span>
        </Row>
      ) : (
        <XyzRow
          label="Center"
          title="Where the primitive's center sits, in the plane's frame"
          values={[form.x, form.y, form.z]}
          onChange={(i, text) => set(i === 0 ? { x: text } : i === 1 ? { y: text } : { z: text })}
          onEnter={panel.confirm}
        />
      )}
      <ToggleRow
        label="Operation"
        value={form.operation}
        options={OPERATION_OPTIONS}
        bound={panel.values.boundText(['operation', 'op'], form.operation)}
        onChange={(operation) => panel.update({ operation })}
      />
      {form.operation !== 'new' && (
        <TargetBodies
          targets={form.targets}
          armed={armed === 'targets'}
          onArm={() => setArmed('targets')}
          onChange={(targets) => panel.update({ targets })}
        />
      )}
      <Note message={note} />
      <ErrorLine message={panel.error} />
      <Actions onCancel={props.close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
