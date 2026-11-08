import type { GcsWrapper } from '@salusoft89/planegcs';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConstraintGlyphs } from './ConstraintGlyphs';
import { DimensionLabels } from './DimensionLabels';
import { SketchBrowser } from './SketchBrowser';
import { ToolOptions } from './ToolOptions';
import { SketchPalette } from './SketchPalette';
import { openTestSession, rowsOf } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

const button = (html: string, label: string) =>
  new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';

describe('palette', () => {
  it('shows the tools with the active one pressed, and every constraint ready to choose before its geometry', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 12);
    t.session.setTool('select');
    t.session.select([rowsOf(t.inputs(), 'curves')[0]?.id as string]);
    const html = renderToStaticMarkup(<SketchPalette session={t.session} onFinish={() => undefined} />);
    for (const label of [
      'Select',
      'Line',
      'Rectangle',
      'Circle',
      '3-Point Arc',
      'Point',
      'Dimension',
      'Horizontal Dimension',
      'Vertical Dimension',
    ]) {
      expect(button(html, label), label).not.toBe('');
    }
    expect(button(html, 'Select')).toContain('aria-pressed="true"');
    expect(button(html, 'Line')).toContain('aria-pressed="false"');
    expect(button(html, 'Horizontal')).not.toContain('disabled');
    expect(button(html, 'Parallel')).not.toContain('disabled');
    expect(button(html, 'Parallel')).toContain('aria-pressed="false"');
    // The selected line carries its inferred horizontal constraint, listed for removal.
    expect(html).toContain('Delete constraint');
    // Its measures, under its name.
    expect(html).toMatch(
      />Line<\/div>.*>Start<\/span><span[^>]*>\(10\.0, 10\.0\)<.*>Length<\/span><span[^>]*>30\.0\d mm</,
    );
    expect(html).toContain('Finish Sketch');
    expect(html).not.toMatch(/coming soon|paused/i);
  });
});

describe('glyphs, browser and tool options', () => {
  it('shows a badge per constraint glyph, the rows with their measures, and the tool asking for its next click', () => {
    const t = openTestSession(gcs);
    t.session.setTool('rectangle');
    t.click(10, 10);
    t.click(40, 30);
    const glyphs = renderToStaticMarkup(
      <ConstraintGlyphs session={t.session} project={(p) => ({ x: p[0], y: -p[1] })} />,
    );
    expect(glyphs.match(/data-constraint=/g)).toHaveLength(4);
    const closed = renderToStaticMarkup(<SketchBrowser session={t.session} />);
    expect(closed).toContain('SKETCH BROWSER');
    expect(closed).toContain('aria-label="Under-constrained · 4 DOF"');
    expect(closed).not.toContain('Line 1');
    const browser = renderToStaticMarkup(<SketchBrowser session={t.session} startCollapsed={false} />);
    expect(browser).toContain('SKETCH BROWSER');
    expect(browser).toContain('4 degrees of freedom');
    expect(browser).toContain('Line 1');
    expect(browser).toContain('30 mm');
    expect(browser.match(/>Horizontal</g)).toHaveLength(2);
    // Each constraint row names what it holds.
    expect(browser).toMatch(/>Horizontal<span[^>]*> · Line 1</);
    expect(browser).toMatch(/>Vertical<span[^>]*> · Line 2</);
    expect(t.session.underDefinedHint()).toBe(
      'Sketch under-constrained: 4 DOF remaining. Undimensioned: Line 1, Line 2, Line 3, Line 4.',
    );
    t.session.setTool('dimension');
    t.click(25, 10);
    t.click(25, 0);
    t.session.clearEditing();
    expect(t.session.underDefinedHint()).toBe(
      'Sketch under-constrained: 3 DOF remaining. Undimensioned: Line 2, Line 3, Line 4.',
    );
    // A fixed point's row gives its coordinates.
    t.session.select([rowsOf(t.inputs(), 'points')[0]?.id as string]);
    expect(t.session.applyConstraint('fix').ok).toBe(true);
    expect(t.session.browse().constraints.at(-1)).toMatchObject({ label: 'Fix', sub: '(10.0, 10.0)' });
    t.session.setTool('offset');
    const options = renderToStaticMarkup(<ToolOptions session={t.session} />);
    expect(options).toContain('Click a curve on the side to offset to');
    expect(options).toMatch(/aria-label="Distance"[^>]*value="5"/);
    // The Offset dialog: its direction, and OK waiting for a curve.
    expect(options).toContain('aria-label="Direction"');
    expect(options).toMatch(/<button[^>]*disabled=""[^>]*>OK<\/button>/);
    t.session.setSettings({ offsetDirection: 'two' });
    expect(renderToStaticMarkup(<ToolOptions session={t.session} />)).toContain('aria-label="Distance 2"');
    t.session.setTool('select');
    expect(renderToStaticMarkup(<ToolOptions session={t.session} />)).toBe('');
  });
});

describe('dimension labels', () => {
  it('opens a dimension just placed for editing, and shows the others as buttons', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 10);
    t.session.setTool('dimension');
    t.click(25, 10);
    t.click(25, 0);
    const render = () =>
      renderToStaticMarkup(<DimensionLabels session={t.session} project={(p) => ({ x: p[0], y: -p[1] })} />);
    // The value without its unit, the unit beside the field.
    expect(render()).toMatch(/<input[^>]*aria-label="Dimension value"[^>]*value="30"[^>]*\/><span[^>]*>mm<\/span>/);
    t.session.clearEditing();
    expect(render()).toContain('>30 mm</button>');
    expect(render()).not.toContain('Driven dimension');
  });
});
