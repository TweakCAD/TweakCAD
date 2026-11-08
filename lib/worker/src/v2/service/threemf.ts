/**
 * 3MF writing: each body's mesh welded into a closed surface, one mesh
 * object per body under one parent object, in a store-only ZIP.
 *
 * Colour, when any body or face has one or a body has a filament slot of its
 * own, is written for two kinds of reader:
 * - the materials extension, one `m:colorgroup` per colour, the body's on
 *   its object and each face's on its triangles, for readers that follow the
 *   spec;
 * - `Metadata/model_settings.config`, the per-part settings file some
 *   slicers read instead, naming an extruder for each body: its filament
 *   slot, or else one slot per distinct body colour (16.1).
 * The extension is not listed as required, so a reader that does not know
 * it still reads the geometry.
 */

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';

/** One body to write: its mesh, and the colour of each triangle where one is set. */
export interface ThreeMfBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** `#rrggbb`, or null for an uncoloured body. */
  color: string | null;
  /** Per triangle, its colour where it differs from the body's. */
  triangleColors?: readonly (string | null)[];
  /** The slot the user chose for it, if any. */
  filamentSlot?: number;
}

/**
 * A mesh with coincident vertices merged, so faces share the vertices along
 * their common edges and a slicer reads a closed surface. Triangles that
 * collapse to a line or a point are dropped; `kept` gives each remaining
 * triangle's index in the input.
 */
export function weldMesh(
  positions: Float32Array,
  indices: Uint32Array,
): { vertices: Float32Array; triangles: Uint32Array; kept: number[] } {
  const remap = new Uint32Array(positions.length / 3);
  const indexOf = new Map<string, number>();
  const out: number[] = [];
  for (let v = 0; v < remap.length; v++) {
    const x = positions[3 * v] ?? 0;
    const y = positions[3 * v + 1] ?? 0;
    const z = positions[3 * v + 2] ?? 0;
    // Number formatting maps -0 and 0 to the same key.
    const key = `${x},${y},${z}`;
    let idx = indexOf.get(key);
    if (idx === undefined) {
      idx = out.length / 3;
      indexOf.set(key, idx);
      out.push(x, y, z);
    }
    remap[v] = idx;
  }
  const tris: number[] = [];
  const kept: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i] ?? 0] ?? 0;
    const b = remap[indices[i + 1] ?? 0] ?? 0;
    const c = remap[indices[i + 2] ?? 0] ?? 0;
    if (a !== b && b !== c && a !== c) {
      tris.push(a, b, c);
      kept.push(i / 3);
    }
  }
  return { vertices: new Float32Array(out), triangles: new Uint32Array(tris), kept };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
}

/** A store-only ZIP archive: 3MF allows uncompressed entries. */
function buildZip(entries: ZipEntry[]): Uint8Array {
  let offset = 0;
  const locals: { offset: number; entry: ZipEntry }[] = [];
  for (const entry of entries) {
    locals.push({ offset, entry });
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const entry of entries) centralSize += 46 + entry.name.length;
  const bytes = new Uint8Array(offset + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let pos = 0;
  const u16 = (v: number) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  for (const { entry } of locals) {
    u32(0x04034b50);
    u16(20); // version needed
    u16(0); // flags
    u16(0); // stored
    u16(0); // time
    u16(0); // date
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0);
    bytes.set(entry.name, pos);
    pos += entry.name.length;
    bytes.set(entry.data, pos);
    pos += entry.data.length;
  }
  for (const { offset: local, entry } of locals) {
    u32(0x02014b50);
    u16(20); // made by
    u16(20); // needed
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(entry.crc);
    u32(entry.data.length);
    u32(entry.data.length);
    u16(entry.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(local);
    bytes.set(entry.name, pos);
    pos += entry.name.length;
  }
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(centralSize);
  u32(centralStart);
  u16(0);
  return bytes;
}

const escapeXml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function meshXml(vertices: Float32Array, triangles: Uint32Array, paint: (t: number) => string): string {
  const lines: string[] = ['      <mesh>', '        <vertices>'];
  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`          <vertex x="${vertices[i] ?? 0}" y="${vertices[i + 1] ?? 0}" z="${vertices[i + 2] ?? 0}" />`);
  }
  lines.push('        </vertices>', '        <triangles>');
  for (let i = 0; i < triangles.length; i += 3) {
    lines.push(
      `          <triangle v1="${triangles[i] ?? 0}" v2="${triangles[i + 1] ?? 0}" v3="${triangles[i + 2] ?? 0}"${paint(i / 3)} />`,
    );
  }
  lines.push('        </triangles>', '      </mesh>');
  return lines.join('\n');
}

/** The colours of an export and each body's slot; null when nothing is coloured and no body has a slot of its own. */
export function paletteOf(
  bodies: readonly ThreeMfBody[],
  fallback: string,
): { palette: string[]; slots: number[] } | null {
  const coloured = bodies.some(
    (b) => b.color !== null || b.filamentSlot !== undefined || (b.triangleColors ?? []).some((c) => c !== null),
  );
  if (!coloured) return null;
  const palette: string[] = [];
  const add = (c: string) => {
    const upper = c.toUpperCase();
    if (!palette.includes(upper)) palette.push(upper);
    return upper;
  };
  // Body colours first, so slot n is the n-th distinct body colour.
  const bodyColours = bodies.map((b) => add(b.color ?? fallback));
  for (const b of bodies) for (const c of b.triangleColors ?? []) if (c !== null) add(c);
  const distinct = [...new Set(bodyColours)];
  const slots = bodies.map((b, i) => b.filamentSlot ?? distinct.indexOf(bodyColours[i] as string) + 1);
  return { palette, slots };
}

/** A 3MF file of the bodies, in millimetres. `fallback` colours an uncoloured body when others are coloured. */
export function build3mf(bodies: readonly ThreeMfBody[], name: string, fallback: string): Uint8Array {
  const colours = paletteOf(bodies, fallback);
  const encoder = new TextEncoder();
  const entry = (path: string, content: string): ZipEntry => {
    const data = encoder.encode(content);
    return { name: encoder.encode(path), data, crc: crc32(data) };
  };
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />${colours ? '\n  <Default Extension="config" ContentType="text/xml" />' : ''}
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>`;

  // Resource ids: colour group k is k + 1, body i is groups + i + 1, the parent last.
  const groups = colours?.palette.length ?? 0;
  const groupId = (colour: string) => (colours?.palette.indexOf(colour.toUpperCase()) ?? 0) + 1;
  const bodyId = (i: number) => groups + i + 1;
  const parentId = groups + bodies.length + 1;
  const objects = bodies.map((b, i) => {
    const { vertices, triangles, kept } = weldMesh(b.positions, b.indices);
    if (!colours)
      return `    <object id="${bodyId(i)}" name="${escapeXml(b.name)}" type="model">\n${meshXml(vertices, triangles, () => '')}\n    </object>`;
    const own = groupId(b.color ?? fallback);
    const paint = (t: number) => {
      const c = b.triangleColors?.[kept[t] as number] ?? null;
      const g = c === null ? own : groupId(c);
      return ` pid="${g}" p1="0"`;
    };
    return `    <object id="${bodyId(i)}" name="${escapeXml(b.name)}" type="model" pid="${own}" pindex="0">\n${meshXml(vertices, triangles, paint)}\n    </object>`;
  });
  const groupXml = (colours?.palette ?? []).map(
    (c, k) => `    <m:colorgroup id="${k + 1}">\n      <m:color color="${c}" />\n    </m:colorgroup>`,
  );
  const components = bodies.map((_, i) => `        <component objectid="${bodyId(i)}" />`).join('\n');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="${CORE_NS}"${colours ? ` xmlns:m="${MATERIAL_NS}"` : ''}>
  <resources>
${[...groupXml, ...objects].join('\n')}
    <object id="${parentId}" name="${escapeXml(name)}" type="model">
      <components>
${components}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="${parentId}" />
  </build>
</model>`;
  const files = [
    entry('[Content_Types].xml', contentTypes),
    entry('_rels/.rels', rels),
    entry('3D/3dmodel.model', model),
  ];
  if (colours) {
    const parts = bodies.map(
      (b, i) => `    <part id="${bodyId(i)}" subtype="normal_part">
      <metadata key="name" value="${escapeXml(b.name)}"/>
      <metadata key="extruder" value="${colours.slots[i] ?? 1}"/>
    </part>`,
    );
    files.push(
      entry(
        'Metadata/model_settings.config',
        `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${parentId}">
    <metadata key="name" value="${escapeXml(name)}"/>
    <metadata key="extruder" value="${colours.slots[0] ?? 1}"/>
${parts.join('\n')}
  </object>
</config>`,
      ),
    );
  }
  return buildZip(files);
}
