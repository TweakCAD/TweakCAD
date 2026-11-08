/**
 * The parameters dialog: a tab for the document and one per
 * part, each listing its parameters (public, name, value expression, what
 * it comes to, kind, description; a choice's options under it) with a row
 * to add one; a part's tab also has its configurations, presets of the
 * part's parameters, one row each, with the active one marked. Every edit
 * is one undo step, committed on Enter or when the field is left; what a
 * value being typed comes to shows before it is committed. Removing a
 * parameter or a configuration row asks first.
 *
 * It opens on the part shown (the document's tab when none is), and a
 * part's tab also lists its model parameters: the numbers its features are
 * built from, by feature, each expression editable.
 */
import { useState } from 'react';
import { Check, Circle, Plus, X } from 'lucide-react';
import type { Doc, Editor } from '@tweakcad/editor';
import { useConfirm, type ConfirmOptions } from '../components/ConfirmDialog.tsx';
import { report } from './AppShell';
import { partsOf } from './features';
import { fieldText } from './modeling/feature';
import { useDocument } from './hooks';
import { modelParametersOf, setModelParameter, type ModelParameter } from './modelParameters';
import {
  addConfiguration,
  addConfigurationRow,
  addParameter,
  configurationsOf,
  evaluatedText,
  fieldOf,
  isConfigurationInput,
  KINDS,
  parametersOf,
  plainRow,
  previewText,
  removeConfigurationRow,
  renameConfigurationRow,
  setActiveConfiguration,
  setConfigurationOverride,
  setParameterKind,
  setParameterOptions,
  setParameterText,
  suggestedName,
  type ConfigurationView,
  type ParameterKind,
  type ParameterScope,
  type ParameterView,
} from './parameters';

type Run = (what: string, r: ReturnType<typeof addParameter>) => boolean;
type Ask = (options: ConfirmOptions) => Promise<boolean>;

const unitOf = (kind: ParameterKind): string => KINDS.find((k) => k.id === kind)?.unit ?? '';

const splitOptions = (text: string): string[] =>
  text
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');

/** A text field that commits on Enter or blur, and goes back on Escape. */
function CommitField({
  value,
  onCommit,
  onDraft,
  width = 120,
  label,
  mono = true,
  placeholder,
  invalid,
}: {
  value: string;
  onCommit: (text: string) => boolean;
  /** Told the text being typed, and null once it is committed or dropped. */
  onDraft?: (text: string | null) => void;
  width?: number;
  label: string;
  mono?: boolean;
  placeholder?: string;
  invalid?: boolean;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const setDraft = (text: string | null) => {
    setDraftState(text);
    onDraft?.(text);
  };
  const commit = () => {
    if (draft === null) return;
    if (draft !== value && !onCommit(draft)) return;
    setDraft(null);
  };
  return (
    <input
      aria-label={label}
      value={draft ?? value}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
      style={{
        ...styles.input,
        width,
        fontFamily: mono ? 'monospace' : 'inherit',
        ...(invalid ? { border: '1px solid #f59e0b' } : {}),
      }}
    />
  );
}

/** The tab the dialog opens on: the part shown, or the document's when no part is. */
export function initialParametersTab(doc: Doc, part: string | null | undefined): string {
  return part && partsOf(doc).some((p) => p.id === part) ? part : 'document';
}

export function ParametersDialog({
  editor,
  part,
  onClose,
}: {
  editor: Editor;
  part?: string | null;
  onClose: () => void;
}) {
  const doc = useDocument(editor);
  const parts = partsOf(doc).map((p) => ({ id: String(p.id), name: String(p.name) }));
  const [tab, setTab] = useState<string>(() => initialParametersTab(editor.document, part));
  const scope: ParameterScope =
    tab === 'document' || !parts.some((p) => p.id === tab) ? { document: true } : { part: tab };
  const params = parametersOf(doc, scope);
  const [error, setError] = useState<string | null>(null);
  const { confirm, element: confirmElement } = useConfirm();
  const run: Run = (what, r) => {
    setError(r.ok ? null : r.error.message);
    return report(r, what);
  };

  return (
    <>
      <div style={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          style={styles.dialog}
          role="dialog"
          aria-label="Parameters"
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        >
          <div style={styles.header}>
            <span style={styles.title}>Parameters</span>
            <button type="button" style={styles.iconBtn} onClick={onClose} title="Close (Esc)">
              <X size={14} />
            </button>
          </div>
          <div style={styles.tabs}>
            {[{ id: 'document', name: 'Document' }, ...parts].map((t) => (
              <button
                key={t.id}
                type="button"
                style={{
                  ...styles.tab,
                  ...(tab === t.id || (t.id === 'document' && 'document' in scope) ? styles.tabActive : {}),
                }}
                onClick={() => setTab(t.id)}
              >
                {t.name}
              </button>
            ))}
          </div>
          <div style={styles.body}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th} title="Set when the document is inserted as a component">
                    Pub
                  </th>
                  <th style={styles.th}>Name</th>
                  <th style={styles.th}>Value</th>
                  <th style={styles.th}>Is</th>
                  <th style={styles.th}>Kind</th>
                  <th style={styles.th}>Description</th>
                  <th style={styles.th} />
                </tr>
              </thead>
              <tbody>
                {params.length === 0 && (
                  <tr>
                    <td colSpan={7} style={styles.empty}>
                      No parameters
                    </td>
                  </tr>
                )}
                {params.map((p) => (
                  <ParameterRow key={p.id} editor={editor} doc={doc} scope={scope} p={p} run={run} ask={confirm} />
                ))}
                <AddParameterRow
                  key={tab}
                  doc={doc}
                  scope={scope}
                  params={params}
                  onAdd={(name, kind, text, options, extra) =>
                    run(`Add ${name}`, addParameter(editor, scope, name, kind, text, options, extra))
                  }
                />
              </tbody>
            </table>
            {'part' in scope && <ModelParameters editor={editor} part={scope.part} run={run} />}
            {'part' in scope && (
              <Configurations editor={editor} part={scope.part} params={params} run={run} ask={confirm} />
            )}
            {error && <div style={styles.error}>{error}</div>}
          </div>
        </div>
      </div>
      {confirmElement}
    </>
  );
}

/** One parameter: its fields, what its value comes to (the typed value's, before it is committed), and for a choice its options. */
export function ParameterRow({
  editor,
  doc,
  scope,
  p,
  run,
  ask,
}: {
  editor: Editor;
  doc: Doc;
  scope: ParameterScope;
  p: ParameterView;
  run: Run;
  ask: Ask;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const preview = draft === null ? null : previewText(doc, scope, p.kind, p.options, draft);
  const input = isConfigurationInput(doc, p);
  const unit = unitOf(p.kind);
  const remove = () => {
    void ask({ title: `Delete "${p.name}"?`, confirmLabel: 'Delete', cancelLabel: 'Cancel', tone: 'danger' }).then(
      (yes) => {
        if (yes) run('Remove', editor.dispatch({ type: 'removeParameter', parameter: p.id }));
      },
    );
  };
  return (
    <>
      <tr>
        <td style={{ ...styles.td, textAlign: 'center' }}>
          <input
            type="checkbox"
            aria-label={`${p.name} public`}
            title="Set when the document is inserted as a component"
            checked={p.public}
            onChange={(e) =>
              run(
                e.target.checked ? `Make ${p.name} public` : `Make ${p.name} private`,
                editor.dispatch({ type: 'editParameter', parameter: p.id, set: { public: e.target.checked } }),
              )
            }
            style={{ marginTop: 6 }}
          />
        </td>
        <td style={styles.td}>
          <span style={styles.nameCell}>
            <span
              style={styles.pendingDot}
              title={draft !== null ? 'Not committed yet: Enter or leave the field to commit it' : undefined}
            >
              {draft !== null && <Circle size={7} fill="currentColor" strokeWidth={0} />}
            </span>
            <CommitField
              label={`${p.name} name`}
              value={p.name}
              width={110}
              onCommit={(name) =>
                run('Rename', editor.dispatch({ type: 'editParameter', parameter: p.id, set: { name } }))
              }
            />
          </span>
        </td>
        <td style={styles.td}>
          {p.kind === 'choice' && p.options.length > 0 ? (
            <select
              aria-label={`${p.name} value`}
              value={fieldOf(p)}
              onChange={(e) => run(`Edit ${p.name}`, setParameterText(editor, scope, p, e.target.value))}
              style={{ ...styles.select, width: 120 }}
            >
              {p.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <span style={styles.valueCell}>
              <CommitField
                label={`${p.name} value`}
                value={unit ? fieldText(p.text, unit) : fieldOf(p)}
                invalid={preview?.ok === false}
                onDraft={setDraft}
                onCommit={(text) => run(`Edit ${p.name}`, setParameterText(editor, scope, p, text))}
              />
              {unit && <span style={styles.unit}>{unit}</span>}
            </span>
          )}
        </td>
        <td style={{ ...styles.td, ...styles.resolved }} title={preview?.ok === false ? preview.message : undefined}>
          {preview ? (preview.ok ? preview.text : '—') : evaluatedText(doc, scope, p)}
        </td>
        <td style={styles.td}>
          {input ? (
            <span style={styles.kindText} title="It chooses a configuration's row">
              {KINDS.find((k) => k.id === p.kind)?.label ?? p.kind}
            </span>
          ) : (
            <select
              aria-label={`${p.name} kind`}
              value={p.kind}
              onChange={(e) =>
                run(`Kind of ${p.name}`, setParameterKind(editor, scope, p, e.target.value as ParameterKind))
              }
              style={styles.select}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
          )}
        </td>
        <td style={styles.td}>
          <CommitField
            label={`${p.name} description`}
            value={p.description}
            width={130}
            mono={false}
            onCommit={(description) =>
              run(
                `Describe ${p.name}`,
                editor.dispatch({ type: 'editParameter', parameter: p.id, set: { description } }),
              )
            }
          />
        </td>
        <td style={styles.td}>
          <button
            type="button"
            style={styles.iconBtn}
            title={`Remove ${p.name}`}
            aria-label={`Remove ${p.name}`}
            onClick={remove}
          >
            <X size={12} />
          </button>
        </td>
      </tr>
      {p.kind === 'choice' && !input && (
        <tr>
          <td style={styles.td} />
          <td style={{ ...styles.td, ...styles.optionsLabel }}>Options:</td>
          <td style={styles.td} colSpan={4}>
            <CommitField
              label={`${p.name} options`}
              value={p.options.join(', ')}
              width={300}
              placeholder="comma-separated, e.g. hex, socket, flat"
              onCommit={(text) => run(`Edit ${p.name}`, setParameterOptions(editor, p, splitOptions(text)))}
            />
          </td>
          <td style={styles.td} />
        </tr>
      )}
    </>
  );
}

/** The row that adds a parameter: public, name (a suggested one when left empty), value with its unit, kind, description. */
export function AddParameterRow({
  doc,
  scope,
  params,
  onAdd,
}: {
  doc: Doc;
  scope: ParameterScope;
  params: readonly ParameterView[];
  onAdd: (
    name: string,
    kind: ParameterKind,
    text: string,
    options: string[],
    extra: { public: boolean; description: string },
  ) => boolean;
}) {
  const [pub, setPub] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ParameterKind>('length');
  const [text, setText] = useState('');
  const [options, setOptions] = useState('');
  const [description, setDescription] = useState('');
  const suggested = suggestedName(params);
  const list = splitOptions(options);
  const value = kind === 'choice' && text.trim() === '' ? (list[0] ?? '') : text;
  const preview = value.trim() === '' ? null : previewText(doc, scope, kind, list, value);
  const add = () => {
    if (onAdd(name.trim() || suggested, kind, value, list, { public: pub, description })) {
      setPub(false);
      setName('');
      setText('');
      setOptions('');
      setDescription('');
    }
  };
  const enter = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') add();
  };
  const unit = unitOf(kind);
  return (
    <tr style={{ background: '#fafafa' }}>
      <td style={{ ...styles.td, textAlign: 'center' }}>
        <input
          type="checkbox"
          aria-label="New parameter public"
          title="Set when the document is inserted as a component"
          checked={pub}
          onChange={(e) => setPub(e.target.checked)}
          style={{ marginTop: 6 }}
        />
      </td>
      <td style={styles.td}>
        <input
          aria-label="New parameter name"
          placeholder={suggested}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={enter}
          style={{ ...styles.input, width: 110 }}
        />
      </td>
      <td style={styles.td}>
        <span style={styles.valueCell}>
          <input
            aria-label="New parameter value"
            placeholder={kind === 'choice' ? 'option' : 'e.g. 100  or  width * 2'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={enter}
            style={{
              ...styles.input,
              width: 120,
              fontFamily: 'monospace',
              ...(preview?.ok === false ? { border: '1px solid #f59e0b' } : {}),
            }}
          />
          {unit && <span style={styles.unit}>{unit}</span>}
        </span>
        {kind === 'choice' && (
          <input
            aria-label="Options"
            placeholder="options, comma separated"
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            onKeyDown={enter}
            style={{ ...styles.input, width: 120, marginTop: 3 }}
          />
        )}
      </td>
      <td style={{ ...styles.td, ...styles.resolved }} title={preview?.ok === false ? preview.message : undefined}>
        {preview?.ok ? preview.text : '—'}
      </td>
      <td style={styles.td}>
        <select
          aria-label="New parameter kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as ParameterKind)}
          style={styles.select}
        >
          {KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </td>
      <td style={styles.td}>
        <input
          aria-label="New parameter description"
          placeholder="description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={enter}
          style={{ ...styles.input, width: 130 }}
        />
      </td>
      <td style={styles.td}>
        <button type="button" style={styles.iconBtn} title="Add parameter" aria-label="Add parameter" onClick={add}>
          <Plus size={13} />
        </button>
      </td>
    </tr>
  );
}

/** A part's model parameters, by feature: name, expression (editable) and what it comes to. */
function ModelParameters({ editor, part, run }: { editor: Editor; part: string; run: Run }) {
  const doc = useDocument(editor);
  const groups = modelParametersOf(doc, part);
  const row = (p: ModelParameter) => (
    <tr key={p.id}>
      <td style={styles.td}>
        <span style={p.name ? styles.modelName : styles.modelLabel} title={p.label}>
          {p.name ?? p.label}
        </span>
      </td>
      <td style={styles.td}>
        <CommitField
          label={`${p.name ?? p.label} expression`}
          value={p.text}
          width={160}
          onCommit={(text) => run(`Edit ${p.name ?? p.label}`, setModelParameter(editor, part, p, text))}
        />
      </td>
      <td style={{ ...styles.td, ...styles.resolved }}>{p.value}</td>
    </tr>
  );
  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Model parameters</div>
      {groups.length === 0 ? (
        <div style={styles.empty}>No model parameters</div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Name</th>
              <th style={styles.th}>Expression</th>
              <th style={styles.th}>Value</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.feature}>
              <tr>
                <td style={styles.featureCell} colSpan={3}>
                  {g.name}
                </td>
              </tr>
              {g.parameters.map(row)}
            </tbody>
          ))}
        </table>
      )}
    </div>
  );
}

function Configurations({
  editor,
  part,
  params,
  run,
  ask,
}: {
  editor: Editor;
  part: string;
  params: ParameterView[];
  run: Run;
  ask: Ask;
}) {
  const doc = useDocument(editor);
  const configurations = configurationsOf(doc, part);
  const [newRow, setNewRow] = useState('');
  if (configurations.length === 0) {
    return (
      <div style={styles.section}>
        <div style={styles.sectionTitle}>Configurations</div>
        <button
          type="button"
          style={styles.button}
          onClick={() => run('Add configuration', addConfiguration(editor, part))}
        >
          Add configuration
        </button>
      </div>
    );
  }
  const remove = (c: ConfigurationView, option: string) => {
    void ask({
      title: `Delete configuration "${option}"?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      tone: 'danger',
    }).then((yes) => {
      if (yes) run('Remove', removeConfigurationRow(editor, c, option));
    });
  };
  return (
    <>
      {configurations.map((c: ConfigurationView) => {
        const columns = params.filter((p) => p.id !== c.input.id);
        const plain = plainRow(c);
        return (
          <div key={c.id} style={styles.section}>
            <div style={styles.sectionHeader}>
              <div style={{ ...styles.sectionTitle, marginBottom: 0 }}>Configurations ({c.input.name})</div>
              {plain !== null && (
                <button
                  type="button"
                  style={styles.smallButton}
                  title="Use the parameters' own values"
                  onClick={() => run('Configuration', setActiveConfiguration(editor, c, plain))}
                >
                  Clear active
                </button>
              )}
            </div>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th} />
                  <th style={styles.th}>Name</th>
                  {columns.map((p) => (
                    <th key={p.id} style={styles.th}>
                      {p.name}
                    </th>
                  ))}
                  <th style={styles.th} />
                </tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.option}>
                    <td style={styles.td}>
                      <button
                        type="button"
                        style={{ ...styles.iconBtn, color: c.active === r.option ? '#1a6fd1' : '#bbb' }}
                        title={c.active === r.option ? 'Active' : 'Make active'}
                        onClick={() => run('Configuration', setActiveConfiguration(editor, c, r.option))}
                      >
                        <Check size={13} />
                      </button>
                    </td>
                    <td style={styles.td}>
                      <CommitField
                        label={`${r.option} name`}
                        value={r.option}
                        width={90}
                        mono={false}
                        onCommit={(to) => run('Rename', renameConfigurationRow(editor, c, r.option, to))}
                      />
                    </td>
                    {columns.map((p) => (
                      <td key={p.id} style={styles.td}>
                        <CommitField
                          label={`${r.option} ${p.name}`}
                          value={fieldOf({ kind: p.kind, text: r.overrides.get(p.id) ?? '' })}
                          placeholder={fieldOf(p)}
                          width={80}
                          onCommit={(text) =>
                            run(`Edit ${r.option}`, setConfigurationOverride(editor, part, c, r.option, p, text))
                          }
                        />
                      </td>
                    ))}
                    <td style={styles.td}>
                      <button
                        type="button"
                        style={styles.iconBtn}
                        title={`Remove ${r.option}`}
                        aria-label={`Remove ${r.option}`}
                        onClick={() => remove(c, r.option)}
                      >
                        <X size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td style={styles.td} />
                  <td style={styles.td} colSpan={columns.length + 2}>
                    <input
                      aria-label="New configuration"
                      placeholder="new configuration"
                      value={newRow}
                      onChange={(e) => setNewRow(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (
                          e.key === 'Enter' &&
                          run('Add configuration', addConfigurationRow(editor, c, newRow.trim()))
                        )
                          setNewRow('');
                      }}
                      style={{ ...styles.input, width: 140 }}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.25)',
    zIndex: 900,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialog: {
    background: '#fff',
    borderRadius: 10,
    boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    width: 820,
    maxWidth: 'calc(100vw - 40px)',
    maxHeight: 'calc(100vh - 80px)',
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: { display: 'flex', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #e8e8e8' },
  title: { flex: 1, fontSize: 13, fontWeight: 600, color: '#333' },
  tabs: { display: 'flex', gap: 2, padding: '6px 10px 0', borderBottom: '1px solid #e8e8e8' },
  tab: {
    border: 'none',
    background: 'transparent',
    padding: '6px 10px',
    fontSize: 12,
    color: '#666',
    cursor: 'pointer',
    borderBottom: '2px solid transparent',
  },
  tabActive: { color: '#1a6fd1', borderBottom: '2px solid #1a6fd1', fontWeight: 600 },
  body: { padding: 12, overflow: 'auto' },
  table: { borderCollapse: 'collapse', width: '100%' },
  th: {
    textAlign: 'left',
    fontSize: 10,
    fontWeight: 600,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    padding: '4px 6px',
  },
  td: { padding: '3px 6px', fontSize: 12, verticalAlign: 'top' },
  empty: { padding: '6px', fontSize: 11, color: '#aaa', fontStyle: 'italic' },
  input: {
    height: 26,
    padding: '0 6px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    fontSize: 12,
    color: '#333',
    outline: 'none',
    display: 'block',
  },
  select: { height: 26, border: '1px solid #d0d0d0', borderRadius: 4, fontSize: 12, background: '#fff' },
  nameCell: { display: 'flex', alignItems: 'center', gap: 2 },
  pendingDot: { width: 8, display: 'inline-flex', color: '#f59e0b', flexShrink: 0 },
  valueCell: { display: 'flex', alignItems: 'center', gap: 4 },
  unit: { fontSize: 11, color: '#999' },
  resolved: { color: '#666', fontFamily: 'monospace', fontSize: 11, paddingTop: 9 },
  kindText: { display: 'inline-block', color: '#888', fontSize: 11, paddingTop: 6 },
  optionsLabel: { fontSize: 11, color: '#888', textAlign: 'right', paddingTop: 8 },
  iconBtn: {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    color: '#888',
    cursor: 'pointer',
    borderRadius: 3,
    padding: 0,
  },
  section: { marginTop: 14, paddingTop: 10, borderTop: '1px solid #f0f0f0' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  button: {
    height: 28,
    padding: '0 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    background: '#f5f5f5',
    color: '#555',
    cursor: 'pointer',
    fontSize: 12,
  },
  smallButton: {
    height: 24,
    padding: '0 10px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#fff',
    color: '#555',
    cursor: 'pointer',
    fontSize: 11,
  },
  error: { fontSize: 11, color: '#dc2626', marginTop: 8 },
  featureCell: { padding: '6px 6px 2px', fontSize: 11, fontWeight: 600, color: '#555' },
  modelName: {
    display: 'inline-block',
    paddingTop: 5,
    paddingLeft: 10,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#333',
  },
  modelLabel: { display: 'inline-block', paddingTop: 5, paddingLeft: 10, fontSize: 12, color: '#888' },
};
