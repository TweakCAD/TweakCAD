import type { GcsWrapper } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectRegions, type SolvedSketch } from '@tweakcad/format';
import type { Json } from './rows';
import { solvedSketchOf } from './solve';
import { WorkingValues } from './values';
import { openTestSession, pointXY, readsClean, rowsOf, sketchDocument, type TestSession } from './testKit';
import { toolCursor } from './session';
import { sketchDrawing } from './io/sketchFile';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

const kinds = (inputs: Json, table: string) => rowsOf(inputs, table).map((r) => r.kind);
const commands = (t: TestSession) => t.editor.log.filter((e) => e.kind === 'command').length;

function rectangle(t: TestSession, x0: number, y0: number, x1: number, y1: number): void {
  t.session.setTool('rectangle');
  t.click(x0, y0);
  t.click(x1, y1);
}

function line(t: TestSession, a: [number, number], b: [number, number]): Json {
  t.session.setTool('line');
  t.click(...a);
  t.click(...b);
  t.key('Escape');
  return rowsOf(t.inputs(), 'curves').at(-1) as Json;
}

describe('snapping', () => {
  it('shares a point snapped to, and holds a point snapped to the origin against it', () => {
    const t = openTestSession(gcs);
    const first = line(t, [0.3, 0.2], [30, 17]);
    let inputs = t.inputs();
    expect(pointXY(inputs, first.start as string)).toEqual([0, 0]);
    const origin = { sketchStandard: { name: 'origin' } };
    for (const kind of ['horizontal', 'vertical']) {
      expect(rowsOf(inputs, 'constraints')).toContainEqual(
        expect.objectContaining({ kind, of: { points: { a: origin, b: { point: { id: first.start } } } } }),
      );
    }

    // The point now on the origin is what a later snap there finds.
    const second = line(t, [0.4, -0.3], [-20, 35]);
    inputs = t.inputs();
    expect(second.start).toBe(first.start);
    expect(kinds(inputs, 'constraints').filter((k) => k === 'horizontal' || k === 'vertical')).toHaveLength(2);
    expect(kinds(inputs, 'constraints')).not.toContain('fixed');

    const third = line(t, [30.5, 16.6], [50, 40]);
    expect(third.start).toBe(first.end);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('puts a point at a line midpoint with a midpoint constraint, and on an axis with a point-on-curve', () => {
    const t = openTestSession(gcs);
    const base = line(t, [10, 10], [50, 30]);
    const mid = line(t, [30.4, 19.7], [30, 60]);
    let inputs = t.inputs();
    expect(rowsOf(inputs, 'constraints')).toContainEqual(
      expect.objectContaining({
        kind: 'midpoint',
        point: { point: { id: mid.start } },
        curve: { curve: { id: base.id } },
      }),
    );
    expect(pointXY(inputs, mid.start as string)).toEqual([30, 20]);

    const onAxis = line(t, [70, 0.4], [90, 30]);
    const onY = line(t, [-0.3, 50], [-20, 70]);
    inputs = t.inputs();
    expect(pointXY(inputs, onAxis.start as string)[1]).toBeCloseTo(0, 12);
    expect(pointXY(inputs, onY.start as string)[0]).toBeCloseTo(0, 12);
    expect(rowsOf(inputs, 'constraints')).toContainEqual(
      expect.objectContaining({
        kind: 'pointOnCurve',
        point: { point: { id: onAxis.start } },
        curve: { sketchStandard: { name: 'x' } },
      }),
    );
    expect(rowsOf(inputs, 'constraints')).toContainEqual(
      expect.objectContaining({
        kind: 'pointOnCurve',
        point: { point: { id: onY.start } },
        curve: { sketchStandard: { name: 'y' } },
      }),
    );
    // A drag cannot take it off the axis.
    t.session.setTool('select');
    t.down(70, 0);
    t.move(75, 6);
    t.up(75, 6);
    expect(pointXY(t.inputs(), onAxis.start as string)[1]).toBeCloseTo(0, 9);
    expect(readsClean(t.editor)).toBe(true);
  });

  it('snaps to the grid when grid snapping is on', () => {
    const t = openTestSession(gcs);
    t.session.setOptions({ gridSnap: true });
    const l = line(t, [21.7, 38.4], [61.2, 79.6]);
    const inputs = t.inputs();
    expect(pointXY(inputs, l.start as string)).toEqual([20, 40]);
    expect(pointXY(inputs, l.end as string)).toEqual([60, 80]);
  });
});

describe('select and drag', () => {
  it('drags a point with one command on release, the solve keeping the constraints', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 50, 30);
    const before = commands(t);
    const corner = rowsOf(t.inputs(), 'points')[2]?.id as string;
    t.session.setTool('select');
    t.down(50, 30);
    for (let i = 1; i <= 5; i++) t.move(50 + 2 * i, 30 + i);
    expect(commands(t)).toBe(before);
    t.up(60, 35);
    expect(commands(t)).toBe(before + 1);
    expect(t.editor.store.undoLabel()).toBe('Drag');
    const inputs = t.inputs();
    expect(pointXY(inputs, corner)[0]).toBeCloseTo(60, 6);
    expect(pointXY(inputs, corner)[1]).toBeCloseTo(35, 6);
    // Its neighbours follow, so the sides stay horizontal and vertical.
    const [p0, p1, , p3] = rowsOf(inputs, 'points').map((p) => [p.x, p.y] as [number, number]);
    expect(p1?.[0]).toBeCloseTo(60, 6);
    expect(p3?.[1]).toBeCloseTo(35, 6);
    expect(p0).toEqual([10, 10]);
    expect(readsClean(t.editor)).toBe(true);
    t.editor.undo();
    expect(pointXY(t.inputs(), corner)).toEqual([50, 30]);
  });

  it('selects by click and box, and a click on nothing clears', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 50, 30);
    const lines = rowsOf(t.inputs(), 'curves').map((c) => c.id as string);
    t.session.setTool('select');
    t.click(30, 10);
    expect(t.session.getState().selection).toEqual([lines[0]]);
    t.click(50, 20, { shift: true });
    expect(t.session.getState().selection).toEqual([lines[0], lines[1]]);
    t.click(80, 80);
    expect(t.session.getState().selection).toEqual([]);

    // Left to right takes what lies wholly inside; right to left what it touches.
    t.down(0, 0);
    t.move(35, 40);
    t.up(35, 40);
    expect(t.session.getState().selection).toEqual([
      lines[3],
      ...rowsOf(t.inputs(), 'points')
        .filter((p) => (p.x as number) < 35)
        .map((p) => p.id),
    ]);
    t.down(35, 40);
    t.move(0, 0);
    t.up(0, 0);
    expect(new Set(t.session.getState().selection)).toEqual(
      new Set([
        lines[0],
        lines[2],
        lines[3],
        ...rowsOf(t.inputs(), 'points')
          .filter((p) => (p.x as number) < 35)
          .map((p) => p.id),
      ]),
    );
  });

  it('deletes the selection; a point goes with the curves using it', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 50, 30);
    const corner = rowsOf(t.inputs(), 'points')[0]?.id as string;
    t.session.select([corner]);
    expect(t.key('Delete')).toBe(true);
    const inputs = t.inputs();
    expect(rowsOf(inputs, 'curves')).toHaveLength(2);
    expect(rowsOf(inputs, 'points')).toHaveLength(3);
    expect(kinds(inputs, 'constraints')).toEqual(['vertical', 'horizontal']);
    expect(readsClean(t.editor)).toBe(true);
    t.editor.undo();
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(4);
  });

  it('toggles construction on the selected curves', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 10], [40, 30]);
    t.session.select([l.id as string]);
    expect(t.key('x')).toBe(true);
    const flag = (rowsOf(t.inputs(), 'curves')[0]?.construction as Json).def as Json;
    expect(flag.expr).toMatchObject({ text: 'true' });
    expect((rowsOf(t.inputs(), 'curves')[0]?.construction as Json).id).toBe((l.construction as Json).id);
    expect(t.session.getState().selected[0]?.construction).toBe(true);
    t.editor.undo();
    expect(t.session.getState().selected[0]?.construction).toBe(false);
  });
});

describe('keys', () => {
  it('takes Shift+letter as the letter, and leaves keys typed into a field or a list alone', () => {
    const t = openTestSession(gcs);
    expect(t.key('L', { shiftKey: true })).toBe(true);
    expect(t.session.tool).toBe('line');
    expect(t.key('c', { target: { tagName: 'SELECT' } })).toBe(false);
    expect(t.key('c', { target: { tagName: 'INPUT' } })).toBe(false);
    expect(t.key('r', { repeat: true })).toBe(false);
    expect(t.session.tool).toBe('line');
    t.session.setTool('point');
    t.click(10, 10);
    const p = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    t.session.setTool('select');
    t.session.select([p.id as string]);
    expect(t.key('Delete', { target: { tagName: 'SELECT' } })).toBe(false);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(1);
    expect(t.key('Delete')).toBe(true);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(0);
  });

  it('shows a crosshair for every tool but Select', () => {
    expect(toolCursor('select')).toBe('');
    expect(toolCursor(null)).toBe('');
    for (const tool of ['line', 'circle', 'text', 'trim', 'dimension'] as const)
      expect(toolCursor(tool)).toBe('crosshair');
  });
});

describe('selection details and resizing', () => {
  it('gives a selected line, circle, arc or point its measures', () => {
    const t = openTestSession(gcs);
    const l = line(t, [10, 10], [40, 50]);
    t.session.select([l.id as string]);
    expect(t.session.getState().details).toEqual({
      title: 'Line',
      props: [
        { label: 'Start', value: '(10.0, 10.0)' },
        { label: 'End', value: '(40.0, 50.0)' },
        { label: 'Length', value: '50.00 mm' },
      ],
    });
    t.session.select([l.end as string]);
    expect(t.session.getState().details).toEqual({
      title: 'Point',
      props: [
        { label: 'X', value: '40.00 mm' },
        { label: 'Y', value: '50.00 mm' },
      ],
    });
    t.session.setTool('circle');
    t.click(80, 60);
    t.click(85, 60);
    const c = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    t.session.select([c.id as string]);
    expect(t.session.getState().details?.props.map((p) => p.value)).toEqual(['(80.0, 60.0)', '5.00 mm', '10.00 mm']);
    t.session.select([c.id as string, l.id as string]);
    expect(t.session.getState().details).toBeNull();
  });

  it('resizes an arc dragged by its rim about its centre, its ends keeping their directions', () => {
    const t = openTestSession(gcs);
    t.session.setTool('arc');
    t.click(50, 40);
    t.click(30, 40);
    t.click(40, 50);
    const arc = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    expect(arc.kind).toBe('arc');
    const before = commands(t);
    t.session.setTool('select');
    t.down(40, 50);
    t.move(40, 52);
    t.move(40, 55);
    t.up(40, 55);
    expect(commands(t)).toBe(before + 1);
    const inputs = t.inputs();
    const center = pointXY(inputs, arc.center as string);
    expect(center[0]).toBeCloseTo(40, 4);
    expect(center[1]).toBeCloseTo(40, 4);
    for (const [id, x] of [
      [arc.start, 55],
      [arc.end, 25],
    ] as const) {
      const p = pointXY(inputs, id as string);
      expect(p[0]).toBeCloseTo(x, 4);
      expect(p[1]).toBeCloseTo(40, 4);
    }
    expect(readsClean(t.editor)).toBe(true);
  });
});

describe('regions', () => {
  it('selects the smallest closed region a click lands in; an edit drops it', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 70, 50);
    t.session.setTool('circle');
    t.click(40, 30);
    t.click(48, 30);
    t.session.setTool('select');
    t.click(15, 15);
    const [ring] = t.session.getState().selection;
    expect(ring).toMatch(/^region:/);
    expect(t.session.getState().selected[0]?.kind).toBe('region');
    t.click(42, 31);
    const [disc] = t.session.getState().selection;
    expect(disc).toMatch(/^region:/);
    expect(disc).not.toBe(ring);
    t.click(15, 15, { shift: true });
    expect(t.session.getState().selection).toEqual([disc, ring]);
    t.click(100, 100);
    expect(t.session.getState().selection).toEqual([]);
    t.click(15, 15);
    t.session.setTool('point');
    t.click(100, 100);
    expect(t.session.getState().selection).toEqual([]);
  });

  it('gives a point inside each selected region, so it can be found again after the sketch is finished', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 70, 50);
    t.session.setTool('circle');
    t.click(40, 30);
    t.click(48, 30);
    t.session.setTool('select');
    expect(t.session.selectedRegionPoints()).toEqual([]);
    t.click(15, 15);
    t.click(42, 31, { shift: true });
    const [ring, disc] = t.session.selectedRegionPoints();
    // The ring's point lies in the rectangle outside the circle; the disc's inside the circle.
    expect(
      ring &&
        Math.hypot(ring[0] - 40, ring[1] - 30) > 8 &&
        ring[0] > 10 &&
        ring[0] < 70 &&
        ring[1] > 10 &&
        ring[1] < 50,
    ).toBe(true);
    expect(disc && Math.hypot(disc[0] - 40, disc[1] - 30) < 8).toBe(true);
  });

  it('writes split fates when a line divides a picked rectangle', () => {
    const t = openTestSession(gcs);
    rectangle(t, 10, 10, 50, 30);
    let inputs = t.inputs();
    // A drawn rectangle's region has no row until a feature picks it; an extrude's pick writes it.
    expect(rowsOf(inputs, 'regions')).toEqual([]);
    const [detected] = detectRegions(
      solvedSketchOf(inputs, new WorkingValues(t.editor.document)) as SolvedSketch,
    ).regions;
    const picked = t.editor.newId('reg');
    expect(
      t.editor.dispatch({
        type: 'pickRegion',
        sketch: t.host.feature,
        region: { id: picked, loop: detected?.loop, holes: detected?.holes } as unknown as Json,
      }).ok,
    ).toBe(true);

    // From the bottom side's midpoint to the top side's.
    line(t, [30.2, 10.3], [29.8, 29.7]);
    inputs = t.inputs();
    const regions = rowsOf(inputs, 'regions');
    expect(regions).toHaveLength(2);
    for (const r of regions) expect(r.origin).toEqual({ from: { id: picked } });
    expect(rowsOf(inputs, 'retired').map((r) => [r.id, r.fate])).toEqual([[picked, { split: {} }]]);
    expect(readsClean(t.editor)).toBe(true);
    t.editor.undo();
    expect(rowsOf(t.inputs(), 'regions').map((r) => r.id)).toEqual([picked]);
  });
});

describe('the document changing underneath', () => {
  it('follows undo, and closes while the sketch feature is gone', () => {
    const t = openTestSession(gcs);
    let notified = 0;
    t.session.subscribe(() => notified++);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 30);
    expect(t.session.getState().counts.curves).toBe(1);
    // An undo from outside the session drops the chain whose point it removed.
    t.editor.undo();
    expect(t.session.getState().counts.curves).toBe(0);
    t.click(60, 60);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(0);
    expect(notified).toBeGreaterThan(0);

    expect(t.editor.dispatch({ type: 'removeFeature', feature: t.host.feature }).ok).toBe(true);
    expect(t.session.getState().open).toBe(false);
    expect(
      t.session.pointer({ type: 'down', uv: [1, 1], pixel: 0.1, button: 0, shift: false, ctrl: false, alt: false }),
    ).toBe(false);
    t.editor.undo();
    expect(t.session.getState().open).toBe(true);
  });
});

describe('parameters changing', () => {
  function circleSizedBy(t: TestSession): Json {
    t.session.setTool('circle');
    t.click(20, 20);
    t.click(30, 20);
    const circle = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    t.session.setTool('dimension');
    t.click(30, 20);
    t.click(50, 50);
    const dim = rowsOf(t.inputs(), 'constraints').at(-1) as Json;
    expect(t.session.setDimension(dim.id as string, 'width').ok).toBe(true);
    return circle;
  }

  function setWidth(t: TestSession, text: string): void {
    const parts = t.editor.document.parts as Json[];
    const table = (parts[0]?.parameters as Json[])[0] as Json;
    const width = (table.parameters as Json[]).find((p) => p.name === 'width') as Json;
    const value = width.value as Json;
    expect(
      t.editor.dispatch({
        type: 'setValueDef',
        value: value.id as string,
        def: { expr: { text, grammar: 1, refs: {} } },
      }).ok,
    ).toBe(true);
  }

  it('shows the sketch as the new values solve it, and writes that with the next edit', () => {
    const t = openTestSession(gcs);
    const circle = circleSizedBy(t);
    expect(t.session.shown.radius(circle.id as string)).toBeCloseTo(20, 6);
    setWidth(t, '80 mm');
    // The document keeps the last solved radius until an edit writes the new one.
    expect(t.session.shown.radius(circle.id as string)).toBeCloseTo(40, 6);
    t.session.select([circle.id as string]);
    expect(t.session.getState().details?.props.find((p) => p.label === 'Radius')?.value).toBe('40.00 mm');
    t.session.setTool('point');
    t.click(100, 100);
    expect(rowsOf(t.inputs(), 'curves').find((c) => c.id === circle.id)?.radius).toBeCloseTo(40, 6);
  });

  it('exports the sketch as the new values solve it', () => {
    const t = openTestSession(gcs);
    circleSizedBy(t);
    setWidth(t, '80 mm');
    const drawing = sketchDrawing(t.editor.document, t.host.part, t.host.feature, 'svg', gcs);
    expect(drawing.ok && /<circle[^>]* r="40"/.test(drawing.text)).toBe(true);
  });
});

describe('gestures cut short', () => {
  it('puts a dragged point back when the tool changes mid-drag, and Escape gives back the degrees of freedom', () => {
    const t = openTestSession(gcs);
    t.session.setTool('point');
    t.click(10, 10);
    const point = rowsOf(t.inputs(), 'curves').at(-1) as Json;
    const at = point.at as string;
    t.session.setTool('select');
    const dof = t.session.getState().dof;
    expect(dof).toBe(2);
    t.down(10, 10);
    t.move(20, 20);
    expect(t.session.shown.point(at)).toEqual([20, 20]);
    expect(t.key('l')).toBe(true);
    t.up(20, 20);
    expect(t.session.shown.point(at)).toEqual([10, 10]);
    expect(pointXY(t.inputs(), at)).toEqual([10, 10]);

    t.session.setTool('select');
    t.down(10, 10);
    t.move(20, 20);
    expect(t.key('Escape')).toBe(true);
    expect(t.session.shown.point(at)).toEqual([10, 10]);
    expect(t.session.getState().dof).toBe(dof);
  });

  it('abandons a drag released where the sketch cannot see it, writing nothing', () => {
    const t = openTestSession(gcs);
    t.session.setTool('point');
    t.click(10, 10);
    const at = (rowsOf(t.inputs(), 'curves').at(-1) as Json).at as string;
    t.session.setTool('select');
    const before = commands(t);
    t.down(10, 10);
    t.move(20, 20);
    t.session.cancelGesture();
    t.move(30, 30);
    t.up(30, 30);
    expect(commands(t)).toBe(before);
    expect(t.session.shown.point(at)).toEqual([10, 10]);
    expect(t.session.getState().dof).toBe(2);
  });
});

describe('a closed session', () => {
  it('refuses edits that arrive after it was finished and disposed', () => {
    const t = openTestSession(gcs);
    t.session.finish();
    t.session.dispose();
    const before = commands(t);
    const dxf = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'LINE',
      '8',
      '0',
      '10',
      '0',
      '20',
      '0',
      '11',
      '10',
      '21',
      '0',
      '0',
      'ENDSEC',
      '0',
      'EOF',
    ].join('\n');
    expect(t.session.insertDrawing(dxf, 'dxf').ok).toBe(false);
    expect(
      t.session.addExternal({ reference: {}, names: {} }, 'project', [{ kind: 'line', start: [0, 0], end: [5, 0] }]).ok,
    ).toBe(false);
    expect(commands(t)).toBe(before);
    expect(rowsOf(t.inputs(), 'curves')).toHaveLength(0);
  });
});

describe('external curves moving', () => {
  it('finds regions where the external curves are now', () => {
    const made = sketchDocument();
    const sketch = ((made.doc.parts as Json[])[0]?.timeline as Json[]).find((f) => f.id === made.feature) as Json;
    const id = made.t.id('crv');
    const external = {
      id,
      kind: 'external',
      construction: made.t.flag(false),
      origin: { drawn: {} },
      source: { standard: { name: 'x' } },
      defining: made.t.flag(true),
      mode: made.t.val('"project"'),
    };
    ((sketch.inputs as Json).curves as Json[]).push(external);
    const t = openTestSession(gcs, made.doc, made.part, made.feature);
    const circle = (x: number) => [
      { id, shape: { kind: 'circle' as const, center: [x, x] as [number, number], radius: 5 }, bounds: true },
    ];
    t.session.setExternals(circle(20));
    t.session.setTool('select');
    t.click(20, 20);
    expect(t.session.getState().selection[0]).toMatch(/^region:/);
    t.session.setExternals(circle(40));
    t.click(20, 20);
    expect(t.session.getState().selection).toEqual([]);
    t.click(40, 40);
    expect(t.session.getState().selection[0]).toMatch(/^region:/);
  });
});
