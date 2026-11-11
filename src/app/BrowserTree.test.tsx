import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserTree,
  allowedEntries,
  bodyFeatureMenu,
  featureMenu,
  type BrowserBody,
  type BrowserTreeProps,
} from './BrowserTree';
import type { FeatureRow } from './features';
import { setAllOpen, toggleNode } from './treeOpen';

// The rows these tests read are inside nodes that start collapsed.
beforeEach(() => setAllOpen(true));

const row = (o: Partial<FeatureRow> & { id: string; type: string }): FeatureRow => ({
  name: o.id,
  iconKey: o.type.replace(/^core\./, ''),
  suppressed: false,
  frozen: false,
  status: 'success',
  hidden: false,
  children: [],
  ...o,
});

const none = () => undefined;

const BODY: BrowserBody = { key: 1, id: 'b1', name: 'Body 1', feature: 'feat_e', color: '#6699cc', visible: true };

function props(
  features: FeatureRow[],
  o: Partial<BrowserTreeProps> = {},
  bodies: BrowserBody[] = [BODY],
): BrowserTreeProps {
  return {
    documentName: 'Doc',
    parts: [{ id: 'part_1', name: 'Part', features, rollbackIndex: features.length, groups: [], bodies }],
    parameters: [{ id: 'par_1', name: 'width', value: '40 mm', text: '40 mm', configured: null }],
    onEditParameters: none,
    onSetConfiguration: none,
    onToggleFeatureVisible: none,
    onBodyAction: none,
    assemblies: [],
    selectedFeatures: new Set(),
    selectedKeys: new Set(),
    selectedStandard: new Set(),
    selectedDatums: new Set(),
    originShown: () => new Set(),
    onSetOriginShown: none,
    onSelectStandard: none,
    onSelectDatum: none,
    onSelectFeature: none,
    onSelectBody: none,
    onFeatureAction: none,
    onRenameFeature: none,
    renaming: null,
    onRenamingChange: none,
    ...o,
  };
}

describe('the browser', () => {
  it('marks a fully constrained sketch, and an under-constrained one with its degrees of freedom', () => {
    const html = renderToStaticMarkup(
      <BrowserTree
        {...props([
          row({ id: 'feat_a', type: 'core.sketch', dof: 0 }),
          row({ id: 'feat_b', type: 'core.sketch', dof: 3 }),
          row({ id: 'feat_e', type: 'core.extrude' }),
        ])}
      />,
    );
    // Each sketch shows once, in Sketches: the timeline is the bar at the bottom.
    expect(html.match(/aria-label="Fully constrained"/g)).toHaveLength(1);
    expect(html.match(/aria-label="Under-constrained, 3 DOF"/g)).toHaveLength(1);
  });

  it('shows no constraint mark on a sketch that paused', () => {
    const html = renderToStaticMarkup(
      <BrowserTree
        {...props([row({ id: 'feat_a', type: 'core.sketch', status: 'failed', message: 'does not solve' })])}
      />,
    );
    expect(html).not.toContain('constrained');
  });

  it('has the Parameters node with its edit gear, and an eye on the Origin and on each of its items', () => {
    const html = renderToStaticMarkup(<BrowserTree {...props([])} />);
    expect(html).toContain('aria-label="Edit parameters"');
    expect(html).toContain('width');
    expect(html).toContain('aria-label="Show origin"');
    for (const item of ['XY Plane', 'Z Axis', 'Origin Point']) expect(html).toContain(`aria-label="Show ${item}"`);
    const some = renderToStaticMarkup(<BrowserTree {...props([], { originShown: () => new Set(['xy', 'z']) })} />);
    expect(some).toContain('aria-label="Hide origin"');
    expect(some).toContain('aria-label="Hide XY Plane"');
    expect(some).toContain('aria-label="Hide Z Axis"');
    expect(some).toContain('aria-label="Show XZ Plane"');
  });

  it('has an eye on the Bodies of a part that hides them all, or shows them all when every one is hidden', () => {
    const two = [BODY, { ...BODY, key: 2, id: 'b2', name: 'Body 2' }];
    expect(renderToStaticMarkup(<BrowserTree {...props([], {}, two)} />)).toContain(
      'aria-label="Hide the bodies of Part"',
    );
    const oneHidden = two.map((b, i) => ({ ...b, visible: i === 0 }));
    expect(renderToStaticMarkup(<BrowserTree {...props([], {}, oneHidden)} />)).toContain(
      'aria-label="Hide the bodies of Part"',
    );
    const hidden = two.map((b) => ({ ...b, visible: false }));
    expect(renderToStaticMarkup(<BrowserTree {...props([], {}, hidden)} />)).toContain(
      'aria-label="Show the bodies of Part"',
    );
    expect(renderToStaticMarkup(<BrowserTree {...props([], {}, [])} />)).not.toContain('the bodies of Part');
  });
});

describe('the browser rows and menus', () => {
  it('offers New Part in its header when it can add one', () => {
    expect(renderToStaticMarkup(<BrowserTree {...props([])} />)).not.toContain('aria-label="New part"');
    expect(renderToStaticMarkup(<BrowserTree {...props([], { onNewPart: none })} />)).toContain(
      'aria-label="New part"',
    );
  });

  it('starts collapsed but for the document, and opens or closes every node at once', () => {
    setAllOpen(false);
    const top = renderToStaticMarkup(<BrowserTree {...props([])} />);
    expect(top).toContain('Part');
    expect(top).not.toContain('Origin');
    toggleNode('part_1');
    const part = renderToStaticMarkup(<BrowserTree {...props([])} />);
    expect(part).toContain('Origin');
    for (const label of ['XY Plane', 'X Axis', 'Origin Point']) expect(part).not.toContain(label);
    setAllOpen(true);
    const all = renderToStaticMarkup(<BrowserTree {...props([])} />);
    for (const label of ['XY Plane', 'X Axis', 'Origin Point']) expect(all).toContain(label);
    expect(all).toContain('aria-label="Expand all"');
    expect(all).toContain('aria-label="Collapse all"');
  });

  it('lists the assemblies before the parts', () => {
    const html = renderToStaticMarkup(
      <BrowserTree {...props([], { assemblies: [{ id: 'asm_1', name: 'Top assembly' }] })} />,
    );
    expect(html.indexOf('Top assembly')).toBeLessThan(html.indexOf('>Part<'));
  });

  it('marks the active part with its radio, and the whole design with the document radio', () => {
    const activating = { onActivatePart: none, activePart: 'part_1' };
    const html = renderToStaticMarkup(<BrowserTree {...props([], { ...activating, designActive: false })} />);
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*aria-label="Make Part active"/);
    expect(html).toMatch(/role="radio" aria-checked="false"[^>]*aria-label="Show the whole design"/);
    const design = renderToStaticMarkup(
      <BrowserTree {...props([], { ...activating, activePart: null, designActive: true })} />,
    );
    expect(design).toMatch(/role="radio" aria-checked="false"[^>]*aria-label="Make Part active"/);
    expect(design).toMatch(/role="radio" aria-checked="true"[^>]*aria-label="Show the whole design"/);
    // A document whose root is a part has no design radio: the part is the design.
    expect(renderToStaticMarkup(<BrowserTree {...props([], activating)} />)).not.toContain('Show the whole design');
  });

  it('lists derived components under Components, each with its eye, and says when there are none', () => {
    expect(renderToStaticMarkup(<BrowserTree {...props([])} />)).toContain('No components');
    const html = renderToStaticMarkup(
      <BrowserTree
        {...props([row({ id: 'feat_d', type: 'core.derive', name: 'Bracket 1', component: true })], {}, [
          { ...BODY, feature: 'feat_d' },
        ])}
      />,
    );
    expect(html).toContain('Components');
    expect(html).toContain('Bracket 1');
    expect(html).toContain('aria-label="Hide Bracket 1"');
    // Its only body hidden: the component shows hidden.
    const hidden = renderToStaticMarkup(
      <BrowserTree
        {...props([row({ id: 'feat_d', type: 'core.derive', name: 'Bracket 1' })], {}, [
          { ...BODY, feature: 'feat_d', visible: false },
        ])}
      />,
    );
    expect(hidden).toContain('aria-label="Show Bracket 1"');
  });

  it('draws an import that made several bodies as one closed node with an eye for all of them', () => {
    const imp = row({ id: 'feat_i', type: 'core.import', name: 'bracket.step' });
    const bodies = [
      { ...BODY, key: 2, id: 'b2', name: 'Body 2', feature: 'feat_i' },
      { ...BODY, key: 3, id: 'b3', name: 'Body 3', feature: 'feat_i' },
    ];
    setAllOpen(false);
    toggleNode('part_1');
    toggleNode('part_1/bodies');
    const html = renderToStaticMarkup(<BrowserTree {...props([imp], {}, bodies)} />);
    expect(html).toContain('bracket.step');
    expect(html).toContain('aria-label="Hide all bodies"');
    expect(html).not.toContain('Body 2');
    const hidden = renderToStaticMarkup(
      <BrowserTree
        {...props(
          [imp],
          {},
          bodies.map((b) => ({ ...b, visible: false })),
        )}
      />,
    );
    expect(hidden).toContain('aria-label="Show all bodies"');
  });

  it('gives each body of a feature that made several its own row, selected and hidden on its own', () => {
    const ext = row({ id: 'feat_x', type: 'core.extrude', name: 'Extrude 1' });
    const bodies = [
      BODY,
      { ...BODY, key: 5, id: 'b2', name: 'Body 2', feature: 'feat_x' },
      { ...BODY, key: 6, id: 'b3', name: 'Body 3', feature: 'feat_x', visible: false },
    ];
    const html = renderToStaticMarkup(<BrowserTree {...props([ext], { selectedKeys: new Set([5]) }, bodies)} />);
    for (const label of ['Hide Body 1', 'Hide Body 2', 'Show Body 3']) expect(html).toContain(`aria-label="${label}"`);
    // Only Body 2's row is selected.
    expect(html.match(/border-left:2px solid #1a6fd1/g)).toHaveLength(1);
    expect(html.indexOf('#1a6fd1')).toBeGreaterThan(html.indexOf('title="Body 1.'));
    expect(html.indexOf('#1a6fd1')).toBeLessThan(html.indexOf('title="Body 3.'));
  });

  it('lists a body the preview does not hold, and selects nothing for it', () => {
    const html = renderToStaticMarkup(
      <BrowserTree {...props([], { selectedKeys: new Set([-1]) }, [{ ...BODY, key: -1 }])} />,
    );
    expect(html).toContain('title="Body 1.');
    expect(html).not.toContain('#1a6fd1');
  });

  it('shows a feature that built but not as authored in amber, with the warning', () => {
    const html = renderToStaticMarkup(
      <BrowserTree
        {...props([
          row({ id: 'feat_p', type: 'core.constructionPlane', name: 'Plane 1', warning: 'replays its stored shape' }),
        ])}
      />,
    );
    expect(html).toContain('Plane 1 (Plane): replays its stored shape');
    expect(html).toContain('border-left:2px solid #d97706');
  });
});

describe('feature menus', () => {
  it('leaves out the rollback moves while the marker is fixed, and keeps the rest', () => {
    const menu = featureMenu(row({ id: 'feat_e', type: 'core.extrude' }), 0, 3, 3);
    expect(menu.map((e) => e.action)).toContain('rollHere');
    const locked = allowedEntries(menu, { readOnly: false, markerLocked: true }).map((e) => e.action);
    expect(locked).not.toContain('rollHere');
    expect(locked).not.toContain('rollEnd');
    expect(locked).toContain('editFeature');
    expect(allowedEntries(menu, { readOnly: false, markerLocked: false })).toHaveLength(menu.length);
  });

  it('offers Duplicate Component on every derive', () => {
    expect(
      featureMenu(row({ id: 'feat_d', type: 'core.derive', component: true }), 1, 2, 2).map((e) => e.action),
    ).toContain('duplicateComponent');
    expect(featureMenu(row({ id: 'feat_d', type: 'core.derive' }), 1, 2, 2).map((e) => e.action)).toContain(
      'duplicateComponent',
    );
    expect(featureMenu(row({ id: 'feat_e', type: 'core.extrude' }), 1, 2, 2).map((e) => e.action)).not.toContain(
      'duplicateComponent',
    );
  });

  it("gives a body's menu its feature's Edit Feature, Suppress and Delete", () => {
    const actions = (r: FeatureRow) => {
      const m = bodyFeatureMenu(r);
      return [...m.edit, ...m.state].map((e) => e.action);
    };
    expect(actions(row({ id: 'feat_e', type: 'core.extrude' }))).toEqual(['editFeature', 'suppress', 'delete']);
    expect(actions(row({ id: 'feat_e', type: 'core.extrude', suppressed: true }))).toEqual([
      'editFeature',
      'unsuppress',
      'delete',
    ]);
    expect(actions(row({ id: 'feat_e', type: 'core.extrude', frozen: true }))).toEqual(['suppress', 'delete']);
    expect(actions(row({ id: 'feat_d', type: 'core.derive', component: true }))).toEqual([
      'editComponent',
      'duplicateComponent',
      'suppress',
      'delete',
    ]);
    // An import has nothing to edit, and is not suppressed from its bodies.
    expect(actions(row({ id: 'feat_i', type: 'core.import' }))).toEqual(['delete']);
  });

  it('offers Extrude and Revolve on a sketch, and Edit Component on a derived component', () => {
    const sketch = featureMenu(row({ id: 'feat_a', type: 'core.sketch' }), 0, 2, 2).map((e) => e.action);
    expect(sketch.slice(0, 3)).toEqual(['editSketch', 'extrude', 'revolve']);
    expect(sketch).not.toContain('editComponent');
    const derive = featureMenu(row({ id: 'feat_d', type: 'core.derive', component: true }), 1, 2, 2).map(
      (e) => e.action,
    );
    expect(derive).toContain('editComponent');
    expect(featureMenu(row({ id: 'feat_d', type: 'core.derive' }), 1, 2, 2).map((e) => e.action)).not.toContain(
      'editComponent',
    );
  });

  it('offers Freeze on a feature that built, and Unfreeze instead of Edit Feature on a frozen one', () => {
    const live = featureMenu(row({ id: 'feat_e', type: 'core.extrude' }), 1, 2, 2).map((e) => e.action);
    expect(live).toContain('freeze');
    expect(live).toContain('editFeature');
    const frozen = featureMenu(row({ id: 'feat_e', type: 'core.extrude', frozen: true }), 1, 2, 2).map((e) => e.action);
    expect(frozen).toContain('unfreeze');
    expect(frozen).not.toContain('editFeature');
    expect(frozen).not.toContain('freeze');
    // Sketches are never frozen; a paused feature has nothing to store; nor has a feature inside a composite.
    expect(featureMenu(row({ id: 'feat_a', type: 'core.sketch' }), 0, 2, 2).map((e) => e.action)).not.toContain(
      'freeze',
    );
    expect(
      featureMenu(row({ id: 'feat_e', type: 'core.extrude', status: 'failed' }), 1, 2, 2).map((e) => e.action),
    ).not.toContain('freeze');
    expect(featureMenu(row({ id: 'feat_e', type: 'core.extrude' }), -1, 2, 2).map((e) => e.action)).not.toContain(
      'freeze',
    );
  });

  it('lists no timeline: features other than sketches and planes show only in the bar', () => {
    const html = renderToStaticMarkup(
      <BrowserTree {...props([row({ id: 'feat_e', type: 'core.extrude', name: 'Extrude 7' })])} />,
    );
    expect(html).not.toContain('Timeline');
    expect(html).not.toContain('Extrude 7');
  });

  it('leaves out every control that writes when the document is a read-only preview', () => {
    const features = [
      row({ id: 'feat_a', type: 'core.sketch', name: 'Sketch 1' }),
      row({ id: 'feat_e', type: 'core.extrude' }),
    ];
    const configured = (o: Partial<BrowserTreeProps>) => {
      const p = props(features, o);
      return {
        ...p,
        parts: p.parts.map((part) => ({ ...part, configuration: { options: ['Small', 'Large'], active: 'Small' } })),
      };
    };
    const editable = renderToStaticMarkup(<BrowserTree {...configured({})} />);
    expect(editable).toContain('aria-label="Edit parameters"');
    expect(editable).toContain('aria-label="Hide Sketch 1"');
    expect(editable).toContain('aria-label="Hide Body 1"');
    expect(editable).not.toMatch(/<select[^>]*disabled/);

    const html = renderToStaticMarkup(<BrowserTree {...configured({ readOnly: true })} />);
    expect(html).not.toContain('Edit parameters');
    expect(html).not.toContain('aria-label="Hide Sketch 1"');
    expect(html).not.toContain('aria-label="Hide Body 1"');
    expect(html).toMatch(/<select[^>]*disabled=""/);
    // Viewing stays: the rows. The origin's eyes write the document, so they go too.
    expect(html).toContain('Sketch 1');
    expect(html).toContain('Body 1');
    expect(html).not.toContain('aria-label="Show origin"');
    expect(html).not.toContain('the bodies of Part');
  });

  it('lists a parameter by its value now, marked with the configuration row that sets it', () => {
    const html = renderToStaticMarkup(
      <BrowserTree
        {...props([], {
          parameters: [
            { id: 'par_1', name: 'thread', value: '"M10"', text: '"M6"', configured: 'M10' },
            { id: 'par_2', name: 'd', value: '6 mm', text: '6 mm', configured: null },
          ],
        })}
      />,
    );
    expect(html).toContain('&quot;M10&quot;');
    expect(html.match(/aria-label="Set by configuration M10"/g)).toHaveLength(1);
  });
});
