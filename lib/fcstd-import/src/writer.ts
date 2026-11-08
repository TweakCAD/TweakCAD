/**
 * Writing the rows of a version-2 document: value objects, features, parts
 * and the references a feature stores to sketch rows and features, with the
 * name-table entries those references need (9.8).
 */
import {
  GRAMMAR,
  NameTable,
  canonicalRotation,
  contentHash,
  idItem,
  ladderOf,
  type Quaternion,
} from '@tweakcad/format';
import type { IdGenerator } from '@tweakcad/editor';
import type { FcPlacement } from './document';
import { placementText } from './placement';

export type Json = Record<string, unknown>;

export interface PartDraft {
  id: string;
  name: string;
  timeline: Json[];
  /** The feature the part is rolled back to, if any: FreeCAD's Tip before the last feature. */
  rollbackBefore?: string;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export class Writer {
  readonly names = new NameTable();
  readonly parts: PartDraft[] = [];
  readonly assets: Json = {};
  /** Value names given so far: one name names one value in the document. */
  readonly valueNames = new Set<string>();

  constructor(readonly ids: IdGenerator) {}

  /** A value object of literal expression text, named when `name` is given. */
  val(text: string, name?: string): Json {
    return { id: this.ids('val'), ...(name ? { name } : {}), def: { expr: { text, grammar: GRAMMAR, refs: {} } } };
  }

  flag(on: boolean): Json {
    return this.val(on ? 'true' : 'false');
  }

  choice(name: string): Json {
    return this.val(JSON.stringify(name));
  }

  placement(p: FcPlacement): Json {
    return this.val(placementText(p));
  }

  /** A feature row (7.2). */
  feature(type: string, name: string, inputs: Json, suppressed = false, id = this.ids('feat')): Json {
    return {
      id,
      type,
      typeVersion: 1,
      name,
      suppressed: this.flag(suppressed),
      frozen: { live: {} },
      command: { alone: {} },
      inputs,
    };
  }

  part(name: string): PartDraft {
    const part: PartDraft = { id: this.ids('part'), name, timeline: [] };
    this.parts.push(part);
    return part;
  }

  /** An asset row (13.1) with its bytes inline; returns its key. */
  asset(bytes: Uint8Array, mediaType: string, name: string): string {
    const hash = contentHash(bytes);
    this.assets[hash] = { mediaType, name, size: bytes.length, data: { inline: { base64: base64(bytes) } } };
    return hash;
  }

  private record(ladder: string[]): Json {
    return { entity: { id: ladder, branch: [], side: [], nb: { set: [] }, n: 1, snapshot: {} } };
  }

  /** The reference to a sketch row (a region, curve or point), as the editor writes one. */
  sketchRef(sketch: string, kind: 'region' | 'curve' | 'point', row: string): Json {
    return this.record(ladderOf({ kind, chain: [], feature: sketch, role: kind, src: [idItem(row)] }, this.names));
  }

  /** The operation input (7.3) on every body of the part. */
  operation(op: 'new' | 'join' | 'cut' | 'intersect'): Json {
    return { op: this.choice(op), targets: { all: {} }, keepTools: this.flag(false) };
  }

  /** An attached frame on a standard plane, moved by `offset` in that plane's frame. */
  frameOn(standard: 'xy' | 'xz' | 'yz', offset: FcPlacement, flip = false): Json {
    return {
      attach: {
        support: [{ standard: { name: standard } }],
        mode: this.choice('plane'),
        offset: this.placement(offset),
        flip: this.flag(flip),
      },
    };
  }

  emptyPart(p: PartDraft): Json {
    return {
      id: p.id,
      name: p.name,
      parameters: [],
      timeline: p.timeline,
      rollback: p.rollbackBefore ? { before: { id: p.rollbackBefore } } : { end: {} },
      groups: [],
      sets: [],
      contexts: [],
      attributes: [],
      configurations: [],
      notes: [],
      properties: {},
    };
  }

  /**
   * An assembly placing each part once, at its FreeCAD Body's placement, for a
   * file whose Bodies are not one Body at the origin.
   */
  assembly(name: string, instances: { part: string; placement: FcPlacement }[]): Json {
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
}
