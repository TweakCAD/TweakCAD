import { child } from './diagnostics';
import { readOperation } from './extrude';
import { discoverValues, registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { LENGTH, readAttachedFrame, value, type InputContext } from './shapes';
import type { Scope, ValueIndex } from './values';

/** Each specified shape's length inputs. */
const SHAPES: Record<string, readonly string[]> = {
  box: ['width', 'height', 'depth'],
  cylinder: ['radius', 'height'],
  sphere: ['radius'],
  cone: ['bottomRadius', 'topRadius', 'height'],
  torus: ['majorRadius', 'minorRadius'],
};

/** Shapes appendix A lists whose inputs are not specified yet. */
const UNSPECIFIED = ['wedge', 'prism', 'pyramid'];

/** `core.primitive` (appendix A), typeVersion 1. */
function readPrimitiveInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['shape', 'frame', 'operation'] });
  if (!o) return;
  const shape = r.union(o.shape, child(path, 'shape'), [...Object.keys(SHAPES), ...UNSPECIFIED]);
  const fields = shape && SHAPES[shape.tag];
  if (shape && fields) {
    const s = r.object(shape.payload, shape.path, { required: fields });
    if (s) for (const field of fields) value(c, s[field], child(shape.path, field), LENGTH);
  } else if (shape) {
    r.diagnostics.pause('unknown-variant', shape.path, `the inputs of a ${shape.tag} are not specified yet`);
    discoverValues(r, values, shape.payload, shape.path, scope);
  }
  readAttachedFrame(c, o.frame, child(path, 'frame'));
  readOperation(c, o.operation, child(path, 'operation'));
}

registerFeatureType('core.primitive', { versions: [1], readInputs: readPrimitiveInputs });
