import type * as THREE from 'three';
import type { Editor } from '@tweakcad/editor';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';

/** What the app gives a sketch session. Coordinates are the part's frame. */
export interface SketchHost {
  editor: Editor;
  /** The part id. */
  part: string;
  /** The core.sketch feature being edited. */
  feature: string;
  /** The sketch's frame in the part, from the display. */
  frame: FrameDisplay;
  /** Added to the scene by the shell, in part coordinates; the session owns its children. */
  group: THREE.Group;
  requestRender(): void;
}

export interface SketchPointer {
  type: 'down' | 'move' | 'up';
  /** The pointer on the sketch plane, in sketch coordinates (mm). */
  uv: [number, number];
  /** Millimetres per screen pixel at that point, for pick and snap tolerances. */
  pixel: number;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export interface SketchLabel {
  /** The constraint id. */
  id: string;
  /** Anchor in part coordinates. */
  at: [number, number, number];
  /** What to show, e.g. "40 mm". */
  text: string;
  /** The value's expression text, for editing. */
  expression: string;
  /** The unit a plain number typed into the label is in. */
  unit: 'mm' | 'deg';
}
