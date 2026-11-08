import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { featureRange, TimelineBar, type TimelineFeature } from './TimelineBar';

const chip = (id: string, o: Partial<TimelineFeature> = {}): TimelineFeature => ({
  id,
  name: id,
  type: 'extrude',
  enabled: true,
  ...o,
});

describe('the timeline bar', () => {
  it('rings every selected feature', () => {
    const html = renderToStaticMarkup(
      <TimelineBar features={[chip('a'), chip('b'), chip('c')]} selectedFeatureIds={new Set(['a', 'c'])} />,
    );
    expect(html.match(/box-shadow:0 0 0 1px #1a6fd1/g)).toHaveLength(2);
  });

  it('marks a frozen feature in its tooltip', () => {
    const html = renderToStaticMarkup(<TimelineBar features={[chip('a', { frozen: true })]} />);
    expect(html).toContain('Frozen');
  });

  it('offers to open a composite, and shows a group as one chip until opened', () => {
    const composite = chip('comp', { name: 'Imported', children: [chip('inner')] });
    const html = renderToStaticMarkup(
      <TimelineBar
        features={[composite, chip('g1'), chip('g2')]}
        groups={[{ id: 'grp', name: 'Holes', members: ['g1', 'g2'] }]}
      />,
    );
    expect(html).toContain('aria-label="Open Imported"');
    expect(html).not.toContain('data-feature-chip="inner"');
    expect(html).toContain('Holes (2 features)');
    expect(html).not.toContain('data-feature-chip="g1"');
  });

  it('tags each top-level chip with the timeline index it starts at, for the rollback marker', () => {
    const html = renderToStaticMarkup(
      <TimelineBar
        features={[chip('a'), chip('g1'), chip('g2'), chip('d')]}
        groups={[{ id: 'grp', name: 'G', members: ['g1', 'g2'] }]}
        rollbackIndex={3}
      />,
    );
    expect([...html.matchAll(/data-slot-index="(\d+)"/g)].map((m) => m[1])).toEqual(['0', '1', '3']);
  });

  it('disables the rollback controls on a read-only preview', () => {
    const nav = (html: string) =>
      [...html.matchAll(/<button[^>]*title="(To start|Step back|Step forward|To end)"[^>]*>/g)].map((m) =>
        / disabled=""/.test(m[0]),
      );
    const features = [chip('a'), chip('b'), chip('c')];
    expect(nav(renderToStaticMarkup(<TimelineBar features={features} rollbackIndex={1} />))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(nav(renderToStaticMarkup(<TimelineBar features={features} rollbackIndex={1} readOnly />))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('while a panel edits a feature, rolls back the chips after it and locks the controls', () => {
    const features = [chip('a'), chip('b'), chip('c'), chip('d')];
    const dimmed = (html: string) =>
      [...html.matchAll(/<button[^>]*data-feature-chip="(\w)"[^>]*>/g)]
        .filter((m) => /opacity:0\.4/.test(m[0]))
        .map((m) => m[1]);
    const nav = (html: string) =>
      [...html.matchAll(/<button[^>]*title="(To start|Step back|Step forward|To end)"[^>]*>/g)].map((m) =>
        / disabled=""/.test(m[0]),
      );
    const stored = renderToStaticMarkup(<TimelineBar features={features} rollbackIndex={4} />);
    expect(dimmed(stored)).toEqual([]);
    expect(stored).toContain('4/4');
    // Editing b: the marker is shown just after it.
    const editing = renderToStaticMarkup(<TimelineBar features={features} rollbackIndex={2} markerLocked />);
    expect(dimmed(editing)).toEqual(['c', 'd']);
    expect(editing).toContain('2/4');
    expect(nav(editing)).toEqual([true, true, true, true]);
  });
});

describe('a shift-click range on the timeline', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('runs from the last chip clicked to this one, either way, in timeline order', () => {
    expect(featureRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(featureRange(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(featureRange(order, 'c', 'c')).toEqual(['c']);
    expect(featureRange(order, 'x', 'c')).toBeNull();
  });
});
