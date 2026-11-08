/**
 * What the tool executor runs on: the app's services (editor, scheduler,
 * display, worker service), the viewport, the main-thread sketch solver, and the session's handles.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { Json } from '@tweakcad/editor';
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import { activePartOf } from '../app/assembly/focus';
import { partsOf } from '../app/features';
import type { AppServiceClient, AppServices } from '../app/services';
import { HandleTable } from './handles';

/** The camera and canvas the view tools drive (`Viewport` has them). */
export interface ViewControl {
  fitToView(): void;
  setStandardView(view: 'front' | 'back' | 'top' | 'bottom' | 'left' | 'right' | 'home'): void;
  zoomIn(): void;
  zoomOut(): void;
  /** The canvas drawn now, as a JPEG data URL. */
  screenshot(quality?: number): string;
  getCanvas(): HTMLCanvasElement;
}

export interface AiContext {
  services: AppServices;
  /** The worker service (the app's client). */
  client: AppServiceClient;
  /** The viewport, when one is mounted. */
  viewport: () => ViewControl | null;
  /** The sketch solver on this thread. */
  solver: () => Promise<GcsWrapper>;
  handles: HandleTable;
}

export interface AiContextOptions {
  services: AppServices;
  viewport?: () => ViewControl | null;
  solver: () => Promise<GcsWrapper>;
}

export function createAiContext(o: AiContextOptions): AiContext {
  return {
    services: o.services,
    client: o.services.client,
    viewport: o.viewport ?? (() => null),
    solver: o.solver,
    handles: new HandleTable(),
  };
}

/** A tool's refusal: a code and a message the model reads. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'REFUSED'
  | 'STALE_HANDLE'
  | 'BUSY'
  | 'UNSUPPORTED_BY_HOST'
  | 'HOST_ERROR';

export const invalid = (message: string): ToolError => new ToolError('INVALID_INPUT', message);

const PREVIEWING =
  'A feature panel is open in the app and shows its preview; ask the user to finish or cancel it first.';

/**
 * The display of the editor's newest document, once it is shown. A change
 * made while waiting starts another evaluate, which is waited for too. When
 * the newest evaluate failed, the display left is of an older document, so
 * it is refused; with `orOlder` it is returned anyway (what the diagnostics
 * show beside the error).
 */
export async function settledDisplay(ctx: AiContext, orOlder = false): Promise<Display> {
  const { scheduler, display, editor } = ctx.services;
  if (scheduler.previewing) throw new ToolError('BUSY', PREVIEWING);
  do await scheduler.whenIdle();
  while (scheduler.busy);
  if (scheduler.previewing) throw new ToolError('BUSY', PREVIEWING);
  const state = display.getState();
  if (!state.display)
    throw new ToolError(
      'HOST_ERROR',
      state.error ? `The model could not be rebuilt: ${state.error}` : 'Nothing is shown yet.',
    );
  if (!orOlder && (state.error !== null || state.preview || state.revision !== editor.store.revision)) {
    throw new ToolError(
      'HOST_ERROR',
      `The model could not be rebuilt: ${state.error ?? 'the newest document is not shown'}`,
    );
  }
  return state.display;
}

/**
 * Refuses an edit while the app shows a revision read-only, and while a
 * feature panel previews its own candidate, which the edit would be built
 * under.
 */
export function checkCanEdit(ctx: AiContext): void {
  if (ctx.services.editor.store.readOnly) {
    throw new ToolError(
      'REFUSED',
      'The app shows an older revision read-only; ask the user to close the preview or restore that revision first.',
    );
  }
  if (ctx.services.scheduler.previewing || ctx.services.app.getState().panel !== null) {
    throw new ToolError('BUSY', 'A feature panel is open in the app; ask the user to finish or cancel it first.');
  }
}

/** The part a tool works on: the one named, or the part new features go into in the app (as its modeling commands choose it), or the first part. */
export function partArg(ctx: AiContext, part: unknown): string {
  const doc = ctx.services.editor.document;
  if (part !== undefined) {
    if (typeof part !== 'string') throw invalid('`part` is a part id');
    if (!partsOf(doc).some((p) => p.id === part)) throw new ToolError('NOT_FOUND', `There is no part ${part}`);
    return part;
  }
  const active = activePartOf(doc, ctx.services.app.getState().focus);
  if (active) return active;
  const first = partsOf(doc)[0];
  if (!first) throw new ToolError('NOT_FOUND', 'The document has no part');
  return first.id as string;
}

export function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
