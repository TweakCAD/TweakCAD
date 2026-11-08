/**
 * planegcs on the main thread, loaded once, for interactive sketch solves.
 * The worker service loads its own copy the same way.
 */
import { make_gcs_wrapper, type GcsWrapper } from '@salusoft89/planegcs';
import planegcsWasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import type { SketchHost } from './host';
import { SketchSession, type SketchSessionOptions } from './session';

let loading: Promise<GcsWrapper> | null = null;

export function loadSketchSolver(): Promise<GcsWrapper> {
  loading ??= make_gcs_wrapper(planegcsWasmUrl);
  return loading;
}

/** A session on the sketch `host` names, once the solver has loaded. */
export async function openSketchSession(host: SketchHost, options: SketchSessionOptions = {}): Promise<SketchSession> {
  return new SketchSession(host, await loadSketchSolver(), options);
}
