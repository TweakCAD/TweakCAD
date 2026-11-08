import { ValueEvaluator } from '@tweakcad/format';
import { Editor, seededIds } from '@tweakcad/editor';
import { describe, expect, it } from 'vitest';
import { SketchGeometry } from '../geometry';
import { RowMaker, sketchInputs, type Json, type P2 } from '../rows';
import { readsClean, sketchDocument } from '../testKit';
import { sketchToSvg } from './svg';
import { importSvg } from './svgImport';
import { described, imported, sameCurves } from './testRows';

const make = () => new RowMaker(seededIds(3));
const read = (text: string) => imported(importSvg(text, make()));

/** viewBox 0 0 100 100: y flips about 100, one user unit is a mm. */
function svg100(body: string, attrs = 'viewBox="0 0 100 100"'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

function close(p: P2, q: P2, digits = 9): void {
  expect(p[0]).toBeCloseTo(q[0], digits);
  expect(p[1]).toBeCloseTo(q[1], digits);
}

describe('importSvg', () => {
  it('reads a <line>, flipping y about the bottom of the viewBox', () => {
    const r = read(svg100('<line x1="0" y1="20" x2="10" y2="20"/>'));
    const [l] = r.curves as [Json];
    expect(l.kind).toBe('line');
    expect([r.at(l.start), r.at(l.end)]).toEqual([
      [0, 80],
      [10, 80],
    ]);
  });

  it('labels the change and adds no constraints', () => {
    const { change } = importSvg(svg100('<line x1="0" y1="0" x2="1" y2="0"/>'), make());
    expect(change.label).toBe('Import SVG');
    expect(change.add?.constraints).toBeUndefined();
  });

  it('reads a <rect> as four lines sharing their corners', () => {
    const r = read(svg100('<rect x="0" y="0" width="10" height="10"/>'));
    expect(r.kinds()).toEqual(['line', 'line', 'line', 'line']);
    expect(r.points).toHaveLength(4);
  });

  it('reads a rounded <rect> as lines and quarter arcs', () => {
    const r = read(svg100('<rect x="0" y="0" width="20" height="10" rx="2"/>'));
    expect(r.kinds()).toEqual(['line', 'arc', 'line', 'arc', 'line', 'arc', 'line', 'arc']);
    expect(r.points).toHaveLength(12);
    const arc = r.curves[1] as Json;
    // The top right corner, centre (18, 98) after the flip; counter-clockwise from (20, 98) to (18, 100).
    close(r.at(arc.center), [18, 98]);
    close(r.at(arc.start), [20, 98]);
    close(r.at(arc.end), [18, 100]);
  });

  it('reads a <circle> with its centre flipped', () => {
    const r = read(svg100('<circle cx="50" cy="40" r="5"/>'));
    const [c] = r.curves as [Json];
    expect(c.kind).toBe('circle');
    expect(r.at(c.center)).toEqual([50, 60]);
    expect(c.radius).toBe(5);
  });

  it('reads an <ellipse> with the longer radius as its major axis', () => {
    const r = read(svg100('<ellipse cx="0" cy="0" rx="3" ry="8"/>'));
    const [e] = r.curves as [Json];
    expect(e.kind).toBe('ellipse');
    expect(r.at(e.center)).toEqual([0, 100]);
    close(r.at(e.majorEnd), [0, 108]);
    expect(e.minorRadius).toBeCloseTo(3, 9);
  });

  it('reads a <circle> under a stretching transform as an ellipse', () => {
    const r = read(svg100('<circle cx="0" cy="0" r="2" transform="scale(3 1)"/>'));
    const [e] = r.curves as [Json];
    expect(e.kind).toBe('ellipse');
    close(r.at(e.majorEnd), [6, 100]);
    expect(e.minorRadius).toBeCloseTo(2, 9);
  });

  it('reads a <polygon> closing back to its first point', () => {
    const r = read(svg100('<polygon points="0,0 10,0 10,10 0,10"/>'));
    expect(r.kinds()).toEqual(['line', 'line', 'line', 'line']);
    expect(r.points).toHaveLength(4);
    expect((r.curves[3] as Json).end).toBe((r.curves[0] as Json).start);
  });

  it('reads a <polyline> as open lines', () => {
    expect(read(svg100('<polyline points="0 0 10 0 10 10"/>')).kinds()).toEqual(['line', 'line']);
  });

  it('scales user units to mm by width over the viewBox', () => {
    const r = read(svg100('<line x1="0" y1="0" x2="10" y2="0"/>', 'width="200mm" viewBox="0 0 100 100"'));
    const [l] = r.curves as [Json];
    expect(r.at(l.end)).toEqual([20, 200]);
  });

  it('scales inches, and takes px as mm', () => {
    const inch = read(svg100('<line x1="0" y1="1" x2="1" y2="1"/>', 'width="1in" viewBox="0 0 1 1"'));
    close(inch.at((inch.curves[0] as Json).end), [25.4, 0]);
    const px = read(svg100('<line x1="0" y1="0" x2="5" y2="0"/>', 'width="20px" viewBox="0 0 10 10"'));
    close(px.at((px.curves[0] as Json).end), [10, 20]);
  });

  it('applies group and element transforms', () => {
    const r = read(
      svg100('<g transform="translate(5,0)"><line x1="0" y1="0" x2="10" y2="0" transform="rotate(90)"/></g>'),
    );
    const [l] = r.curves as [Json];
    close(r.at(l.start), [5, 100]);
    close(r.at(l.end), [5, 90]);
  });

  it('reads a cubic path segment as one bezier', () => {
    const r = read(svg100('<path d="M 0 0 C 0 10 10 10 10 0"/>'));
    const [b] = r.curves as [Json];
    expect(b.kind).toBe('bezier');
    expect([b.start, b.c1, b.c2, b.end].map(r.at)).toEqual([
      [0, 100],
      [0, 90],
      [10, 90],
      [10, 100],
    ]);
  });

  it('reads S as a cubic whose first control point mirrors the last', () => {
    const r = read(svg100('<path d="M0 0 C0 10 10 10 10 0 S20 -10 20 0"/>'));
    expect(r.kinds()).toEqual(['bezier', 'bezier']);
    const second = r.curves[1] as Json;
    expect(second.start).toBe((r.curves[0] as Json).end);
    close(r.at(second.c1), [10, 110]);
  });

  it('reads a quadratic segment as the conic with rho 1/2, and T as its mirror', () => {
    const r = read(svg100('<path d="M 0 0 Q 5 10 10 0 T 20 0"/>'));
    expect(r.kinds()).toEqual(['conic', 'conic']);
    const [q, t] = r.curves as [Json, Json];
    expect([q.start, q.apex, q.end].map(r.at)).toEqual([
      [0, 100],
      [5, 90],
      [10, 100],
    ]);
    expect(r.numbers(q.rho)).toEqual([0.5]);
    close(r.at(t.apex), [15, 110]);
  });

  it('reads lines and a close as lines sharing their ends', () => {
    const r = read(svg100('<path d="M 0 0 L 10 0 L 10 10 Z"/>'));
    expect(r.kinds()).toEqual(['line', 'line', 'line']);
    expect(r.points).toHaveLength(3);
  });

  it('reads relative commands, H and V, and repeated coordinates', () => {
    const r = read(svg100('<path d="m10 10 10 0 v10 h-10 z"/>'));
    expect(r.kinds()).toEqual(['line', 'line', 'line', 'line']);
    expect(r.curves.map((c) => r.at(c.start))).toEqual([
      [10, 90],
      [20, 90],
      [20, 80],
      [10, 80],
    ]);
  });

  it('reads a round arc segment as an arc, counter-clockwise in the sketch', () => {
    // Sweep flag 1 runs clockwise on screen: once flipped, over the top from (0, 100) to (10, 100),
    // so the arc runs counter-clockwise from (10, 100) back to (0, 100).
    const r = read(svg100('<path d="M 0 0 A 5 5 0 0 1 10 0"/>'));
    const [a] = r.curves as [Json];
    expect(a.kind).toBe('arc');
    close(r.at(a.center), [5, 100]);
    expect(r.at(a.start)).toEqual([10, 100]);
    expect(r.at(a.end)).toEqual([0, 100]);
  });

  it('reads arc flags written without separators', () => {
    const r = read(svg100('<path d="M0 0a5 5 0 0010 0"/>'));
    const [a] = r.curves as [Json];
    expect(a.kind).toBe('arc');
    expect(r.at(a.start)).toEqual([0, 100]);
    expect(r.at(a.end)).toEqual([10, 100]);
  });

  it('reads a rotated elliptical arc segment as an elliptical arc', () => {
    const r = read(svg100('<path d="M 0 0 A 10 5 90 0 0 0 20"/>'));
    const [e] = r.curves as [Json];
    expect(e.kind).toBe('ellipticalArc');
    close(r.at(e.center), [0, 90]);
    close(r.at(e.majorEnd), [0, 100]);
    expect(e.minorRadius).toBeCloseTo(5, 9);
  });

  it('reports drawable elements it does not read and passes over metadata and other namespaces', () => {
    const result = importSvg(
      svg100(
        '<title>t</title><defs><circle r="3"/></defs><sodipodi:namedview/><text x="0" y="0">hi</text><image/><text/><line x1="0" y1="0" x2="1" y2="0"/>',
      ),
      make(),
    );
    expect([...result.skipped].sort()).toEqual(['image', 'text']);
    expect(imported(result).kinds()).toEqual(['line']);
  });

  it('reads nothing from a document that is not SVG', () => {
    expect(importSvg('<html><body/></html>', make()).change.add?.curves).toEqual([]);
    expect(importSvg('<svg><line', make()).change.add?.curves).toEqual([]);
  });
});

describe('importSvg into a sketch', () => {
  const art = svg100(
    '<path d="M 10 10 L 40 10 A 10 10 0 0 1 40 30 L 10 30 Z"/>' +
      '<path d="M 60 10 C 70 0 80 20 90 10 Q 95 20 90 30"/>' +
      '<path d="M 60 60 A 15 8 30 1 0 80 70"/>' +
      '<rect x="10" y="50" width="30" height="20" rx="3" ry="5"/>' +
      '<circle cx="20" cy="85" r="5"/><ellipse cx="50" cy="85" rx="10" ry="4" transform="rotate(20 50 85)"/>',
  );

  it('adds rows the format reads, and keeps kinds and coordinates through SVG export and import', () => {
    const { doc, part, feature } = sketchDocument();
    const editor = new Editor(doc, { ids: seededIds(7) });
    const { change } = importSvg(art, new RowMaker((kind) => editor.newId(kind)));
    const kinds = imported({ change, skipped: [] }).kinds();
    expect(new Set(kinds)).toEqual(new Set(['line', 'arc', 'bezier', 'conic', 'ellipticalArc', 'circle', 'ellipse']));
    const result = editor.dispatch({ type: 'editSketch', sketch: feature, add: change.add });
    expect(result.ok).toBe(true);
    expect(readsClean(editor)).toBe(true);

    const inputs = sketchInputs(editor.document, part, feature) as Json;
    const svg = sketchToSvg(new SketchGeometry(inputs, new ValueEvaluator(editor.document)));
    const back = imported(importSvg(svg, make()));
    // The exported drawing's bottom edge lands on the x axis: the round trip moves y alone.
    const before = described(inputs.points as Json[], inputs.curves as Json[]);
    const after = described(back.points, back.curves);
    const [p, q] = [before[0]?.points[0] as P2, after[0]?.points[0] as P2];
    expect(q[0]).toBeCloseTo(p[0], 9);
    sameCurves(before, after, [0, q[1] - p[1]], 6);
    expect(back.points).toHaveLength((inputs.points as Json[]).length);
  });
});
