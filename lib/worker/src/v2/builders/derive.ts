/**
 * `core.derive` (11.1): bodies of another part, an assembly or a library
 * component brought into this part. The source builds as a variant with the
 * derive's insertion overrides; its bodies are placed by `frame`, then, when
 * `mirror` is given, reflected in that default plane of this part. Each
 * derived entity keeps its name in the source with the `derive` step in its
 * `chain` (9.5), and the `mirror` step after it, so a pick on a derived face
 * survives an edit to the source that keeps the face.
 */
import { resolve, startFeature, type EntityRecord, type ShapeRef } from '@tweakcad/format';
import type { ShapeHandle } from 'occt-wasm';
import { FeaturePause, registerBuilder, type BuildContext, type Json } from '../context';
import { applyToCopies } from '../copies';
import { recordDerive } from '../deriveRecords';
import { STANDARD, frameOf } from '../places';
import { fromFrame, type Plane } from '../rigid';
import { copyShapes, mergeStates, variantOf, type Placeable } from '../variants';

/**
 * The source shapes holding the derived bodies. A body that shares its shape
 * with bodies that are not derived comes as a shape of its own, its solid's
 * sub-shapes keeping their keys, so they keep their names.
 */
function picked(ctx: BuildContext, source: Placeable, items: Json): (readonly [ShapeRef, ShapeHandle])[] {
  if ('all' in items) return [...source.shapes];
  const chosen = new Map<ShapeRef, Set<number>>();
  for (const ref of ((items.items as Json).set as Json[]) ?? []) {
    const record = (ref.entity ?? null) as EntityRecord | null;
    if (!record) throw new FeaturePause('only bodies are derived yet');
    const found = resolve(record, source.state, ctx.ev.adapter);
    if (found.outcome !== 'same')
      throw new FeaturePause(`a derived body is ${found.outcome === 'ask' ? 'ambiguous' : 'gone'} in its source`);
    for (const e of found.entities) {
      const shape = e.kind === 'body' ? source.state.bodies.get(e.key) : undefined;
      if (shape === undefined) throw new FeaturePause('only bodies are derived yet');
      chosen.set(shape, (chosen.get(shape) ?? new Set()).add(e.key));
    }
  }
  const { adapter } = ctx.ev;
  return [...chosen].flatMap(([shape, solids]) => {
    if (adapter.topology(shape).solids.length === solids.size)
      return [[shape, source.shapes.get(shape) as ShapeHandle] as const];
    return [...solids].map((solid) => {
      const handle = adapter.handleOf(solid);
      return [adapter.addShape(handle, `derive:${ctx.id}:${solid}`), handle] as const;
    });
  });
}

function mirrorPlane(mirror: Json): Plane {
  const ref = mirror.plane as Json;
  const frame = 'standard' in ref ? STANDARD[(ref.standard as Json).name as string] : undefined;
  if (!frame) throw new FeaturePause('a derive mirrors only in a default plane yet');
  return { point: frame.origin, normal: frame.normal };
}

registerBuilder('core.derive', (ctx) => {
  const { ev, part, inputs, id, ordinal } = ctx;
  const variant = variantOf(ev, inputs.from as Json, inputs.overrides as Json[], id);
  const source = variant.result;
  const shapes = picked(ctx, source, inputs.items as Json);
  if (shapes.length === 0) throw new FeaturePause('the source has no body to derive');
  const frame = fromFrame(frameOf(ctx, inputs.frame as Json));
  const mirror = inputs.mirror === undefined ? undefined : mirrorPlane(inputs.mirror as Json);

  const namer = startFeature(mergeStates(part.state, source.state), { feature: id, ordinal }, ev.adapter, ev.names);
  let copies = copyShapes(ev, namer, shapes, { rigid: frame }, { op: { id }, key: { derive: {} } });
  for (const ref of source.shapes.keys()) namer.retire(ref);
  if (mirror) {
    const reflected = copyShapes(
      ev,
      namer,
      copies.map((c) => [c.shape, c.handle] as const),
      { mirror },
      { op: { id }, key: { mirror: {} } },
    );
    for (const c of copies) namer.retire(c.shape);
    copies = reflected;
  }
  applyToCopies(ctx, namer, copies, inputs.operation as Json);
  recordDerive(part, { feature: id, frame, ...(mirror ? { mirror } : {}) });
});
