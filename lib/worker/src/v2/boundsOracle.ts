/**
 * For the extrude suites: a build whose extrudes take loose boxes for their
 * reach must name and measure every entity as the same build on precise
 * boxes does. `preciseBuild` evaluates a document with every bounding box
 * the kernel is asked for made precise, and `entityPrints` lists what a
 * build holds, keys left out, for comparing the two.
 */
import { canonicalize, type JsonValue } from '@tweakcad/format';
import type { OcctKernel } from 'occt-wasm';
import { evaluateDocument, type EvaluateOptions, type Evaluation } from './evaluate';
import type { Json } from './context';

/** `doc` evaluated with every box precise, whatever the builders ask for. */
export function preciseBuild(doc: Json, k: OcctKernel, options: EvaluateOptions = {}): Evaluation {
  const loose = k.getBoundingBox.bind(k);
  const target = k as unknown as {
    getBoundingBox: (h: Parameters<OcctKernel['getBoundingBox']>[0]) => ReturnType<OcctKernel['getBoundingBox']>;
  };
  target.getBoundingBox = (h) => loose(h);
  try {
    return evaluateDocument(doc, k, options);
  } finally {
    delete (target as { getBoundingBox?: unknown }).getBoundingBox;
  }
}

const round = (_: string, v: unknown) => (typeof v === 'number' ? Number(v.toFixed(6)) : v);

/** Every entity of every part as its names, lineage and measures give it, sorted, with the pauses. */
export function entityPrints(ev: Evaluation): string[] {
  const out: string[] = [];
  for (const [id, part] of ev.parts) {
    for (const e of part.state.entities.values()) {
      out.push(
        `${id} ${JSON.stringify(
          {
            kind: e.kind,
            ladder: e.ladder,
            branch: canonicalize(e.branch as unknown as JsonValue),
            aliases: canonicalize(e.aliases as unknown as JsonValue),
            createdBy: e.createdBy,
            measures: ev.adapter.measures(e.key),
          },
          round,
        )}`,
      );
    }
    out.push(`${id} bodies ${part.shapes.size}`);
  }
  out.push(...ev.pauses.map((p) => `pause ${p.feature} ${p.message}`));
  return out.sort();
}
