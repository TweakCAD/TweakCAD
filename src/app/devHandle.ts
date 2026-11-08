/**
 * A development-only handle on `window.__TWEAKCAD__`, for driving the app
 * from the browser console or an automated browser: open a document from
 * text, read the saved text and the display, wait for rebuilds.
 */
import type { Display } from '@tweakcad/worker/src/v2/service/types';
import type { AppServices } from './services';
import type { SelectionItem } from './selection';
import type { FileOutcome } from './storage/session';
import type { Viewport } from './viewport/Viewport';

export interface DevHandle {
  services: AppServices;
  /** Opens a `.cadjson` text as if it were picked from disk. */
  openText(text: string, filename?: string): FileOutcome;
  /** The document as Save writes it. */
  save(): string;
  display(): Display | null;
  /** Resolves once the newest document is shown. */
  idle(): Promise<void>;
  viewport(): Viewport | null;
  /** What a click at a client point would select. */
  pickAt(clientX: number, clientY: number): SelectionItem | null;
  undo(): boolean;
  redo(): boolean;
}

declare global {
  interface Window {
    __TWEAKCAD__?: DevHandle;
  }
}

export function installDevHandle(services: AppServices, viewport: () => Viewport | null): () => void {
  const handle: DevHandle = {
    services,
    openText: (text, filename) => services.session.openText(text, filename ? { filename, handle: null } : undefined),
    save: () => services.editor.save(),
    display: () => services.display.getState().display,
    idle: () => services.whenShown(),
    viewport,
    pickAt: (x, y) => viewport()?.pickAt(x, y) ?? null,
    undo: () => services.editor.undo(),
    redo: () => services.editor.redo(),
  };
  window.__TWEAKCAD__ = handle;
  return () => {
    if (window.__TWEAKCAD__ === handle) delete window.__TWEAKCAD__;
  };
}
