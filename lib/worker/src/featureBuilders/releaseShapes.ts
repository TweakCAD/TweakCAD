/**
 * Free kernel shapes a builder made and will not return.
 *
 * A builder's intermediates — the sketch face an extrude sweeps, the tool
 * solid a cut subtracts, the un-moved copy of a placed body — are not in the
 * build context, so the rebuilder's orphan sweep never sees them. Anything a
 * builder allocates and does not publish has to be released here, or it stays
 * in the WASM heap for the worker's lifetime and grows with every rebuild.
 *
 * Never throws: a missed free is a leak, a thrown one loses the user's
 * geometry.
 */

import type { CadKernel } from '@tweakcad/kernel/src/interface.ts';
import type { KernelBody, KernelEdge, KernelFace } from '@tweakcad/kernel/src/types.ts';

export function releaseShapes(
  kernel: CadKernel,
  handles: Iterable<KernelBody | KernelFace | KernelEdge>,
): void {
  for (const handle of handles) {
    try {
      kernel.dispose(handle);
    } catch (e) {
      console.warn('[featureBuilders] Failed to release an intermediate shape:', e);
    }
  }
}
