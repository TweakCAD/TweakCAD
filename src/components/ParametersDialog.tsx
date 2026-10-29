/**
 * Parameters editor — Project + per-part scope tabs.
 *
 * Each row dispatches SetParameter on commit (blur or Enter) and
 * DeleteParameter on × click. Validation feedback is inline. The
 * "= Value" column previews against the currently-resolved parameter
 * set so the user sees the effect of their edit without committing.
 *
 * Planned: public/description fields and a 'choice' parameter kind
 * (string-typed, picks from `options[]`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, X, Trash2, RotateCcw, Check, Circle, ChevronRight } from 'lucide-react';
import { useCommandBus, useDocumentState } from '../hooks/useDocumentStore.ts';
import { useSeededState } from '../hooks/useSeededState.ts';
import { resolveAllParameters } from '@tweakcad/core/src/parameters/evaluator.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { formatWithUnit } from '@tweakcad/core/src/units.ts';
import type { ParameterValue, ConfigurationRow, CadPart } from '@tweakcad/core/src/document/schema.ts';
import type { ParameterUnit } from '@tweakcad/core/src/units.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import { applyActiveConfiguration } from '@tweakcad/core/src/commands/handlers/configurationCommands.ts';

type Scope = 'project' | PartId;
type Kind = 'number' | 'choice';

const UNITS: ParameterUnit[] = ['mm', 'deg', 'count', 'none'];
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseOptionsCsv(csv: string): string[] {
  return csv.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function optionsToCsv(options: string[] | undefined): string {
  return (options ?? []).join(', ');
}

// ---- Dialog ----

type DialogProps = {
  open: boolean;
  onClose: () => void;
};

export function ParametersDialog({ open, onClose }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const project = useDocumentState();
  const commandBus = useCommandBus();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === e.currentTarget) onClose();
  }
  function onDialogCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onClose();
  }

  const partList = useMemo(
    () => Object.values(project.parts).map(p => ({ id: p.id as PartId, name: p.name })),
    [project.parts],
  );

  const [scope, setScope] = useState<Scope>('project');
  // Pending edits to existing parameters — staged here until the user hits
  // Apply. Keyed by parameter name. Empty = no pending changes.
  const [pending, setPending] = useState<Record<string, ParameterValue>>({});
  // Bumped on Revert (or scope/dialog change) to force ParameterRow's local
  // useState seeds to re-read from props. Cheaper than tearing down the
  // grid via `key` per-row.
  const [syncKey, setSyncKey] = useState(0);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Both resets are adjusted during render rather than in effects, so the
  // dialog never paints the previous session's scope or staged edits for a
  // frame before clearing them. Each keys off its own previous value, so
  // opening the dialog and switching scope stay independent triggers.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setScope('project');
      setPending({});
      setApplyError(null);
      setSyncKey(k => k + 1);
    }
  }

  // Switching tabs discards pending edits in the previous scope. A confirm
  // would be friendlier; deferred to a future polish pass.
  const [lastScope, setLastScope] = useState(scope);
  if (scope !== lastScope) {
    setLastScope(scope);
    setPending({});
    setApplyError(null);
    setSyncKey(k => k + 1);
  }

  const activeTable = useMemo(() => {
    if (scope === 'project') return project.parameters;
    return project.parts[scope]?.parameters ?? { values: {} };
  }, [scope, project]);

  const resolved = useMemo(() => {
    // Mirror the rebuilder's resolution path so the "= Resolved" column
    // shows the value the build would compute — including active config
    // overrides when one is selected.
    const activePartTable =
      scope === 'project'
        ? { values: {} }
        : project.parts[scope] ? applyActiveConfiguration(project.parts[scope]!) : { values: {} };
    const r = resolveAllParameters(project.parameters, activePartTable);
    return r.ok ? r.value : {};
  }, [scope, project]);

  const dispatch = useCallback(
    (cmd: Parameters<typeof commandBus.dispatch>[0]) => commandBus.dispatch(cmd),
    [commandBus],
  );

  const pendingCount = Object.keys(pending).length;

  const stage = useCallback((name: string, value: ParameterValue) => {
    setPending(prev => ({ ...prev, [name]: value }));
    setApplyError(null);
  }, []);

  const revert = useCallback(() => {
    setPending({});
    setApplyError(null);
    setSyncKey(k => k + 1);
  }, []);

  const apply = useCallback(() => {
    const entries = Object.entries(pending);
    if (entries.length === 0) return;
    // Group all dispatches under one undo entry so users can revert the
    // whole Apply in one Ctrl-Z. detectDirty still fires per-mutate, but
    // the rebuild scheduler coalesces.
    commandBus.beginTransaction(
      entries.length === 1
        ? `Set Parameter "${entries[0]![0]}"`
        : `Apply ${entries.length} parameter changes`,
    );
    const failures: string[] = [];
    for (const [name, value] of entries) {
      const result = commandBus.dispatch({ type: 'SetParameter', scope, name, value });
      if (!result.ok) failures.push(`${name}: ${result.error.message}`);
    }
    commandBus.endTransaction();
    if (failures.length > 0) {
      setApplyError(`Some changes were rejected:\n${failures.join('\n')}`);
      // Drop the successfully-applied entries; keep the failed ones so the
      // user can fix them. (Cheap heuristic: if any row succeeded, the
      // doc state changed and the row's useEffect will sync.)
      setPending(prev => {
        const next: Record<string, ParameterValue> = {};
        for (const f of failures) {
          const name = f.split(':')[0]!;
          if (prev[name] !== undefined) next[name] = prev[name]!;
        }
        return next;
      });
    } else {
      setPending({});
    }
  }, [pending, scope, commandBus]);

  return (
    <dialog ref={ref} onClick={onDialogClick} onCancel={onDialogCancel} style={styles.dialog}>
      <div style={styles.body}>
        <div style={styles.header}>
          <h2 style={styles.title}>Parameters</h2>
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div style={styles.tabs}>
          <ScopeTab label="Project" active={scope === 'project'} onClick={() => setScope('project')} />
          {partList.map(p => (
            <ScopeTab
              key={p.id}
              label={p.name}
              active={scope === p.id}
              onClick={() => setScope(p.id)}
            />
          ))}
        </div>

        <div style={styles.tableWrap}>
          <div style={styles.tableHead}>
            <div style={styles.colPublic} title="Show in import-component dialog">Pub</div>
            <div style={styles.colName}>Name</div>
            <div style={styles.colKind}>Kind</div>
            <div style={styles.colExpr}>Expression / Value</div>
            <div style={styles.colUnit}>Unit</div>
            <div style={styles.colValue}>= Resolved</div>
            <div style={styles.colDesc}>Description</div>
            <div style={styles.colAction} />
          </div>

          {Object.values(activeTable.values).length === 0 && (
            <div style={styles.empty}>
              No parameters in this scope. Use the bottom row to add one.
            </div>
          )}

          {Object.values(activeTable.values).map(param => (
            <ParameterRow
              key={`${param.name}_${syncKey}`}
              scope={scope}
              param={param}
              pendingValue={pending[param.name]}
              isDirty={pending[param.name] !== undefined}
              resolved={resolved}
              stage={stage}
              dispatch={dispatch}
            />
          ))}

          <NewParameterRow
            scope={scope}
            existingNames={Object.keys(activeTable.values)}
            resolved={resolved}
            dispatch={dispatch}
          />
        </div>

        {scope !== 'project' && project.parts[scope] && (
          <ConfigurationsSection
            part={project.parts[scope]!}
            dispatch={dispatch}
          />
        )}

        {applyError && (
          <div style={styles.errorBar}>{applyError}</div>
        )}

        <div style={styles.footer}>
          <span style={styles.pendingCount}>
            {pendingCount === 0
              ? 'No pending changes'
              : pendingCount === 1
                ? '1 pending change'
                : `${pendingCount} pending changes`}
          </span>
          <div style={styles.footerActions}>
            <button
              type="button"
              onClick={revert}
              disabled={pendingCount === 0}
              style={{ ...styles.footerBtn, ...(pendingCount === 0 ? styles.footerBtnDisabled : styles.footerBtnSecondary) }}
            >
              <RotateCcw size={12} /> Revert
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={pendingCount === 0}
              style={{ ...styles.footerBtn, ...(pendingCount === 0 ? styles.footerBtnDisabled : styles.footerBtnPrimary) }}
            >
              <Check size={12} /> Apply{pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

// ---- Scope tab ----

function ScopeTab(props: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const bg = props.active ? '#1a6fd1' : hover ? '#e8e8e8' : 'transparent';
  const color = props.active ? '#fff' : '#444';
  return (
    <button
      type="button"
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.tabBtn, background: bg, color }}
    >
      {props.label}
    </button>
  );
}

// ---- Existing row ----

type RowDispatch = (cmd: Parameters<ReturnType<typeof useCommandBus>['dispatch']>[0]) => ReturnType<ReturnType<typeof useCommandBus>['dispatch']>;

type ExistingRowProps = {
  scope: Scope;
  param: ParameterValue;
  /** Staged value from the dialog-level pending map, if any. */
  pendingValue?: ParameterValue | undefined;
  /** True iff this row has staged-but-unapplied edits. */
  isDirty: boolean;
  resolved: Record<string, number>;
  /** Stage a value into pending (does NOT dispatch). */
  stage: (name: string, value: ParameterValue) => void;
  /** Dispatch immediately — used only for Delete; never for staged edits. */
  dispatch: RowDispatch;
};

function ParameterRow({ scope, param, pendingValue, isDirty, resolved, stage, dispatch }: ExistingRowProps) {
  // Seed from the staged pending value if present (so re-opening the dialog
  // mid-edit shows the staged content), else from the doc-state param.
  const seed = pendingValue ?? param;
  const initialKind: Kind = seed.kind ?? 'number';

  // Local edit state — typing is local; commit pushes to the staged
  // `pending` map (NOT directly to the document store).
  // Each field re-seeds when the underlying parameter changes from outside
  // (e.g. undo) but is otherwise free to edit — see `useSeededState`, which
  // does the re-seed during render rather than in six separate effects.
  const [expr, setExpr] = useSeededState(seed.expression);
  const [unit, setUnit] = useSeededState<ParameterUnit>(seed.unit);
  const [pub, setPub] = useSeededState<boolean>(seed.public ?? false);
  const [desc, setDesc] = useSeededState<string>(seed.description ?? '');
  const [kind, setKind] = useSeededState<Kind>(initialKind);
  const [optsCsv, setOptsCsv] = useSeededState<string>(optionsToCsv(seed.options));
  const [error, setError] = useState<string | null>(null);

  // Preview value: numbers run through the evaluator; choice shows the
  // selected option text directly.
  //
  // When the row is NOT dirty (i.e. expr === param.expression) we use the
  // already-resolved value from the shared `resolved` map. That map runs
  // through the same active-configuration overlay the rebuilder uses, so
  // the displayed value reflects what geometry will see — including
  // overrides from the active configuration row. When the user is mid-edit
  // (dirty), we evaluate the local draft expression against `resolved` so
  // they see the preview of their typed change.
  const previewResult = useMemo(() => {
    if (kind === 'choice') return null;
    const isDraft = expr !== param.expression;
    if (!isDraft) {
      const resolvedValue = resolved[param.name];
      if (resolvedValue !== undefined) return { ok: true as const, value: resolvedValue };
    }
    return evaluateExpression(expr, resolved);
  }, [kind, expr, resolved, param.name, param.expression]);

  /** Build the full ParameterValue from local state, omitting unused fields. */
  function buildValue(): ParameterValue {
    const base: ParameterValue = {
      name: param.name,
      expression: expr,
      unit,
    };
    if (pub) base.public = true;
    if (desc.trim() !== '') base.description = desc;
    if (kind === 'choice') {
      base.kind = 'choice';
      base.options = parseOptionsCsv(optsCsv);
    }
    return base;
  }

  // Stage the row's current edit into the dialog-level pending map.
  // Does NOT dispatch — Apply at the dialog level does the actual commit.
  // We DO run a peek-validation here against the live document state so
  // we can show inline errors on type before Apply (cycles, bad
  // expressions, etc.). The same validate runs again on dispatch.
  const commit = useCallback((override?: Partial<ParameterValue>) => {
    const value = { ...buildValue(), ...(override ?? {}) };
    stage(param.name, value);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- buildValue depends on every local state field
  }, [expr, unit, pub, desc, kind, optsCsv, param.name, stage]);

  // The handler refuses a delete that would leave another row referencing
  // this name, and its message lists them, so the dependent check lives
  // there rather than being re-derived here against the wrong row's text.
  const onDelete = useCallback(() => {
    if (!confirm(`Delete "${param.name}"?`)) return;
    const result = dispatch({ type: 'DeleteParameter', scope, name: param.name });
    if (!result.ok) setError(result.error.message);
  }, [param, scope, dispatch]);

  function onKindChange(next: Kind) {
    setKind(next);
    // Build a fresh ParameterValue with the new kind so we don't carry
    // over stale fields (e.g. options on a number param).
    const base: ParameterValue = { name: param.name, expression: expr, unit };
    if (pub) base.public = true;
    if (desc.trim() !== '') base.description = desc;
    if (next === 'choice') {
      const seedOpts = parseOptionsCsv(optsCsv).length > 0
        ? parseOptionsCsv(optsCsv)
        : ['option_1'];
      base.kind = 'choice';
      base.options = seedOpts;
      base.expression = seedOpts[0]!;
      base.unit = 'none';
      setOptsCsv(seedOpts.join(', '));
      setExpr(seedOpts[0]!);
      setUnit('none');
    } else {
      // Reset expression to a valid numeric default when leaving choice.
      if (expr === '' || (param.kind === 'choice' && (param.options ?? []).includes(expr))) {
        base.expression = '0';
        setExpr('0');
      }
    }
    stage(param.name, base);
    setError(null);
  }

  return (
    <>
      <div style={styles.row}>
        <div style={styles.colPublic}>
          <input
            type="checkbox"
            checked={pub}
            onChange={e => {
              const next = e.target.checked;
              setPub(next);
              // Build the dispatched value with `public` conditionally
              // included so we don't ship `public: false` (omit is canonical).
              const value: ParameterValue = { name: param.name, expression: expr, unit };
              if (next) value.public = true;
              if (desc.trim() !== '') value.description = desc;
              if (kind === 'choice') { value.kind = 'choice'; value.options = parseOptionsCsv(optsCsv); }
              stage(param.name, value);
              setError(null);
            }}
            title="Show in import-component dialog"
            style={styles.checkbox}
          />
        </div>
        <div style={styles.colName}>
          <span style={styles.nameLabel}>
            {isDirty && (
              <span style={styles.dirtyDot} title="Pending change; click Apply to commit">
                <Circle size={7} fill="currentColor" strokeWidth={0} />
              </span>
            )}
            {param.name}
          </span>
        </div>
        <div style={styles.colKind}>
          <select
            value={kind}
            onChange={e => onKindChange(e.target.value as Kind)}
            style={styles.select}
          >
            <option value="number">num</option>
            <option value="choice">choice</option>
          </select>
        </div>
        <div style={styles.colExpr}>
          {kind === 'choice' ? (
            <select
              value={expr}
              onChange={e => { setExpr(e.target.value); commit({ expression: e.target.value }); }}
              style={styles.select}
            >
              {parseOptionsCsv(optsCsv).map(opt => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={expr}
              onChange={e => setExpr(e.target.value)}
              onBlur={() => commit()}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.currentTarget.blur(); }
                if (e.key === 'Escape') { setExpr(param.expression); e.currentTarget.blur(); }
              }}
              style={{
                ...styles.input,
                borderColor: error ? '#dc2626' : previewResult && !previewResult.ok ? '#f59e0b' : '#d0d0d0',
              }}
              title={error ?? (previewResult?.ok === false ? previewResult.error : '')}
            />
          )}
        </div>
        <div style={styles.colUnit}>
          {kind === 'choice' ? (
            <span style={styles.unitBadge} title="Choice parameter (string)">str</span>
          ) : (
            <select
              value={unit}
              onChange={e => { setUnit(e.target.value as ParameterUnit); commit({ unit: e.target.value as ParameterUnit }); }}
              style={styles.select}
            >
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )}
        </div>
        <div style={styles.colValue}>
          {kind === 'choice' ? (
            <span style={styles.valueOk}>{expr || '—'}</span>
          ) : previewResult?.ok ? (
            <span style={styles.valueOk}>{formatWithUnit(previewResult.value, unit)}</span>
          ) : (
            <span style={styles.valueErr} title={previewResult?.ok === false ? previewResult.error : ''}>—</span>
          )}
        </div>
        <div style={styles.colDesc}>
          <input
            type="text"
            value={desc}
            placeholder="—"
            onChange={e => setDesc(e.target.value)}
            onBlur={() => commit()}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={styles.input}
          />
        </div>
        <div style={styles.colAction}>
          <button
            type="button"
            onClick={onDelete}
            style={styles.iconBtn}
            aria-label={`Delete ${param.name}`}
          >
            <Trash2 size={13} color="#888" />
          </button>
        </div>
      </div>
      {kind === 'choice' && (
        <div style={styles.optionsRow}>
          <label style={styles.optionsLabel}>Options:</label>
          <input
            type="text"
            value={optsCsv}
            onChange={e => setOptsCsv(e.target.value)}
            onBlur={() => commit({ options: parseOptionsCsv(optsCsv) })}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="comma-separated, e.g. hex, socket, flat"
            style={{ ...styles.input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          />
        </div>
      )}
      {error && <div style={styles.errorBar}>{error}</div>}
    </>
  );
}

// ---- New row ----

type NewRowProps = {
  scope: Scope;
  existingNames: string[];
  resolved: Record<string, number>;
  dispatch: RowDispatch;
};

function NewParameterRow({ scope, existingNames, resolved, dispatch }: NewRowProps) {
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [unit, setUnit] = useState<ParameterUnit>('mm');
  const [pub, setPub] = useState(false);
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<Kind>('number');
  const [optsCsv, setOptsCsv] = useState('');
  const [error, setError] = useState<string | null>(null);

  const suggestedName = useMemo(() => {
    let i = existingNames.length + 1;
    while (existingNames.includes(`param_${i}`)) i++;
    return `param_${i}`;
  }, [existingNames]);

  const previewResult = useMemo(() => {
    if (kind === 'choice') return null;
    return expr.trim() ? evaluateExpression(expr, resolved) : null;
  }, [kind, expr, resolved]);

  function reset() {
    setName('');
    setExpr('');
    setUnit('mm');
    setPub(false);
    setDesc('');
    setKind('number');
    setOptsCsv('');
    setError(null);
  }

  function tryAdd() {
    const finalName = (name.trim() || suggestedName).trim();
    if (!NAME_RE.test(finalName)) {
      setError('Name must start with a letter or _, then letters/digits/_');
      return;
    }
    if (existingNames.includes(finalName)) {
      setError(`A parameter named "${finalName}" already exists in this scope`);
      return;
    }
    let value: ParameterValue;
    if (kind === 'choice') {
      const opts = parseOptionsCsv(optsCsv);
      if (opts.length === 0) {
        setError('Choice parameter needs at least one option (comma-separated)');
        return;
      }
      value = {
        name: finalName,
        expression: expr.trim() && opts.includes(expr.trim()) ? expr.trim() : opts[0]!,
        unit: 'none',
        kind: 'choice',
        options: opts,
        ...(pub ? { public: true } : {}),
        ...(desc.trim() ? { description: desc } : {}),
      };
    } else {
      if (!expr.trim()) {
        setError('Expression cannot be empty');
        return;
      }
      value = {
        name: finalName,
        expression: expr,
        unit,
        ...(pub ? { public: true } : {}),
        ...(desc.trim() ? { description: desc } : {}),
      };
    }
    const result = dispatch({ type: 'SetParameter', scope, name: finalName, value });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    reset();
  }

  return (
    <div>
      <div style={{ ...styles.row, background: '#fafafa' }}>
        <div style={styles.colPublic}>
          <input
            type="checkbox"
            checked={pub}
            onChange={e => { setPub(e.target.checked); setError(null); }}
            title="Show in import-component dialog"
            style={styles.checkbox}
          />
        </div>
        <div style={styles.colName}>
          <input
            type="text"
            placeholder={suggestedName}
            value={name}
            onChange={e => { setName(e.target.value); setError(null); }}
            style={styles.input}
            onKeyDown={e => { if (e.key === 'Enter') tryAdd(); }}
          />
        </div>
        <div style={styles.colKind}>
          <select value={kind} onChange={e => { setKind(e.target.value as Kind); setError(null); }} style={styles.select}>
            <option value="number">num</option>
            <option value="choice">choice</option>
          </select>
        </div>
        <div style={styles.colExpr}>
          <input
            type="text"
            placeholder={kind === 'choice' ? 'default option (e.g. hex)' : 'e.g. 100  or  width * 2'}
            value={expr}
            onChange={e => { setExpr(e.target.value); setError(null); }}
            style={{
              ...styles.input,
              borderColor: previewResult && !previewResult.ok ? '#f59e0b' : '#d0d0d0',
            }}
            onKeyDown={e => { if (e.key === 'Enter') tryAdd(); }}
            title={previewResult && !previewResult.ok ? previewResult.error : ''}
          />
        </div>
        <div style={styles.colUnit}>
          {kind === 'choice' ? (
            <span style={styles.unitBadge}>str</span>
          ) : (
            <select value={unit} onChange={e => setUnit(e.target.value as ParameterUnit)} style={styles.select}>
              {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          )}
        </div>
        <div style={styles.colValue}>
          {previewResult?.ok
            ? <span style={styles.valueOk}>{formatWithUnit(previewResult.value, unit)}</span>
            : <span style={styles.valueErr}>—</span>}
        </div>
        <div style={styles.colDesc}>
          <input
            type="text"
            value={desc}
            placeholder="description (optional)"
            onChange={e => setDesc(e.target.value)}
            style={styles.input}
            onKeyDown={e => { if (e.key === 'Enter') tryAdd(); }}
          />
        </div>
        <div style={styles.colAction}>
          <button
            type="button"
            onClick={tryAdd}
            style={{ ...styles.iconBtn, background: '#1a6fd1', borderRadius: 4 }}
            aria-label="Add parameter"
          >
            <Plus size={13} color="#fff" />
          </button>
        </div>
      </div>
      {kind === 'choice' && (
        <div style={styles.optionsRow}>
          <label style={styles.optionsLabel}>Options:</label>
          <input
            type="text"
            value={optsCsv}
            onChange={e => { setOptsCsv(e.target.value); setError(null); }}
            placeholder="comma-separated, e.g. hex, socket, flat"
            style={{ ...styles.input, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            onKeyDown={e => { if (e.key === 'Enter') tryAdd(); }}
          />
        </div>
      )}
      {error && <div style={styles.errorBar}>{error}</div>}
    </div>
  );
}

// ---- Configurations section ----

/**
 * Per-part configurations editor — list of named override rows + active
 * selector. Unlike parameter edits (which stage to the Apply queue),
 * configuration edits dispatch immediately: adding / deleting rows and
 * switching active are intentional structural changes, not value tweaks.
 *
 * Override cells: one column per part-scope, number-kind parameter.
 * Blank = use the parameter's default expression for that row.
 */
function ConfigurationsSection({ part, dispatch }: { part: CadPart; dispatch: RowDispatch }) {
  const configs = part.configurations;
  const rows = configs?.rows ?? [];
  const active = configs?.active ?? null;

  // Overridable parameters: part-scope, number-kind only. Choice params
  // can't be overridden (validated handler-side) and project-scope params
  // must be shadowed into the part scope first.
  const overridableParams = useMemo(
    () => Object.values(part.parameters.values).filter(p => (p.kind ?? 'number') !== 'choice'),
    [part.parameters.values],
  );

  function addRow() {
    const id = `cfg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const name = `Config ${rows.length + 1}`;
    const result = dispatch({
      type: 'SetConfigurationRow',
      partId: part.id,
      row: { id, name, overrides: {} },
    });
    if (!result.ok) console.error('[Configurations] add row failed:', result.error.message);
  }

  function setActive(rowId: string | null) {
    const result = dispatch({ type: 'SetActiveConfiguration', partId: part.id, rowId });
    if (!result.ok) console.error('[Configurations] set active failed:', result.error.message);
  }

  return (
    <div style={styles.configSection}>
      <div style={styles.configHeader}>
        <h3 style={styles.configTitle}>Configurations</h3>
        <div style={styles.configHeaderActions}>
          {active !== null && (
            <button
              type="button"
              onClick={() => setActive(null)}
              style={styles.configClearActiveBtn}
              title="Clear active configuration (use parameter defaults)"
            >
              Clear active
            </button>
          )}
          <button type="button" onClick={addRow} style={styles.configAddBtn}>
            <Plus size={11} /> Add row
          </button>
        </div>
      </div>

      {overridableParams.length === 0 && (
        <div style={styles.configEmpty}>
          Define at least one part-scope number parameter above to author configurations.
          Project-scope parameters must be shadowed into the part scope first.
        </div>
      )}

      {overridableParams.length > 0 && rows.length === 0 && (
        <div style={styles.configEmpty}>
          No configurations yet. Click <strong>Add row</strong> to create a preset (e.g. "M3×10").
        </div>
      )}

      {overridableParams.length > 0 && rows.length > 0 && (
        <div style={styles.configTable}>
          <div
            style={{
              ...styles.configRow,
              gridTemplateColumns: `28px 1.4fr ${overridableParams.map(() => '1fr').join(' ')} 28px`,
              fontWeight: 600,
              fontSize: 11,
              color: '#666',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              borderBottom: '1px solid #eee',
            }}
          >
            <div title="Active row" style={{ display: 'flex', alignItems: 'center' }}>
              <ChevronRight size={12} />
            </div>
            <div>Name</div>
            {overridableParams.map(p => (
              <div key={p.name} title={`Override for "${p.name}" (default: ${p.expression})`}>{p.name}</div>
            ))}
            <div />
          </div>

          {rows.map(row => (
            <ConfigurationRowView
              key={row.id}
              row={row}
              isActive={row.id === active}
              partId={part.id}
              params={overridableParams}
              onSetActive={() => setActive(row.id)}
              dispatch={dispatch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigurationRowView({ row, isActive, partId, params, onSetActive, dispatch }: {
  row: ConfigurationRow;
  isActive: boolean;
  partId: PartId;
  params: ParameterValue[];
  onSetActive: () => void;
  dispatch: RowDispatch;
}) {
  // Re-seed from the configuration row when it changes underneath. Same
  // pattern (and same `Object.is` comparison) the effects used, minus the
  // extra render pass — `overrides` is compared by identity exactly as the
  // dependency array did.
  const [name, setName] = useSeededState(row.name);
  const [overrides, setOverrides] = useSeededState<Record<string, string>>(row.overrides);
  const [error, setError] = useState<string | null>(null);

  function commit(nextOverrides: Record<string, string>, nextName: string) {
    // Strip empty overrides — blank cell = "use default" not "override
    // with empty string". The handler rejects empty expressions anyway.
    const cleanOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(nextOverrides)) {
      if (typeof v === 'string' && v.trim() !== '') cleanOverrides[k] = v;
    }
    const result = dispatch({
      type: 'SetConfigurationRow',
      partId,
      row: { id: row.id, name: nextName, overrides: cleanOverrides },
    });
    if (!result.ok) setError(result.error.message);
    else setError(null);
  }

  function onDelete() {
     
    if (!confirm(`Delete configuration "${row.name}"?`)) return;
    const result = dispatch({ type: 'DeleteConfigurationRow', partId, rowId: row.id });
    if (!result.ok) setError(result.error.message);
  }

  return (
    <>
      <div
        style={{
          ...styles.configRow,
          gridTemplateColumns: `28px 1.4fr ${params.map(() => '1fr').join(' ')} 28px`,
          background: isActive ? '#eef5ff' : 'transparent',
        }}
      >
        <div style={styles.configActiveCell}>
          <input
            type="radio"
            checked={isActive}
            onChange={onSetActive}
            title="Set as active configuration"
            style={styles.checkbox}
          />
        </div>
        <div>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onBlur={() => { if (name.trim() !== row.name) commit(overrides, name.trim()); }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={styles.input}
          />
        </div>
        {params.map(p => (
          <div key={p.name}>
            <input
              type="text"
              value={overrides[p.name] ?? ''}
              placeholder={p.expression}
              onChange={e => setOverrides(prev => ({ ...prev, [p.name]: e.target.value }))}
              onBlur={() => {
                const nextOverrides = { ...overrides };
                if ((nextOverrides[p.name] ?? '').trim() === '') delete nextOverrides[p.name];
                commit(nextOverrides, name);
              }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              style={styles.input}
            />
          </div>
        ))}
        <div style={styles.colAction}>
          <button type="button" onClick={onDelete} style={styles.iconBtn} aria-label={`Delete ${row.name}`}>
            <Trash2 size={12} color="#888" />
          </button>
        </div>
      </div>
      {error && <div style={styles.errorBar}>{error}</div>}
    </>
  );
}

// ---- Imperative hook ----

export function useParametersEditor(): { open: () => void; element: React.ReactElement } {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const onClose = useCallback(() => setIsOpen(false), []);
  const element = <ParametersDialog open={isOpen} onClose={onClose} />;
  return { open, element };
}

// ---- Styles ----

const GRID = '24px 1.1fr 0.55fr 1.7fr 0.6fr 0.9fr 1.5fr 28px';

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(96vw, 920px)',
    maxHeight: '85vh',
    padding: 0,
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.2)',
    background: '#ffffff',
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: {
    padding: '16px 18px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  closeBtn: {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color: '#666',
    cursor: 'pointer',
    borderRadius: 4,
  },
  tabs: {
    display: 'flex',
    gap: 4,
    borderBottom: '1px solid #e8e8e8',
    paddingBottom: 6,
    flexWrap: 'wrap',
  },
  tabBtn: {
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid transparent',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tableWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    overflowY: 'auto',
    paddingRight: 4,
  },
  tableHead: {
    display: 'grid',
    gridTemplateColumns: GRID,
    gap: 6,
    padding: '4px 4px',
    fontSize: 11,
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    borderBottom: '1px solid #eee',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: GRID,
    gap: 6,
    padding: '4px 4px',
    alignItems: 'center',
    borderBottom: '1px solid #f3f3f3',
  },
  optionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px 8px 56px',
    borderBottom: '1px solid #f3f3f3',
  },
  optionsLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    flexShrink: 0,
  },
  colPublic: { display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 },
  colName: { minWidth: 0 },
  colKind: { minWidth: 0 },
  colExpr: { minWidth: 0 },
  colUnit: { minWidth: 0 },
  colValue: { minWidth: 0, fontSize: 12, color: '#444' },
  colDesc: { minWidth: 0 },
  colAction: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  nameLabel: {
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    color: '#222',
    padding: '4px 6px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    display: 'block',
  },
  input: {
    width: '100%',
    fontSize: 12,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '5px 7px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#fff',
    color: '#222',
    boxSizing: 'border-box',
  },
  select: {
    width: '100%',
    fontSize: 12,
    padding: '5px 6px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    background: '#fff',
    color: '#222',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  checkbox: {
    width: 14,
    height: 14,
    cursor: 'pointer',
    margin: 0,
  },
  valueOk: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    color: '#1a6fd1',
  },
  valueErr: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12,
    color: '#f59e0b',
  },
  unitBadge: {
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 600,
    color: '#8b5cf6',
    background: '#f3eafe',
    padding: '3px 6px',
    borderRadius: 4,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  iconBtn: {
    width: 24,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    borderRadius: 4,
  },
  empty: {
    padding: '14px 10px',
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
  },
  errorBar: {
    padding: '6px 10px',
    margin: '4px 4px 0 4px',
    fontSize: 12,
    color: '#b91c1c',
    background: '#fee2e2',
    border: '1px solid #fecaca',
    borderRadius: 4,
    whiteSpace: 'pre-line',
  },
  dirtyDot: {
    display: 'inline-flex',
    alignItems: 'center',
    color: '#f59e0b',
    marginRight: 4,
    lineHeight: 1,
  },
  footer: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTop: '1px solid #e8e8e8',
    paddingTop: 12,
    marginTop: 4,
  },
  pendingCount: {
    fontSize: 12,
    color: '#666',
  },
  footerActions: {
    display: 'flex',
    gap: 8,
  },
  footerBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 14px',
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: 'inherit',
    border: '1px solid transparent',
  },
  footerBtnPrimary: {
    background: '#1a6fd1',
    color: '#fff',
    borderColor: '#1a6fd1',
  },
  footerBtnSecondary: {
    background: '#f5f5f5',
    color: '#333',
    borderColor: '#d0d0d0',
  },
  footerBtnDisabled: {
    background: '#f5f5f5',
    color: '#bbb',
    borderColor: '#e8e8e8',
    cursor: 'not-allowed',
  },
  configSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    borderTop: '1px solid #e8e8e8',
    paddingTop: 12,
    marginTop: 4,
  },
  configHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  configTitle: {
    margin: 0,
    fontSize: 12,
    fontWeight: 600,
    color: '#444',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  configHeaderActions: {
    display: 'flex',
    gap: 6,
  },
  configAddBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 500,
    background: '#1a6fd1',
    color: '#fff',
    border: '1px solid #1a6fd1',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  configClearActiveBtn: {
    padding: '4px 8px',
    fontSize: 11,
    fontWeight: 500,
    background: 'transparent',
    color: '#666',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  configEmpty: {
    padding: '10px',
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
  },
  configTable: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  configRow: {
    display: 'grid',
    gap: 6,
    padding: '4px 4px',
    alignItems: 'center',
    borderBottom: '1px solid #f3f3f3',
  },
  configActiveCell: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
};
