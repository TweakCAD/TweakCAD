/**
 * What a regression fixture is checked against: each part's and each
 * assembly's bodies (volume, bounding box, face and edge counts), the
 * cosmetic threads, and the exact list of pauses. Numbers are rounded so a
 * summary is stable text; a comparison allows a tolerance on top.
 */
import type { NamedEntity } from '@tweakcad/format';
import type { Evaluation, Json } from './context';

export interface BodySummary {
  volume: number;
  min: number[];
  max: number[];
  faces: number;
  edges: number;
}

export interface OwnerSummary {
  name: string;
  bodies: BodySummary[];
  /** Cosmetic threads by designation and class, sorted. */
  threads: string[];
}

export interface FixtureSummary {
  parts: OwnerSummary[];
  assemblies: (OwnerSummary & { instances: number })[];
  /** Every pause and stale report: the feature's name and the message, sorted. */
  pauses: string[];
}

const round = (x: number, digits = 4) => {
  const r = Number(x.toFixed(digits));
  return Object.is(r, -0) ? 0 : r;
};

/** Orders two points by x, then y, then z. */
const compare = (a: readonly number[], b: readonly number[]) =>
  a.map((c, i) => c - (b[i] as number)).find((d) => d !== 0) ?? 0;

function bodiesOf(ev: Evaluation, result: { state: { entities: ReadonlyMap<unknown, NamedEntity> } }): BodySummary[] {
  const bodies = [...result.state.entities.values()].filter((e) => e.kind === 'body');
  return bodies
    .map((b) => {
      const measured = ev.adapter.measures(b.key);
      const [min, max] = measured.bbox as unknown as [number[], number[]];
      const solid = ev.adapter.topology(b.body).solids.find((s) => s.solid === b.key);
      const faces = new Set(solid?.faces ?? []);
      const edges = ev.adapter.topology(b.body).edges.filter((e) => e.faces.some((f) => faces.has(f.face))).length;
      return {
        volume: round(measured.volume as number, 3),
        min: min.map((c) => round(c, 3)),
        max: max.map((c) => round(c, 3)),
        faces: faces.size,
        edges,
      };
    })
    .sort((a, b) => a.volume - b.volume || compare(a.min, b.min));
}

/** The feature (or row) names of a document by id, for pause lines that read without ids. */
function namesById(doc: Json): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Json;
      if (typeof o.id === 'string' && typeof o.name === 'string') out.set(o.id, o.name);
      for (const [key, child] of Object.entries(o)) if (key !== 'library') walk(child);
    }
  };
  walk(doc.parts);
  walk(doc.assemblies);
  return out;
}

export function summarize(ev: Evaluation, doc: Json): FixtureSummary {
  const names = namesById(doc);
  const parts = ((doc.parts as Json[]) ?? []).flatMap((p) => {
    const result = ev.parts.get(p.id as string);
    if (!result) return [];
    const threads = [...result.threads.values()]
      .flat()
      .map((t) => `${t.designation} ${t.class}${t.internal ? ' internal' : ' external'}`)
      .sort();
    return [{ name: String(p.name), bodies: bodiesOf(ev, result), threads }];
  });
  const assemblies = ((doc.assemblies as Json[]) ?? []).flatMap((a) => {
    const result = ev.assemblies.get(a.id as string);
    if (!result) return [];
    return [{ name: String(a.name), instances: result.nodes.length, bodies: bodiesOf(ev, result), threads: [] }];
  });
  const pauses = [...ev.pauses, ...(ev.stale ?? [])]
    .map((p) => `${names.get(p.feature) ?? p.feature}: ${p.message}`)
    .sort();
  return { parts, assemblies, pauses };
}

/** Where `actual` differs from `expected`, beyond `tolerance` relative on volumes and absolute (mm) on box corners. */
export function differences(
  expected: FixtureSummary,
  actual: FixtureSummary,
  tolerance = { volume: 1e-4, length: 1e-3 },
): string[] {
  const out: string[] = [];
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  const owners = (kind: string, e: OwnerSummary[], a: OwnerSummary[]) => {
    if (e.length !== a.length) out.push(`${kind}: ${e.length} expected, ${a.length} built`);
    e.forEach((eo, i) => {
      const ao = a[i];
      if (!ao) return;
      const at = `${kind} ${eo.name}`;
      if (eo.name !== ao.name) out.push(`${at}: named ${ao.name}`);
      if (JSON.stringify(eo.threads) !== JSON.stringify(ao.threads))
        out.push(`${at}: threads ${JSON.stringify(ao.threads)}, expected ${JSON.stringify(eo.threads)}`);
      if ('instances' in eo && (eo as { instances: number }).instances !== (ao as { instances?: number }).instances) {
        out.push(
          `${at}: ${(ao as { instances?: number }).instances} instances, expected ${(eo as { instances: number }).instances}`,
        );
      }
      if (eo.bodies.length !== ao.bodies.length) {
        out.push(`${at}: ${ao.bodies.length} bodies, expected ${eo.bodies.length}`);
        return;
      }
      eo.bodies.forEach((eb, j) => {
        const ab = ao.bodies[j] as BodySummary;
        const where = `${at} body ${j + 1}`;
        if (!near(eb.volume, ab.volume, tolerance.volume * Math.max(1, Math.abs(eb.volume))))
          out.push(`${where}: volume ${ab.volume}, expected ${eb.volume}`);
        [...eb.min, ...eb.max].forEach((c, n) => {
          const got = [...ab.min, ...ab.max][n] as number;
          if (!near(c, got, tolerance.length))
            out.push(`${where}: box ${JSON.stringify([ab.min, ab.max])}, expected ${JSON.stringify([eb.min, eb.max])}`);
        });
        if (eb.faces !== ab.faces || eb.edges !== ab.edges)
          out.push(`${where}: ${ab.faces} faces and ${ab.edges} edges, expected ${eb.faces} and ${eb.edges}`);
      });
    });
  };
  owners('part', expected.parts, actual.parts);
  owners('assembly', expected.assemblies, actual.assemblies);
  if (JSON.stringify(expected.pauses) !== JSON.stringify(actual.pauses))
    out.push(`pauses ${JSON.stringify(actual.pauses)}, expected ${JSON.stringify(expected.pauses)}`);
  return [...new Set(out)];
}
