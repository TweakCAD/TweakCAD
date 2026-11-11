/**
 * `core.import` (13.3): replays the stored shape, so a newer importer or kernel
 * never changes an import. `units` and `upAxis` record what the importer did to
 * reach it. Identities come from the shape map, after the 13.2 load check, or,
 * for a derived map (a fingerprint and no entries), from naming the shape again
 * by the `import` rule once its fingerprint matches. Frozen features and
 * captured contexts load their stored shapes the same way, from full maps only.
 */
import { OcctError, type ShapeHandle } from 'occt-wasm';
import {
  contentHash,
  nameImported,
  shapeFingerprint,
  startFeature,
  type BodyOutcome,
  type FeatureNamer,
  type ShapeMapJson,
  type ShapeRef,
} from '@tweakcad/format';
import { FeaturePause, registerBuilder, type BuildContext, type Json } from '../context';

/** An asset's bytes as text, verified against its row (13.1, 13.2). */
function assetText(ctx: BuildContext, hash: string): string {
  const row = ctx.ev.assets[hash] as Json | undefined;
  if (!row) throw new FeaturePause('the stored shape is missing from the assets');
  const data = row.data as Json | undefined;
  if (!data || !('inline' in data)) throw new FeaturePause('the stored shape is not loaded yet');
  const binary = atob((data.inline as Json).base64 as string);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (bytes.length !== row.size || contentHash(bytes) !== hash)
    throw new FeaturePause('the stored shape does not match its asset hash');
  return new TextDecoder().decode(bytes);
}

function decode(ctx: BuildContext, text: string): ShapeHandle {
  try {
    return ctx.ev.kernel.fromBREP(text);
  } catch (e) {
    if (e instanceof OcctError) throw new FeaturePause('the stored shape cannot be read');
    throw e;
  }
}

/**
 * Decodes a stored shape (13.2) and gives its sub-shapes the identities of its
 * map through `namer`; its solids become bodies. A derived map (allowed when
 * `derivable`) names the shape by the `import` rule instead, and `bodies` are
 * then the outcomes for `namer.finish`. Pauses on an unknown representation,
 * an asset that is missing or altered, a shape with no root compound, and a
 * map or fingerprint that fails the load check.
 */
export function loadStored(
  ctx: BuildContext,
  namer: FeatureNamer,
  stored: Json,
  ref: string,
  derivable = false,
): { ref: ShapeRef; handle: ShapeHandle; bodies: BodyOutcome[] } {
  const representation = stored.representation as Json;
  if (representation.name !== 'brep' || representation.version !== 1) {
    throw new FeaturePause(
      `the representation ${String(representation.name)} ${String(representation.version)} is not built yet`,
    );
  }
  const { adapter } = ctx.ev;
  const handle = decode(ctx, assetText(ctx, stored.asset as string));
  const shape = adapter.addShape(handle, ref);
  // The root of a stored shape is a compound holding the bodies (13.2).
  if (adapter.subShapes(shape)[0]?.kind !== 'compound') throw new FeaturePause('the stored shape has no root compound');
  const map = stored.map as unknown as ShapeMapJson;
  const fingerprint = stored.fingerprint as string | undefined;
  if (map.length > 0 || fingerprint === undefined) {
    namer.load(shape, map, fingerprint);
    return { ref: shape, handle, bodies: [] };
  }
  if (!derivable) throw new FeaturePause('only an import derives its shape map');
  if (shapeFingerprint(shape, adapter) !== fingerprint) {
    throw new FeaturePause('the stored shape is numbered differently from when it was written');
  }
  return { ref: shape, handle, bodies: nameImported(namer, shape, adapter) };
}

registerBuilder('core.import', (ctx) => {
  const { inputs, id, ordinal, part } = ctx;
  const { adapter, names } = ctx.ev;
  const namer = startFeature(part.state, { feature: id, ordinal }, adapter, names);
  const { ref, handle, bodies } = loadStored(ctx, namer, inputs.stored as Json, `import:${id}`, true);
  const state = namer.finish(bodies);
  const { solids } = adapter.topology(ref);
  if (solids.length === 0) throw new FeaturePause('imported surfaces are not built yet');
  if (solids.some((s) => state.get(s.solid) === undefined))
    throw new FeaturePause('a stored solid has no name in the shape map');
  part.state = state;
  part.shapes.set(ref, handle);
});
