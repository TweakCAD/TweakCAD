/**
 * 3MF export helper plus shared MIME table.
 *
 * 3MF is mesh-based: tessellate every body, concatenate into one big mesh
 * (vertex offsetting), and serialize. The ZIP/XML formatter is a pure-JS
 * implementation. No external compression library is required — the
 * archive uses store-only ZIP entries with CRC-32 integrity checks, all
 * in-memory.
 *
 * STEP and STL writers are no longer here — occt-wasm@5.x exposes
 * `kernel.exportStep(shape)` / `kernel.exportStl(shape, ...)` directly, so
 * the previous Emscripten-FS round-trip code is gone.
 */

import type { DisplayMesh } from '@tweakcad/core/src/document/schema.ts';
import { DEFAULT_BODY_COLOR } from '@tweakcad/core/src/document/schema.ts';

// ---------------------------------------------------------------------------
// 3MF export — pure-JS, mesh-based.
//
// Each body's mesh is welded first: the display tessellation gives every
// face its own copy of the nodes along its edges, which a slicer reads as
// open edges. Merging coincident vertices makes each body a closed surface.
//
// Colour, when any body has one, is written for two kinds of reader:
//  - the materials extension, one `m:colorgroup` per colour with the
//    group on each body's object and on every triangle, for readers that
//    follow the spec;
//  - `Metadata/model_settings.config`, the per-part settings file some
//    slicers read instead, naming an extruder for each body so each colour
//    gets its own filament slot.
// For both, every body is its own mesh object and one parent object holds
// them as components, so the bodies stay one object on the plate.
// The extension is not listed as required, so a reader that does not know
// it still reads the geometry.
// ---------------------------------------------------------------------------

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

type MeshInput = Pick<DisplayMesh, 'positions' | 'indices'>;

/**
 * One body's mesh with coincident vertices merged, so faces share the
 * vertices along their common edges. Triangles that collapse to a line or
 * a point after merging are dropped.
 */
export function weldMesh(m: MeshInput): { vertices: Float32Array; triangles: Uint32Array } {
  const remap = new Uint32Array(m.positions.length / 3);
  const indexOf = new Map<string, number>();
  const kept: number[] = [];
  for (let v = 0; v < remap.length; v++) {
    const x = m.positions[3 * v] ?? 0;
    const y = m.positions[3 * v + 1] ?? 0;
    const z = m.positions[3 * v + 2] ?? 0;
    // Number formatting maps -0 and 0 to the same key.
    const key = `${x},${y},${z}`;
    let idx = indexOf.get(key);
    if (idx === undefined) {
      idx = kept.length / 3;
      indexOf.set(key, idx);
      kept.push(x, y, z);
    }
    remap[v] = idx;
  }
  const tris: number[] = [];
  for (let i = 0; i + 2 < m.indices.length; i += 3) {
    const a = remap[m.indices[i] ?? 0] ?? 0;
    const b = remap[m.indices[i + 1] ?? 0] ?? 0;
    const c = remap[m.indices[i + 2] ?? 0] ?? 0;
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { vertices: new Float32Array(kept), triangles: new Uint32Array(tris) };
}

/** Concatenation of any number of meshes into one, each welded first. */
export function combineMeshes(meshes: MeshInput[]): {
  vertices: Float32Array;
  triangles: Uint32Array;
} {
  const welded = meshes.map(weldMesh);
  let vtxFloats = 0;
  let triUints = 0;
  for (const w of welded) {
    vtxFloats += w.vertices.length;
    triUints += w.triangles.length;
  }
  const vertices = new Float32Array(vtxFloats);
  const triangles = new Uint32Array(triUints);
  let vOff = 0;
  let tOff = 0;
  for (const w of welded) {
    vertices.set(w.vertices, vOff);
    const vertexBase = vOff / 3;
    for (let i = 0; i < w.triangles.length; i++) {
      triangles[tOff + i] = (w.triangles[i] ?? 0) + vertexBase;
    }
    vOff += w.vertices.length;
    tOff += w.triangles.length;
  }
  return { vertices, triangles };
}

/**
 * The distinct colours of a coloured export, in 3MF's `#RRGGBB` form, and
 * each body's index into them. Bodies without a colour take the default
 * body colour. Null when no body has a colour.
 */
export function bodyPalette(
  bodyCount: number,
  colors: ReadonlyArray<string | undefined> | undefined,
): { palette: string[]; bodyIndex: number[] } | null {
  if (!colors?.some(c => c !== undefined)) return null;
  const palette: string[] = [];
  const indexOf = new Map<string, number>();
  const bodyIndex: number[] = [];
  for (let i = 0; i < bodyCount; i++) {
    const color = (colors[i] ?? DEFAULT_BODY_COLOR).toUpperCase();
    let idx = indexOf.get(color);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(color);
      indexOf.set(color, idx);
    }
    bodyIndex.push(idx);
  }
  return { palette, bodyIndex };
}

// CRC-32 lookup table for store-only ZIP entries.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
}

/**
 * Build a store-only (no compression) ZIP archive. Sufficient for 3MF —
 * the spec allows uncompressed entries and slicers handle them fine. We
 * avoid pulling in zlib / fflate just for export.
 */
function buildZip(entries: ZipEntry[]): ArrayBuffer {
  let offset = 0;
  const localHeaders: { offset: number; entry: ZipEntry }[] = [];
  for (const entry of entries) {
    localHeaders.push({ offset, entry });
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const entry of entries) centralSize += 46 + entry.name.length;

  const totalSize = offset + centralSize + 22;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let pos = 0;

  for (const { entry } of localHeaders) {
    view.setUint32(pos, 0x04034b50, true); pos += 4;
    view.setUint16(pos, 20, true);         pos += 2; // version
    view.setUint16(pos, 0, true);          pos += 2; // flags
    view.setUint16(pos, 0, true);          pos += 2; // compression (store)
    view.setUint16(pos, 0, true);          pos += 2; // time
    view.setUint16(pos, 0, true);          pos += 2; // date
    view.setUint32(pos, entry.crc, true);  pos += 4;
    view.setUint32(pos, entry.data.length, true); pos += 4; // csize
    view.setUint32(pos, entry.data.length, true); pos += 4; // usize
    view.setUint16(pos, entry.name.length, true); pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    bytes.set(entry.name, pos);            pos += entry.name.length;
    bytes.set(entry.data, pos);            pos += entry.data.length;
  }

  for (const { offset: localOff, entry } of localHeaders) {
    view.setUint32(pos, 0x02014b50, true); pos += 4;
    view.setUint16(pos, 20, true);         pos += 2;
    view.setUint16(pos, 20, true);         pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint32(pos, entry.crc, true);  pos += 4;
    view.setUint32(pos, entry.data.length, true); pos += 4;
    view.setUint32(pos, entry.data.length, true); pos += 4;
    view.setUint16(pos, entry.name.length, true); pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint16(pos, 0, true);          pos += 2;
    view.setUint32(pos, 0, true);          pos += 4;
    view.setUint32(pos, localOff, true);   pos += 4;
    bytes.set(entry.name, pos);            pos += entry.name.length;
  }

  view.setUint32(pos, 0x06054b50, true); pos += 4;
  view.setUint16(pos, 0, true);          pos += 2;
  view.setUint16(pos, 0, true);          pos += 2;
  view.setUint16(pos, entries.length, true); pos += 2;
  view.setUint16(pos, entries.length, true); pos += 2;
  view.setUint32(pos, centralSize, true); pos += 4;
  view.setUint32(pos, centralStart, true); pos += 4;
  view.setUint16(pos, 0, true);          // archive comment length

  return buf;
}

function escapeXmlAttr(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function meshXml(vertices: Float32Array, triangles: Uint32Array, paint: string): string {
  const lines: string[] = ['      <mesh>', '        <vertices>'];
  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`          <vertex x="${vertices[i] ?? 0}" y="${vertices[i + 1] ?? 0}" z="${vertices[i + 2] ?? 0}" />`);
  }
  lines.push('        </vertices>', '        <triangles>');
  for (let i = 0; i < triangles.length; i += 3) {
    lines.push(`          <triangle v1="${triangles[i] ?? 0}" v2="${triangles[i + 1] ?? 0}" v3="${triangles[i + 2] ?? 0}"${paint} />`);
  }
  lines.push('        </triangles>', '      </mesh>');
  return lines.join('\n');
}

/** Uncoloured: every body welded into one mesh object. */
function plainModelXml(meshes: MeshInput[], name: string, unit: string): string {
  const { vertices, triangles } = combineMeshes(meshes);
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="${CORE_NS}">
  <resources>
    <object id="1" name="${escapeXmlAttr(name)}" type="model">
${meshXml(vertices, triangles, '')}
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;
}

/**
 * Resource ids in a coloured export: colour group k (0-based) is id k + 1,
 * body i is id groups + i + 1, and the parent object comes last. A body's
 * extruder in the settings file is its colour group's id, so each colour
 * gets its own filament slot.
 */
function colouredLayout(bodyCount: number, groups: number) {
  return {
    groupId: (k: number) => k + 1,
    bodyId: (i: number) => groups + i + 1,
    parentId: groups + bodyCount + 1,
  };
}

function bodyName(name: string, i: number, count: number): string {
  return count === 1 ? name : `${name} ${i + 1}`;
}

function colouredModelXml(
  meshes: MeshInput[],
  name: string,
  unit: string,
  colours: { palette: string[]; bodyIndex: number[] },
): string {
  const ids = colouredLayout(meshes.length, colours.palette.length);
  const groups = colours.palette
    .map((c, k) => `    <m:colorgroup id="${ids.groupId(k)}">\n      <m:color color="${c}" />\n    </m:colorgroup>`)
    .join('\n');
  const bodies = meshes.map((m, i) => {
    const group = ids.groupId(colours.bodyIndex[i] ?? 0);
    const { vertices, triangles } = weldMesh(m);
    return `    <object id="${ids.bodyId(i)}" name="${escapeXmlAttr(bodyName(name, i, meshes.length))}" type="model" pid="${group}" pindex="0">
${meshXml(vertices, triangles, ` pid="${group}" p1="0"`)}
    </object>`;
  }).join('\n');
  const components = meshes.map((_, i) => `        <component objectid="${ids.bodyId(i)}" />`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}">
  <resources>
${groups}
${bodies}
    <object id="${ids.parentId}" name="${escapeXmlAttr(name)}" type="model">
      <components>
${components}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="${ids.parentId}" />
  </build>
</model>`;
}

/** The per-part settings file: one part per body, each on its colour's extruder. */
function modelSettingsXml(
  bodyCount: number,
  name: string,
  colours: { palette: string[]; bodyIndex: number[] },
): string {
  const ids = colouredLayout(bodyCount, colours.palette.length);
  const parts: string[] = [];
  for (let i = 0; i < bodyCount; i++) {
    parts.push(`    <part id="${ids.bodyId(i)}" subtype="normal_part">
      <metadata key="name" value="${escapeXmlAttr(bodyName(name, i, bodyCount))}"/>
      <metadata key="extruder" value="${ids.groupId(colours.bodyIndex[i] ?? 0)}"/>
    </part>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${ids.parentId}">
    <metadata key="name" value="${escapeXmlAttr(name)}"/>
    <metadata key="extruder" value="${ids.groupId(colours.bodyIndex[0] ?? 0)}"/>
${parts.join('\n')}
  </object>
</config>`;
}

/**
 * Build a 3MF ArrayBuffer from one or more pre-tessellated meshes.
 *
 * The CAD app already has tessellation results cached on each body, so
 * the caller passes DisplayMesh instances directly — we don't re-mesh.
 */
export function build3MF(
  meshes: DisplayMesh[],
  opts: { name?: string; unit?: string; colors?: ReadonlyArray<string | undefined> } = {},
): ArrayBuffer {
  const { name = 'model', unit = 'millimeter' } = opts;
  const colours = bodyPalette(meshes.length, opts.colors);
  const encoder = new TextEncoder();

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />${colours ? '\n  <Default Extension="config" ContentType="text/xml" />' : ''}
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const model = colours
    ? colouredModelXml(meshes, name, unit, colours)
    : plainModelXml(meshes, name, unit);

  function entry(path: string, content: string): ZipEntry {
    const nameBytes = encoder.encode(path);
    const dataBytes = encoder.encode(content);
    return { name: nameBytes, data: dataBytes, crc: crc32(dataBytes) };
  }

  return buildZip([
    entry('[Content_Types].xml', contentTypes),
    entry('_rels/.rels', rels),
    entry('3D/3dmodel.model', model),
    ...(colours ? [entry('Metadata/model_settings.config', modelSettingsXml(meshes.length, name, colours))] : []),
  ]);
}

/** MIME type strings for the exports. */
export const EXPORT_MIME = {
  step: 'application/step',
  stl: 'application/sla',
  brep: 'model/brep',
  threemf: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
} as const;
