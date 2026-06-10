/**
 * Imported geometry feature builder.
 *
 * Reads the base64-encoded file bytes out of `inputs.data`, decodes
 * to ArrayBuffer, and calls `kernel.importStep`, `kernel.importStl`,
 * or `kernel.importBrep` depending on `inputs.format`. The kernel
 * decomposes STEP compounds
 * into per-solid bodies (see `decomposeToBodies` in occtKernel.ts);
 * a single-solid file returns a one-body result.
 *
 * Each imported body gets a deterministic id derived from the feature
 * id + a per-body suffix — same pattern Extrude uses for multi-profile
 * outputs — so the user's downstream FaceRef / EdgeRef captures
 * survive subsequent rebuilds.
 */

import type {
  FeatureNode,
  ImportedGeometryFeatureInputs,
} from '@tweakcad/core/src/document/schema.ts';
import type { ResolvedParams } from '@tweakcad/core/src/expressions.ts';
import { bodyId as bodyIdBrand } from '@tweakcad/core/src/ids.ts';
import type { BodyId } from '@tweakcad/core/src/ids.ts';
import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { BuildContext, BuildResult } from '@tweakcad/core/src/features/contracts.ts';

export async function buildImportedGeometry(
  node: FeatureNode,
  _params: ResolvedParams,
  _context: BuildContext,
  kernel: CadKernel,
): Promise<BuildResult> {
  const inputs = node.inputs as unknown as ImportedGeometryFeatureInputs;

  if (!inputs.data || inputs.data.length === 0) {
    throw new Error(`Imported geometry "${inputs.fileName}" has empty data`);
  }
  if (inputs.format !== 'step' && inputs.format !== 'stl' && inputs.format !== 'brep') {
    throw new Error(`Unsupported import format: ${inputs.format}`);
  }

  // Decode base64 → ArrayBuffer. atob is sync + reasonably fast; for
  // very large files (>50MB) we'd switch to a streaming decoder, but
  // STEP/STL files in the typical hobby/professional CAD range are
  // 100KB-20MB.
  const buf = base64ToArrayBuffer(inputs.data);

  // Feature.id makes the topology-tracker origin deterministic across
  // rebuilds — same import re-running produces the same stable face
  // and edge IDs.
  const origin = `import_${node.id}`;
  const importResult = inputs.format === 'step'
    ? await kernel.importStep(buf, origin)
    : inputs.format === 'brep'
      ? await kernel.importBrep(buf, origin)
      : await kernel.importStl(buf, origin);

  if (!importResult.ok) {
    throw new Error(`Import "${inputs.fileName}" failed: ${importResult.error.message}`);
  }
  const bodies = importResult.value;
  if (bodies.length === 0) {
    throw new Error(`Import "${inputs.fileName}" produced no bodies`);
  }

  // Apply stored placement (Move gizmo): per-body transform first, then the
  // whole-import group transform on top. Absent/identity → leave as imported.
  // A rigid transform preserves TShapes so stable IDs carry over.
  // Per-body placement is keyed by the body's FULL id (`body_import_<feat>_<i>`)
  // — the same key Shell's Move tool writes, so no fragile index parsing.
  const groupT = inputs.transform;
  const perBody = inputs.bodyTransforms ?? {};
  const out = [];
  for (let i = 0; i < bodies.length; i++) {
    let handle = bodies[i]!;
    const id = bodyIdBrand(`body_import_${node.id}_${i}`);
    const bt = perBody[String(id)];
    if (bt && !isIdentityTransform(bt)) {
      const r = await kernel.transform(handle, bt);
      if (!r.ok) throw new Error(`Placing "${inputs.fileName}" body ${i} failed: ${r.error.message}`);
      handle = r.value;
    }
    if (groupT && !isIdentityTransform(groupT)) {
      const r = await kernel.transform(handle, groupT);
      if (!r.ok) throw new Error(`Placing "${inputs.fileName}" failed: ${r.error.message}`);
      handle = r.value;
    }
    out.push({ bodyId: id, handle });
  }
  return {
    bodies: out,
    outputs: {
      bodies: Object.fromEntries(
        out.map((b, i) => [i === 0 ? 'main' : `body_${i}`, b.bodyId]),
      ) as Record<string, BodyId>,
    },
  };
}

/**
 * Base64 string → ArrayBuffer. Uses the global atob (available in
 * both browser main thread and web worker contexts; not in pure
 * Node, but the worker runs in a browser-like environment).
 */
/** True when a transform is the identity (no move) — skip the kernel call. */
function isIdentityTransform(t: { position: [number, number, number]; rotation: [number, number, number, number] }): boolean {
  const [px, py, pz] = t.position;
  const [rx, ry, rz, rw] = t.rotation;
  return px === 0 && py === 0 && pz === 0 && rx === 0 && ry === 0 && rz === 0 && rw === 1;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
