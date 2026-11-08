/**
 * `core.pattern` (appendix A): copies of bodies, or of features' tools, at the
 * slots of a linear or circular layout, each from the seed in one motion and
 * named with its slot (9.5). The seed is slot 0, so changing a count keeps the
 * other slots; the copies on a symmetric direction's other side take
 * negative slots.
 */
import { startFeature } from '@tweakcad/format';
import {
  ANGLE,
  FLAG,
  FeaturePause,
  INTEGER,
  LENGTH,
  add,
  registerBuilder,
  scale,
  type BuildContext,
  type Json,
} from '../context';
import { axisOf, directionOf } from '../places';
import { circularTurns, sideIndices } from '../layoutSlots';
import { applyToCopies, copyByMotion, sourcesOf, type Motion } from '../copies';
import { applyFeatureCopies, featureTools, motionMaps } from '../featureCopies';
import type { Live } from '../operation';

interface Slot {
  i: number;
  j: number;
  motion: Motion;
}

function countOf(ctx: BuildContext, count: unknown): number {
  const n = ctx.ev.values.literal(count, INTEGER) as number;
  if (n < 1) throw new FeaturePause('a pattern counts at least its seed');
  return n;
}

/** Every copy of a linear layout, indices from the seed at 0 along each direction, the seed left out. */
function linearSlots(ctx: BuildContext, layout: Json): Slot[] {
  const { values } = ctx.ev;
  const rows = (layout.directions as Json[]).map((row) => {
    const spacing = row.spacing as Json;
    if (!('equal' in spacing)) throw new FeaturePause('listed spacing is not built yet');
    const s = values.number((spacing.equal as Json).s, LENGTH);
    const symmetric = row.symmetric !== undefined && values.literal(row.symmetric, FLAG) === true;
    return {
      step: scale(directionOf(ctx, row.direction as Json), s),
      indices: sideIndices(countOf(ctx, row.count), symmetric),
    };
  });
  const [first, second] = rows as [(typeof rows)[number], (typeof rows)[number] | undefined];
  const slots: Slot[] = [];
  for (const i of first.indices) {
    for (const j of second?.indices ?? [0]) {
      if (i === 0 && j === 0) continue;
      const shift = add(scale(first.step, i), second ? scale(second.step, j) : [0, 0, 0]);
      slots.push({ i, j, motion: { shift } });
    }
  }
  return slots;
}

/**
 * Every copy of a circular layout. One-sided, `angle` is the sweep from the
 * seed: a full turn spaces the copies evenly around it and anything less
 * puts the last at `angle`; symmetric, it is the whole spread both ways.
 */
function circularSlots(ctx: BuildContext, layout: Json): Slot[] {
  const { values } = ctx.ev;
  const symmetric = values.literal(layout.symmetric, FLAG) === true;
  const turns = circularTurns(countOf(ctx, layout.count), values.number(layout.angle, ANGLE), symmetric);
  const axis = axisOf(ctx, layout.axis as Json);
  return turns
    .filter((t) => t.i !== 0)
    .map(({ i, degrees }) => ({ i, j: 0, motion: { turn: { ...axis, radians: (degrees * Math.PI) / 180 } } }));
}

export function slotsOf(ctx: BuildContext, layout: Json): Slot[] {
  if ('linear' in layout) return linearSlots(ctx, layout.linear as Json);
  if ('circular' in layout) return circularSlots(ctx, layout.circular as Json);
  throw new FeaturePause('path layouts are not built yet');
}

registerBuilder('core.pattern', (ctx) => {
  const { inputs, id, ordinal } = ctx;
  const { adapter, names } = ctx.ev;
  if ((inputs.vary as Json[]).length > 0) throw new FeaturePause('patterns with per-copy overrides are not built yet');
  const skip = new Set(
    ((inputs.skip as Json).set as Json[]).map((key) => {
      const { i, j } = key.slot as { i: number; j: number };
      return `${i},${j}`;
    }),
  );
  if (skip.has('0,0')) throw new FeaturePause('the seed of a pattern is its source and cannot be skipped');
  const slots = slotsOf(ctx, inputs.layout as Json).filter((s) => !skip.has(`${s.i},${s.j}`));

  const namer = startFeature(ctx.part.state, { feature: id, ordinal }, adapter, names);

  const of = inputs.of as Json;
  if ('features' in of) {
    // Each feature's own operation applies; the pattern's `operation` is not used.
    const from = featureTools(ctx, of, 'patterns');
    const copies = from.tools.flatMap((tool) =>
      slots.map(({ i, j, motion }) => {
        const step = { op: { id }, key: { slot: { i, j } } };
        return {
          live: copyByMotion(ctx, namer, tool, motion, step, tool.names),
          feature: tool.feature,
          step,
          ...motionMaps(motion),
        };
      }),
    );
    applyFeatureCopies(ctx, namer, copies, from);
    return;
  }
  const sources = sourcesOf(ctx, namer, inputs.of as Json, 'patterns');
  const copies: Live[] = [];
  for (const source of sources) {
    for (const { i, j, motion } of slots) {
      copies.push(copyByMotion(ctx, namer, source, motion, { op: { id }, key: { slot: { i, j } } }));
    }
  }
  applyToCopies(ctx, namer, copies, inputs.operation as Json);
});
