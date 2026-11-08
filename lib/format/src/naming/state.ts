import type { ShapeKey, ShapeRef } from './facts';
import type { BranchEntry, EntityKey, EntityKind } from './names';

/** One named sub-shape of a live body. */
export interface NamedEntity {
  key: ShapeKey;
  kind: EntityKind;
  /** The identity ladder, coarse to fine (9.3). */
  ladder: readonly string[];
  branch: readonly BranchEntry[];
  /** Identities merged into this one, or carried by lineage (9.4, 9.6). */
  aliases: readonly EntityKey[];
  /** Neighbour names this entity also stands for: a blend for its edge's faces (9.6 rule 4). */
  standsFor: readonly string[];
  /** The live body shape holding it. */
  body: ShapeRef;
  /** The feature that created it, for creation order among merges (7.3). */
  createdBy: string;
  /** That feature's place in the build, lower is earlier. */
  createdAt: number;
}

/**
 * Every named entity of a part at one point in the timeline. Immutable: a
 * feature produces the next state, so the rebuilder can keep one per feature.
 */
export class NamedState {
  private index: Map<string, NamedEntity[]> | null = null;

  constructor(
    /** Entities by sub-shape key, across every live body. */
    readonly entities: ReadonlyMap<ShapeKey, NamedEntity>,
    /** Live bodies: each body entity's solid key and the shape holding it. */
    readonly bodies: ReadonlyMap<ShapeKey, ShapeRef>,
    /** Features whose splits are in effect in this state (9.6 rule 0). */
    readonly splits: ReadonlySet<string>,
    /** For edges and vertices: canonical (kind, chain, role, src) → the feature that first produced it. */
    readonly producers: ReadonlyMap<string, string>,
  ) {}

  static empty(): NamedState {
    return new NamedState(new Map(), new Map(), new Set(), new Map());
  }

  /** Entities whose ladder contains `hash`, or that carry it as an alias. */
  lookup(hash: string): readonly NamedEntity[] {
    if (this.index === null) {
      const index = new Map<string, NamedEntity[]>();
      const add = (h: string, e: NamedEntity) => {
        const list = index.get(h);
        if (list) {
          if (!list.includes(e)) list.push(e);
        } else index.set(h, [e]);
      };
      for (const e of this.entities.values()) {
        for (const h of e.ladder) add(h, e);
        for (const a of e.aliases) add(a.hash, e);
      }
      this.index = index;
    }
    return this.index.get(hash) ?? [];
  }

  get(key: ShapeKey): NamedEntity | undefined {
    return this.entities.get(key);
  }
}
