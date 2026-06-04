/**
 * 3MF export helper plus shared MIME table.
 *
 * 3MF is mesh-based: tessellate every body, concatenate into one big mesh
 * (vertex offsetting), and serialize. The ZIP/XML formatter is a pure-JS
 * implementation. No external compression library is required — the
 * archive uses store-only ZIP entries with CRC-32 integrity checks, all
 * in-memory.
 *
 * STEP and STL writers are no longer here — occt-wasm@3.x exposes
 * `kernel.exportStep(shape)` / `kernel.exportStl(shape, ...)` directly, so
 * the previous Emscripten-FS round-trip code is gone.
 */

import type { DisplayMesh } from '@tweakcad/core/src/document/schema.ts';

// ---------------------------------------------------------------------------
// 3MF export — pure-JS, mesh-based.
//
// Stripped of the per-face material / color machinery (we don't expose
// face groups yet).
// ---------------------------------------------------------------------------

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
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
): string {
  const vLines: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    vLines.push(
      `        <vertex x="${vertices[i] ?? 0}" y="${vertices[i + 1] ?? 0}" z="${vertices[i + 2] ?? 0}" />`,
    );
  }
  const tLines: string[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    tLines.push(
      `        <triangle v1="${triangles[i] ?? 0}" v2="${triangles[i + 1] ?? 0}" v3="${triangles[i + 2] ?? 0}" />`,
    );
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="${unit}" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" name="${escapeXmlAttr(name)}" type="model">
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
    <item objectid="1" />
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
  opts: { name?: string; unit?: string } = {},
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

  const model = build3MFModelXml(vertices, triangles, name, unit);

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
  threemf: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
} as const;
