import type { GcsWrapper } from '@salusoft89/planegcs';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLORS } from './draw';
import { openTestSession, rowsOf } from './testKit';
import { loadTestSolver } from './testSetup';

let gcs: GcsWrapper;
beforeAll(async () => {
  gcs = await loadTestSolver();
});

function drawn(group: THREE.Group) {
  const root = group.children[0] as THREE.Group;
  const lines = root.children.filter((o): o is Line2 => o instanceof Line2);
  return {
    root,
    lines,
    colors: lines.map((l) => (l.material as LineMaterial).color.getHex()),
    dashed: lines.filter((l) => (l.material as LineMaterial).dashed).length,
    points: root.children
      .filter((o) => o instanceof THREE.Points)
      .reduce((n, o) => n + ((o as THREE.Points).geometry.getAttribute('position')?.count ?? 0), 0),
    regions: root.children.filter((o) => o instanceof THREE.Mesh && !(o instanceof Line2)).length,
    sprites: root.children.filter((o) => o instanceof THREE.Sprite).length,
    names: root.children.filter((o) => o instanceof THREE.Sprite).map((o) => o.name),
  };
}

describe('drawing', () => {
  it('draws curves, points and regions in the frame; selection and construction show; glyphs are anchored for the overlay', () => {
    const t = openTestSession(gcs);
    t.session.setTool('rectangle');
    t.click(10, 10);
    t.click(50, 30);
    let d = drawn(t.host.group);
    expect(d.colors).toEqual([COLORS.line, COLORS.line, COLORS.line, COLORS.line]);
    // Four corners and the origin's marker.
    expect(d.points).toBe(5);
    expect(d.regions).toBe(1);
    // Glyphs are not sprites: one anchor per horizontal and vertical constraint, for the overlay.
    expect(d.sprites).toBe(0);
    expect(
      t.session
        .glyphs()
        .map((g) => g.symbol)
        .sort(),
    ).toEqual(['H', 'H', 'V', 'V']);
    expect(t.host.renders).toBeGreaterThan(0);

    const first = rowsOf(t.inputs(), 'curves')[0]?.id as string;
    t.session.select([first]);
    t.key('x');
    t.session.select([first]);
    d = drawn(t.host.group);
    expect(d.colors[0]).toBe(COLORS.selected);
    t.session.clearSelection();
    d = drawn(t.host.group);
    expect(d.dashed).toBe(1);
    // The construction side bounds nothing, so no region is closed.
    expect(d.regions).toBe(0);

    t.session.setOptions({ construction: false, constraints: false, profile: false });
    d = drawn(t.host.group);
    expect(d.lines).toHaveLength(3);
    expect(t.session.glyphs()).toHaveLength(0);
  });

  it('shades a picked region, and a constraint row hovered in the browser lights its geometry', () => {
    const t = openTestSession(gcs);
    t.session.setTool('rectangle');
    t.click(10, 10);
    t.click(50, 30);
    t.session.setTool('select');
    const fill = () => {
      const mesh = drawn(t.host.group).root.children.find(
        (o) => o instanceof THREE.Mesh && !(o instanceof Line2),
      ) as THREE.Mesh;
      return (mesh.material as THREE.MeshBasicMaterial).color.getHex();
    };
    expect(fill()).toBe(COLORS.region);
    t.move(30, 20);
    expect(fill()).toBe(COLORS.regionHovered);
    t.click(30, 20);
    expect(fill()).toBe(COLORS.regionSelected);

    const [first] = rowsOf(t.inputs(), 'curves');
    const horizontal = rowsOf(t.inputs(), 'constraints').find((c) => JSON.stringify(c).includes(first?.id as string));
    t.session.highlight(horizontal?.id as string);
    expect(drawn(t.host.group).colors).toEqual([COLORS.hovered, COLORS.line, COLORS.line, COLORS.line]);
  });

  it('previews the tool in progress with a snap marker, and the inferred constraint', () => {
    const t = openTestSession(gcs);
    t.session.setTool('line');
    t.click(10, 10);
    t.move(40, 10.5);
    const d = drawn(t.host.group);
    expect(d.colors).toContain(COLORS.preview);
    expect(d.names).toEqual(['hint']);
    // On the x axis: the axis snap's marker, and no hint for a line that is not near horizontal.
    t.move(40, 0.2);
    expect(drawn(t.host.group).names).toEqual(['snap']);
    t.move(40.4, 40.3);
    expect(drawn(t.host.group).names).toEqual([]);
  });

  it('places the drawing and the labels by the sketch frame', () => {
    // The xz plane lifted 5 mm along its normal +Y: sketch x along part X, sketch y along part −Z.
    const frame = { origin: [0, 5, 0], x: [1, 0, 0], y: [0, 0, -1], normal: [0, 1, 0] } as const;
    const t = openTestSession(gcs, undefined, undefined, undefined, {
      origin: [...frame.origin],
      x: [...frame.x],
      y: [...frame.y],
      normal: [...frame.normal],
    });
    const root = t.host.group.children[0] as THREE.Group;
    expect(new THREE.Vector3(10, 20, 0).applyMatrix4(root.matrix).toArray()).toEqual([10, 5, -20]);
    t.session.setTool('line');
    t.click(10, 10);
    t.click(40, 50);
    t.session.setTool('dimension');
    t.click(25, 30);
    t.click(30, 60);
    expect(t.session.labels()[0]?.at).toEqual([30, 5, -60]);
  });

  it('gives up its drawing on dispose', () => {
    const t = openTestSession(gcs);
    expect(t.host.group.children).toHaveLength(1);
    t.session.dispose();
    expect(t.host.group.children).toHaveLength(0);
  });
});
