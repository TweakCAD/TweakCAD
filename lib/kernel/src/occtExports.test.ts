/**
 * Unit tests for the pure-JS pieces of occtExports.
 *
 * The OCCT-bound paths (STL writer, STEP writer) need a real WASM kernel
 * to test end-to-end — that lives in the app's integration tests. Here
 * we cover what we can in Node: mesh combine + 3MF ZIP packaging.
 */
import { describe, expect, it } from 'vitest';
import { build3MF, combineMeshes, weldMesh } from './occtExports.ts';
import type { DisplayMesh } from '@tweakcad/core/src/document/schema.ts';
import { bodyId } from '@tweakcad/core/src/ids.ts';

function unitTriangleMesh(offsetX = 0): DisplayMesh {
  return {
    bodyId: bodyId('test'),
    positions: new Float32Array([
      0 + offsetX, 0, 0,
      1 + offsetX, 0, 0,
      0 + offsetX, 1, 0,
    ]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe('combineMeshes', () => {
  it('concatenates a single mesh untouched', () => {
    const m = unitTriangleMesh();
    const combined = combineMeshes([m]);
    expect(Array.from(combined.vertices)).toEqual(Array.from(m.positions));
    expect(Array.from(combined.triangles)).toEqual(Array.from(m.indices));
  });

  it('offsets index references when concatenating multiple meshes', () => {
    const m1 = unitTriangleMesh(0);
    const m2 = unitTriangleMesh(10);
    const combined = combineMeshes([m1, m2]);

    expect(combined.vertices.length).toBe(18); // 6 verts × 3 floats
    expect(combined.triangles.length).toBe(6); // 2 triangles × 3 indices
    // Second triangle's indices should be shifted by 3 (vertex count of m1).
    expect(Array.from(combined.triangles)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns empty buffers for an empty mesh list', () => {
    const combined = combineMeshes([]);
    expect(combined.vertices.length).toBe(0);
    expect(combined.triangles.length).toBe(0);
  });
});

describe('build3MF', () => {
  it('produces a valid store-only ZIP archive', () => {
    const buf = build3MF([unitTriangleMesh()]);
    const bytes = new Uint8Array(buf);

    // ZIP local file header signature 0x04034b50 (little-endian).
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);

    // End-of-central-directory signature 0x06054b50 appears in the trailer.
    let sawEocd = false;
    for (let i = bytes.length - 22; i >= bytes.length - 100; i--) {
      if (
        bytes[i] === 0x50 &&
        bytes[i + 1] === 0x4b &&
        bytes[i + 2] === 0x05 &&
        bytes[i + 3] === 0x06
      ) {
        sawEocd = true;
        break;
      }
    }
    expect(sawEocd).toBe(true);
  });

  it('embeds vertices and triangles in the 3D model XML entry', () => {
    const buf = build3MF([unitTriangleMesh()], { name: 'TestPart', unit: 'millimeter' });
    const text = new TextDecoder().decode(new Uint8Array(buf));
    expect(text).toContain('<model unit="millimeter"');
    expect(text).toContain('name="TestPart"');
    // Spot-check one vertex and the single triangle.
    expect(text).toContain('<vertex x="0" y="0" z="0"');
    expect(text).toContain('<triangle v1="0" v2="1" v3="2"');
  });

  it('escapes XML special characters in the model name', () => {
    const buf = build3MF([unitTriangleMesh()], { name: 'a&b<c>"d' });
    const text = new TextDecoder().decode(new Uint8Array(buf));
    expect(text).toContain('a&amp;b&lt;c&gt;&quot;d');
  });

  it('writes no colour markup and no settings file when no body has a colour', () => {
    const text = new TextDecoder().decode(new Uint8Array(
      build3MF([unitTriangleMesh(), unitTriangleMesh(2)], { colors: [undefined, undefined] })));
    expect(text).not.toContain('colorgroup');
    expect(text).not.toContain('pid=');
    expect(text).not.toContain('model_settings.config');
    expect(text).toContain('<item objectid="1" />');
  });

  it('writes each coloured body as a component with its own colour group and extruder', () => {
    const text = new TextDecoder().decode(new Uint8Array(
      build3MF([unitTriangleMesh(), unitTriangleMesh(2), unitTriangleMesh(4)], { name: 'Part', colors: ['#e53935', undefined, '#e53935'] })));
    // One group per colour: some readers keep only one colour per group.
    expect(text).toContain('<m:colorgroup id="1">\n      <m:color color="#E53935" />\n    </m:colorgroup>');
    expect(text).toContain('<m:colorgroup id="2">\n      <m:color color="#6699CC" />\n    </m:colorgroup>');
    // Bodies are objects 3, 4, 5, coloured on the object and on each triangle.
    expect(text).toContain('<object id="3" name="Part 1" type="model" pid="1" pindex="0">');
    expect(text).toContain('<object id="4" name="Part 2" type="model" pid="2" pindex="0">');
    expect(text).toContain('<object id="5" name="Part 3" type="model" pid="1" pindex="0">');
    expect(text).toContain('<triangle v1="0" v2="1" v3="2" pid="2" p1="0" />');
    // The parent holds them as components, and is the one build item.
    expect(text).toMatch(/<object id="6" name="Part" type="model">\s*<components>\s*<component objectid="3" \/>\s*<component objectid="4" \/>\s*<component objectid="5" \/>/);
    expect(text).toContain('<item objectid="6" />');
    // The settings file puts each body on its colour's extruder.
    expect(text).toContain('Metadata/model_settings.config');
    expect(text).toMatch(/<object id="6">[\s\S]*<part id="3" subtype="normal_part">\s*<metadata key="name" value="Part 1"\/>\s*<metadata key="extruder" value="1"\/>/);
    expect(text).toMatch(/<part id="4" subtype="normal_part">\s*<metadata key="name" value="Part 2"\/>\s*<metadata key="extruder" value="2"\/>/);
    expect(text).toMatch(/<part id="5" subtype="normal_part">\s*<metadata key="name" value="Part 3"\/>\s*<metadata key="extruder" value="1"\/>/);
    expect(text).toContain('<Default Extension="config" ContentType="text/xml" />');
  });
});

describe('weldMesh', () => {
  it('merges coincident vertices so two faces share their edge', () => {
    // Two triangles of a square, each with its own copy of the shared edge.
    const quad = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    };
    const { vertices, triangles } = weldMesh(quad);
    expect(vertices.length / 3).toBe(4);
    expect([...triangles]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('treats -0 and 0 as the same position, and drops triangles that collapse', () => {
    const m = {
      positions: new Float32Array([0, 0, 0, -0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    };
    const { vertices, triangles } = weldMesh(m);
    expect(vertices.length / 3).toBe(3);
    expect([...triangles]).toEqual([0, 1, 2]);
  });
});
