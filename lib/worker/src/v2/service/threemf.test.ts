import { describe, expect, it } from 'vitest';
import { build3mf, crc32, paletteOf, weldMesh, type ThreeMfBody } from './threemf';
import { edgeAt, faceAt, matrixOf } from './picking';
import { unzip } from './testKit';
import type { BodyMesh } from './types';

/** Two triangles of a square, each with its own copy of the shared corners, as a display mesh gives them. */
const square = (): Pick<ThreeMfBody, 'positions' | 'indices'> => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
});

describe('3MF writing', () => {
  it('welds coincident vertices and drops collapsed triangles', () => {
    const { positions, indices } = square();
    const welded = weldMesh(positions, new Uint32Array([...indices, 0, 3, 1]));
    expect(welded.vertices.length / 3).toBe(4);
    expect([...welded.triangles]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(welded.kept).toEqual([0, 1]);
  });

  it('gives each distinct body colour its own slot unless the user chose one', () => {
    const body = (color: string | null, filamentSlot?: number): ThreeMfBody => ({
      name: 'b',
      ...square(),
      color,
      ...(filamentSlot !== undefined ? { filamentSlot } : {}),
    });
    expect(paletteOf([body(null), body(null)], '#6699cc')).toBeNull();
    expect(paletteOf([body('#ff0000'), body(null), body('#ff0000'), body('#00ff00', 7)], '#6699cc')).toEqual({
      palette: ['#FF0000', '#6699CC', '#00FF00'],
      slots: [1, 2, 1, 7],
    });
  });

  it('keeps a filament slot the user chose on a body with no colour', () => {
    expect(
      paletteOf(
        [
          { name: 'a', ...square(), color: null },
          { name: 'b', ...square(), color: null, filamentSlot: 7 },
        ],
        '#6699cc',
      ),
    ).toEqual({
      palette: ['#6699CC'],
      slots: [1, 7],
    });
    const files = unzip(build3mf([{ name: 'Box', ...square(), color: null, filamentSlot: 7 }], 'Box', '#6699cc'));
    expect(files.get('Metadata/model_settings.config')).toContain('<metadata key="extruder" value="7"/>');
  });

  it('paints a face colour on its triangles', () => {
    const bytes = build3mf(
      [{ name: 'Plate', ...square(), color: '#ff0000', triangleColors: [null, '#00ff00'] }],
      'Plate',
      '#6699cc',
    );
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      '3D/3dmodel.model',
      'Metadata/model_settings.config',
    ]);
    const model = files.get('3D/3dmodel.model') as string;
    expect(model).toContain('<m:color color="#FF0000" />');
    expect(model).toContain('v1="0" v2="1" v3="2" pid="1" p1="0"');
    expect(model).toContain('v1="0" v2="2" v3="3" pid="2" p1="0"');
  });

  it('checks entries with CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('pick tables', () => {
  const mesh = {
    faces: new Uint32Array([0, 2, 7, 2, 0, 8, 2, 3, 9]),
    edges: new Uint32Array([0, 4, 11, 4, 1, 12]),
  } as BodyMesh;

  it('finds the face of a triangle and the edge of a segment', () => {
    expect([0, 1, 2, 4, 5].map((t) => faceAt(mesh, t))).toEqual([7, 7, 9, 9, undefined]);
    expect([0, 3, 4, 5].map((s) => edgeAt(mesh, s))).toEqual([11, 11, 12, undefined]);
  });

  it('writes a placement as a column-major matrix', () => {
    const s = Math.SQRT1_2;
    const m = matrixOf({ position: [1, 2, 3], rotation: [0, 0, s, s] });
    const round = m.map((v) => Math.round(v * 1e9) / 1e9 + 0);
    expect(round).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]);
  });
});
