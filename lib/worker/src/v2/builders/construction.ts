/** Construction features (chapter 15): an attached frame given out as a plane, axis, point or frame. */
import { ladderOf } from '@tweakcad/format';
import { registerBuilder, type ConstructionOutput, type Json } from '../context';
import { frameOf } from '../places';

const TYPES: Record<string, ConstructionOutput['kind']> = {
  'core.constructionPlane': 'plane',
  'core.constructionAxis': 'axis',
  'core.constructionPoint': 'point',
  'core.constructionFrame': 'frame',
};

for (const [type, kind] of Object.entries(TYPES)) {
  registerBuilder(type, ({ ev, part, inputs, id }) => {
    const frame = frameOf({ ev, part }, inputs.frame as Json);
    const ladder = ladderOf({ kind, chain: [], feature: id, role: kind, src: [] }, ev.names);
    part.construction.set(id, { kind, frame, ladder });
  });
}
