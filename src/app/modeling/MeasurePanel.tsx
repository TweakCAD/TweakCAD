/**
 * The Measure panel: the first click in the view fills Selection 1, the next
 * Selection 2, and the panel shows what each measures on its own and, with
 * both, the distance and angle between them (Results). A click on a selection
 * drops it; with both filled, a click starts over; Clear selection empties
 * both. An item selected in the browser counts as a selection too. Measures
 * come from the kernel's shapes rather than the display mesh. Keep turns a
 * reading into a named measured value (`m1`, …) that expressions can use, in
 * a `core.measure` feature.
 *
 * The measure feature's own panel lists its values, to rename or remove.
 */
import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { MeasureKind } from '@tweakcad/worker/src/v2/service/types';
import { MeasureIcon } from '../../icons/cadIcons.tsx';
import { report, type PanelProps } from '../AppShell';
import { consoleLog } from '../console';
import { useDocument, useSlice } from '../hooks';
import type { SelectionItem } from '../selection';
import type { AppServices } from '../services';
import { activePart } from './commands';
import {
  bodyReadings,
  formatReading,
  KIND_LABELS,
  type BodyReading,
  keepMeasure,
  measuredValues,
  measuresFor,
  measureSelections,
  removeMeasured,
  UNITS,
  type Reading,
} from './measure';
import { ErrorLine, PanelCard, styles } from './panelKit';
import { kindOf, labelOf } from './picks';
import { useClicks } from './usePanel';
import { useReadOnly } from '../storage/preview';

type KeyItem = Extract<SelectionItem, { key: number }>;

/** What one group of keys reads: each measure that applies, and for one body its surface, centre and size. */
async function readingsOf(
  services: AppServices,
  keys: readonly KeyItem[],
  kinds: readonly string[],
): Promise<{ list: Reading[]; body: BodyReading[] }> {
  const list: Reading[] = [];
  for (const kind of measuresFor(kinds)) {
    const m = await services.client.measure(
      kind,
      keys.map((k) => k.key),
    );
    if ('value' in m) list.push({ kind, label: KIND_LABELS[kind], value: m.value, unit: UNITS[kind] });
  }
  const one =
    keys.length === 1 && kinds[0] === 'body' ? await services.client.bodyMeasures?.((keys[0] as KeyItem).key) : null;
  return { list, body: one ? bodyReadings(one) : [] };
}

interface Readings {
  key: string;
  /** Each selection's own readings, then the results between the two. */
  own: { list: Reading[]; body: BodyReading[] }[];
  results: Reading[];
}

const sameKey = (a: KeyItem, b: KeyItem): boolean => a.key === b.key;

export function MeasurePanel({ services, viewport, close }: PanelProps) {
  const items = useSlice(services.selection, (s) => s.items);
  const display = useSlice(services.display, (s) => s.display);
  // A read-only preview measures but keeps no value.
  const readOnly = useReadOnly(services.session);
  const [readings, setReadings] = useState<Readings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = items.filter((i): i is KeyItem => 'key' in i && !i.instance);
  const selectionKey = `${display?.generation ?? ''}|${keys.map((k) => k.key).join(',')}`;

  // A click in the view fills Selection 1, then Selection 2.
  useClicks(services, viewport, (item) => {
    const clicked = item && 'key' in item && !item.instance ? (item as KeyItem) : null;
    const now = services.selection.getState().items.filter((i): i is KeyItem => 'key' in i && !i.instance);
    const next = measureSelections(now, clicked, sameKey);
    services.selection.setState({ items: next, generation: services.display.getState().display?.generation ?? null });
  });

  useEffect(() => {
    let cancelled = false;
    const kinds = keys.map((k) => kindOf(display, k) ?? '');
    void (async () => {
      // Two selections read on their own and between them; more (from the browser) read together.
      const own =
        keys.length <= 2
          ? await Promise.all(keys.map((k, i) => readingsOf(services, [k], [kinds[i] as string])))
          : [await readingsOf(services, keys, kinds)];
      const results = keys.length === 2 ? (await readingsOf(services, keys, kinds)).list : [];
      if (!cancelled) setReadings({ key: selectionKey, own, results });
    })();
    return () => {
      cancelled = true;
    };
    // Keyed by the selection and the display it belongs to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, services]);

  const keep = async (kind: MeasureKind, of: readonly KeyItem[]) => {
    const part = activePart(services);
    if (!part) return;
    const refs = [];
    for (const k of of) {
      const picked = await services.pick(k);
      if (!picked || 'region' in picked) {
        setError('The selection is no longer shown; select it again');
        return;
      }
      refs.push(picked);
    }
    const { result, name } = keepMeasure(services.editor, part, kind, refs);
    if (report(result, 'Keep measure'))
      consoleLog('success', `Kept ${KIND_LABELS[kind].toLowerCase()} as ${name}`, 'measure');
  };

  const current = readings?.key === selectionKey ? readings : null;
  const drop = (i: number) =>
    services.selection.setState({ items: keys.filter((_, j) => j !== i), generation: display?.generation ?? null });
  const readingRows = (list: readonly Reading[], of: readonly KeyItem[]) =>
    list.map((r) => (
      <div key={r.kind} style={{ ...styles.pickRow, minHeight: 26 }}>
        <span style={{ ...styles.label, minWidth: 70 }}>{r.label}</span>
        <span style={{ ...styles.pickLabel, fontFamily: 'monospace', textAlign: 'right' }}>
          {formatReading(r.value, r.unit)}
        </span>
        {readOnly ? (
          <span style={{ width: 18, flexShrink: 0 }} />
        ) : (
          <button
            type="button"
            style={styles.pickRemove}
            title="Keep as a named value"
            aria-label={`Keep ${r.label.toLowerCase()}`}
            onClick={() => void keep(r.kind, of)}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
    ));
  const bodyRows = (body: readonly BodyReading[]) =>
    body.map((r) => (
      <div key={r.label} style={{ ...styles.pickRow, minHeight: 26 }}>
        <span style={{ ...styles.label, minWidth: 70 }}>{r.label}</span>
        <span style={{ ...styles.pickLabel, fontFamily: 'monospace', textAlign: 'right' }}>{r.text}</span>
        <span style={{ width: 18, flexShrink: 0 }} />
      </div>
    ));
  const slot = (i: number) => {
    const item = keys[i];
    const own = current?.own[i];
    return (
      <div key={i} style={styles.section}>
        <div style={styles.sectionLabel}>Selection {i + 1}</div>
        {item ? (
          <div style={styles.pickRow}>
            <span style={styles.pickLabel}>{labelOf(services, item)}</span>
            <button
              type="button"
              style={styles.pickRemove}
              title="Remove"
              aria-label={`Remove selection ${i + 1}`}
              onClick={() => drop(i)}
            >
              <X size={11} />
            </button>
          </div>
        ) : (
          <div style={styles.emptyHint}>
            {i === 0 ? 'Click a face, an edge, a vertex or a body' : 'Click a second one to measure between them'}
          </div>
        )}
        {item && !current && <div style={styles.emptyHint}>Measuring</div>}
        {item &&
          own &&
          own.list.length === 0 &&
          own.body.length === 0 &&
          i === keys.length - 1 &&
          keys.length === 1 && <div style={styles.emptyHint}>Nothing to measure on its own</div>}
        {item && own && readingRows(own.list, [item])}
        {item && own && bodyRows(own.body)}
      </div>
    );
  };

  return (
    <PanelCard title="Measure" icon={<MeasureIcon size={14} color="#0d9488" />} onClose={close}>
      {keys.length <= 2 ? (
        <>
          {slot(0)}
          {slot(1)}
          {keys.length === 2 && (
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Results</div>
              {!current && <div style={styles.emptyHint}>Measuring</div>}
              {current && current.results.length === 0 && (
                <div style={styles.emptyHint}>Nothing to measure between these</div>
              )}
              {current && readingRows(current.results, keys)}
            </div>
          )}
        </>
      ) : (
        <div style={styles.section}>
          <div style={styles.sectionLabel}>Selection ({keys.length})</div>
          {current && readingRows(current.own[0]?.list ?? [], keys)}
          {current && (current.own[0]?.list.length ?? 0) === 0 && (
            <div style={styles.emptyHint}>Nothing to measure in this selection</div>
          )}
        </div>
      )}
      <ErrorLine message={error} />
      <div style={{ ...styles.actions, justifyContent: 'flex-start' }}>
        <button
          type="button"
          style={styles.cancelBtn}
          disabled={keys.length === 0}
          onClick={() => services.selection.setState({ items: [], generation: display?.generation ?? null })}
        >
          Clear selection
        </button>
      </div>
    </PanelCard>
  );
}

export function MeasureValuesPanel({ services, request, close }: PanelProps) {
  const doc = useDocument(services.editor);
  const feature = request.feature ?? '';
  const values = measuredValues(doc, feature);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const rename = (id: string, name: string) => {
    setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== id)));
    const old = values.find((v) => v.id === id)?.name;
    if (name.trim() === '' || name === old) return;
    report(services.editor.dispatch({ type: 'renameValue', value: id, name: name.trim() }), 'Rename');
  };
  return (
    <PanelCard title="Measured values" icon={<MeasureIcon size={14} color="#0d9488" />} onClose={close}>
      <div style={styles.section}>
        {values.length === 0 && <div style={styles.emptyHint}>No values</div>}
        {values.map((v) => (
          <div key={v.id} style={{ ...styles.pickRow, minHeight: 28 }}>
            <input
              aria-label="Name"
              style={{ ...styles.input, width: 90, height: 24, textAlign: 'left' }}
              value={drafts[v.id] ?? v.name}
              onChange={(e) => setDrafts((d) => ({ ...d, [v.id]: e.target.value }))}
              onBlur={(e) => rename(v.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') rename(v.id, e.currentTarget.value);
              }}
            />
            <span style={styles.pickLabel}>{KIND_LABELS[v.kind as MeasureKind] ?? v.kind}</span>
            <button
              type="button"
              style={styles.pickRemove}
              title="Remove"
              onClick={() => report(removeMeasured(services.editor, feature, v.id), 'Remove value')}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
