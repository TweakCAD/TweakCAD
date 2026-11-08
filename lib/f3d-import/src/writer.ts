/**
 * Writing the rows of a version-2 document: value objects, features and the
 * references a feature stores to sketch rows, with the name-table entries
 * those references need (9.8).
 */
import {
  GRAMMAR,
  NameTable,
  canonicalRotation,
  contentHash,
  idItem,
  ladderOf,
  type ExprRef,
  type Quaternion,
} from '@tweakcad/format';
import type { IdGenerator } from '@tweakcad/editor';
import { compose, invert, placementOfFrame, placementText, dot, type Placement, type Vec3 } from './placement';

export type Json = Record<string, unknown>;

export type StandardPlane = 'xy' | 'xz' | 'yz';

/** The standard planes' frames in a part (9.1). */
const STANDARD_FRAMES: Record<StandardPlane, { placement: Placement; normal: Vec3 }> = {
  xy: { placement: placementOfFrame([0, 0, 0], [1, 0, 0], [0, 0, 1]), normal: [0, 0, 1] },
  xz: { placement: placementOfFrame([0, 0, 0], [1, 0, 0], [0, 1, 0]), normal: [0, 1, 0] },
  yz: { placement: placementOfFrame([0, 0, 0], [0, 0, -1], [1, 0, 0]), normal: [1, 0, 0] },
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class Writer {
  readonly names = new NameTable();
  readonly assets: Json = {};

  constructor(readonly ids: IdGenerator) {}

  /** A value object of expression text, with what the text names. */
  val(text: string, refs: Record<string, ExprRef> = {}): Json {
    return { id: this.ids('val'), def: { expr: { text, grammar: GRAMMAR, refs } } };
  }

  flag(on: boolean): Json {
    return this.val(on ? 'true' : 'false');
  }

  choice(name: string): Json {
    return this.val(JSON.stringify(name));
  }

  /** A feature row (7.2). */
  feature(type: string, name: string, inputs: Json, id = this.ids('feat')): Json {
    return {
      id,
      type,
      typeVersion: 1,
      name,
      suppressed: this.flag(false),
      frozen: { live: {} },
      command: { alone: {} },
      inputs,
    };
  }

  /** An asset row (13.1) with its bytes inline; returns its key. */
  asset(bytes: Uint8Array, mediaType: string, name: string): string {
    const hash = contentHash(bytes);
    this.assets[hash] = { mediaType, name, size: bytes.length, data: { inline: { base64: base64(bytes) } } };
    return hash;
  }

  /** The reference to a sketch region, as the editor writes one. */
  regionRef(sketch: string, region: string): Json {
    const id = ladderOf(
      { kind: 'region', chain: [], feature: sketch, role: 'region', src: [idItem(region)] },
      this.names,
    );
    return { entity: { id, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
  }

  /** The operation input (7.3) on every body of the part. */
  operation(op: 'new' | 'join' | 'cut' | 'intersect'): Json {
    return { op: this.choice(op), targets: { all: {} }, keepTools: this.flag(false) };
  }

  /** An assembly placing parts, each instance fixed where the file put it. */
  assembly(name: string, instances: { part: string; placement: Placement }[]): Json {
    return {
      id: this.ids('asm'),
      name,
      parameters: [],
      configurations: [],
      instances: instances.map((i) => ({
        id: this.ids('inst'),
        of: { part: { id: i.part } },
        placement: {
          position: [...i.placement.position],
          rotation: canonicalRotation(i.placement.rotation as Quaternion),
        },
        grounded: this.flag(true),
        suppressed: this.flag(false),
        overrides: [],
      })),
      jointOrigins: [],
      joints: [],
      relations: [],
      rigidGroups: [],
      contactSets: [],
      timeline: [],
      positions: [],
      activePosition: { current: {} },
      explodedViews: [],
      attributes: [],
      notes: [],
      properties: {},
      solver: 1,
    };
  }

  /** A sketch frame at `at`, attached to the standard plane it is parallel to, or to the xy plane with an offset. */
  frame(at: Placement, normal: Vec3): Json {
    const name =
      (Object.keys(STANDARD_FRAMES) as StandardPlane[]).find(
        (p) => Math.abs(Math.abs(dot(STANDARD_FRAMES[p].normal, normal)) - 1) < 1e-9,
      ) ?? 'xy';
    const offset = compose(invert(STANDARD_FRAMES[name].placement), at);
    return {
      attach: {
        support: [{ standard: { name } }],
        mode: this.choice('plane'),
        offset: this.val(placementText(offset)),
        flip: this.flag(false),
      },
    };
  }
}
