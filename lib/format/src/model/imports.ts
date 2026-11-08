import { child } from './diagnostics';
import { registerFeatureType } from './features';
import type { Json, Reader } from './reader';
import { choice, value, type InputContext } from './shapes';
import { assetUse, readStoredShape } from './storage';
import type { Scope, ValueIndex } from './values';

/** `core.import` (13.3), typeVersion 1. */
function readImportInputs(r: Reader, values: ValueIndex, inputs: Json, path: string, scope: Scope): void {
  const c: InputContext = { r, values, scope };
  const o = r.object(inputs, path, { required: ['source', 'stored', 'importer', 'units', 'upAxis'] });
  if (!o) return;
  const source = r.union(o.source, child(path, 'source'), ['file', 'kept']);
  if (source?.tag === 'file') {
    const f = r.object(source.payload, source.path, { required: ['asset'] });
    if (f) assetUse(r, f.asset, child(source.path, 'asset'));
  } else if (source) r.object(source.payload, source.path, { required: [] });
  readStoredShape(r, o.stored, child(path, 'stored'));
  const imp = r.object(o.importer, child(path, 'importer'), { required: ['format', 'version'] });
  if (imp) {
    r.string(imp.format, child(path, 'importer/format'));
    r.string(imp.version, child(path, 'importer/version'));
  }
  value(c, o.units, child(path, 'units'), choice('mm', 'cm', 'm', 'um', 'in', 'ft'));
  value(c, o.upAxis, child(path, 'upAxis'), choice('y', 'z'));
}

registerFeatureType('core.import', { versions: [1], readInputs: readImportInputs });
