/**
 * The bodies a join, cut or intersect acts on: all bodies until some are
 * picked; clicking the list arms it, and then a click on any face or edge of a body
 * adds that body, or drops it when it is there already.
 */
import type { AppServices } from '../services';
import type { SelectionItem } from '../selection';
import { pickBody, toggled } from './BodyPanels';
import type { FeatureTarget, PickedRef } from './feature';
import { PickList } from './panelKit';
import { inOtherPart, OWN_GEOMETRY } from './picks';
import type { Toggle } from './profiles';

/** What the viewport may pick while the target list is armed. */
export const TARGET_PICKING = { kinds: ['face', 'edge'], standardPlanes: false } as const;

/** The body under `item` added to the targets or dropped from them, or a hint why nothing changed. */
export async function toggleTarget(
  services: AppServices,
  target: FeatureTarget,
  item: SelectionItem,
): Promise<Toggle<PickedRef>> {
  const picked = await pickBody(services, target, item);
  if (!picked) return { hint: inOtherPart(item) ? OWN_GEOMETRY : 'Click a body' };
  return { toggle: (now) => toggled(now, picked) };
}

export function TargetBodies({
  targets,
  armed,
  onArm,
  onChange,
}: {
  targets: readonly PickedRef[];
  armed: boolean;
  onArm: () => void;
  onChange: (targets: PickedRef[]) => void;
}) {
  return (
    <PickList
      label="Target bodies"
      items={targets}
      armed={armed}
      onArm={onArm}
      onRemove={(i) => onChange(targets.filter((_, j) => j !== i))}
      empty={armed ? 'All bodies; click the bodies to act on' : 'All bodies'}
    />
  );
}
