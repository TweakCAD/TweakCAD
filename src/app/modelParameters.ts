/**
 * Model parameters, as the parameters dialog lists them: the numbers a part's
 * features are built from (a sketch's dimensions, an extrude's distance, a
 * fillet's radius), grouped by feature in timeline order, each with its name
 * where it has one, its expression and what it comes to. Editing one rewrites
 * that value's expression, as editing the feature would.
 *
 * Only numbers are listed: flags, choices, texts, vectors and placements
 * are a feature's settings, edited in its panel. A sketch lists its
 * dimensions only, not the positions of its geometry.
 */
import { ValueEvaluator, isPlainObject, quantityOf, toStored, type ExprValue } from '@tweakcad/format';
import {
  bindExpression,
  withDefaultUnit,
  type CommandResult,
  type Doc,
  type Editor,
  type Json,
} from '@tweakcad/editor';
import { featureDisplayName, partOf } from './features';

export interface ModelParameter {
  /** The value object's id. */
  id: string;
  feature: string;
  /** The value's own name ("d1"), or null for an unnamed value. */
  name: string | null;
  /** What the value is in its feature ("Distance", "Radius"). */
  label: string;
  /** Its expression text. */
  text: string;
  /** What it comes to now, with its unit; '—' when it comes to nothing. */
  value: string;
  /** Its quantity (`length`, `angle`, `ratio`), which an edit keeps. */
  quantity: string;
}

export interface ModelParameterGroup {
  feature: string;
  name: string;
  parameters: ModelParameter[];
}

const UNITS: Record<string, string> = { length: 'mm', angle: 'deg' };

/** Keys that wrap a value without saying what it is. */
const BARE = new Set(['d', 'v', 'value', 'at']);

/** A readable label for a value at `path` in a feature's inputs: its innermost telling key ("Distance", "Taper"). */
export function valueLabel(path: readonly string[]): string {
  if (path[0] === 'constraints') return 'Dimension';
  const keys = path.filter((k) => !/^\d+$/.test(k));
  const key = [...keys].reverse().find((k) => !BARE.has(k)) ?? keys[keys.length - 1] ?? 'Value';
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const side = path.indexOf('sides');
  const second = side >= 0 && path[side + 1] === '1' ? ' (side 2)' : '';
  return words.charAt(0).toUpperCase() + words.slice(1) + second;
}

/** The value objects in `inputs`, with their paths. */
function valuesIn(inputs: unknown, path: string[], out: { value: Json; path: string[] }[]): void {
  if (Array.isArray(inputs)) {
    inputs.forEach((item, i) => valuesIn(item, [...path, String(i)], out));
    return;
  }
  if (!isPlainObject(inputs)) return;
  if (typeof inputs.id === 'string' && inputs.id.startsWith('val_') && 'def' in inputs) {
    out.push({ value: inputs, path });
    return;
  }
  for (const [key, item] of Object.entries(inputs)) if (key !== 'extensions') valuesIn(item, [...path, key], out);
}

/** A scalar result as text in its quantity's stored unit. */
function scalarText(result: ExprValue & { kind: 'scalar' }, quantity: string): string {
  const stored = toStored(result, { type: 'number', quantity });
  if (typeof stored !== 'number') return '—';
  const unit = UNITS[quantity];
  return `${Number(stored.toFixed(6))}${unit ? ` ${unit}` : ''}`;
}

/** The model parameters of `part`, by feature in timeline order; features with none are left out. */
export function modelParametersOf(doc: Doc, part: string): ModelParameterGroup[] {
  let evaluator: ValueEvaluator | null;
  try {
    evaluator = new ValueEvaluator(doc);
  } catch {
    evaluator = null;
  }
  const groups: ModelParameterGroup[] = [];
  const visit = (features: unknown): void => {
    if (!Array.isArray(features)) return;
    for (const f of features as Json[]) {
      const found: { value: Json; path: string[] }[] = [];
      if (f.type === 'core.sketch') valuesIn((f.inputs as Json | undefined)?.constraints, ['constraints'], found);
      else valuesIn(f.inputs, [], found);
      const parameters: ModelParameter[] = [];
      for (const { value, path } of found) {
        const def = value.def as Json;
        if (!isPlainObject(def.expr)) continue;
        let result: ExprValue;
        try {
          if (!evaluator) continue;
          result = evaluator.value(String(value.id));
        } catch {
          continue;
        }
        if (result.kind !== 'scalar') continue;
        const quantity = quantityOf(result.dim)?.name ?? 'ratio';
        parameters.push({
          id: String(value.id),
          feature: String(f.id),
          name: typeof value.name === 'string' && value.name !== '' ? value.name : null,
          label: valueLabel(path),
          text: String((def.expr as Json).text),
          value: scalarText(result, quantity),
          quantity,
        });
      }
      if (parameters.length > 0) groups.push({ feature: String(f.id), name: featureDisplayName(f, doc), parameters });
      visit(f.children);
    }
  };
  visit(partOf(doc, part)?.timeline);
  return groups;
}

/** Sets a model parameter's expression; a bare number takes the value's unit. */
export function setModelParameter(editor: Editor, part: string, p: ModelParameter, text: string): CommandResult {
  const unit = UNITS[p.quantity];
  const bound = bindExpression(
    editor.document,
    { part, feature: p.feature, self: p.id },
    unit ? withDefaultUnit(text, unit) : text,
    { type: 'number', quantity: p.quantity },
  );
  if (!bound.ok) return { ok: false, error: { code: 'invalid', message: bound.message } };
  return editor.dispatch({ type: 'setValueDef', value: p.id, def: bound.def });
}
