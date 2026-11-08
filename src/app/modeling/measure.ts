/**
 * Measuring: what the measure panel reads off the selection (through the
 * worker's `measure`, in base units), and keeping a reading as a named
 * measured value of a `core.measure` feature (appendix A, 6.3), so later
 * expressions can use it.
 *
 * A kept value goes into the part's `core.measure` feature when that is
 * the last feature before the rollback marker, otherwise into a new one
 * there.
 */
import { isPlainObject } from '@tweakcad/format';
import { CommandError, freeValueName, type CommandResult, type Doc, type Editor, type Json } from '@tweakcad/editor';
import type { BodyMeasures, MeasureKind } from '@tweakcad/worker/src/v2/service/types';
import { findFeature } from '../features';
import { featureBefore, featureRow, insertionPoint, nextFeatureName } from './common';

export interface Reading {
  kind: MeasureKind;
  label: string;
  /** In base units: mm, mm², mm³, deg. */
  value: number;
  unit: string;
}

export const UNITS: Record<MeasureKind, string> = {
  distance: 'mm',
  length: 'mm',
  radius: 'mm',
  area: 'mm²',
  volume: 'mm³',
  angle: '°',
};
export const KIND_LABELS: Record<MeasureKind, string> = {
  distance: 'Distance',
  length: 'Length',
  radius: 'Radius',
  area: 'Area',
  volume: 'Volume',
  angle: 'Angle',
};

/** The measures that may apply to a selection of entity kinds: one entity's own, or between two. */
export function measuresFor(kinds: readonly string[]): MeasureKind[] {
  if (kinds.length === 1) {
    switch (kinds[0]) {
      case 'body':
        return ['volume'];
      case 'face':
      case 'region':
        return ['area', 'radius'];
      case 'edge':
      case 'curve':
        return ['length', 'radius'];
      default:
        return [];
    }
  }
  if (kinds.length === 2) return ['distance', 'angle'];
  if (kinds.length > 2 && kinds.every((k) => k === 'edge' || k === 'curve')) return ['length'];
  if (kinds.length > 2 && kinds.every((k) => k === 'face' || k === 'region')) return ['area'];
  if (kinds.length > 2 && kinds.every((k) => k === 'body')) return ['volume'];
  return [];
}

/**
 * Measure's two selections after a viewport click: the first click fills
 * Selection 1, the next Selection 2; a click on one already held drops it;
 * with both held, a click starts over with it as Selection 1. A click on
 * nothing changes nothing.
 */
export function measureSelections<T>(now: readonly T[], clicked: T | null, same: (a: T, b: T) => boolean): T[] {
  if (clicked === null) return [...now];
  const held = now.slice(0, 2);
  if (held.some((h) => same(h, clicked))) return held.filter((h) => !same(h, clicked));
  return held.length < 2 ? [...held, clicked] : [clicked];
}

/** Significant figures for the readout: a 0.05 mm radius and a 400 mm plate both read usefully. */
export function formatReading(value: number, unit: string): string {
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 1 : abs >= 1 ? 3 : 5;
  return `${Number(value.toFixed(digits))}${unit === '°' ? '' : ' '}${unit}`;
}

/** Three coordinates, to three decimals. */
export function formatVector(v: readonly [number, number, number]): string {
  return v.map((n) => Number(n.toFixed(3)) + 0).join(', ');
}

/** A reading shown but not kept as a value. */
export interface BodyReading {
  label: string;
  text: string;
}

/** What one body reads besides its volume: its surface area, centre of mass, and the size of its bounding box. */
export function bodyReadings(m: BodyMeasures): BodyReading[] {
  const [min, max] = m.bbox;
  return [
    { label: 'Surface', text: formatReading(m.area, 'mm²') },
    { label: 'Centroid', text: formatVector(m.centroid) },
    { label: 'Size', text: formatVector([max[0] - min[0], max[1] - min[1], max[2] - min[2]]) },
  ];
}

/** The part's measure feature that takes a new value: the last one before the marker, if it is the last feature there. */
export function measureFeatureFor(doc: Doc, part: string): string | null {
  const before = featureBefore(doc, part, insertionPoint(doc, part));
  const row = before ? findFeature(doc, before) : undefined;
  return row?.type === 'core.measure' ? (row.id as string) : null;
}

/**
 * Keeps a measure of `references` as a named value, as one undo step; the
 * name is the next free `m1`, `m2`, …
 */
export function keepMeasure(
  editor: Editor,
  part: string,
  kind: MeasureKind,
  references: readonly { reference: Json; names: Json }[],
): { result: CommandResult; name: string } {
  const doc = editor.document;
  const name = freeValueName(doc, part, 'm');
  const value: Json = {
    id: editor.newId('val'),
    name,
    def: { measure: { kind, of: references.map((r) => r.reference) } },
  };
  const names: Json = {};
  for (const r of references) Object.assign(names, r.names);
  const existing = measureFeatureFor(doc, part);
  const check = (r: CommandResult) => {
    if (!r.ok) throw new CommandError(r.error.code, r.error.message);
    return r;
  };
  try {
    if (existing) {
      const row = findFeature(doc, existing) as Json;
      const values = Array.isArray((row.inputs as Json | undefined)?.values)
        ? ((row.inputs as Json).values as Json[])
        : [];
      const result = editor.transaction(`Add ${name}`, () =>
        check(
          editor.dispatch({
            type: 'replaceInput',
            feature: existing,
            pointer: '/values',
            with: [...values, value],
            names,
          }),
        ),
      );
      return { result, name };
    }
    const id = editor.newId('feat');
    const label = nextFeatureName(doc, part, 'Measure');
    const before = insertionPoint(doc, part);
    const result = editor.transaction(`Add ${name}`, () =>
      check(
        editor.dispatch({
          type: 'addFeature',
          container: part,
          feature: featureRow(editor, id, 'core.measure', label, { values: [value] }),
          names,
          ...(before ? { before } : {}),
        }),
      ),
    );
    return { result, name };
  } catch (e) {
    if (e instanceof CommandError) return { result: { ok: false, error: e.toFailure() }, name };
    throw e;
  }
}

/** The measured values of a `core.measure` feature: id, name and kind. */
export function measuredValues(doc: Doc, feature: string): { id: string; name: string; kind: string }[] {
  const row = findFeature(doc, feature);
  const values = isPlainObject(row?.inputs) && Array.isArray(row.inputs.values) ? (row.inputs.values as Json[]) : [];
  return values.map((v) => ({
    id: String(v.id),
    name: typeof v.name === 'string' ? v.name : '',
    kind: String(((v.def as Json | undefined)?.measure as Json | undefined)?.kind ?? ''),
  }));
}

/** Removes a measured value from its feature (refused while an expression uses it). */
export function removeMeasured(editor: Editor, feature: string, value: string): CommandResult {
  const row = findFeature(editor.document, feature) as Json;
  const values = ((row.inputs as Json).values as Json[]).filter((v) => v.id !== value);
  return editor.dispatch({ type: 'replaceInput', feature, pointer: '/values', with: values });
}
