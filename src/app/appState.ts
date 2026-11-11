/**
 * App-wide view state that is not the document: what the user is doing
 * (modelling, or editing one sketch), which feature panel is open, what the
 * viewport's picks may land on while a panel picks, and layout toggles.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SelectionItem } from './selection';
import type { OriginItem } from './attributes';
import type { PickKind } from './viewport/ModelScene';

export type Mode = { kind: 'model' } | { kind: 'sketch'; part: string; feature: string };

/**
 * What the window works on when it is not the document's root: one of its
 * parts or assemblies, or a part edited in an assembly's context (12.4),
 * where the assembly shows and new features go into the part at instance
 * path `at`.
 */
export type Focus = { part: string; context?: { assembly: string; at: unknown } } | { assembly: string };

/** An open feature panel: which one, the feature it edits (absent while creating), and the feature it starts from. */
export interface PanelRequest {
  kind: string;
  feature?: string;
  /** A feature the new one starts from: the sketch an extrude takes its profiles from. */
  from?: string;
  /** Region keys of the shown display a new extrude or revolve starts with, in place of the selection. */
  regions?: readonly number[];
}

/** A standard plane a section view can cut parallel to. */
export type SectionOrientation = 'XY' | 'XZ' | 'YZ';

/**
 * A section view: the plane it starts from (a standard plane, or a flat
 * face or construction plane picked, as a point, its normal and its x
 * axis), how far along that normal the cut lies (null: through the bodies'
 * centre, until it is placed), its turn in degrees about the plane's x
 * axis, and whether the other half is kept.
 */
export interface SectionView {
  plane:
    | SectionOrientation
    | {
        label: string;
        origin: readonly [number, number, number];
        normal: readonly [number, number, number];
        x: readonly [number, number, number];
      };
  distance: number | null;
  angle: number;
  flipped: boolean;
}

/** What a panel lets the viewport pick, and whether the standard planes show for it. */
export interface Picking {
  kinds: readonly PickKind[];
  standardPlanes: boolean;
}

export interface AppState {
  mode: Mode;
  panel: PanelRequest | null;
  /** Set by a panel while it picks; null picks anything. */
  picking: Picking | null;
  /** Sketches a panel shows whatever their visibility (the sketches a profile-based feature takes profiles from). */
  shownSketches: readonly string[];
  /**
   * Set by a panel that takes features, bodies or standard planes clicked in
   * the browser or the timeline: those clicks go to it instead of selecting.
   */
  treeClicks: ((item: SelectionItem) => void) | null;
  sidebarCollapsed: boolean;
  /** The origin planes, axes and point drawn: the active part's, as its document keeps them. */
  originShown: ReadonlySet<OriginItem>;
  /** The parameters dialog is open. */
  parametersOpen: boolean;
  /** What the window works on; null for the document's root. */
  focus: Focus | null;
  /** The exploded view the shown assembly is drawn in, or null for its pose. */
  exploded: string | null;
  /** The Components panel is open. */
  componentsOpen: boolean;
  /** The section view while it cuts the bodies, or null. */
  section: SectionView | null;
}

export type AppStore = StoreApi<AppState>;

export function createAppStore(): AppStore {
  return createStore<AppState>(() => ({
    mode: { kind: 'model' },
    panel: null,
    picking: null,
    shownSketches: [],
    treeClicks: null,
    sidebarCollapsed: false,
    originShown: new Set(),
    parametersOpen: false,
    focus: null,
    exploded: null,
    componentsOpen: false,
    section: null,
  }));
}
