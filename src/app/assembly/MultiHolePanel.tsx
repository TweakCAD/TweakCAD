/**
 * Hole Through Parts (12.3): click a flat face of the instance the hole
 * starts in (each further click on it adds a position), set the diameter,
 * and click the other instances it goes through. OK writes a hole into
 * each part's own timeline, one diameter for all, the other parts' holes
 * following the first through their contexts.
 */
import { useState } from 'react';
import { HoleIcon } from '../../icons/cadIcons.tsx';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import type { PanelProps } from '../AppShell';
import { useClicks, usePicking } from '../modeling/usePanel';
import { planarFrame } from '../modeling/picks';
import { Actions, ErrorLine, ExprField, Note, PanelCard, PickList } from '../modeling/panelKit';
import { assemblyOf, instanceAt, instanceLabel } from './assembly';
import { currentAssembly } from './commands';
import { assemblyDisplay } from './focus';
import { holeProblem, writeMultiHole, type HolePoint } from './multiHole';
import { rigidOf } from './pose';
import { apply, applyVector } from '@tweakcad/worker/src/v2/rigid';

const round = (n: number) => Math.round(n * 100) / 100 + 0;

export function MultiHolePanel(props: PanelProps) {
  const { services, viewport, close } = props;
  const [assembly] = useState(() => currentAssembly(services));
  const [face, setFace] = useState<{ key: number; index: number; frame: FrameDisplay } | null>(null);
  const [points, setPoints] = useState<HolePoint[]>([]);
  const [through, setThrough] = useState<number[]>([]);
  const [diameter, setDiameter] = useState('5');
  const [armed, setArmed] = useState<'face' | 'through'>('face');
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  usePicking(services, { kinds: ['face'], standardPlanes: false });

  const label = (index: number) => {
    const doc = services.editor.document;
    const asm = assembly ? assemblyOf(doc, assembly) : undefined;
    const id = assembly ? instanceAt(services.display.getState().display, assembly, index) : null;
    return asm && id ? instanceLabel(doc, asm, id) : 'Instance';
  };

  useClicks(services, viewport, (item, e) => {
    if (!assembly || !viewport || !item || !('key' in item) || item.instance?.assembly !== assembly) return;
    const index = item.instance.index;
    const problem = holeProblem(services.editor.document, services, assembly, index);
    if (problem) {
      setHint(problem);
      return;
    }
    setHint(null);
    if (armed === 'through') {
      if (face && index === face.index) return;
      setThrough((t) => (t.includes(index) ? t.filter((i) => i !== index) : [...t, index]));
      return;
    }
    const key = item.key;
    void (async () => {
      const frame = await planarFrame(services, key);
      const inst = assemblyDisplay(services.display.getState().display, assembly)?.instances[index];
      if (!frame || !inst) {
        setHint('Click a flat face where the hole starts');
        return;
      }
      // The face frame is in the part; the click is in the assembly, where the instance stands.
      const place = rigidOf(inst.placement);
      const world: FrameDisplay = {
        origin: apply(place, frame.origin),
        x: applyVector(place, frame.x),
        y: applyVector(place, frame.y),
        normal: applyVector(place, frame.normal),
      };
      const hit = viewport.planePoint(e.clientX, e.clientY, world);
      const point = { id: services.editor.newId('hp'), x: round(hit?.uv[0] ?? 0), y: round(hit?.uv[1] ?? 0) };
      if (face && face.key === key && face.index === index) setPoints((p) => [...p, point]);
      else {
        setFace({ key, index, frame });
        setPoints([point]);
        setThrough((t) => t.filter((i) => i !== index));
      }
    })();
  });

  if (!assembly) return null;
  const confirm = () => {
    if (!face || busy) return;
    setBusy(true);
    setError(null);
    void writeMultiHole(
      services,
      { assembly, face: { key: face.key, index: face.index }, points, diameter, through },
      face.frame,
    ).then((written) => {
      setBusy(false);
      if (written.ok) close();
      else setError(written.message);
    });
  };
  return (
    <PanelCard title="Hole Through Parts" icon={<HoleIcon size={14} color="#f97316" />} onClose={close}>
      <PickList
        label="Start face"
        single
        items={face ? [{ label: `Face of ${label(face.index)}` }] : []}
        armed={armed === 'face'}
        onArm={() => setArmed('face')}
        onRemove={() => {
          setFace(null);
          setPoints([]);
        }}
        empty="Click a flat face where the hole starts"
      />
      <PickList
        label="Positions"
        items={points.map((p) => ({ label: `${p.x}, ${p.y} mm` }))}
        armed={armed === 'face'}
        onArm={() => setArmed('face')}
        onRemove={(i) => setPoints((p) => p.filter((_, j) => j !== i))}
        empty="Click on the face for each hole"
      />
      <ExprField label="Diameter" value={diameter} unit="mm" onChange={setDiameter} onEnter={confirm} />
      <PickList
        label="Through"
        items={through.map((i) => ({ label: label(i) }))}
        armed={armed === 'through'}
        onArm={() => setArmed('through')}
        onRemove={(i) => setThrough((t) => t.filter((_, j) => j !== i))}
        empty="Click here, then the other parts it goes through"
      />
      <Note message={hint ?? (busy ? 'Drilling through the parts…' : null)} />
      <ErrorLine message={error} />
      <Actions onCancel={close} onOk={confirm} />
    </PanelCard>
  );
}
