/**
 * Dragging an instance: an instance held by a joint moves only within it, the
 * gizmo standing at the joint and showing the joint's own slides and turns; a
 * free instance moves and turns anywhere. Each drag is written when it ends,
 * with the pose the solve gives, as one undo step. A grounded instance does
 * not move, nor does one whose joints that move are all locked (Lock Motion).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Move3d } from 'lucide-react';
import { TransformGizmo } from '@tweakcad/viewport/src/TransformGizmo';
import { matrixOf } from '@tweakcad/worker/src/v2/service/picking';
import type { Placement } from '@tweakcad/worker/src/v2/service/types';
import type { PanelProps } from '../AppShell';
import { useSlice } from '../hooks';
import { usePicking } from '../modeling/usePanel';
import { Note, PanelCard, ToggleRow } from '../modeling/panelKit';
import { flagReader } from '../features';
import {
  JOINT_KINDS,
  assemblyOf,
  indicesOf,
  instanceAt,
  instanceLabel,
  jointLabel,
  jointLocked,
  rowsOf,
  storedPlacement,
  type JointKind,
} from './assembly';
import { commitSolved } from './commit';
import { currentAssembly, reported, selectedInstances } from './commands';
import { assemblyDisplay } from './focus';
import { jointsOf } from './joints';
import { carried, jointValues } from './pose';

const CLICK_PIXELS = 3;

const placementOf = (o: THREE.Object3D): Placement => ({
  position: [o.position.x, o.position.y, o.position.z],
  rotation: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w],
});

export function MoveInstancePanel(props: PanelProps) {
  const { services, viewport, close, request } = props;
  const { editor, display: displayStore } = services;
  const assembly = useMemo(() => currentAssembly(services), [services]);
  const [instance, setInstance] = useState<string | null>(
    () => request.from ?? (assembly ? (selectedInstances(services, assembly)[0] ?? null) : null),
  );
  const [mode, setMode] = useState<'translate' | 'rotate'>('translate');
  const [busy, setBusy] = useState(false);
  const display = useSlice(displayStore, (s) => s.display);
  usePicking(services, { kinds: ['face', 'edge'], standardPlanes: false });

  useEffect(() => {
    if (!assembly) close();
  }, [assembly, close]);

  const doc = editor.document;
  const asm = assembly ? assemblyOf(doc, assembly) : undefined;
  const row = rowsOf(asm, 'instances').find((r) => r.id === instance);
  const grounded = row ? flagReader(doc)(row.grounded) : false;
  const moving =
    assembly && instance
      ? jointsOf(doc, assembly, instance).filter((j) => (JOINT_KINDS[j.joint.kind as JointKind]?.dofs.length ?? 0) > 0)
      : [];
  // A locked joint holds where it stands: the instance moves within another joint, or not at all.
  const held = moving.find((j) => !jointLocked(doc, asm, j.joint.id as string));
  const lockedBy = held ? undefined : moving[0];
  const dofs: readonly string[] = held
    ? JOINT_KINDS[held.joint.kind as JointKind].dofs
    : ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];
  const slides = dofs.filter((d) => d.startsWith('t'));
  const turns = dofs.filter((d) => d.startsWith('r'));
  const effectiveMode = slides.length === 0 ? 'rotate' : turns.length === 0 ? 'translate' : mode;

  // Where the gizmo stands: the joint end the instance stands on, or the instance's own origin.
  const shown = assemblyDisplay(display, assembly);
  const index = assembly && instance ? (indicesOf(display, assembly, instance)[0] ?? -1) : -1;
  const frames = held ? shown?.jointFrames[held.joint.id as string] : undefined;
  const start: Placement | undefined = held
    ? frames
      ? frames[held.side]
      : undefined
    : shown?.instances[index]?.placement;

  const proxy = useRef(new THREE.Object3D());
  const gizmo = useRef<TransformGizmo | null>(null);
  const latest = useRef({ start, index, held, frames, instance, busy });
  useLayoutEffect(() => {
    latest.current = { start, index, held, frames, instance, busy };
  });

  // Clicks pick the instance to move; drags on a handle move it.
  useEffect(() => {
    if (!viewport || !assembly) return;
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
      const item = viewport.pickAt(e.clientX, e.clientY);
      if (item && 'key' in item && item.instance?.assembly === assembly) {
        const id = instanceAt(services.display.getState().display, assembly, item.instance.index);
        if (id) setInstance(id);
      }
      return true;
    });
    const scene = viewport.getScene();
    const object = proxy.current;
    return () => {
      viewport.setPointerHandler(null);
      g.dispose();
      scene.remove(object);
      gizmo.current = null;
      viewport.requestRender();
    };
  }, [viewport, assembly, services]);

  const startPosition = start?.position.join(',');
  const startRotation = start?.rotation.join(',');
  useEffect(() => {
    const g = gizmo.current;
    if (!g || !viewport) return;
    if (!start || grounded || lockedBy || busy || !instance) {
      g.detach();
      viewport.requestRender();
      return;
    }
    proxy.current.matrixAutoUpdate = true;
    proxy.current.position.set(...start.position);
    proxy.current.quaternion.set(...start.rotation);
    proxy.current.updateMatrixWorld();
    const show = (d: string) => dofs.includes(effectiveMode === 'translate' ? `t${d}` : `r${d}`);
    g.attach(
      proxy.current,
      { mode: effectiveMode, space: held ? 'local' : 'world', showX: show('x'), showY: show('y'), showZ: show('z') },
      {
        onChange: (o) => {
          // The instance follows the handle while it is dragged; the solve places it when the drag ends.
          const { start: from, index: at } = latest.current;
          const inst =
            at >= 0
              ? services.display.getState().display?.assemblies.find((a) => a.id === assembly)?.instances[at]
              : undefined;
          const drawn = at >= 0 ? viewport.model.instanceObject(at) : undefined;
          if (from && inst && drawn) {
            drawn.matrix.fromArray(matrixOf(carried(inst.placement, from, placementOf(o))));
            drawn.matrixWorldNeedsUpdate = true;
          }
          viewport.requestRender();
        },
        onCommit: (o) => {
          const { start: from, held: joint, frames: ends, instance: id, index: at } = latest.current;
          if (!from || !id || !assembly) return;
          const now = placementOf(o);
          const doc = editor.document;
          const a = assemblyOf(doc, assembly);
          let label: string;
          let command;
          if (joint && ends) {
            const kindDofs = JOINT_KINDS[joint.joint.kind as JointKind].dofs;
            const state = joint.side === 'b' ? jointValues(kindDofs, ends.a, now) : jointValues(kindDofs, now, ends.b);
            label = `Drive ${a ? jointLabel(a, joint.joint.id as string) : 'joint'}`;
            command = { type: 'editAssemblyRow' as const, row: joint.joint.id as string, set: { state } };
          } else {
            const inst = services.display.getState().display?.assemblies.find((x) => x.id === assembly)?.instances[at];
            if (!inst) return;
            label = `Move ${a ? instanceLabel(doc, a, id) : 'instance'}`;
            command = {
              type: 'editAssemblyRow' as const,
              row: id,
              set: {
                placement: storedPlacement(carried(inst.placement, from, now)) as unknown as Record<string, unknown>,
              },
            };
          }
          setBusy(true);
          void commitSolved(services, label, [command]).then((written) => {
            setBusy(false);
            reported(label, written);
          });
        },
      },
    );
    viewport.requestRender();
    // Re-attached whenever what is moved, or where it stands, changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    viewport,
    startPosition,
    startRotation,
    effectiveMode,
    grounded,
    lockedBy?.joint.id,
    busy,
    instance,
    held?.joint.id,
  ]);

  if (!assembly) return null;
  const name = asm && instance ? instanceLabel(doc, asm, instance) : null;
  const note = !instance
    ? 'Click the instance to move'
    : grounded
      ? `${name ?? 'It'} is grounded; unground it to move it`
      : lockedBy
        ? `${asm ? jointLabel(asm, lockedBy.joint.id as string) : 'Its joint'} is locked; unlock it to move ${name ?? 'it'}`
        : held
          ? `Moves within ${asm ? jointLabel(asm, held.joint.id as string) : 'its joint'}`
          : 'Free: drag to move or turn it';
  return (
    <PanelCard title={name ? `Move ${name}` : 'Move'} icon={<Move3d size={14} color="#6366f1" />} onClose={close}>
      {slides.length > 0 && turns.length > 0 && (
        <ToggleRow
          label="Gizmo"
          value={effectiveMode}
          options={[
            { id: 'translate', label: 'Move' },
            { id: 'rotate', label: 'Rotate' },
          ]}
          onChange={setMode}
        />
      )}
      <Note message={note} />
    </PanelCard>
  );
}
