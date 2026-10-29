/**
 * Immer-based document store.
 * Single source of truth for the .cadjson document.
 * All mutations go through this store.
 */

import { produce, enablePatches, applyPatches } from 'immer';
import type { Patch } from 'immer';
import type { CadProject } from '../document/schema.ts';
import type { PartId } from '../ids.ts';
import { UndoManager } from './undoManager.ts';

enablePatches();

export class DocumentStore {
  private state: CadProject;
  private undoManager = new UndoManager();
  private listeners = new Set<(s: CadProject) => void>();
  private dirtyListeners = new Set<(fromIndex: number, partId: PartId) => void>();
  private revision = 0;

  /**
   * @param initial - Initial project state
   */
  constructor(initial: CadProject) {
    this.state = initial;
  }

  /** @returns The current frozen document state */
  getState(): Readonly<CadProject> {
    return this.state;
  }

  /** @returns The current document revision number (incremented on every mutation) */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Apply a mutation to the document state.
   * Records undo entry, detects dirty features, and notifies subscribers.
   * @param label - Human-readable label for undo/redo (undefined skips undo recording)
   * @param recipe - Immer producer function
   */
  mutate(label: string | undefined, recipe: (draft: CadProject) => void): void {
    let patches: Patch[] = [];
    let inversePatches: Patch[] = [];

    const next = produce(this.state, recipe, (p, ip) => {
      patches = p;
      inversePatches = ip;
    });

    // Skip undo recording when the recipe was a no-op (handler early-return,
    // dedupe hit, etc.). An empty patch entry would otherwise show as a
    // ghost step in the undo stack — the SketchApplyConstraint
    // dedupe goes through here and must not pollute history.
    if (label && patches.length > 0) {
      this.undoManager.record({
        label,
        patches,
        inversePatches,
        timestamp: Date.now(),
      });
    }

    this.state = next;
    this.revision++;
    this.notify();
    this.detectDirty(patches);
  }

  /**
   * Undo the last mutation.
   *
   * `detectDirty` runs on the inverse patches for the same reason `mutate`
   * runs it on the forward ones: undoing a feature changes the geometry the
   * timeline describes, and nothing else triggers a rebuild. Without it,
   * Ctrl+Z after an extrude removed the feature from the timeline and left
   * the body in the viewport, with a `bodyToFeatureMap` still pointing at a
   * feature that no longer existed.
   *
   * Inverse patches carry the same path shape as the forward ones, so the
   * classifier reads them identically.
   */
  undo(): void {
    this.undoManager.undo(p => {
      this.state = applyPatches(this.state, p);
      this.revision++;
      this.notify();
      this.detectDirty(p);
    });
  }

  /** Redo the last undone mutation. Dirties the same way — see {@link undo}. */
  redo(): void {
    this.undoManager.redo(p => {
      this.state = applyPatches(this.state, p);
      this.revision++;
      this.notify();
      this.detectDirty(p);
    });
  }

  /** @returns Whether undo is available */
  canUndo(): boolean {
    return this.undoManager.canUndo();
  }

  /** @returns Whether redo is available */
  canRedo(): boolean {
    return this.undoManager.canRedo();
  }

  /** @returns Label for the next undo action */
  undoLabel(): string | undefined {
    return this.undoManager.undoLabel();
  }

  /** @returns Label for the next redo action */
  redoLabel(): string | undefined {
    return this.undoManager.redoLabel();
  }

  /**
   * Subscribe to state changes.
   * @param fn - Callback receiving new state
   * @returns Unsubscribe function
   */
  subscribe(fn: (s: CadProject) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Subscribe to dirty feature detection.
   * Triggered when Immer patches touch timeline features.
   * @param fn - Callback with dirty feature index and part ID
   * @returns Unsubscribe function
   */
  onDirtyFeature(fn: (fromIndex: number, partId: PartId) => void): () => void {
    this.dirtyListeners.add(fn);
    return () => this.dirtyListeners.delete(fn);
  }

  /**
   * Begin a transaction - groups multiple mutations into one undo step.
   * @param label - Label for the transaction group
   */
  beginTransaction(label: string): void {
    this.undoManager.beginTransaction(label);
  }

  /** End the current transaction */
  endTransaction(): void {
    this.undoManager.endTransaction();
  }

  /** Clear all undo/redo history */
  clearHistory(): void {
    this.undoManager.clear();
  }

  /**
   * Replace the document wholesale (e.g. loaded from storage on boot).
   * Clears undo history; notifies subscribers; bumps revision; marks every
   * existing part's timeline as dirty so the rebuild scheduler refreshes
   * geometry from the new state.
   */
  replaceDocument(next: CadProject): void {
    this.state = next;
    this.revision++;
    this.undoManager.clear();
    this.notify();
    for (const partId of Object.keys(this.state.parts) as PartId[]) {
      this.dirtyListeners.forEach((fn) => fn(0, partId));
    }
  }

  /**
   * Analyze Immer patches to detect which features became dirty.
   *
   * Three patch shapes mark something dirty:
   *   - `parts.{partId}.timeline.{index}.*` → that feature (+ all
   *     subsequent ones in the same part) needs rebuilding.
   *   - `parameters.values.*` → ANY part may reference any project
   *     parameter, so every part is marked dirty.
   *   - `parts.{partId}.parameters.values.*` → only that part's
   *     timeline depends on its own parameter scope.
   *
   * Changes to display-only properties (visible) do NOT trigger rebuilds
   * since visibility is a viewport concern, not a geometry concern.
   *
   * The Set deduping avoids spamming the listener N times when a single
   * `SetParameter` produces multiple Immer patches (e.g. add + replace).
   */
  private detectDirty(patches: Patch[]): void {
    const DISPLAY_ONLY_PROPERTIES = new Set(['visible']);
    const dirty = new Map<PartId, number>();

    function markPart(partId: PartId, fromIndex: number) {
      const prev = dirty.get(partId);
      if (prev === undefined || fromIndex < prev) dirty.set(partId, fromIndex);
    }

    for (const patch of patches) {
      if (patch.path[0] === 'parts' && patch.path[2] === 'timeline') {
        if (patch.path.length === 5 && typeof patch.path[4] === 'string' && DISPLAY_ONLY_PROPERTIES.has(patch.path[4])) {
          continue;
        }
        const partId = patch.path[1] as PartId;
        const idx = typeof patch.path[3] === 'number' ? patch.path[3] : 0;
        markPart(partId, idx);
      } else if (patch.path[0] === 'parameters') {
        // Project-level parameter change: any part might reference it,
        // so every part rebuilds from the start.
        for (const partId of Object.keys(this.state.parts) as PartId[]) {
          markPart(partId, 0);
        }
      } else if (patch.path[0] === 'parts' && patch.path[2] === 'parameters') {
        // Part-scoped parameter change: only that part needs rebuilding.
        const partId = patch.path[1] as PartId;
        markPart(partId, 0);
      } else if (patch.path[0] === 'parts' && patch.path[2] === 'configurations') {
        // Active config or row overrides changed — re-resolve params and
        // rebuild from the start. Only affects the part the config lives on.
        const partId = patch.path[1] as PartId;
        markPart(partId, 0);
      } else if (patch.path[0] === 'references' || patch.path[0] === 'embeddedComponents') {
        // Imported-geometry assets and embedded component sources are shared
        // document-level stores: any part may hold a feature pointing into
        // them, and the patch path says nothing about which. Rebuild all.
        //
        // Without this, re-linking a reference whose bytes were not loaded
        // changed the document and nothing else — the import stayed broken
        // and the error's own advice ("re-link the file to rebuild this
        // import") did not work.
        for (const partId of Object.keys(this.state.parts) as PartId[]) {
          markPart(partId, 0);
        }
      }
    }

    for (const [partId, fromIndex] of dirty) {
      this.dirtyListeners.forEach(fn => fn(fromIndex, partId));
    }
  }

  /** Notify all subscribers of state change */
  private notify(): void {
    this.listeners.forEach(fn => fn(this.state));
  }
}
