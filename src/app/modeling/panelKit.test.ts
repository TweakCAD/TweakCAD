import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Actions, enterIsOk, PANEL_WIDTH, PanelCard, Select, WIDE_PANEL_WIDTH, XyzRow } from './panelKit';

const noop = () => undefined;

describe('panel layout', () => {
  it('gives every panel one width, and a wide one to a panel with a table', () => {
    const card = (wide: boolean) =>
      renderToStaticMarkup(createElement(PanelCard, { title: 'T', icon: null, onClose: noop, wide }, 'x'));
    expect(card(false)).toContain(`width:${PANEL_WIDTH}px`);
    expect(card(true)).toContain(`width:${WIDE_PANEL_WIDTH}px`);
  });

  it('keeps Cancel and OK in view while a tall panel scrolls', () => {
    const html = renderToStaticMarkup(createElement(Actions, { onCancel: noop, onOk: noop }));
    expect(html).toContain('position:sticky');
    expect(html).toContain('bottom:0');
  });

  it('lets X, Y and Z fields share the panel width rather than a fixed narrow one', () => {
    const html = renderToStaticMarkup(
      createElement(XyzRow, { label: 'Centre', values: ['-60', '0', '0'], onChange: noop }),
    );
    expect(html).not.toContain('width:44px');
    expect(html).toContain('width:100%');
  });

  it('lets a dropdown take the row rather than truncating at a fixed width', () => {
    const html = renderToStaticMarkup(
      createElement(Select, {
        label: 'Configuration',
        value: 'a',
        options: [{ id: 'a', label: "Component's own (M6)" }],
        onChange: noop,
      }),
    );
    expect(html).not.toContain('max-width:150px');
  });
});

describe('Enter in a panel', () => {
  /** A stand-in for an element: what closest() finds above it, by selector. */
  const element = (above: Record<string, { pressed?: boolean }>) =>
    ({
      closest: (sel: string) =>
        above[sel]
          ? { hasAttribute: (name: string) => name === 'aria-pressed' && above[sel]?.pressed !== undefined }
          : null,
    }) as unknown as EventTarget;

  it('is OK on a toggle button, a check box or a field that does not take it', () => {
    expect(enterIsOk(element({ button: { pressed: false } }), false)).toBe(true);
    expect(enterIsOk(element({}), false)).toBe(true);
  });

  it('leaves Cancel, OK and remove buttons, text areas, and fields that took it', () => {
    expect(enterIsOk(element({ button: {} }), false)).toBe(false);
    expect(enterIsOk(element({ textarea: {} }), false)).toBe(false);
    expect(enterIsOk(element({}), true)).toBe(false);
  });

  it('marks the OK button for it', () => {
    expect(renderToStaticMarkup(createElement(Actions, { onCancel: noop, onOk: noop }))).toMatch(
      /<button[^>]*data-panel-ok=""[^>]*>OK<\/button>/,
    );
  });
});
