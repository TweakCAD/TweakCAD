/**
 * Right-side Components Panel.
 *
 * Three views:
 *   1. Browse   — search + category groups + card grid
 *   2. Configure — header (back arrow, name, standard chip) + parameter form
 *   3. Inserted — brief confirmation, auto-returns to browse
 *
 * Insertion dispatches a CreateComponentInstance command into the editor
 * CommandBus. The worker's placeholder cylinder builder draws a stand-in
 * body so the user sees feedback in the viewport while the real
 * parametric geometry rebuild is still in development.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Search, Star, X } from 'lucide-react';
import type {
  ComponentDetail,
  ComponentManifest,
  ComponentParameter,
  ComponentSummary,
} from '@tweakcad/api-types';
import type { CommandBus } from '@tweakcad/core/src/commands/bus.ts';
import type { PartId } from '@tweakcad/core/src/ids.ts';
import { getApiClient } from '../../api/client.ts';
import { listComponents, getComponentBySlug } from '@tweakcad/api-client';
import { consoleLog } from '@tweakcad/core/src/store/consoleStore.ts';
import {
  clampNumber,
  coerceParameterValue,
  initialParameterValues,
} from './parameters.ts';

type BooleanMode = 'newBody' | 'cut' | 'join';

type View =
  | { kind: 'browse' }
  | {
      kind: 'configure';
      detail: ComponentDetail;
      values: Record<string, unknown>;
      booleanMode: BooleanMode;
    }
  | { kind: 'inserted'; componentName: string };

interface ComponentsPanelProps {
  /** Close handler — wires to the same toggle that opens the panel. */
  onClose: () => void;
  /** Command bus to dispatch the insert command. */
  commandBus: CommandBus;
  /** The host part to insert into. Panel is disabled when no part exists. */
  partId: PartId | null;
}

export function ComponentsPanel({ onClose, commandBus, partId }: ComponentsPanelProps) {
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [items, setItems] = useState<ComponentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search input — keeps us from hitting /api/v1/components
  // on every keystroke.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // Fetch the list whenever the debounced search changes.
  const reqIdRef = useRef(0);
  useEffect(() => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    void listComponents(getApiClient(), {
      limit: 48,
      search: debouncedSearch || undefined,
    }).then((res) => {
      if (id !== reqIdRef.current) return; // a newer request superseded this one
      if (res.ok) {
        setItems(res.value.items);
      } else {
        setError(res.error.message || 'Failed to load components');
      }
      setLoading(false);
    });
  }, [debouncedSearch]);

  // Group items by first-level category for the browse view sidebar tree.
  const groups = useMemo(() => groupByCategory(items), [items]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const handleSelectComponent = useCallback(async (slug: string) => {
    setError(null);
    setLoading(true);
    const res = await getComponentBySlug(getApiClient(), slug);
    setLoading(false);
    if (!res.ok) {
      setError(res.error.message || 'Failed to load component');
      return;
    }
    setView({
      kind: 'configure',
      detail: res.value,
      values: initialParameterValues(res.value.manifest),
      booleanMode: 'newBody',
    });
  }, []);

  const handleBackToBrowse = useCallback(() => {
    setView({ kind: 'browse' });
  }, []);

  const handleParameterChange = useCallback((paramName: string, raw: unknown) => {
    setView((prev) => {
      if (prev.kind !== 'configure') return prev;
      const param = prev.detail.manifest.parameters.find((p) => p.name === paramName);
      if (!param) return prev;
      const coerced = coerceParameterValue(param, raw);
      if (coerced === null) return prev;
      return { ...prev, values: { ...prev.values, [paramName]: coerced } };
    });
  }, []);

  const handleBooleanModeChange = useCallback((mode: BooleanMode) => {
    setView((prev) => (prev.kind === 'configure' ? { ...prev, booleanMode: mode } : prev));
  }, []);

  const handleInsert = useCallback(() => {
    if (view.kind !== 'configure') return;
    if (!partId) {
      consoleLog('warn', 'Cannot insert component: no active part.', 'components');
      return;
    }
    const { detail, values, booleanMode } = view;
    const result = commandBus.dispatch({
      type: 'CreateComponentInstance',
      partId,
      inputs: {
        componentProjectId: detail.id,
        componentSlug: detail.slug,
        componentName: detail.name,
        manifestVersion: detail.manifest.schemaVersion,
        parameters: values,
        boolean: booleanMode,
      },
    });
    if (!result.ok) {
      consoleLog('error', `Insert failed: ${result.error.message}`, 'components');
      return;
    }
    consoleLog('success', `Inserted component: ${detail.name}`, 'components');
    setView({ kind: 'inserted', componentName: detail.name });
  }, [view, commandBus, partId]);

  // Auto-return to browse a couple seconds after a successful insert so the
  // user can drop another one without clicking back.
  useEffect(() => {
    if (view.kind !== 'inserted') return;
    const handle = window.setTimeout(() => setView({ kind: 'browse' }), 1800);
    return () => window.clearTimeout(handle);
  }, [view]);

  return (
    <div style={styles.panel} data-testid="components-panel">
      <div style={styles.header}>
        <span>Components</span>
        <button
          type="button"
          style={styles.closeBtn}
          onClick={onClose}
          title="Close Components panel (Ctrl+I)"
          aria-label="Close Components panel"
        >
          <X size={12} />
        </button>
      </div>

      {view.kind === 'browse' && (
        <BrowseView
          searchInput={searchInput}
          onSearchInput={setSearchInput}
          loading={loading}
          error={error}
          groups={groups}
          collapsedGroups={collapsedGroups}
          onToggleGroup={(name) =>
            setCollapsedGroups((prev) => {
              const next = new Set(prev);
              if (next.has(name)) next.delete(name);
              else next.add(name);
              return next;
            })
          }
          onSelect={handleSelectComponent}
        />
      )}
      {view.kind === 'configure' && (
        <ConfigureView
          detail={view.detail}
          values={view.values}
          booleanMode={view.booleanMode}
          onParameterChange={handleParameterChange}
          onBooleanModeChange={handleBooleanModeChange}
          onBack={handleBackToBrowse}
          onInsert={handleInsert}
          insertDisabled={!partId}
        />
      )}
      {view.kind === 'inserted' && <InsertedView componentName={view.componentName} />}
    </div>
  );
}

// ---- Browse View ----

interface CategoryGroup {
  name: string;
  items: ComponentSummary[];
}

function groupByCategory(items: ComponentSummary[]): CategoryGroup[] {
  const map = new Map<string, ComponentSummary[]>();
  for (const item of items) {
    const key = item.categoryName ?? 'Uncategorized';
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return Array.from(map.entries())
    .map(([name, groupItems]) => ({ name, items: groupItems }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function BrowseView({
  searchInput,
  onSearchInput,
  loading,
  error,
  groups,
  collapsedGroups,
  onToggleGroup,
  onSelect,
}: {
  searchInput: string;
  onSearchInput: (value: string) => void;
  loading: boolean;
  error: string | null;
  groups: CategoryGroup[];
  collapsedGroups: Set<string>;
  onToggleGroup: (name: string) => void;
  onSelect: (slug: string) => void;
}) {
  return (
    <div style={styles.content}>
      <div style={styles.searchRow}>
        <Search size={12} style={styles.searchIcon} />
        <input
          type="search"
          placeholder="Search components..."
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          style={styles.searchInput}
          aria-label="Search components"
        />
      </div>

      {error && <div style={styles.error}>{error}</div>}
      {loading && groups.length === 0 && (
        <div style={styles.empty}>Loading...</div>
      )}
      {!loading && !error && groups.length === 0 && (
        <div style={styles.empty}>No components match this search.</div>
      )}

      <div style={styles.groupList}>
        {groups.map((group) => {
          const collapsed = collapsedGroups.has(group.name);
          return (
            <section key={group.name} style={styles.group}>
              <button
                type="button"
                style={styles.groupHeader}
                onClick={() => onToggleGroup(group.name)}
                aria-expanded={!collapsed}
              >
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span style={styles.groupName}>{group.name}</span>
                <span style={styles.groupCount}>{group.items.length}</span>
              </button>
              {!collapsed && (
                <div style={styles.cardGrid}>
                  {group.items.map((item) => (
                    <ComponentCard
                      key={item.id}
                      item={item}
                      onClick={() => onSelect(item.slug)}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function ComponentCard({
  item,
  onClick,
}: {
  item: ComponentSummary;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.card,
        borderColor: hover ? '#1a6fd1' : '#e2e2e2',
        boxShadow: hover ? '0 2px 6px rgba(26,111,209,0.18)' : 'none',
      }}
      aria-label={`Open ${item.name}`}
      data-testid={`component-card-${item.slug}`}
    >
      <div style={styles.thumbnail}>
        {item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            style={styles.thumbnailImg}
            draggable={false}
          />
        ) : (
          <span style={styles.thumbnailPlaceholder}>Component</span>
        )}
      </div>
      <div style={styles.cardBody}>
        <div style={styles.cardTitleRow}>
          <span style={styles.cardName} title={item.name}>{item.name}</span>
          {item.standard && (
            <span style={styles.standardChip}>{item.standard}</span>
          )}
        </div>
        <div style={styles.cardMeta}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Star size={10} fill="currentColor" strokeWidth={0} />
            {item.likeCount}
          </span>
        </div>
      </div>
    </button>
  );
}

// ---- Configure View ----

function ConfigureView({
  detail,
  values,
  booleanMode,
  onParameterChange,
  onBooleanModeChange,
  onBack,
  onInsert,
  insertDisabled,
}: {
  detail: ComponentDetail;
  values: Record<string, unknown>;
  booleanMode: BooleanMode;
  onParameterChange: (name: string, value: unknown) => void;
  onBooleanModeChange: (mode: BooleanMode) => void;
  onBack: () => void;
  onInsert: () => void;
  insertDisabled: boolean;
}) {
  return (
    <div style={styles.content}>
      <div style={styles.configHeader}>
        <button
          type="button"
          style={styles.backBtn}
          onClick={onBack}
          aria-label="Back to component browser"
        >
          <ArrowLeft size={14} />
        </button>
        <span style={styles.configName}>{detail.name}</span>
        {detail.standard && (
          <span style={styles.standardChip}>{detail.standard}</span>
        )}
      </div>

      <div style={styles.previewBox}>
        {detail.thumbnailUrl ? (
          <img
            src={detail.thumbnailUrl}
            alt=""
            style={styles.previewImg}
            draggable={false}
          />
        ) : (
          <span style={styles.previewPlaceholder}>Preview</span>
        )}
      </div>

      {detail.manifest.installHint && (
        <p style={styles.installHint}>{detail.manifest.installHint}</p>
      )}

      <div style={styles.paramList}>
        {detail.manifest.parameters.map((param) => (
          <ParameterInput
            key={param.name}
            param={param}
            value={values[param.name]}
            onChange={(next) => onParameterChange(param.name, next)}
          />
        ))}
      </div>

      <label style={styles.paramRow}>
        <span style={styles.paramLabel}>Boolean</span>
        <select
          value={booleanMode}
          onChange={(e) => onBooleanModeChange(e.target.value as BooleanMode)}
          style={styles.selectInput}
          data-testid="components-boolean-select"
          aria-label="Boolean mode against existing bodies"
        >
          <option value="newBody">New body</option>
          <option value="cut">Cut from existing bodies</option>
          <option value="join">Join with existing bodies</option>
        </select>
      </label>

      <div style={styles.insertRow}>
        <button
          type="button"
          style={{
            ...styles.insertBtn,
            opacity: insertDisabled ? 0.5 : 1,
            cursor: insertDisabled ? 'not-allowed' : 'pointer',
          }}
          onClick={insertDisabled ? undefined : onInsert}
          disabled={insertDisabled}
          data-testid="components-insert-btn"
        >
          Insert
        </button>
      </div>
    </div>
  );
}

function ParameterInput({
  param,
  value,
  onChange,
}: {
  param: ComponentParameter;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  switch (param.type) {
    case 'number':
      return <NumberParameterInput param={param} value={value} onChange={onChange} />;
    case 'enum':
      return <EnumParameterInput param={param} value={value} onChange={onChange} />;
    case 'boolean':
      return <BooleanParameterInput param={param} value={value} onChange={onChange} />;
    case 'string':
      return <StringParameterInput param={param} value={value} onChange={onChange} />;
  }
}

function NumberParameterInput({
  param,
  value,
  onChange,
}: {
  param: ComponentParameter;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const numeric = typeof value === 'number' ? value : 0;
  const [min, max] = param.range ?? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  return (
    <label style={styles.paramRow}>
      <span style={styles.paramLabel}>{param.label}</span>
      <div style={styles.paramControlRow}>
        <input
          type="number"
          value={numeric}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={styles.numberInput}
          {...(param.range
            ? { min: param.range[0], max: param.range[1] }
            : {})}
          data-testid={`param-input-${param.name}`}
        />
        {param.range && (
          <input
            type="range"
            min={min}
            max={max}
            step={(max - min) / 200 || 0.1}
            value={clampNumber(numeric, param.range)}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            style={styles.rangeInput}
            aria-label={`${param.label} slider`}
          />
        )}
      </div>
    </label>
  );
}

function EnumParameterInput({
  param,
  value,
  onChange,
}: {
  param: ComponentParameter;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const str = typeof value === 'string' ? value : '';
  return (
    <label style={styles.paramRow}>
      <span style={styles.paramLabel}>{param.label}</span>
      <select
        value={str}
        onChange={(e) => onChange(e.target.value)}
        style={styles.selectInput}
        data-testid={`param-input-${param.name}`}
      >
        {(param.values ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

function BooleanParameterInput({
  param,
  value,
  onChange,
}: {
  param: ComponentParameter;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const checked = Boolean(value);
  return (
    <label style={{ ...styles.paramRow, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={`param-input-${param.name}`}
      />
      <span style={styles.paramLabel}>{param.label}</span>
    </label>
  );
}

function StringParameterInput({
  param,
  value,
  onChange,
}: {
  param: ComponentParameter;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const str = typeof value === 'string' ? value : '';
  return (
    <label style={styles.paramRow}>
      <span style={styles.paramLabel}>{param.label}</span>
      <input
        type="text"
        value={str}
        onChange={(e) => onChange(e.target.value)}
        style={styles.textInput}
        data-testid={`param-input-${param.name}`}
      />
    </label>
  );
}

// ---- Inserted Confirmation ----

function InsertedView({ componentName }: { componentName: string }) {
  return (
    <div style={styles.content}>
      <div style={styles.insertedBox} role="status" aria-live="polite">
        <strong style={styles.insertedTitle}>Inserted!</strong>
        <span style={styles.insertedDetail}>{componentName} dropped into your part.</span>
      </div>
    </div>
  );
}

// ---- Manifest helpers exposed for unit tests ----

/** Used by tests so the panel module is the public surface, not the helper file. */
export type { ComponentManifest };

// ---- Styles ----

const PANEL_WIDTH = 340;

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: PANEL_WIDTH,
    minWidth: 300,
    maxWidth: 360,
    background: '#fafafa',
    borderLeft: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    padding: '8px 12px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#888',
    borderBottom: '1px solid #d8d8d8',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexShrink: 0,
  },
  closeBtn: {
    width: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    background: 'transparent',
    borderRadius: 3,
    color: '#999',
    cursor: 'pointer',
    padding: 0,
  },
  content: {
    flex: 1,
    overflow: 'auto',
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  searchRow: {
    position: 'relative',
    flexShrink: 0,
  },
  searchIcon: {
    position: 'absolute',
    left: 8,
    top: '50%',
    transform: 'translateY(-50%)',
    color: '#999',
    pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '6px 8px 6px 26px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 4,
    background: '#fff',
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  error: {
    padding: '6px 8px',
    fontSize: 11,
    color: '#a33',
    background: '#fff0f0',
    borderRadius: 3,
  },
  empty: {
    padding: '24px 8px',
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
  },
  groupList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    padding: '2px 0',
    color: '#555',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  groupName: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    flex: 1,
  },
  groupCount: {
    fontSize: 10,
    color: '#999',
    background: '#ececec',
    padding: '1px 6px',
    borderRadius: 8,
  },
  cardGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 6,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    padding: 0,
    border: '1px solid #e2e2e2',
    borderRadius: 5,
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    overflow: 'hidden',
    transition: 'border-color 0.1s, box-shadow 0.1s',
  },
  thumbnail: {
    width: '100%',
    aspectRatio: '1 / 1',
    background: '#f0f0f0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  thumbnailPlaceholder: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#bbb',
  },
  cardBody: {
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  cardTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  cardName: {
    fontSize: 11,
    fontWeight: 600,
    color: '#222',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  standardChip: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
    color: '#075985',
    background: '#dbeafe',
    padding: '1px 5px',
    borderRadius: 3,
    flexShrink: 0,
  },
  cardMeta: {
    fontSize: 10,
    color: '#999',
  },
  configHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
  backBtn: {
    width: 22,
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid #d8d8d8',
    background: '#fff',
    color: '#555',
    borderRadius: 3,
    cursor: 'pointer',
    padding: 0,
  },
  configName: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: '#222',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  previewBox: {
    width: '100%',
    aspectRatio: '4 / 3',
    background: '#f0f0f0',
    border: '1px solid #e2e2e2',
    borderRadius: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  previewImg: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  previewPlaceholder: {
    fontSize: 11,
    color: '#bbb',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  installHint: {
    margin: 0,
    fontSize: 11,
    color: '#666',
    fontStyle: 'italic',
    lineHeight: 1.4,
  },
  paramList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  paramRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
  },
  paramLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#444',
  },
  paramControlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  numberInput: {
    width: 78,
    padding: '4px 6px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 3,
    background: '#fff',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  },
  rangeInput: {
    flex: 1,
    minWidth: 0,
  },
  selectInput: {
    width: '100%',
    padding: '4px 6px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 3,
    background: '#fff',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  textInput: {
    width: '100%',
    padding: '4px 6px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 3,
    background: '#fff',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  },
  insertRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    paddingTop: 8,
    borderTop: '1px solid #eee',
    marginTop: 'auto',
  },
  insertBtn: {
    padding: '6px 16px',
    fontSize: 12,
    fontWeight: 600,
    background: '#16a34a',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    fontFamily: 'inherit',
  },
  insertedBox: {
    margin: 'auto',
    padding: '24px 18px',
    background: '#f1fdf5',
    border: '1px solid #16a34a',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  insertedTitle: {
    fontSize: 14,
    color: '#15803d',
  },
  insertedDetail: {
    fontSize: 12,
    color: '#444',
    textAlign: 'center',
  },
};
