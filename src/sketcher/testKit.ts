/** What the sketch session tests share: a document with an empty sketch, a host, and pointer events. */
import * as THREE from 'three';
import type { GcsWrapper } from '@salusoft89/planegcs';
import { readDocument } from '@tweakcad/format';
import { Editor, seededIds, type Json } from '@tweakcad/editor';
import { PLACEMENT_TEXT, TestDoc } from '../../lib/editor/src/testDocs';
import type { FrameDisplay } from '@tweakcad/worker/src/v2/service/types';
import type { SketchHost, SketchPointer } from './host';
import { sketchInputs } from './rows';
import { SketchSession } from './session';

/** A document with one part holding one empty sketch on the xy plane, and parameters `width` (part) and `gap` (document). */
export function sketchDocument(): { doc: Json; part: string; feature: string; t: TestDoc } {
  const t = new TestDoc();
  t.parameters.push(t.table('Document', [t.parameter('gap', '5 mm')]));
  const part = t.part('Part 1');
  (part.parameters as Json[]).push(t.table('Part 1', [t.parameter('width', '40 mm')]));
  const inputs: Json = {
    frame: {
      attach: {
        support: [{ standard: { name: 'xy' } }],
        mode: t.val('"plane"'),
        offset: t.val(PLACEMENT_TEXT),
        flip: t.flag(false),
      },
    },
    points: [],
    curves: [],
    constraints: [],
    regions: [],
    retired: [],
    text: [],
  };
  const feature = t.feature('core.sketch', inputs, 'Sketch 1');
  (part.timeline as Json[]).push(feature);
  return { doc: t.document(), part: part.id as string, feature: feature.id as string, t };
}

export interface TestSession {
  editor: Editor;
  session: SketchSession;
  host: SketchHost & { renders: number };
  /** The sketch's rows in the document now. */
  inputs: () => Json;
  /** Presses and releases the left button at a point. */
  click: (u: number, v: number, options?: Partial<SketchPointer>) => void;
  move: (u: number, v: number) => void;
  down: (u: number, v: number, options?: Partial<SketchPointer>) => void;
  up: (u: number, v: number) => void;
  /** Presses a key, with Shift held, auto-repeating or typed into an element when the options say so. */
  key: (key: string, options?: { shiftKey?: boolean; repeat?: boolean; target?: { tagName?: string } }) => boolean;
}

/** Millimetres per pixel the tests' pointer events report. */
export const PIXEL = 0.1;

export function openTestSession(
  gcs: GcsWrapper,
  doc?: Json,
  part?: string,
  feature?: string,
  frame?: FrameDisplay,
): TestSession {
  const made = doc && part && feature ? { doc, part, feature } : sketchDocument();
  const editor = new Editor(made.doc, { ids: seededIds(7) });
  const host = {
    editor,
    part: made.part,
    feature: made.feature,
    frame: frame ?? { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
    group: new THREE.Group(),
    renders: 0,
    requestRender() {
      host.renders++;
    },
  } satisfies SketchHost & { renders: number };
  const session = new SketchSession(host, gcs);
  const event = (
    type: SketchPointer['type'],
    u: number,
    v: number,
    options: Partial<SketchPointer> = {},
  ): SketchPointer => ({
    type,
    uv: [u, v],
    pixel: PIXEL,
    button: 0,
    shift: false,
    ctrl: false,
    alt: false,
    ...options,
  });
  return {
    editor,
    session,
    host,
    inputs: () => sketchInputs(editor.document, made.part, made.feature) as Json,
    click: (u, v, options) => {
      session.pointer(event('down', u, v, options));
      session.pointer(event('up', u, v, options));
    },
    move: (u, v) => {
      session.pointer(event('move', u, v));
    },
    down: (u, v, options) => {
      session.pointer(event('down', u, v, options));
    },
    up: (u, v) => {
      session.pointer(event('up', u, v));
    },
    key: (key, options = {}) =>
      session.key({
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        target: null,
        ...options,
      } as unknown as KeyboardEvent),
  };
}

/** Whether the editor's document reads with no refusals. */
export function readsClean(editor: Editor): boolean {
  return !readDocument(editor.document).refused;
}

export const rowsOf = (inputs: Json, table: string): Json[] => (inputs[table] as Json[]) ?? [];

export function pointXY(inputs: Json, id: string): [number, number] {
  const p = rowsOf(inputs, 'points').find((r) => r.id === id);
  if (!p) throw new Error(`no point ${id}`);
  return [p.x as number, p.y as number];
}
