/**
 * Per-instance properties editor for an `component` feature.
 *
 * Lets the consumer pick a configuration row, override individual public
 * parameters, and choose the boolean op against host bodies — without
 * touching the embedded source. All edits are staged locally and applied
 * as a single `ReplaceFeatureInputs` dispatch (one undo step, one rebuild).
 *
 * A transform UX (numeric panel + gizmo + snap picker) is not yet
 * built. The transform is preserved in the feature inputs untouched so
 * it can grow into the same dialog as a tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCcw, Check } from 'lucide-react';
import { useCommandBus, useDocumentState } from '../hooks/useDocumentStore.ts';
import { resolveAllParameters } from '@tweakcad/core/src/parameters/evaluator.ts';
import { evaluateExpression } from '@tweakcad/core/src/expressions.ts';
import { formatWithUnit } from '@tweakcad/core/src/units.ts';
import type {
  CadPart,
  ComponentDefinition,
  ComponentFeatureInputs,
  ParameterValue,
} from '@tweakcad/core/src/document/schema.ts';
import type { PartId, FeatureId } from '@tweakcad/core/src/ids.ts';

// ---- Dialog props ----

type DialogProps = {
  open: boolean;
  partId: PartId | null;
  featureId: FeatureId | null;
  onClose: () => void;
};

type BooleanMode = 'newBody' | 'cut' | 'join';

type DraftState = {
  /**
   * Per-parameter override expressions keyed by param name. Empty string
   * means "no override" (we'll drop this entry on Apply so the doc keeps
   * the default expression).
   */
  overrides: Record<string, string>;
  /** `'__defaults__'` = no active config. Any other value = row id. */
  configRowId: string;
  boolean: BooleanMode;
};

const DEFAULTS_ROW_ID = '__defaults__';

/**
 * Build the dialog's initial draft from the live feature inputs. Called
 * on open AND on Revert; never reads its own state, so it's pure.
 */
function makeDraftFrom(
  inputs: ComponentFeatureInputs,
  componentPart: CadPart,
): DraftState {
  // Seed overrides with what's in the feature today. Empty record =
  // "no overrides" — all public params show their default expression.
  const overrides: Record<string, string> = {};
  for (const [name, expr] of Object.entries(inputs.parameterOverrides ?? {})) {
    overrides[name] = String(expr);
  }
  // Per-instance configurationId wins over the embedded component's
  // own active row; matches the rebuilder's merge order.
  const perInstance = inputs.configurationId;
  const embeddedActive = componentPart.configurations?.active ?? null;
  const effectiveId = perInstance !== undefined && perInstance !== null
    ? perInstance
    : embeddedActive;
  return {
    overrides,
    configRowId: effectiveId ?? DEFAULTS_ROW_ID,
    boolean: inputs.boolean ?? 'newBody',
  };
}

// ---- Component ----

export function ComponentDialog({ open, partId, featureId, onClose }: DialogProps) {
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

  // Resolve the live feature + embedded component each render (the
  // dialog state lifecycle is short — opens, edits, applies, closes —
  // so re-reading is cheaper than caching).
  const resolved = useMemo(() => {
    if (!partId || !featureId) return null;
    const part = project.parts[partId];
    if (!part) return null;
    const feature = part.timeline.find(f => f.id === featureId);
    if (!feature || feature.type !== 'component') return null;
    const inputs = feature.inputs as unknown as ComponentFeatureInputs;
    const def: ComponentDefinition | undefined =
      project.embeddedComponents?.[inputs.componentRef];
    if (!def) return null;
    const compPartIds = Object.keys(def.source.parts);
    const compPartId = compPartIds[0];
    if (!compPartId) return null;
    const compPart = def.source.parts[compPartId as keyof typeof def.source.parts];
    if (!compPart) return null;
    return { feature, inputs, def, compPart };
  }, [project, partId, featureId]);

  const [draft, setDraft] = useState<DraftState | null>(null);

  // Seed draft on open. Keying off `open` (not `resolved`) keeps the draft
  // stable while the user is editing — a stray rebuild that bumps `project`
  // would otherwise clobber half-typed entries.
  //
  // Adjusted during render rather than in an effect, which also removes the
  // `exhaustive-deps` suppression: the effect intentionally read `resolved`
  // without depending on it, and suppressing the warning hid that intent
  // behind a blanket disable. The explicit previous-value check says it
  // outright — react to `open` flipping, read `resolved` as of now.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open && resolved) {
      setDraft(makeDraftFrom(resolved.inputs, resolved.compPart));
    } else if (!open) {
      setDraft(null);
    }
  }

  // Public parameters to expose in the editor. We surface BOTH the
  // embedded source's project-scope and part-scope params — most
  // .cadcomponent stubs (dowel_pin, washer, bolt_stub…) declare their
  // public knobs at the project scope because the component IS the
  // project from the author's perspective. Builder applies overrides
  // to whichever scope holds the param. Hides internal helpers
  // (matches the design doc §3 "Public" column intent); fallback to
  // every param if nothing is marked public so a stub author who
  // forgot to flag knobs isn't locked out.
  const publicParams = useMemo<ParameterValue[]>(() => {
    if (!resolved) return [];
    const all: ParameterValue[] = [
      ...Object.values(resolved.def.source.parameters.values),
      ...Object.values(resolved.compPart.parameters.values),
    ];
    const marked = all.filter(p => p.public === true);
    const chosen = marked.length > 0 ? marked : all;
    // Defensive: if the same name appears in both scopes, dedup by
    // name (project scope wins since the builder checks part scope
    // first, but for display either is fine — they're the same
    // logical knob from the author's point of view).
    const byName = new Map<string, ParameterValue>();
    for (const p of chosen) {
      if (!byName.has(p.name)) byName.set(p.name, p);
    }
    return Array.from(byName.values());
  }, [resolved]);

  // Resolve current parameter values so we can show "= 4.00 mm" hints
  // next to each row. Mirrors the builder's merge logic
  // (buildComponent.applyInstanceOverrides): config-row
  // overrides apply at PART scope; per-instance overrides flow into
  // whichever scope holds the param. Without that, an override of a
  // project-scope param like the dowel pin's `D` would be silently
  // dropped here even though the builder honored it.
  const resolvedValues = useMemo<Record<string, number>>(() => {
    if (!resolved || !draft) return {};
    const part = resolved.compPart;
    const partValues: Record<string, ParameterValue> = { ...part.parameters.values };
    const projectValues: Record<string, ParameterValue> = { ...resolved.def.source.parameters.values };

    // 1) selected config row's part-scope overrides
    if (draft.configRowId !== DEFAULTS_ROW_ID && part.configurations) {
      const row = part.configurations.rows.find(r => r.id === draft.configRowId);
      if (row) {
        for (const [n, expr] of Object.entries(row.overrides)) {
          const existing = partValues[n];
          if (existing) partValues[n] = { ...existing, expression: expr };
        }
      }
    }
    // 2) per-instance draft overrides — apply to whichever scope holds it
    for (const [n, expr] of Object.entries(draft.overrides)) {
      if (expr.trim() === '') continue;
      if (partValues[n]) {
        partValues[n] = { ...partValues[n]!, expression: expr };
      } else if (projectValues[n]) {
        projectValues[n] = { ...projectValues[n]!, expression: expr };
      }
    }
    const r = resolveAllParameters({ values: projectValues }, { values: partValues });
    return r.ok ? r.value : {};
  }, [resolved, draft]);

  // What the "= " hint shows for a row. If the user is mid-edit (the
  // draft override differs from the default expression), evaluate the
  // draft expression so the preview updates on type. Otherwise read
  // the already-resolved value.
  const previewFor = useCallback(
    (param: ParameterValue): { ok: true; value: number } | { ok: false; error: string } | null => {
      if (param.kind === 'choice') return null;
      const draftOverride = draft?.overrides[param.name];
      const expr = draftOverride !== undefined && draftOverride !== '' ? draftOverride : param.expression;
      if (expr === param.expression) {
        const v = resolvedValues[param.name];
        if (v !== undefined) return { ok: true as const, value: v };
      }
      const r = evaluateExpression(expr, resolvedValues);
      return r;
    },
    [draft, resolvedValues],
  );

  const isDirty = useMemo(() => {
    if (!draft || !resolved) return false;
    const baseline = makeDraftFrom(resolved.inputs, resolved.compPart);
    if (draft.boolean !== baseline.boolean) return true;
    if (draft.configRowId !== baseline.configRowId) return true;
    // overrides parity — same key set + same non-empty values
    const norm = (d: Record<string, string>) =>
      Object.fromEntries(Object.entries(d).filter(([, v]) => v.trim() !== ''));
    return JSON.stringify(norm(draft.overrides)) !== JSON.stringify(norm(baseline.overrides));
  }, [draft, resolved]);

  const onRevert = useCallback(() => {
    if (resolved) setDraft(makeDraftFrom(resolved.inputs, resolved.compPart));
  }, [resolved]);

  const onApply = useCallback(() => {
    if (!resolved || !draft || !partId || !featureId) return;
    // Build the next inputs preserving componentRef + transform untouched.
    // Drop empty-string overrides (they mean "no override").
    const overrides: Record<string, string> = {};
    for (const [n, expr] of Object.entries(draft.overrides)) {
      if (expr.trim() !== '') overrides[n] = expr;
    }
    const nextInputs: ComponentFeatureInputs = {
      componentRef: resolved.inputs.componentRef,
      transform: resolved.inputs.transform,
      parameterOverrides: overrides,
      configurationId: draft.configRowId === DEFAULTS_ROW_ID ? null : draft.configRowId,
      boolean: draft.boolean,
    };
    const result = commandBus.dispatch({
      type: 'ReplaceFeatureInputs',
      partId,
      featureId,
      inputs: nextInputs as unknown as Record<string, unknown>,
    });
    if (result.ok) {
      onClose();
    } else {
      // Validation failures here are unlikely (the handler doesn't
      // re-validate the inputs shape), but log defensively.
      console.error('[ComponentDialog] Apply failed:', result.error.message);
    }
  }, [resolved, draft, partId, featureId, commandBus, onClose]);

  return (
    <dialog ref={ref} onClick={onDialogClick} onCancel={onDialogCancel} style={styles.dialog}>
      <div style={styles.body}>
        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>
              {resolved?.def.name ?? 'Component'}
            </h2>
            {resolved?.def.origin && (
              <div style={styles.origin}>{resolved.def.origin}</div>
            )}
          </div>
          <button type="button" onClick={onClose} style={styles.closeBtn} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        {!resolved && (
          <div style={styles.empty}>Component data unavailable.</div>
        )}

        {resolved && draft && (
          <>
            {/* ---- Boolean op ---- */}
            <div style={styles.section}>
              <div style={styles.sectionLabel}>Boolean</div>
              <div style={styles.modeRow}>
                {(['newBody', 'cut', 'join'] as BooleanMode[]).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    style={{
                      ...styles.modeBtn,
                      ...(draft.boolean === mode ? styles.modeBtnActive : {}),
                    }}
                    onClick={() => setDraft({ ...draft, boolean: mode })}
                  >
                    {mode === 'newBody' ? 'New body' : mode === 'cut' ? 'Cut' : 'Join'}
                  </button>
                ))}
              </div>
              <div style={styles.hint}>
                {draft.boolean === 'newBody' && 'Component bodies are kept separate from host bodies.'}
                {draft.boolean === 'cut' && 'Component bodies are subtracted from every host body.'}
                {draft.boolean === 'join' && 'Component bodies are fused with every host body.'}
              </div>
            </div>

            {/* ---- Configuration ---- */}
            {resolved.compPart.configurations && resolved.compPart.configurations.rows.length > 0 && (
              <div style={styles.section}>
                <div style={styles.sectionLabel}>Configuration</div>
                <div style={styles.configList}>
                  <ConfigChip
                    label="(use defaults)"
                    active={draft.configRowId === DEFAULTS_ROW_ID}
                    onClick={() => setDraft({ ...draft, configRowId: DEFAULTS_ROW_ID })}
                  />
                  {resolved.compPart.configurations.rows.map(row => (
                    <ConfigChip
                      key={row.id}
                      label={row.name || row.id}
                      active={draft.configRowId === row.id}
                      onClick={() => setDraft({ ...draft, configRowId: row.id })}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ---- Public parameters ---- */}
            <div style={styles.section}>
              <div style={styles.sectionLabel}>
                Parameters
                {publicParams.length === 0 && (
                  <span style={styles.sectionLabelMuted}> (this component exposes no parameters)</span>
                )}
              </div>

              {publicParams.length > 0 && (
                <div style={styles.paramTable}>
                  <div style={styles.paramHead}>
                    <div style={styles.colName}>Name</div>
                    <div style={styles.colExpr}>Value / Expression</div>
                    <div style={styles.colUnit}>Unit</div>
                    <div style={styles.colResolved}>= Resolved</div>
                    <div style={styles.colDesc}>Description</div>
                  </div>

                  {publicParams.map(param => {
                    const override = draft.overrides[param.name] ?? '';
                    const placeholder = param.expression;
                    const preview = previewFor(param);
                    const isOverridden = override.trim() !== '' && override !== param.expression;
                    return (
                      <div key={param.name} style={styles.paramRow}>
                        <div style={styles.colName}>
                          {param.name}
                          {isOverridden && <span style={styles.overrideDot} title="Per-instance override active" />}
                        </div>
                        <div style={styles.colExpr}>
                          {param.kind === 'choice' && param.options ? (
                            <select
                              value={override !== '' ? override : param.expression}
                              onChange={e =>
                                setDraft({
                                  ...draft,
                                  overrides: { ...draft.overrides, [param.name]: e.target.value },
                                })
                              }
                              style={styles.input}
                            >
                              {param.options.map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={override}
                              placeholder={placeholder}
                              onChange={e =>
                                setDraft({
                                  ...draft,
                                  overrides: { ...draft.overrides, [param.name]: e.target.value },
                                })
                              }
                              style={styles.input}
                            />
                          )}
                        </div>
                        <div style={styles.colUnit}>{param.unit}</div>
                        <div style={styles.colResolved}>
                          {preview === null
                            ? '—'
                            : preview.ok
                              ? formatWithUnit(preview.value, param.unit)
                              : <span style={styles.errorText}>{preview.error}</span>}
                        </div>
                        <div style={styles.colDesc} title={param.description ?? ''}>
                          {param.description ?? ''}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {/* ---- Footer ---- */}
        <div style={styles.footer}>
          <span style={styles.dirtyHint}>
            {isDirty ? 'Unapplied changes' : 'No pending changes'}
          </span>
          <div style={styles.footerActions}>
            <button
              type="button"
              onClick={onRevert}
              disabled={!isDirty}
              style={{
                ...styles.footerBtn,
                ...(isDirty ? styles.footerBtnSecondary : styles.footerBtnDisabled),
              }}
            >
              <RotateCcw size={12} /> Revert
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={!isDirty}
              style={{
                ...styles.footerBtn,
                ...(isDirty ? styles.footerBtnPrimary : styles.footerBtnDisabled),
              }}
            >
              <Check size={12} /> Apply
            </button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

/**
 * React-state hook + dialog element pair. Mirrors the
 * `useParametersEditor` shape so App.tsx can mount one extra dialog
 * without scattering the open/close logic.
 */
export function useComponentEditor() {
  const [state, setState] = useState<{
    open: boolean;
    partId: PartId | null;
    featureId: FeatureId | null;
  }>({ open: false, partId: null, featureId: null });

  const open = useCallback((partId: PartId, featureId: FeatureId) => {
    setState({ open: true, partId, featureId });
  }, []);

  const close = useCallback(() => {
    setState(s => ({ ...s, open: false }));
  }, []);

  const element = (
    <ComponentDialog
      open={state.open}
      partId={state.partId}
      featureId={state.featureId}
      onClose={close}
    />
  );

  return { openComponentEditor: open, componentDialogElement: element };
}

// ---- Sub-components ----

function ConfigChip(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        ...styles.configChip,
        ...(props.active ? styles.configChipActive : {}),
      }}
    >
      {props.label}
    </button>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(96vw, 760px)',
    maxHeight: '85vh',
    padding: 0,
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
    background: '#ffffff',
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: {
    padding: '16px 18px 18px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minHeight: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  origin: {
    marginTop: 2,
    fontSize: 11,
    color: '#888',
    fontFamily: 'ui-monospace, monospace',
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
    flexShrink: 0,
  },
  empty: {
    padding: 24,
    textAlign: 'center',
    color: '#888',
    fontSize: 12,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#666',
  },
  sectionLabelMuted: {
    fontWeight: 400,
    fontSize: 11,
    textTransform: 'none',
    letterSpacing: 0,
    color: '#999',
    marginLeft: 6,
  },
  modeRow: {
    display: 'flex',
    gap: 6,
  },
  modeBtn: {
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid #d8d8d8',
    background: '#fff',
    color: '#444',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  modeBtnActive: {
    background: '#1a6fd1',
    color: '#fff',
    borderColor: '#1a6fd1',
  },
  hint: {
    fontSize: 11,
    color: '#888',
  },
  configList: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
  },
  configChip: {
    padding: '4px 10px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    background: '#fff',
    color: '#444',
    borderRadius: 4,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  configChipActive: {
    background: '#1a6fd1',
    color: '#fff',
    borderColor: '#1a6fd1',
  },
  paramTable: {
    border: '1px solid #e8e8e8',
    borderRadius: 6,
    overflow: 'hidden',
  },
  paramHead: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr 50px 110px 1.5fr',
    gap: 8,
    padding: '6px 10px',
    background: '#f5f5f5',
    fontSize: 11,
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  paramRow: {
    display: 'grid',
    gridTemplateColumns: '120px 1fr 50px 110px 1.5fr',
    gap: 8,
    padding: '6px 10px',
    fontSize: 12,
    borderTop: '1px solid #f0f0f0',
    alignItems: 'center',
  },
  colName: {
    fontWeight: 500,
    color: '#222',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  colExpr: {
    display: 'flex',
  },
  colUnit: {
    color: '#666',
    fontSize: 11,
  },
  colResolved: {
    fontFamily: 'ui-monospace, monospace',
    fontSize: 11,
    color: '#444',
  },
  colDesc: {
    fontSize: 11,
    color: '#666',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  input: {
    width: '100%',
    padding: '4px 6px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 4,
    fontFamily: 'ui-monospace, monospace',
    background: '#fff',
    color: '#222',
  },
  overrideDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#1a6fd1',
  },
  errorText: {
    color: '#dc2626',
    fontSize: 10,
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTop: '1px solid #e8e8e8',
  },
  dirtyHint: {
    fontSize: 11,
    color: '#888',
  },
  footerActions: {
    display: 'flex',
    gap: 8,
  },
  footerBtn: {
    padding: '5px 12px',
    fontSize: 12,
    fontWeight: 500,
    border: '1px solid transparent',
    borderRadius: 4,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontFamily: 'inherit',
  },
  footerBtnPrimary: {
    background: '#1a6fd1',
    color: '#fff',
    borderColor: '#1a6fd1',
  },
  footerBtnSecondary: {
    background: '#fff',
    color: '#444',
    borderColor: '#d8d8d8',
  },
  footerBtnDisabled: {
    background: '#f5f5f5',
    color: '#aaa',
    borderColor: '#e8e8e8',
    cursor: 'not-allowed',
  },
};
