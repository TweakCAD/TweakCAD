/**
 * Bodies read from a file's B-rep streams written as one STEP file (AP214, in
 * millimetres), so the kernel's STEP reader makes the solids: it also adds what
 * the stream leaves implicit, such as seam edges on closed faces and the curves
 * of edges in each face's parameters.
 */
import type { BodyCurve, BodySurface, ReadBody, Vec3 } from './parser/asmBodies';

/** A real as STEP writes it: always with a decimal point. */
function real(x: number): string {
  if (!Number.isFinite(x)) throw new Error('a value is not finite');
  if (Object.is(x, -0) || x === 0) return '0.';
  const s = String(x).toUpperCase();
  if (s.includes('.')) return s;
  const e = s.indexOf('E');
  return e < 0 ? `${s}.` : `${s.slice(0, e)}.${s.slice(e)}`;
}

const list = (xs: readonly string[]): string => `(${xs.join(',')})`;
const flag = (b: boolean): string => (b ? '.T.' : '.F.');

class Writer {
  private readonly lines: string[] = [];
  private n = 0;

  add(entity: string): string {
    this.n++;
    this.lines.push(`#${this.n}=${entity};`);
    return `#${this.n}`;
  }

  point(p: Vec3): string {
    return this.add(`CARTESIAN_POINT('',${list(p.map(real))})`);
  }

  direction(d: Vec3): string {
    return this.add(`DIRECTION('',${list(d.map(real))})`);
  }

  placement(origin: Vec3, axis: Vec3, x: Vec3): string {
    // The reference direction must not lean on the axis: take its part across it.
    const dot = x[0] * axis[0] + x[1] * axis[1] + x[2] * axis[2];
    let r: Vec3 = [x[0] - dot * axis[0], x[1] - dot * axis[1], x[2] - dot * axis[2]];
    const len = Math.hypot(...r);
    if (len < 1e-9) {
      const other: Vec3 = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      const d = other[0] * axis[0] + other[1] * axis[1] + other[2] * axis[2];
      r = [other[0] - d * axis[0], other[1] - d * axis[1], other[2] - d * axis[2]];
    }
    const l = Math.hypot(...r);
    r = [r[0] / l, r[1] / l, r[2] / l];
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.direction(axis)},${this.direction(r)})`);
  }

  text(): string {
    return this.lines.join('\n');
  }
}

function surface(w: Writer, s: BodySurface): string {
  switch (s.kind) {
    case 'plane':
      return w.add(`PLANE('',${w.placement(s.origin, s.normal, s.x)})`);
    case 'cylinder':
      return w.add(`CYLINDRICAL_SURFACE('',${w.placement(s.origin, s.axis, s.x)},${real(s.radius)})`);
    case 'cone':
      return w.add(`CONICAL_SURFACE('',${w.placement(s.origin, s.axis, s.x)},${real(s.radius)},${real(s.semiAngle)})`);
    case 'sphere':
      return w.add(`SPHERICAL_SURFACE('',${w.placement(s.origin, s.axis, s.x)},${real(s.radius)})`);
    case 'torus':
      return w.add(`TOROIDAL_SURFACE('',${w.placement(s.origin, s.axis, s.x)},${real(s.major)},${real(s.minor)})`);
    case 'ellipticCylinder':
      throw new Error('an elliptical cylinder is written as its B-spline');
    case 'bspline': {
      const grid = list(s.poles.map((row) => list(row.map((p) => w.point(p)))));
      const knots = `${list(s.uMults.map(String))},${list(s.vMults.map(String))},${list(s.uKnots.map(real))},${list(s.vKnots.map(real))},.UNSPECIFIED.`;
      if (!s.weights)
        return w.add(
          `B_SPLINE_SURFACE_WITH_KNOTS('',${s.uDegree},${s.vDegree},${grid},.UNSPECIFIED.,.F.,.F.,.F.,${knots})`,
        );
      const weights = list(s.weights.map((row) => list(row.map(real))));
      return w.add(
        `(BOUNDED_SURFACE()B_SPLINE_SURFACE(${s.uDegree},${s.vDegree},${grid},.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS(${knots})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${weights})REPRESENTATION_ITEM('')SURFACE())`,
      );
    }
  }
}

function curve(w: Writer, c: BodyCurve): string {
  switch (c.kind) {
    case 'line':
      return w.add(`LINE('',${w.point(c.origin)},${w.add(`VECTOR('',${w.direction(c.direction)},1.)`)})`);
    case 'circle':
      return w.add(`CIRCLE('',${w.placement(c.origin, c.axis, c.x)},${real(c.radius)})`);
    case 'ellipse': {
      if (c.minor <= c.major)
        return w.add(`ELLIPSE('',${w.placement(c.origin, c.axis, c.x)},${real(c.major)},${real(c.minor)})`);
      // The first semi-axis is the longer: start a quarter turn on, the same way round.
      const [a, b, d] = c.axis;
      const [x, y, z] = c.x;
      const across: Vec3 = [b * z - d * y, d * x - a * z, a * y - b * x];
      return w.add(`ELLIPSE('',${w.placement(c.origin, c.axis, across)},${real(c.minor)},${real(c.major)})`);
    }
    case 'bspline': {
      const poles = list(c.poles.map((p) => w.point(p)));
      const knots = `${list(c.mults.map(String))},${list(c.knots.map(real))},.UNSPECIFIED.`;
      if (!c.weights) return w.add(`B_SPLINE_CURVE_WITH_KNOTS('',${c.degree},${poles},.UNSPECIFIED.,.F.,.F.,${knots})`);
      return w.add(
        `(BOUNDED_CURVE()B_SPLINE_CURVE(${c.degree},${poles},.UNSPECIFIED.,.F.,.F.)B_SPLINE_CURVE_WITH_KNOTS(${knots})CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE(${list(c.weights.map(real))})REPRESENTATION_ITEM(''))`,
      );
    }
  }
}

/** The solids of `bodies` as the text of one STEP file. */
export function writeStep(bodies: readonly ReadBody[], name = 'bodies'): string {
  const w = new Writer();
  const context = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${context})`);
  const productContext = w.add(`PRODUCT_CONTEXT('',${context},'mechanical')`);
  const product = w.add(`PRODUCT('${name}','${name}','',(${productContext}))`);
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definitionContext = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${context},'design')`);
  const definition = w.add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const shape = w.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  const length = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angle = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solidAngle = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const uncertainty = w.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),${length},'distance_accuracy_value','')`,
  );
  const geometric = w.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle}))REPRESENTATION_CONTEXT('',''))`,
  );

  const items: string[] = [];
  for (const body of bodies) {
    const vertices = body.vertices.map((p) => w.add(`VERTEX_POINT('',${w.point(p)})`));
    const edges = body.edges.map((e) =>
      w.add(
        `EDGE_CURVE('',${vertices[e.start] as string},${vertices[e.end] as string},${curve(w, e.curve)},${flag(e.sameSense)})`,
      ),
    );
    for (const solid of body.solids) {
      const shells = solid.shells.map((faces) => {
        const refs = faces.map((f) => {
          const bounds = f.loops.map((loop) => {
            const l =
              'vertex' in loop
                ? w.add(`VERTEX_LOOP('',${vertices[loop.vertex] as string})`)
                : w.add(
                    `EDGE_LOOP('',${list(loop.edges.map((u) => w.add(`ORIENTED_EDGE('',*,*,${edges[u.edge] as string},${flag(u.forward)})`)))})`,
                  );
            return w.add(`FACE_BOUND('',${l},.T.)`);
          });
          return w.add(`ADVANCED_FACE('',${list(bounds)},${surface(w, f.surface)},${flag(f.sameSense)})`);
        });
        return w.add(`CLOSED_SHELL('',${list(refs)})`);
      });
      const [outer, ...voids] = shells as [string, ...string[]];
      items.push(
        voids.length === 0
          ? w.add(`MANIFOLD_SOLID_BREP('',${outer})`)
          : w.add(
              `BREP_WITH_VOIDS('',${outer},${list(voids.map((v) => w.add(`ORIENTED_CLOSED_SHELL('',*,${v},.F.)`)))})`,
            ),
      );
    }
  }
  const representation = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',${list(items)},${geometric})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION(('stored bodies'),'2;1');`,
    `FILE_NAME('${name}.stp','',(''),(''),'','','');`,
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));`,
    'ENDSEC;',
    'DATA;',
    w.text(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
