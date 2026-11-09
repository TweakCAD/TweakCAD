/**
 * Turning a STEP, STL or BREP file into the stored shape of a `core.import`
 * (13.2, 13.3): the file is read once, here, and its solids are written as a
 * `brep` 1 asset with a shape map, so replay never reads the file again and a
 * newer kernel or importer never changes the import.
 *
 * The file has no entity ids of its own that the kernel exposes, so faces and
 * bodies are named by their map index; edges and vertices follow from the
 * faces by the rules of 9.4.
 */
import type { OcctKernel, ShapeHandle } from 'occt-wasm';
import {
  NameTable,
  NamedState,
  contentHash,
  startFeature,
  writeShapeMap,
  type NameTableJson,
  type OperationHistory,
} from '@tweakcad/format';
import { NamingAdapter } from '@tweakcad/kernel/src/namingAdapter.ts';

export type ImportFormat = 'step' | 'stl' | 'brep';

/** The most triangles an STL may have to be read: each is a face until coplanar ones merge. */
export const MAX_STL_TRIANGLES = 200_000;
/**
 * The most faces an STL may make once coplanar triangles merge. Every face,
 * edge and vertex of a stored shape is an entry of its map in the document
 * (about 3 kB per triangle of a curved mesh), so this keeps the document a
 * few megabytes.
 */
export const MAX_STL_FACES = 2_000;

/** What a `core.import` row needs from the file: its stored shape, the assets it names and the names its map uses. */
export interface ImportedShape {
  /** The `stored` input (13.2). */
  stored: { asset: string; representation: { name: 'brep'; version: 1 }; map: unknown[] };
  /** The stored shape's asset row and the file's own, keyed by content hash. */
  assets: Record<string, { mediaType: string; name: string; size: number; data: { inline: { base64: string } } }>;
  /** The content hash of the file as read. */
  source: string;
  names: NameTableJson;
  /** How many bodies the file holds. */
  bodies: number;
  /** How many open meshes of an STL were left out: shells with holes or loose triangles, which bound no solid. */
  skipped: number;
}

const OPEN_MESH = 'This STL mesh is not closed: it has holes or loose triangles, so it bounds no solid.';

/** What an import is doing, as it reports it: each stage once, and each solid of an STL as it is made. */
export type ImportProgress =
  | { stage: 'reading' }
  | { stage: 'sewing'; triangles: number }
  | { stage: 'solids'; done: number; total: number }
  | { stage: 'naming'; faces: number };

/** Refusals a user reads: the file is not one this importer can make solids of. */
export class ImportRefusal extends Error {}

export const MEDIA_TYPES: Record<ImportFormat, string> = {
  step: 'model/step',
  stl: 'model/stl',
  brep: 'model/x-brep',
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** The text form of a BREP file, or its binary form: BREP text starts with the OCCT header. */
function isBrepText(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 64));
  return head.trimStart().startsWith('DBRep_DrawableShape') || head.trimStart().startsWith('CASCADE Topology');
}

/** The file read by the kernel, as a shape the caller releases. */
function read(k: OcctKernel, bytes: Uint8Array, format: ImportFormat): ShapeHandle {
  try {
    switch (format) {
      case 'step':
        return k.importStep(new TextDecoder().decode(bytes));
      case 'brep':
        return isBrepText(bytes) ? k.fromBREP(new TextDecoder().decode(bytes)) : k.fromBREPBinary(bytes);
      case 'stl':
        return k.importStl(bytes);
    }
  } catch (e) {
    throw new ImportRefusal(
      `The file could not be read as ${format.toUpperCase()}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  throw new ImportRefusal(`${String(format)} files cannot be imported`);
}

/** One shell of an STL as a valid solid of positive volume, or null when the shell is open. */
function closedSolid(k: OcctKernel, shell: ShapeHandle, made: ShapeHandle[]): ShapeHandle | null {
  let solid: ShapeHandle;
  try {
    solid = k.makeSolid(shell);
  } catch {
    return null;
  }
  made.push(solid);
  if (k.getVolume(solid) < 0) {
    solid = k.fixShape(solid);
    made.push(solid);
  }
  // An open shell still makes a solid of positive volume; only a valid one encloses it.
  if (!(k.getVolume(solid) > 0) || !k.isValid(solid)) return null;
  return solid;
}

/**
 * The solids of a file, each its own body, and how many open meshes were
 * left out. An STL is a soup of triangles: they are sewn into shells and
 * each closed shell made a solid, as a mesh import into a solid modeller
 * does; an open shell is left out and counted.
 */
function solidsOf(
  k: OcctKernel,
  root: ShapeHandle,
  format: ImportFormat,
  made: ShapeHandle[],
  report: (p: ImportProgress) => void,
): { solids: ShapeHandle[]; skipped: number } {
  if (format === 'stl') {
    const triangles = k.subShapeCount(root, 'face');
    if (triangles > MAX_STL_TRIANGLES) {
      throw new ImportRefusal(
        `This STL file has ${triangles} triangles; TweakCAD reads meshes of up to ${MAX_STL_TRIANGLES}.`,
      );
    }
    report({ stage: 'sewing', triangles });
    const sewn = k.sew([root], 1e-6);
    made.push(sewn);
    const solids: ShapeHandle[] = [];
    let faces = 0;
    let skipped = 0;
    const shells = k.getSubShapes(sewn, 'shell');
    made.push(...shells);
    for (const [i, shell] of shells.entries()) {
      report({ stage: 'solids', done: i, total: shells.length });
      const solid = closedSolid(k, shell, made);
      if (!solid) {
        skipped++;
        continue;
      }
      // Triangles that lie in one plane become one face, as a mesh of a machined part mostly does.
      const merged = k.unifySameDomain(solid);
      made.push(merged);
      faces += k.subShapeCount(merged, 'face');
      solids.push(merged);
    }
    if (faces > MAX_STL_FACES) {
      throw new ImportRefusal(
        `This STL mesh makes ${faces} faces; TweakCAD imports meshes of up to ${MAX_STL_FACES} faces. A STEP file of the part, or a coarser mesh, imports.`,
      );
    }
    if (solids.length === 0 && skipped > 0) throw new ImportRefusal(OPEN_MESH);
    return { solids, skipped };
  }
  if (k.isSolid(root)) return { solids: [root], skipped: 0 };
  const solids = k.getSubShapes(root, 'solid');
  made.push(...solids);
  return { solids, skipped: 0 };
}

/**
 * Reads `bytes` as `format` into the stored shape of the `core.import`
 * feature `feature`. Refuses a file with no solids. `name` is the file's
 * name, kept on its asset row. `report` hears each stage as it starts.
 */
export function importShape(
  k: OcctKernel,
  bytes: Uint8Array,
  format: ImportFormat,
  feature: string,
  name: string,
  report: (p: ImportProgress) => void = () => undefined,
): ImportedShape {
  const made: ShapeHandle[] = [];
  const adapter = new NamingAdapter(k);
  try {
    report({ stage: 'reading' });
    const root = read(k, bytes, format);
    made.push(root);
    const { solids, skipped } = solidsOf(k, root, format, made, report);
    if (solids.length === 0) {
      throw new ImportRefusal(
        format === 'stl'
          ? 'This STL file has no closed mesh to make a solid of.'
          : 'This file holds no solids; TweakCAD does not import surfaces yet.',
      );
    }
    const compound = k.makeCompound(solids);
    made.push(compound);
    // BRepBuilderAPI_Copy leaves the mesh behind, so the bytes never depend on whether the shape was displayed.
    const copy = k.copy(compound);
    made.push(copy);
    const brep = new TextEncoder().encode(k.toBREP(copy));
    // The map is written from the bytes as replay reads them: a text round trip can shift a measure past the load tolerance.
    const replayed = k.fromBREP(new TextDecoder().decode(brep));
    made.push(replayed);
    const ref = adapter.addShape(replayed, 'stored');
    const index = new Map(adapter.subShapes(ref).map((s, i) => [s.key, i]));
    const at = (key: number) => ({ index: index.get(key) as number });
    const none = { kept: [], modified: new Map(), deleted: [], added: [] };
    const history: OperationHistory = {
      result: ref,
      inputs: [],
      faces: none,
      edges: none,
      facesFromFace: new Map(),
      facesFromEdge: new Map(),
    };
    const topology = adapter.topology(ref);
    report({ stage: 'naming', faces: topology.faces.length });
    const names = new NameTable();
    const namer = startFeature(NamedState.empty(), { feature, ordinal: 0 }, adapter, names);
    namer.step(history, {
      outputs: topology.faces.map((f) => ({ entity: f, role: 'face', src: [at(f)] })),
      dividers: [],
    });
    const state = namer.finish(topology.solids.map((s) => ({ solid: s.solid, from: { create: [at(s.solid)] } })));
    const map = writeShapeMap(state, ref, adapter) as unknown[];

    const hash = contentHash(brep);
    const source = contentHash(bytes);
    const base = name.replace(/\.[^.]*$/, '') || 'import';
    return {
      stored: { asset: hash, representation: { name: 'brep', version: 1 }, map },
      assets: {
        [source]: {
          mediaType: MEDIA_TYPES[format],
          name,
          size: bytes.length,
          data: { inline: { base64: base64(bytes) } },
        },
        [hash]: {
          mediaType: 'model/x-brep',
          name: `${base}.brep`,
          size: brep.length,
          data: { inline: { base64: base64(brep) } },
        },
      },
      source,
      names: names.toJson(),
      bodies: topology.solids.length,
      skipped,
    };
  } finally {
    adapter.dispose();
    for (const h of made.reverse()) {
      try {
        k.release(h);
      } catch {
        // Already released with its parent.
      }
    }
  }
}
