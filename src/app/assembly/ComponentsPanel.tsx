/**
 * The Components panel: the catalogue searched and grouped by
 * category, a component's card with its standard, and its configure view:
 * its configuration (Size), its public parameters, and how a component
 * derived into a part meets the part's bodies. Selecting a component
 * downloads its document, which must be a version-2 document the reader
 * accepts. Insert embeds it in the library and places it: as an instance
 * in the shown assembly, or derived into the active part.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Search, Star, X } from 'lucide-react';
import type { ComponentDetail, ComponentSummary } from '@tweakcad/api-types';
import { getComponentBySlug, getComponentDocument, listComponents } from '@tweakcad/api-client';
import { loadDocument, type Doc } from '@tweakcad/editor';
import { getApiClient } from '../../api/client.ts';
import { consoleLog } from '../console';
import type { AppServices } from '../services';
import { useSlice } from '../hooks';
import { candidateOf, commitSolved } from './commit';
import { activePartOf, shownAssembly } from './focus';
import {
  chooseRow,
  embedDocument,
  insertComponentCommands,
  insertOverrides,
  newInsertForm,
  type DeriveOperation,
  type InsertForm,
} from './library';

type View =
  | { kind: 'browse' }
  | { kind: 'configure'; detail: ComponentDetail; source: Doc; form: InsertForm }
  | { kind: 'inserted'; name: string; into: 'part' | 'assembly' };

export function ComponentsPanel({ services, onClose }: { services: AppServices; onClose: () => void }) {
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ComponentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const focus = useSlice(services.app, (s) => s.focus);
  const target = useMemo(() => {
    const doc = services.editor.document;
    const assembly = shownAssembly(doc, focus);
    const part = activePartOf(doc, focus);
    return assembly !== null ? { assembly } : part ? { part } : null;
  }, [services, focus]);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 200);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  // A new search shows loading at once, during render, as it changes.
  const [requested, setRequested] = useState<string | null>(null);
  if (requested !== search) {
    setRequested(search);
    setLoading(true);
    setError(null);
  }
  const request = useRef(0);
  useEffect(() => {
    const id = ++request.current;
    void listComponents(getApiClient(), { limit: 48, ...(search ? { search } : {}) }).then((res) => {
      if (id !== request.current) return;
      if (res.ok) setItems(res.value.items);
      else setError(res.error.message || 'The components could not be loaded');
      setLoading(false);
    });
  }, [search]);

  const groups = useMemo(() => {
    const map = new Map<string, ComponentSummary[]>();
    for (const item of items) {
      const key = item.categoryName ?? 'Uncategorized';
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()]
      .map(([name, list]) => ({ name, items: list }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const select = useCallback(async (slug: string) => {
    setError(null);
    setLoading(true);
    const client = getApiClient();
    const [detail, document] = await Promise.all([
      getComponentBySlug(client, slug),
      getComponentDocument(client, slug),
    ]);
    setLoading(false);
    if (!detail.ok) return setError(detail.error.message || 'The component could not be loaded');
    if (!document.ok) return setError(document.error.message || 'The component could not be downloaded');
    const loaded = loadDocument(JSON.stringify(document.value));
    if (!loaded.ok) return setError(`"${detail.value.name}" could not be read: ${loaded.message}`);
    for (const w of loaded.warnings) consoleLog('warn', `${detail.value.name}: ${w.message}`, 'components');
    setView({ kind: 'configure', detail: detail.value, source: loaded.document, form: newInsertForm(loaded.document) });
  }, []);

  const insert = useCallback(async () => {
    if (view.kind !== 'configure' || !target) return;
    const { editor } = services;
    const embedded = embedDocument(view.source, view.detail.name, editor.newId('lib'), {
      catalogue: { id: view.detail.slug, version: view.detail.updatedAt, policy: 'pinned' },
    });
    const commands = insertComponentCommands(editor, embedded, target, insertOverrides(view.form), view.form.operation);
    const checked = candidateOf(editor.document, commands);
    if (!checked.ok) return setError(checked.message);
    const written = await commitSolved(services, `Insert ${view.detail.name}`, commands);
    if (!written.ok) return setError(written.message);
    consoleLog('success', `Inserted component: ${view.detail.name}`, 'components');
    setView({ kind: 'inserted', name: view.detail.name, into: 'assembly' in target ? 'assembly' : 'part' });
  }, [view, target, services]);

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
        <div style={styles.content}>
          <div style={styles.searchRow}>
            <Search size={12} style={styles.searchIcon} />
            <input
              type="search"
              placeholder="Search components..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={styles.searchInput}
              aria-label="Search components"
            />
          </div>
          {error && <div style={styles.error}>{error}</div>}
          {loading && groups.length === 0 && <div style={styles.empty}>Loading...</div>}
          {!loading && !error && groups.length === 0 && (
            <div style={styles.empty}>No components match this search.</div>
          )}
          {groups.map((group) => {
            const shut = collapsed.has(group.name);
            return (
              <section key={group.name} style={styles.group}>
                <button
                  type="button"
                  style={styles.groupHeader}
                  aria-expanded={!shut}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.name)) next.delete(group.name);
                      else next.add(group.name);
                      return next;
                    })
                  }
                >
                  {shut ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <span style={styles.groupName}>{group.name}</span>
                  <span style={styles.groupCount}>{group.items.length}</span>
                </button>
                {!shut && (
                  <div style={styles.cardGrid}>
                    {group.items.map((item) => (
                      <ComponentCard key={item.id} item={item} onClick={() => void select(item.slug)} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {view.kind === 'configure' && (
        <ConfigureView
          detail={view.detail}
          form={view.form}
          target={target ? ('assembly' in target ? 'assembly' : 'part') : null}
          error={error}
          onChange={(form) => setView({ ...view, form })}
          onBack={() => setView({ kind: 'browse' })}
          onInsert={() => void insert()}
        />
      )}
      {view.kind === 'inserted' && (
        <div style={styles.content}>
          <div style={styles.insertedBox} role="status" aria-live="polite">
            <strong style={styles.insertedTitle}>Inserted!</strong>
            <span style={styles.insertedDetail}>
              {view.name} dropped into your {view.into}.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** A catalogue card: thumbnail, name with the component's standard (an ISO number), likes. */
export function ComponentCard({ item, onClick }: { item: ComponentSummary; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={styles.card}
      aria-label={`Open ${item.name}`}
      data-testid={`component-card-${item.slug}`}
    >
      <div style={styles.thumbnail}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" style={styles.thumbnailImg} draggable={false} />
        ) : (
          <span style={styles.placeholder}>Component</span>
        )}
      </div>
      <div style={styles.cardBody}>
        <span style={styles.cardTitleRow}>
          <span style={styles.cardName} title={item.name}>
            {item.name}
          </span>
          {item.standard && <span style={styles.standardChip}>{item.standard}</span>}
        </span>
        <span style={styles.cardMeta}>
          <Star size={10} fill="currentColor" strokeWidth={0} />
          {item.likeCount}
        </span>
      </div>
    </button>
  );
}

const OPERATIONS: { id: DeriveOperation; label: string }[] = [
  { id: 'new', label: 'New body' },
  { id: 'cut', label: 'Cut from existing bodies' },
  { id: 'join', label: 'Join with existing bodies' },
];

const unquoted = (text: string): string => /^\s*"(.*)"\s*$/.exec(text)?.[1] ?? text;

/**
 * A component's configure view: its header with the standard, preview and
 * install hint, a Size select per configuration it lets a host choose, a
 * field per public parameter (a choice's options as a select, the unit
 * beside a number, the description as its label), and, when it goes into
 * a part, how it meets the part's bodies. `target` is where Insert puts it,
 * or null when nothing can take it.
 */
export function ConfigureView({
  detail,
  form,
  target,
  error,
  onChange,
  onBack,
  onInsert,
}: {
  detail: ComponentDetail;
  form: InsertForm;
  target: 'part' | 'assembly' | null;
  error: string | null;
  onChange: (form: InsertForm) => void;
  onBack: () => void;
  onInsert: () => void;
}) {
  return (
    <div style={styles.content}>
      <div style={styles.configHeader}>
        <button type="button" style={styles.backBtn} onClick={onBack} aria-label="Back to component browser">
          <ArrowLeft size={14} />
        </button>
        <span style={styles.configName}>{detail.name}</span>
        {detail.standard && <span style={styles.standardChip}>{detail.standard}</span>}
      </div>
      <div style={styles.previewBox}>
        {detail.thumbnailUrl ? (
          <img src={detail.thumbnailUrl} alt="" style={styles.previewImg} draggable={false} />
        ) : (
          <span style={styles.placeholder}>Preview</span>
        )}
      </div>
      {detail.manifest.installHint && <p style={styles.hint}>{detail.manifest.installHint}</p>}
      {form.configurations.map((c) => (
        <label key={c.input.id} style={styles.paramRow}>
          <span style={styles.paramLabel} title={c.input.name}>
            {form.configurations.length === 1 ? 'Size' : c.input.description || c.input.name}
          </span>
          <select
            value={form.rows[c.input.id] ?? c.own ?? ''}
            onChange={(e) => onChange(chooseRow(form, c.input.id, e.target.value))}
            style={styles.selectInput}
            data-testid="components-configuration-select"
            aria-label="Component configuration"
          >
            {c.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div style={styles.paramList}>
        {form.params.length === 0 ? (
          <p style={styles.hint}>This component has no adjustable parameters.</p>
        ) : (
          form.params.map((p) => {
            const value = form.values[p.id] ?? '';
            const set = (text: string) => onChange({ ...form, values: { ...form.values, [p.id]: text } });
            return (
              <label key={p.id} style={styles.paramRow}>
                <span style={styles.paramLabel} title={p.name}>
                  {p.description || p.name}
                </span>
                {p.kind === 'choice' && p.options.length > 0 ? (
                  <select
                    value={unquoted(value)}
                    onChange={(e) => set(JSON.stringify(e.target.value))}
                    style={styles.selectInput}
                    data-testid={`param-input-${p.name}`}
                  >
                    {p.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={styles.paramControlRow}>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      style={styles.paramInput}
                      spellCheck={false}
                      aria-label={p.name}
                      data-testid={`param-input-${p.name}`}
                    />
                    <span style={styles.paramUnit}>{p.unit}</span>
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
      {target === 'part' && (
        <label style={styles.paramRow}>
          <span style={styles.paramLabel}>Boolean</span>
          <select
            value={form.operation}
            onChange={(e) => onChange({ ...form, operation: e.target.value as DeriveOperation })}
            style={styles.selectInput}
            data-testid="components-boolean-select"
            aria-label="Boolean mode against existing bodies"
          >
            {OPERATIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div style={styles.error}>{error}</div>}
      <div style={styles.insertRow}>
        <button
          type="button"
          style={{ ...styles.insertBtn, opacity: target ? 1 : 0.5, cursor: target ? 'pointer' : 'not-allowed' }}
          disabled={!target}
          onClick={onInsert}
          data-testid="components-insert-btn"
        >
          {target === 'assembly' ? 'Insert into the assembly' : 'Insert into the part'}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: 300,
    background: '#fafafa',
    borderLeft: '1px solid #d8d8d8',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 20,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderBottom: '1px solid #d8d8d8',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#888',
  },
  closeBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: '#777',
    padding: 2,
    display: 'inline-flex',
  },
  content: { flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  searchRow: { position: 'relative' },
  searchIcon: { position: 'absolute', left: 8, top: 8, color: '#999' },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px 5px 26px',
    border: '1px solid #d0d0d0',
    borderRadius: 4,
    fontSize: 12,
  },
  error: {
    fontSize: 11,
    color: '#b91c1c',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 4,
    padding: '6px 8px',
  },
  empty: { fontSize: 12, color: '#888', padding: 12, textAlign: 'center' },
  group: { display: 'flex', flexDirection: 'column', gap: 6 },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    padding: '2px 0',
    fontSize: 11,
    color: '#555',
    fontWeight: 600,
  },
  groupName: { flex: 1, textAlign: 'left' },
  groupCount: { fontSize: 10, color: '#999' },
  cardGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  card: {
    display: 'flex',
    flexDirection: 'column',
    border: '1px solid #e2e2e2',
    borderRadius: 6,
    background: '#fff',
    cursor: 'pointer',
    padding: 0,
    overflow: 'hidden',
    textAlign: 'left',
  },
  thumbnail: { height: 72, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  thumbnailImg: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  placeholder: { fontSize: 10, color: '#aaa' },
  cardBody: { padding: '4px 6px', display: 'flex', flexDirection: 'column', gap: 2 },
  cardTitleRow: { display: 'flex', alignItems: 'center', gap: 4 },
  cardName: {
    fontSize: 11,
    fontWeight: 600,
    color: '#333',
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
  cardMeta: { fontSize: 10, color: '#888', display: 'inline-flex', alignItems: 'center', gap: 3 },
  configHeader: { display: 'flex', alignItems: 'center', gap: 6 },
  backBtn: {
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    color: '#555',
    padding: 2,
    display: 'inline-flex',
  },
  configName: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: '#333',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  previewBox: {
    height: 140,
    background: '#f3f4f6',
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  previewImg: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
  hint: { fontSize: 11, color: '#666', margin: 0, fontStyle: 'italic', lineHeight: 1.4 },
  paramList: { display: 'flex', flexDirection: 'column', gap: 8 },
  paramRow: { display: 'flex', flexDirection: 'column', gap: 3 },
  paramLabel: { fontSize: 11, fontWeight: 500, color: '#444' },
  paramControlRow: { display: 'flex', alignItems: 'center', gap: 6 },
  paramInput: {
    flex: 1,
    minWidth: 0,
    padding: '4px 6px',
    fontSize: 12,
    border: '1px solid #d8d8d8',
    borderRadius: 3,
    background: '#fff',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
  },
  paramUnit: { fontSize: 10, color: '#999', fontWeight: 500 },
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
  insertedTitle: { fontSize: 14, color: '#15803d' },
  insertedDetail: { fontSize: 12, color: '#444', textAlign: 'center' },
};
