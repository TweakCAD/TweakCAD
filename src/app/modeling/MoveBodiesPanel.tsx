/**
 * The Move panel: bodies clicked in the viewport or
 * the browser, moved by the gizmo's arrows (Move) or rings (Rotate) about
 * their centre, or by the fields: a translation, and a turn about the part
 * origin as X, Y and Z angles (an angle about an axis direction when the
 * stored turn is not plain numbers). Copy keeps the originals. The drag
 * writes the fields once it ends; the preview follows the fields.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { TransformGizmo } from '@tweakcad/viewport/src/TransformGizmo';
import { MoveIcon } from '../../icons/cadIcons.tsx';
import type { PanelProps } from '../AppShell';
import { bodiesOf } from '../features';
import { useSlice } from '../hooks';
import type { Display, Key } from '@tweakcad/worker/src/v2/service/types';
import type { SelectionItem } from '../selection';
import { buildMove, newMoveForm, readMove, type MoveForm } from './bodyFeatures';
import { sameReference } from './feature';
import { pickBody, toggled } from './BodyPanels';
import { Actions, Check, ErrorLine, ExprField, Note, PanelCard, PickList, Row, ToggleRow, XyzRow } from './panelKit';
import { bodyItem, inOtherPart, kindOf, OWN_GEOMETRY } from './picks';
import { clickWhenShown } from './viewportClicks';
import { keysOf, usePicking, useFeaturePanel, useShownPicks, useTreeClicks, type PanelSpec } from './usePanel';

const SPEC: PanelSpec<MoveForm> = {
  type: 'core.move',
  baseName: 'Move',
  create: newMoveForm,
  read: readMove,
  build: buildMove,
};

/** Pixels the pointer may move between press and release for a click. */
const CLICK_PIXELS = 3;

const num = (t: string): number | null => {
  const v = Number(t.trim() === '' ? '0' : t);
  return Number.isFinite(v) ? v : null;
};
const round = (n: number, p = 100): string => String(Math.round(n * p) / p + 0);

/** The form's transform as a rotation and translation, when its fields are plain numbers. */
export function transformOf(form: MoveForm): { q: THREE.Quaternion; t: THREE.Vector3 } | null {
  const values = [form.x, form.y, form.z, ...form.axis, form.angle].map(num);
  if (values.some((v) => v === null)) return null;
  const [x, y, z, ax, ay, az, angle] = values as number[];
  const axis = new THREE.Vector3(ax, ay, az);
  const q =
    axis.lengthSq() > 0
      ? new THREE.Quaternion().setFromAxisAngle(axis.normalize(), ((angle as number) * Math.PI) / 180)
      : new THREE.Quaternion();
  return { q, t: new THREE.Vector3(x, y, z) };
}

/** The form's fields for the transform that takes `centre` to `position`, turned by `q`. */
export function fieldsFor(
  centre: THREE.Vector3,
  position: THREE.Vector3,
  q: THREE.Quaternion,
): Pick<MoveForm, 'x' | 'y' | 'z' | 'axis' | 'angle'> {
  const t = position.clone().sub(centre.clone().applyQuaternion(q));
  return { x: round(t.x), y: round(t.y), z: round(t.z), ...turnFields(q) };
}

/** The form's turn fields for the rotation `q`: an axis direction and an angle in degrees. */
export function turnFields(q: THREE.Quaternion): Pick<MoveForm, 'axis' | 'angle'> {
  const w = Math.min(1, Math.max(-1, q.w));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  const axis: [string, string, string] =
    s < 1e-9 ? ['0', '0', '1'] : [round(q.x / s, 1e4), round(q.y / s, 1e4), round(q.z / s, 1e4)];
  return { axis, angle: round((angle * 180) / Math.PI) };
}

/** The form's turn as Euler X, Y, Z angles in degrees (about X, then Y, then Z), or null when its fields are not plain numbers. */
export function eulerOf(form: MoveForm): [string, string, string] | null {
  const tr = transformOf(form);
  if (!tr) return null;
  const e = new THREE.Euler().setFromQuaternion(tr.q, 'XYZ');
  return [round((e.x * 180) / Math.PI), round((e.y * 180) / Math.PI), round((e.z * 180) / Math.PI)];
}

/** The turn fields for Euler X, Y, Z angles in degrees, or null when one is not a number. */
export function turnOfEuler(degrees: readonly [string, string, string]): Pick<MoveForm, 'axis' | 'angle'> | null {
  const [x, y, z] = degrees.map(num);
  if (x === null || y === null || z === null || x === undefined || y === undefined || z === undefined) return null;
  const rad = Math.PI / 180;
  return turnFields(new THREE.Quaternion().setFromEuler(new THREE.Euler(x * rad, y * rad, z * rad, 'XYZ')));
}

/** The matrix of a rotation and translation. */
const matrixOf = (tr: { q: THREE.Quaternion; t: THREE.Vector3 }): THREE.Matrix4 =>
  new THREE.Matrix4().compose(tr.t, tr.q, new THREE.Vector3(1, 1, 1));

/** The centre of the shown bodies `keys`, from their meshes. */
function centreOf(display: Display | null, keys: readonly Key[]): THREE.Vector3 | null {
  const box = new THREE.Box3();
  for (const d of display?.definitions ?? []) {
    for (const b of d.bodies) {
      if (!keys.includes(b.key)) continue;
      const p = b.mesh.positions;
      for (let i = 0; i < p.length; i += 3) box.expandByPoint(new THREE.Vector3(p[i], p[i + 1], p[i + 2]));
    }
  }
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

/** Which turn fields the panel shows: X, Y, Z angles when the stored turn is plain numbers, otherwise its angle and axis as written. */
export function turnRows(form: MoveForm): 'euler' | 'axisAngle' {
  return eulerOf(form) ? 'euler' : 'axisAngle';
}

/**
 * The turn as Euler X, Y, Z angles: typing three numbers sets the stored
 * axis and angle; the row follows them otherwise.
 */
function EulerRow({
  form,
  onTurn,
  onEnter,
}: {
  form: MoveForm;
  onTurn: (turn: Pick<MoveForm, 'axis' | 'angle'>) => void;
  onEnter: () => void;
}) {
  const [drafts, setDrafts] = useState<[string, string, string] | null>(null);
  const shown = drafts ?? eulerOf(form);
  if (!shown) return null;
  return (
    <div onBlur={() => setDrafts(null)}>
      <XyzRow
        label="Rotate"
        unit="°"
        values={shown}
        onChange={(i, text) => {
          const next = shown.map((v, j) => (j === i ? text : v)) as [string, string, string];
          setDrafts(next);
          const turn = turnOfEuler(next);
          if (turn) onTurn(turn);
        }}
        onEnter={onEnter}
      />
    </div>
  );
}

export function MoveBodiesPanel(props: PanelProps) {
  const { services, viewport, close, request } = props;
  const panel = useFeaturePanel(props, SPEC);
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const [hint, setHint] = useState<string | null>(null);
  /** The bodies were taken as all the bodies of one feature (an import): the panel is Move All. */
  // The selection as the panel opened, before the panel shows its own picks selected.
  const [opened] = useState(() => services.selection.getState().items);
  const [whole, setWhole] = useState(() => !request.feature && request.from !== undefined);
  /** The picked bodies' centre before the move. */
  const centre = useRef<THREE.Vector3 | null>(null);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });
  useShownPicks(
    services,
    panel?.target.part ?? null,
    (panel?.form.bodies ?? []).map((b) => b.reference),
  );

  /** Sets the centre from the shown bodies `keys`, undoing the move when the display shows it. */
  const placeCentre = (keys: readonly Key[]) => {
    if (!panel || centre.current) return;
    const shown = centreOf(services.display.getState().display, keys);
    if (!shown) return;
    const holds = services.display.getState().preview || request.feature !== undefined;
    const tr = transformOf(panel.latest.current);
    centre.current = holds && tr ? shown.sub(tr.t).applyQuaternion(tr.q.clone().invert()) : shown;
  };

  /** A click toggles the body; `add` (the bodies selected when the panel opens) only adds it. */
  const onClick = (item: SelectionItem | null, add = false) => {
    if (!panel || !item) return;
    const body =
      kindOf(services.display.getState().display, item) === 'body'
        ? item
        : bodyItem(services.display.getState().display, item);
    void pickBody(services, panel.target, item).then((picked) => {
      if (!picked) {
        setHint(inOtherPart(item) ? OWN_GEOMETRY : 'Click a body');
        return;
      }
      setHint(null);
      if (body && 'key' in body) placeCentre([body.key]);
      panel.update((f) => ({
        bodies:
          add && f.bodies.some((b) => sameReference(b.reference, picked.reference))
            ? f.bodies
            : toggled(f.bodies, picked),
      }));
    });
  };
  /** Takes every body feature `feature` made (all of an import): Move All. */
  const madeBy = (feature: string) =>
    panel
      ? bodiesOf(services.display.getState().display, panel.target.part).filter(
          (b) => b.feature === feature && b.key >= 0,
        )
      : [];
  const takeAll = (feature: string) => {
    const bodies = madeBy(feature);
    if (bodies.length === 0) return;
    setWhole(true);
    for (const b of bodies) onClick({ key: b.key }, true);
  };
  useTreeClicks(services, (item) => {
    if ('feature' in item) takeAll(item.feature);
    else onClick(item);
  });

  // Bodies selected when the panel opens are taken, or all the bodies of the feature it is opened on; an edited move finds its centre from the bodies it shows.
  useEffect(() => {
    if (!panel) return;
    const display = services.display.getState().display;
    const selected = opened.filter((i) => 'key' in i && kindOf(display, i) === 'body');
    if (!request.feature && request.from) for (const b of madeBy(request.from)) onClick({ key: b.key }, true);
    else if (!request.feature) selected.forEach((i) => onClick(i, true));
    else {
      const part = panel.target.part;
      void Promise.all(
        panel.form.bodies.map((b) => {
          const entity = (b.reference as { entity?: unknown }).entity;
          return entity
            ? services.client.resolve(entity as never, { part })
            : Promise.resolve({ outcome: 'gone' as const });
        }),
      ).then((found) => {
        const keys = found.flatMap((r) => (r.outcome === 'same' ? r.keys : []));
        if (keys.length > 0) placeCentre(keys);
        panel.update({});
      });
    }
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The gizmo: on the proxy at the moved centre; a drag writes the fields when it ends.
  const proxy = useRef(new THREE.Object3D());
  const gizmo = useRef<TransformGizmo | null>(null);
  useEffect(() => {
    if (!viewport || !panel) return;
    const g = new TransformGizmo(viewport.getScene(), viewport.getCamera(), viewport.getCanvas(), () => undefined);
    gizmo.current = g;
    viewport.getScene().add(proxy.current);
    let down: { x: number; y: number } | null = null;
    let dragging = false;
    viewport.setPointerHandler((e) => {
      if (e.type === 'move') {
        viewport.requestRender();
        return dragging;
      }
      if (e.button !== 0) return false;
      if (e.type === 'down') {
        dragging = g.isDragging();
        down = { x: e.clientX, y: e.clientY };
        return dragging;
      }
      if (dragging) {
        dragging = false;
        down = null;
        return true;
      }
      const from = down;
      down = null;
      if (!from || Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_PIXELS) return false;
      clickWhenShown(services, viewport, e, (item) => onClick(item));
      return true;
    });
    const scene = viewport.getScene();
    const object = proxy.current;
    return () => {
      viewport.setPointerHandler(null);
      viewport.model.moveBodies([], null);
      g.dispose();
      scene.remove(object);
      gizmo.current = null;
      viewport.requestRender();
    };
    // The handler reads the latest form through the panel's ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport, panel === null]);

  const form = panel?.form;
  useEffect(() => {
    const g = gizmo.current;
    if (!g || !form || !viewport || g.isDragging()) return;
    const tr = transformOf(form);
    const c = centre.current;
    if (!tr || !c || form.bodies.length === 0) {
      g.detach();
      viewport.requestRender();
      return;
    }
    proxy.current.position.copy(c.clone().applyQuaternion(tr.q).add(tr.t));
    proxy.current.quaternion.copy(tr.q);
    proxy.current.updateMatrixWorld();
    // The bodies follow the drag: drawn moved from where the display shows them until the move is evaluated.
    let base: THREE.Matrix4 | null = null;
    g.attach(
      proxy.current,
      { mode, space: 'world' },
      {
        onDragStart: () => {
          const holds = services.display.getState().preview || request.feature !== undefined;
          base = holds ? matrixOf(tr) : new THREE.Matrix4();
        },
        onChange: (o) => {
          const from = centre.current;
          const moved = from ? transformOf({ ...form, ...fieldsFor(from, o.position, o.quaternion) }) : null;
          if (base && moved && !form.copy)
            viewport.model.moveBodies(shownKeys.current, matrixOf(moved).multiply(base.clone().invert()));
          viewport.requestRender();
        },
        onCommit: (o) => {
          base = null;
          const from = centre.current;
          if (!from || !panel) return;
          panel.update(fieldsFor(from, o.position, o.quaternion));
        },
      },
    );
    viewport.requestRender();
  }, [form, mode, viewport, panel, services, request.feature]);

  // The keys the shown display draws the picked bodies by, for the drag to move.
  const shownKeys = useRef<number[]>([]);
  const display = useSlice(services.display, (s) => s.display);
  const bodyRefs = JSON.stringify((form?.bodies ?? []).map((b) => b.reference));
  useEffect(() => {
    const part = panel?.target.part;
    if (!part) return;
    let live = true;
    void keysOf(
      services,
      part,
      (form?.bodies ?? []).map((b) => b.reference),
    ).then((items) => {
      if (live) shownKeys.current = items.flatMap((i) => ('key' in i ? [i.key] : []));
    });
    return () => {
      live = false;
    };
    // Keyed by the references and the display they are read in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyRefs, display, services]);

  if (!panel || !form) return null;
  return (
    <PanelCard title={whole ? 'Move All' : 'Move'} icon={<MoveIcon size={14} color="#0ea5e9" />} onClose={close}>
      <PickList
        label={form.of === 'faces' ? 'Faces' : 'Bodies'}
        items={form.bodies}
        armed
        onRemove={(i) => panel.update({ bodies: form.bodies.filter((_, j) => j !== i) })}
        empty="Click the bodies to move"
      />
      <Note message={hint} />
      <ToggleRow
        label="Gizmo"
        value={mode}
        options={[
          { id: 'translate', label: 'Move' },
          { id: 'rotate', label: 'Rotate' },
        ]}
        onChange={setMode}
      />
      {form.kept ? (
        <Row label="Transform">
          <span style={{ fontSize: 12, color: '#555' }}>As written</span>
        </Row>
      ) : (
        <>
          <ExprField label="X" value={form.x} unit="mm" onChange={(x) => panel.update({ x })} onEnter={panel.confirm} />
          <ExprField label="Y" value={form.y} unit="mm" onChange={(y) => panel.update({ y })} onEnter={panel.confirm} />
          <ExprField label="Z" value={form.z} unit="mm" onChange={(z) => panel.update({ z })} onEnter={panel.confirm} />
          {turnRows(form) === 'euler' ? (
            <EulerRow form={form} onTurn={(turn) => panel.update(turn)} onEnter={panel.confirm} />
          ) : (
            <>
              <ExprField
                label="Angle"
                value={form.angle}
                unit="°"
                onChange={(angle) => panel.update({ angle })}
                onEnter={panel.confirm}
              />
              <XyzRow
                label="About"
                values={form.axis}
                onChange={(i, text) =>
                  panel.update({ axis: form.axis.map((v, j) => (j === i ? text : v)) as [string, string, string] })
                }
                onEnter={panel.confirm}
              />
            </>
          )}
        </>
      )}
      <Check
        label="Copy"
        checked={form.copy}
        bound={panel.values.boundText(['copy'], form.copy)}
        onChange={(copy) => panel.update({ copy })}
      />
      <ErrorLine message={panel.error} />
      <Actions onCancel={close} onOk={panel.confirm} blocked={panel.blocked} />
    </PanelCard>
  );
}
