/**
 * Edit Component: the panel that edits an inserted component's public
 * parameter values, its configuration row, where it is placed and, for one
 * derived into a part, its operation; the viewport previews the edit, OK writes it as one undo step, Cancel and
 * Escape write nothing.
 *
 * Opened on `request.feature`: an instance id with its assembly in
 * `request.from`, or a derive feature id.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Puzzle, RotateCcw } from 'lucide-react';
import type { PanelProps } from '../AppShell';
import { useDocument } from '../hooks';
import { Actions, ErrorLine, PanelCard, Row, Section, Select, ToggleRow } from '../modeling/panelKit';
import { candidateOf, commitSolved } from './commit';
import {
  componentEditCommands,
  defaults,
  isOverridden,
  ORIGIN,
  readComponentEdit,
  resolvedValues,
  type ComponentEdit,
  type ComponentSite,
  type DeriveOperation,
  type PlacementEdit,
} from './componentEdit';
import type { PublicParameter } from './library';

/** Milliseconds a change waits before the preview follows it. */
const PREVIEW_DELAY = 150;

const OWN_ROW = '';

const OPERATIONS: { id: DeriveOperation; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'join', label: 'Join' },
  { id: 'cut', label: 'Cut' },
];

const unquoted = (text: string): string => /^\s*"(.*)"\s*$/.exec(text)?.[1] ?? text;

export function ComponentEditPanel({ services, request, close }: PanelProps) {
  const { editor, scheduler } = services;
  const site = useMemo<ComponentSite | null>(() => {
    if (!request.feature) return null;
    return request.from ? { assembly: request.from, instance: request.feature } : { feature: request.feature };
  }, [request]);
  const initial = useMemo(() => (site ? readComponentEdit(editor.document, site) : null), [editor, site]);
  const [edit, setEdit] = useState<ComponentEdit | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!initial) close();
  }, [initial, close]);

  // While OK writes, the preview it solves is not replaced; once closed, nothing it started touches the panel.
  const committing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const doc = useDocument(editor);

  // The preview follows the fields, and the document, a moment after they change.
  useEffect(() => {
    if (!site || !edit) return;
    const timer = setTimeout(() => {
      if (committing.current) return;
      const candidate = candidateOf(editor.document, componentEditCommands(editor.document, site, edit));
      setError(candidate.ok ? null : candidate.message);
      scheduler.setPreview(candidate.ok ? candidate.doc : null);
    }, PREVIEW_DELAY);
    return () => clearTimeout(timer);
  }, [site, edit, editor, scheduler, doc]);
  useEffect(() => () => scheduler.setPreview(null), [scheduler]);

  const resolved = useMemo(
    () => (site && edit ? resolvedValues(editor.document, site, edit) : {}),
    [editor, site, edit],
  );

  if (!site || !edit) return null;
  const update = (patch: Partial<ComponentEdit>) => setEdit({ ...edit, ...patch });
  const confirm = () => {
    if (busy) return;
    setBusy(true);
    committing.current = true;
    void commitSolved(
      services,
      `Edit ${edit.label}`,
      componentEditCommands(editor.document, site, edit),
      () => mounted.current,
    ).then((r) => {
      committing.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (r.ok) close();
      else setError(r.message);
    });
  };
  const derive = 'feature' in site;

  return (
    <PanelCard title={`Edit ${edit.label}`} icon={<Puzzle size={14} color="#6366f1" />} onClose={close} wide>
      <Row label="Component">
        <span style={styles.name} title={edit.name}>
          {edit.name}
          <span style={styles.origin}>{edit.origin}</span>
        </span>
      </Row>
      {edit.operation && (
        <ToggleRow
          label="Operation"
          value={edit.operation}
          options={OPERATIONS}
          bound={edit.operation === initial?.operation ? (edit.operationBound ?? null) : null}
          onChange={(operation) => update({ operation })}
        />
      )}
      {edit.placement && (
        <PlacementSection
          placement={edit.placement}
          derive={derive}
          onChange={(placement) => update({ placement })}
          onEnter={confirm}
        />
      )}
      {edit.configurations.map((c) => (
        <Select
          key={c.input.id}
          label={edit.configurations.length > 1 ? c.input.name : 'Configuration'}
          value={edit.rows[c.input.id] ?? OWN_ROW}
          options={[
            { id: OWN_ROW, label: c.own ? `Component's own (${c.own})` : "Component's own" },
            ...c.options.map((o) => ({ id: o, label: o })),
          ]}
          onChange={(row) => update({ rows: { ...edit.rows, [c.input.id]: row === OWN_ROW ? null : row } })}
        />
      ))}
      {edit.params.length === 0 && edit.configurations.length === 0 && (
        <div style={styles.empty}>This component has no public parameters.</div>
      )}
      {edit.params.length > 0 && (
        <Section label="Parameters">
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Value / Expression</th>
                <th style={styles.th}>= Resolved</th>
                <th style={styles.th}>Description</th>
              </tr>
            </thead>
            <tbody>
              {edit.params.map((p, i) => {
                const r = resolved[p.id];
                return (
                  <tr key={p.id}>
                    <td style={styles.td}>
                      <span style={styles.paramName}>
                        {p.name}
                        {isOverridden(edit, p) && <span style={styles.overrideDot} title="Set for this insertion" />}
                      </span>
                    </td>
                    <td style={styles.td}>
                      <ValueField
                        p={p}
                        value={edit.values[p.id] ?? ''}
                        shown={r?.ok ? r.text : p.text}
                        autoFocus={i === 0}
                        onChange={(text) => update({ values: { ...edit.values, [p.id]: text } })}
                        onEnter={confirm}
                      />
                    </td>
                    <td style={{ ...styles.td, ...styles.resolved }}>
                      {!r ? (
                        '—'
                      ) : r.ok ? (
                        r.text
                      ) : (
                        <span style={styles.resolvedError} title={r.message}>
                          {r.message}
                        </span>
                      )}
                    </td>
                    <td style={{ ...styles.td, ...styles.description }} title={p.description}>
                      {p.description}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}
      {(edit.params.length > 0 || edit.configurations.length > 0) && (
        <div style={styles.resetRow}>
          <button
            type="button"
            style={styles.reset}
            onClick={() => update(defaults(edit))}
            title="Use the component's own values"
          >
            <RotateCcw size={11} /> Defaults
          </button>
        </div>
      )}
      <ErrorLine message={error} />
      <Actions onCancel={close} onOk={confirm} />
    </PanelCard>
  );
}

/**
 * A public parameter's field: a choice's options, otherwise an expression
 * with the unit beside it. Empty where the insertion sets nothing, showing
 * greyed what the component gives (`shown`) under the chosen rows.
 */
function ValueField({
  p,
  value,
  shown,
  autoFocus,
  onChange,
  onEnter,
}: {
  p: PublicParameter;
  value: string;
  shown: string;
  autoFocus: boolean;
  onChange: (text: string) => void;
  onEnter: () => void;
}) {
  if (p.kind === 'choice' && p.options.length > 0) {
    return (
      <select
        aria-label={p.name}
        value={value === '' ? '' : unquoted(value)}
        onChange={(e) => onChange(e.target.value === '' ? '' : JSON.stringify(e.target.value))}
        style={styles.select}
      >
        <option value="">{`Component's own (${unquoted(shown)})`}</option>
        {p.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <span style={styles.valueCell}>
      <input
        type="text"
        aria-label={p.name}
        value={value}
        placeholder={shown}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          }
        }}
        style={styles.input}
      />
      {p.unit && <span style={styles.unit}>{p.unit}</span>}
    </span>
  );
}

/** Translation and rotation, X/Y/Z each, and a reset to the origin. */
function PlacementSection({
  placement,
  derive,
  onChange,
  onEnter,
}: {
  placement: PlacementEdit;
  derive: boolean;
  onChange: (p: PlacementEdit) => void;
  onEnter: () => void;
}) {
  const set = (key: keyof PlacementEdit, i: number, text: string) => {
    const next = [...placement[key]] as PlacementEdit[typeof key];
    next[i] = text;
    onChange({ ...placement, [key]: next });
  };
  const row = (key: keyof PlacementEdit, label: string, unit: string) => (
    <div style={styles.placementRow}>
      <span style={styles.placementLabel}>{label}</span>
      {(['X', 'Y', 'Z'] as const).map((axis, i) => {
        const text = placement[key][i] as string;
        const invalid =
          key === 'position' && derive ? text.trim() === '' : !Number.isFinite(text.trim() === '' ? NaN : Number(text));
        return (
          <label key={axis} style={styles.placementField}>
            <span style={styles.axis}>{axis}</span>
            <input
              type="text"
              aria-label={`${label} ${axis}`}
              value={text}
              spellCheck={false}
              onChange={(e) => set(key, i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onEnter();
                }
              }}
              style={{ ...styles.placementInput, border: `1px solid ${invalid ? '#dc2626' : '#d0d0d0'}` }}
            />
            <span style={styles.unit}>{unit}</span>
          </label>
        );
      })}
    </div>
  );
  return (
    <Section label="Placement">
      {row('position', 'Translation', 'mm')}
      {row('rotation', 'Rotation', '°')}
      <div style={styles.placementActions}>
        <button type="button" style={styles.reset} onClick={() => onChange(ORIGIN)}>
          Reset to origin
        </button>
      </div>
    </Section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  name: {
    fontSize: 12,
    color: '#555',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  origin: { fontSize: 11, color: '#888', fontFamily: 'ui-monospace, monospace' },
  empty: { fontSize: 11, color: '#999', fontStyle: 'italic', padding: '4px 12px 8px' },
  table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' },
  th: {
    textAlign: 'left',
    fontSize: 10,
    fontWeight: 600,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    padding: '2px 4px',
  },
  td: {
    padding: '3px 4px',
    fontSize: 12,
    verticalAlign: 'middle',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  paramName: { display: 'inline-flex', alignItems: 'center', gap: 4, color: '#333' },
  overrideDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#1a6fd1',
    display: 'inline-block',
    flexShrink: 0,
  },
  valueCell: { display: 'flex', alignItems: 'center', gap: 4 },
  input: {
    flex: 1,
    minWidth: 0,
    height: 24,
    padding: '0 6px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    color: '#333',
    outline: 'none',
  },
  select: { width: '100%', height: 24, border: '1px solid #d0d0d0', borderRadius: 4, fontSize: 12, background: '#fff' },
  unit: { fontSize: 11, color: '#999' },
  resolved: { fontFamily: 'monospace', fontSize: 11, color: '#666' },
  resolvedError: { color: '#dc2626' },
  description: { fontSize: 11, color: '#888' },
  resetRow: { display: 'flex', justifyContent: 'flex-end', padding: '0 12px 6px' },
  reset: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 24,
    padding: '0 8px',
    border: '1px solid #e0e0e0',
    borderRadius: 4,
    background: '#f7f7f7',
    color: '#555',
    fontSize: 11,
    cursor: 'pointer',
  },
  placementRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 },
  placementLabel: { fontSize: 11, color: '#555', width: 70, flexShrink: 0 },
  placementField: { display: 'flex', alignItems: 'center', gap: 3, flex: 1, minWidth: 0 },
  axis: { fontSize: 10, color: '#999', fontWeight: 600 },
  placementInput: {
    flex: 1,
    minWidth: 0,
    height: 24,
    padding: '0 5px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'right',
    outline: 'none',
  },
  placementActions: { display: 'flex', justifyContent: 'flex-end', marginTop: 2 },
};
