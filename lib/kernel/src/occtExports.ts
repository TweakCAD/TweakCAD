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
// Colour is per body, written with the materials extension: one
// `m:colorgroup`, and `pid`/`p1` on every triangle as well as the object's
// `pid`/`pindex`. Some slicers read colour from triangles only and ignore
// `basematerials` and `pindex`, so per-triangle is the form that reaches
// all of them. The extension is not listed as required, so a consumer that
// does not know it still reads the geometry.
// ---------------------------------------------------------------------------

const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

/**
 * Per-triangle colour indices for the combined mesh, plus the distinct
 * colours they index, in 3MF's `#RRGGBB` form. Null when no body has a
 * colour, so an uncoloured export stays exactly as before.
 */
export function triangleColors(
  meshes: DisplayMesh[],
  colors: ReadonlyArray<string | undefined> | undefined,
): { palette: string[]; perTriangle: Uint32Array } | null {
  if (!colors?.some(c => c !== undefined)) return null;
  const palette: string[] = [];
  const indexOf = new Map<string, number>();
  let triCount = 0;
  for (const m of meshes) triCount += m.indices.length / 3;
  const perTriangle = new Uint32Array(triCount);
  let t = 0;
  meshes.forEach((m, i) => {
    const color = (colors[i] ?? DEFAULT_BODY_COLOR).toUpperCase();
    let idx = indexOf.get(color);
    if (idx === undefined) {
      idx = palette.length;
      palette.push(color);
      indexOf.set(color, idx);
    }
    perTriangle.fill(idx, t, t + m.indices.length / 3);
    t += m.indices.length / 3;
  });
  return { palette, perTriangle };
}

/** Concatenation of any number of DisplayMesh instances into one mesh. */
export function combineMeshes(meshes: DisplayMesh[]): {
  vertices: Float32Array;
  triangles: Uint32Array;
} {
  let vtxFloats = 0;
  let triUints = 0;
  for (const m of meshes) {
    vtxFloats += m.positions.length;
    triUints += m.indices.length;
  }
  const vertices = new Float32Array(vtxFloats);
  const triangles = new Uint32Array(triUints);

  let vOff = 0;
  let tOff = 0;
  for (const m of meshes) {
    vertices.set(m.positions, vOff);
    const vertexBase = vOff / 3;
    for (let i = 0; i < m.indices.length; i++) {
       
      triangles[tOff + i] = (m.indices[i] as number) + vertexBase;
    }
    vOff += m.positions.length;
    tOff += m.indices.length;
  }
  return { vertices, triangles };
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

function build3MFModelXml(
  vertices: Float32Array,
  triangles: Uint32Array,
  name: string,
  unit: string,
  colors: { palette: string[]; perTriangle: Uint32Array } | null,
): string {
  const vLines: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vLines.push(
      `        <vertex x="${vertices[i] ?? 0}" y="${vertices[i + 1] ?? 0}" z="${vertices[i + 2] ?? 0}" />`,
    );
  }
  const tLines: string[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    const paint = colors ? ` pid="1" p1="${colors.perTriangle[i / 3] ?? 0}"` : '';
    tLines.push(
      `        <triangle v1="${triangles[i] ?? 0}" v2="${triangles[i + 1] ?? 0}" v3="${triangles[i + 2] ?? 0}"${paint} />`,
    );
  }
  // Resource ids: the colour group is 1, the object 2 when colours are
  // written; the object is 1 otherwise, as it always was.
  const objectId = colors ? 2 : 1;
  const ns = colors ? ` xmlns:m="${MATERIAL_NS}"` : '';
  const group = colors
    ? `    <m:colorgroup id="1">
${colors.palette.map(c => `      <m:color color="${c}" />`).join('\n')}
    </m:colorgroup>
`
    : '';
  const objectPaint = colors ? ` pid="1" pindex="${colors.perTriangle[0] ?? 0}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"${ns}>
  <resources>
${group}    <object id="${objectId}" name="${escapeXmlAttr(name)}" type="model"${objectPaint}>
      <mesh>
      <vertices>
${vLines.join('\n')}
      </vertices>
      <triangles>
${tLines.join('\n')}
      </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="${objectId}" />
  </build>
</model>`;
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
  const { vertices, triangles } = combineMeshes(meshes);
  const encoder = new TextEncoder();

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  const model = build3MFModelXml(vertices, triangles, name, unit, triangleColors(meshes, opts.colors));

  function entry(path: string, content: string): ZipEntry {
    const nameBytes = encoder.encode(path);
    const dataBytes = encoder.encode(content);
    return { name: nameBytes, data: dataBytes, crc: crc32(dataBytes) };
  }

  return buildZip([
    entry('[Content_Types].xml', contentTypes),
    entry('_rels/.rels', rels),
    entry('3D/3dmodel.model', model),
  ]);
}

/** MIME type strings for the exports. */
export const EXPORT_MIME = {
  step: 'application/step',
  stl: 'application/sla',
  brep: 'model/brep',
  threemf: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
} as const;
