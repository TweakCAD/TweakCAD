/**
 * Times the stages of a build as its progress reports them (each feature,
 * placing, meshing), and, given the times of an earlier build of the same
 * document, tells how far a full build has come in time: a few slow
 * features can take most of a build, so counting features misleads.
 *
 * A feature's time runs from the progress that starts it to the progress
 * that starts the next feature, placing or meshing, so it holds whatever the
 * evaluation does between them.
 */
import type { BuildTimes, Progress } from './types';

/** Share of the document's features an earlier build must have timed for its times to stand in for this build's. */
const COVERAGE = 0.9;

export class ProgressClock {
  private readonly measured: Record<string, number> = {};
  private placing: number | undefined;
  private meshing: number | undefined;
  /** What runs now, and since when. */
  private current: { stage: string; since: number } | undefined;
  /** Expected ms per feature key; undefined when there is no earlier build to go by. */
  private readonly expected: Map<string, number> | undefined;
  private readonly expectedBuild: number;
  private readonly expectedPlacing: number;
  private readonly expectedMeshing: number;
  private doneExpected = 0;
  private last = 0;

  constructor(
    /** The keys of every feature the build may run, `<part id>/<feature id>`. */
    keys: readonly string[],
    earlier: BuildTimes | undefined,
    /** Whether the build runs every feature (an evaluation afresh): only then do earlier times tell its length. */
    full: boolean,
    private readonly now: () => number = () => performance.now(),
  ) {
    const known = earlier ? keys.filter((k) => earlier.features[k] !== undefined) : [];
    if (!earlier || !full || keys.length === 0 || known.length < COVERAGE * keys.length) {
      this.expected = undefined;
      this.expectedBuild = this.expectedPlacing = this.expectedMeshing = 0;
      return;
    }
    const times = known.map((k) => earlier.features[k] as number).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] ?? 0;
    this.expected = new Map(keys.map((k) => [k, earlier.features[k] ?? median]));
    this.expectedBuild = [...this.expected.values()].reduce((a, b) => a + b, 0);
    this.expectedPlacing = earlier.placing ?? 0;
    this.expectedMeshing = earlier.meshing ?? 0;
  }

  /** `p` with how far the build has come, timing the stage it closes. */
  report(p: Progress): Progress {
    const at = this.now();
    if (p.phase === 'reading' || p.phase === 'built') return p;
    if (p.phase === 'building') {
      this.close(at);
      this.current = { stage: `${p.part}/${p.feature}`, since: at };
      return this.withFraction(p, this.doneExpected);
    }
    if (p.phase === 'placing') {
      this.close(at);
      this.current = { stage: 'placing', since: at };
      return this.withFraction(p, this.expectedBuild);
    }
    if (this.current?.stage !== 'meshing') {
      this.close(at);
      this.current = { stage: 'meshing', since: at };
    }
    const share = p.total > 0 ? p.done / p.total : 0;
    return this.withFraction(p, this.expectedBuild + this.expectedPlacing + share * this.expectedMeshing);
  }

  /** The times this build took: features it built, and those of `earlier` it took over. */
  finish(earlier: BuildTimes | undefined): BuildTimes {
    this.close(this.now());
    const times: BuildTimes = { features: { ...(earlier?.features ?? {}), ...this.measured } };
    const placing = this.placing ?? earlier?.placing;
    const meshing = this.meshing ?? earlier?.meshing;
    if (placing !== undefined) times.placing = placing;
    if (meshing !== undefined) times.meshing = meshing;
    return times;
  }

  private close(at: number): void {
    const c = this.current;
    if (!c) return;
    const ms = at - c.since;
    if (c.stage === 'placing') this.placing = ms;
    else if (c.stage === 'meshing') this.meshing = ms;
    else {
      this.measured[c.stage] = ms;
      this.doneExpected += this.expected?.get(c.stage) ?? 0;
    }
    this.current = undefined;
  }

  private withFraction<P extends Progress>(p: P, doneMs: number): P {
    if (!this.expected) return p;
    const total = this.expectedBuild + this.expectedPlacing + this.expectedMeshing;
    if (total <= 0) return p;
    // Never back, and never full before the build ends.
    this.last = Math.max(this.last, Math.min(0.99, doneMs / total));
    return { ...p, fraction: this.last };
  }
}
