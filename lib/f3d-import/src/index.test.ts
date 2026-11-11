import { describe, expect, it } from 'vitest';
import { readDocument } from '@tweakcad/format';
import { seededIds } from '@tweakcad/editor';
import { importF3d } from './index';
import { asmStream, boxRecords } from './parser/asmBuilder.testHelper';
import {
  buildArchive,
  buildDesign,
  head,
  lineRecord,
  linearDimensionRecord,
  parameterOwnerRecord,
  parameterRecord,
  placementRecord,
  pointRecord,
  relationRecord,
  sketchRecord,
  type ByteWriter,
} from './parser/designBuilder.testHelper';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A 4 × 2 cm rectangle: points 10–13, lines 20–23. */
function rectangle(
  options: {
    matrix?: number[] | null;
    relations?: ReturnType<typeof relationRecord>[];
    extra?: Parameters<typeof buildDesign>[0];
    breps?: Record<string, Uint8Array>;
  } = {},
) {
  const corners: [number, number][] = [
    [0, 0],
    [4, 0],
    [4, 2],
    [0, 2],
  ];
  const points = corners.map(([x, y], i) => pointRecord(10 + i, 30 + i, x, y));
  const lines = corners.map((from, i) =>
    lineRecord(20 + i, 10 + i, 10 + ((i + 1) % 4), from, corners[(i + 1) % 4] as [number, number]),
  );
  return buildArchive(
    buildDesign([
      placementRecord(2, options.matrix ?? null),
      sketchRecord(1, 2, 'Outline', [10, 11, 12, 13, 20, 21, 22, 23]),
      ...points,
      ...lines,
      ...(options.relations ?? []),
      ...(options.extra ?? []),
    ]),
    options.breps,
  );
}

function imported(bytes: Uint8Array) {
  const result = importF3d(bytes, {
    ids: seededIds(5),
    writer: { app: 'test', version: '0' },
    name: 'plate',
    now: '2026-11-06T00:00:00Z',
  });
  if (!result.ok) throw new Error(result.error);
  const { document, report, notes } = result.value;
  expect(readDocument(document).diagnostics.filter((d) => d.severity === 'refuse')).toEqual([]);
  const part = (document.parts as Row[])[0] as Row;
  const sketch = (part.timeline as Row[]).find((f) => f.type === 'core.sketch') as Row;
  return { document, part, sketch, inputs: sketch.inputs as Row, report, notes };
}

const kinds = (inputs: Row, kind: string): Row[] => (inputs.constraints as Row[]).filter((c) => c.kind === kind);
const text = (v: Row): string => v.def.expr.text;

describe('importF3d', () => {
  it('imports a sketch in millimetres with shared corners and its one region', () => {
    const { sketch, inputs } = imported(rectangle());
    expect(sketch.name).toBe('Outline');
    expect(inputs.curves.filter((c: Row) => c.kind === 'line')).toHaveLength(4);
    expect(inputs.points).toHaveLength(4);
    expect(Math.max(...inputs.points.map((p: Row) => p.x))).toBeCloseTo(40);
    expect(Math.max(...inputs.points.map((p: Row) => p.y))).toBeCloseTo(20);
    expect(inputs.regions).toHaveLength(1);
  });

  it('holds a point on the sketch origin there', () => {
    const { inputs } = imported(rectangle());
    const held = [...kinds(inputs, 'horizontal'), ...kinds(inputs, 'vertical')];
    expect(held).toHaveLength(2);
    for (const c of held) expect(c.of.points.b).toEqual({ sketchStandard: { name: 'origin' } });
  });

  it('brings relations the geometry satisfies', () => {
    const { inputs } = imported(
      rectangle({
        relations: [
          relationRecord(40, 1, 0x40, [20]),
          relationRecord(41, 1, 0x80, [21]),
          relationRecord(42, 1, 0x10, [20, 22]),
        ],
      }),
    );
    expect(kinds(inputs, 'horizontal').filter((c) => c.of.curve)).toHaveLength(1);
    expect(kinds(inputs, 'vertical').filter((c) => c.of.curve)).toHaveLength(1);
    expect(kinds(inputs, 'parallel')).toHaveLength(1);
  });

  it('leaves out a relation the geometry does not satisfy', () => {
    const { inputs, report } = imported(rectangle({ relations: [relationRecord(40, 1, 0x20, [20, 22])] }));
    expect(kinds(inputs, 'perpendicular')).toHaveLength(0);
    expect(report.sketches[0]?.skipped.notSatisfied).toBe(1);
  });

  it('keeps the coordinates of a sketch whose axes differ from the plane it lies on', () => {
    // Sketch x along model y, sketch y along model x, its z the other way.
    const { inputs } = imported(
      rectangle({
        matrix: [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
        relations: [relationRecord(40, 1, 0x40, [20])],
      }),
    );
    expect(kinds(inputs, 'horizontal').filter((c) => c.of.curve)).toHaveLength(1);
    expect(Math.max(...inputs.points.map((p: Row) => p.x))).toBeCloseTo(40);
    expect(inputs.frame.attach.support).toEqual([{ standard: { name: 'xy' } }]);
  });

  it('places a sketch on an angled plane with an offset from a standard plane', () => {
    const c = Math.SQRT1_2;
    const { inputs } = imported(rectangle({ matrix: [1, 0, 0, 0, 0, c, -c, 0, 0, c, c, 0, 0, 0, 0, 1] }));
    expect(text(inputs.frame.attach.offset)).toContain('45 deg');
  });

  it('attaches a sketch parallel to a standard plane to that plane', () => {
    const { inputs } = imported(rectangle({ matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 2.5, 0, 0, 0, 1] }));
    expect(inputs.frame.attach.support).toEqual([{ standard: { name: 'xz' } }]);
  });

  it('keeps a dimension driven by a user parameter', () => {
    const owner = parameterOwnerRecord(50);
    const width = parameterRecord(52, null, 'width', '40 mm', 4, { role: 'User Parameter', user: true });
    const dimension = parameterRecord(51, 50, 'd1', 'width', 4);
    const linear = linearDimensionRecord(53, 1, 50, [10, 11], 0x40);
    const { inputs, part } = imported(rectangle({ extra: [owner, width, dimension, linear] }));
    const rows = part.parameters[0].parameters as Row[];
    expect(rows.map((p) => [p.name, text(p.value)])).toEqual([['width', '40 mm']]);
    const value = (kinds(inputs, 'distanceX')[0] as Row).value;
    expect(text(value)).toBe('width');
    expect(value.def.expr.refs.width).toEqual({ parameter: { id: rows[0]?.id } });
  });

  it('uses the value when a formula does not reproduce it', () => {
    const owner = parameterOwnerRecord(50);
    const width = parameterRecord(52, null, 'width', '10 mm', 1, { role: 'User Parameter', user: true });
    const dimension = parameterRecord(51, 50, 'd1', 'width', 4); // stale: 40 mm, not 10
    const linear = linearDimensionRecord(53, 1, 50, [10, 11], 0x40);
    const { inputs } = imported(rectangle({ extra: [owner, width, dimension, linear] }));
    expect(text((kinds(inputs, 'distanceX')[0] as Row).value)).toBe('40 mm');
  });

  it('takes a parameter to its solved value when its formula cannot be read', () => {
    const owner = parameterOwnerRecord(50);
    const width = parameterRecord(52, null, 'width', 'nosuchfunction(1) * 40 mm', 4, {
      role: 'User Parameter',
      user: true,
    });
    const { part } = imported(rectangle({ extra: [owner, width] }));
    expect(text(part.parameters[0].parameters[0].value)).toBe('40 mm');
  });

  it('writes a distance from the lower point, so its value stays positive', () => {
    const owner = parameterOwnerRecord(50);
    const dimension = parameterRecord(51, 50, 'd1', '40 mm', 4);
    const linear = linearDimensionRecord(53, 1, 50, [11, 10], 0x40);
    const { inputs } = imported(rectangle({ extra: [owner, dimension, linear] }));
    const row = kinds(inputs, 'distanceX')[0] as Row;
    const at = (o: Row) => (inputs.points as Row[]).find((p) => p.id === o.point.id) as Row;
    expect(at(row.b).x).toBeGreaterThan(at(row.a).x);
    expect(row.solved).toBeCloseTo(40);
  });

  it('leaves out a dimension the geometry does not have', () => {
    const owner = parameterOwnerRecord(50);
    const dimension = parameterRecord(51, 50, 'd1', '40 mm', 4);
    const wrong = linearDimensionRecord(54, 1, 50, [11, 12], 0x40); // these two points are level in x
    const { report } = imported(rectangle({ extra: [owner, dimension, wrong] }));
    expect(report.sketches[0]?.skipped.notSatisfied).toBe(1);
  });

  it('says how many stored bodies it could not read', () => {
    // A base feature whose body the file does not name.
    const body = { id: 60, type: 'D7015B81', primary: (w: ByteWriter) => void head(w, 60).u8(0).u8(0) };
    const { report, notes } = imported(rectangle({ extra: [body] }));
    expect(report.leftOut).toEqual({ 'stored body': 1 });
    expect(notes.find((n) => n.object === 'timeline')?.message).toContain(
      '1 body with no history could not be read from the file',
    );
  });

  it('reads a body with no history from the B-rep stream its body map names', () => {
    // A body record, and a body map pairing selector 0 with it in BREP.a.smb.
    const body = { id: 70, type: 'D3937028', primary: (w: ByteWriter) => void head(w, 70).u8(0).u8(0) };
    const map = {
      id: 71,
      type: '40DCC3F4',
      primary: (w: ByteWriter) => void head(w, 71).u8(0).u8(0).u32(1).u64(0).u64(70).wstr('BREP.a.smb'),
    };
    const { report, notes } = imported(
      rectangle({ extra: [body, map], breps: { 'BREP.a.smb': asmStream(boxRecords([0, 0, 0], [1, 1, 1])) } }),
    );
    expect(report.leftOut['stored body']).toBeUndefined();
    expect(notes.map((n) => n.message)).toContain(
      '1 body has no history and comes in as the file stored it, in 1 Base Feature',
    );
  });

  it('says when there is nothing to build a body from', () => {
    const { notes } = imported(rectangle());
    expect(notes.map((n) => n.message)).toEqual(['This file has nothing on its timeline that builds a body.']);
  });

  it('keeps the file as the document origin', () => {
    const { document } = imported(rectangle());
    const origin = (document.metadata as Row).origin.imported as Row;
    expect(origin.format).toBe('f3d');
    expect((document.assets as Row)[origin.source].mediaType).toBe('application/x-f3d');
  });

  it('reports a file it cannot read', () => {
    const result = importF3d(Uint8Array.from([1, 2, 3, 4]), {
      ids: seededIds(5),
      writer: { app: 'test', version: '0' },
    });
    expect(result.ok).toBe(false);
  });
});
