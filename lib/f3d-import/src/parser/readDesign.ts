/** Decode a `.f3d` or `.f3z` file into plain design data. */

import { readPackage, type F3dDesignStreams, type F3dPackage } from './f3dArchive';
import { parseDesignIndex } from './designIndex';
import { readParameters } from './parameters';
import { readSketches } from './sketches';
import { readFeatures } from './features';
import { FaceIndex, readBrepFaces } from './brep';
import { readFeatureBodies } from './bodies';
import { readComponentPlacement } from './components';
import { STORED_BODY, UNLINKED, type F3dComponent, type F3dDesign, type F3dLink } from './types';

/** Reads a member and what it links to; one that can't be read costs only its links. */
function readLinks(
  pack: F3dPackage,
  links: Map<string, unknown[]>,
  seen: Map<string, F3dDesign | null>,
): { links: F3dLink[]; unread: number } {
  const out: F3dLink[] = [];
  let unread = 0;
  for (const [path, placements] of links) {
    let design = seen.get(path);
    if (design === undefined) {
      seen.set(path, null);
      try {
        design = readStreams(pack.open(path), pack, path, seen);
      } catch {
        design = null;
      }
      seen.set(path, design);
    }
    if (design) out.push({ design, name: pack.nameOf(path), placements: placements as F3dLink['placements'] });
    else unread += placements.length;
  }
  return { links: out, unread };
}

export function readDesign(bytes: Uint8Array): F3dDesign {
  const pack = readPackage(bytes);
  return readStreams(pack.open(pack.root), pack, pack.root, new Map([[pack.root, null]]));
}

function readStreams(
  streams: F3dDesignStreams,
  pack: F3dPackage,
  path: string,
  seen: Map<string, F3dDesign | null>,
): F3dDesign {
  const index = parseDesignIndex(streams.meta, streams.bulk);
  const { parameters } = readParameters(index);
  const { features, order, leftOut } = readFeatures(index, parameters);
  const faces = new FaceIndex();
  if (
    features.some(
      (f) =>
        f.kind === 'fillet' ||
        f.kind === 'chamfer' ||
        f.kind === 'shell' ||
        (f.kind === 'extrude' && f.faces.length > 0),
    )
  ) {
    for (const stream of streams.breps()) {
      try {
        faces.add(readBrepFaces(stream));
      } catch {
        // One unreadable stream only costs the references into it.
      }
    }
  }
  const placement = readComponentPlacement(index, pack.roles(path));
  const bodies = readFeatureBodies(index);
  const componentOf = new Map<number, number>();
  for (const f of features) {
    const component = bodies.componentOfFeature(f.id);
    if (component !== null && component !== placement.rootId) componentOf.set(f.id, component);
  }
  // A fillet names no body: it works where the faces it picks were made.
  for (const f of features) {
    if ((f.kind !== 'fillet' && f.kind !== 'chamfer') || componentOf.has(f.id)) continue;
    const ops = f.sets.flatMap((s) => s.edges.flatMap((e) => e.faces.flatMap((n) => n.ops)));
    const made = ops.map((op) => bodies.recordOfOp(op)).find((r) => r !== undefined && componentOf.has(r));
    if (made !== undefined) componentOf.set(f.id, componentOf.get(made) as number);
  }
  const placements = placement.placementsOf();
  const components: F3dComponent[] = placement.ids
    .filter((id) => id !== placement.rootId)
    .map((id) => ({
      id,
      name: placement.nameOf(id),
      world: placement.worldOf(id),
      placements: placements.get(id) ?? [],
    }));
  const storedBodies = bodies.storedBodies(placement.rootId);
  const stored = [...storedBodies.values()].reduce((a, b) => a + b, 0);
  if (stored > 0) leftOut[STORED_BODY] = stored;
  const { links, unread } = readLinks(pack, placement.linksOf(), seen);
  if (placement.unresolved + unread > 0) leftOut[UNLINKED] = placement.unresolved + unread;
  return {
    parameters,
    sketches: readSketches(index, parameters),
    features,
    order,
    faces,
    leftOut,
    components,
    componentOf,
    recordOfOp: bodies.recordOfOp,
    storedBodies,
    links,
  };
}
