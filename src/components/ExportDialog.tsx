/**
 * The Export dialog: what an assembly or design export puts in. It lists
 * each kind of part that a file may leave out (purchased, reference) with
 * how many there are, ticked as the caller asks. Opened only when there
 * is such a choice; `useExportDialog` gives a Promise-based `ask`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ExportIncludeChoice {
  purchased: boolean;
  reference: boolean;
}

export interface ExportDialogRequest {
  /** "Export 3MF". */
  title: string;
  /** What is exported: an assembly and how many instances it places, or a design and how many parts it has. */
  kind: 'assembly' | 'design';
  name: string;
  instances: number;
  /** How many instances (parts, in a design) are purchased and reference parts; a kind with none is not offered. */
  counts: { purchased: number; reference: number };
  initial: ExportIncludeChoice;
}

/** What `instances` counts: an assembly's instances or a design's parts. */
function unit(request: ExportDialogRequest): string {
  const one = request.instances === 1;
  if (request.kind === 'design') return one ? 'part' : 'parts';
  return one ? 'instance' : 'instances';
}

export function ExportDialog({
  request,
  onExport,
  onCancel,
}: {
  request: ExportDialogRequest | null;
  onExport: (include: ExportIncludeChoice) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [include, setInclude] = useState<ExportIncludeChoice>(
    request?.initial ?? { purchased: false, reference: false },
  );
  const [shown, setShown] = useState(request);
  // A new request starts from its own ticks.
  if (request !== shown) {
    setShown(request);
    if (request) setInclude(request.initial);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (request && !el.open) el.showModal();
    if (!request && el.open) el.close();
  }, [request]);

  const kinds = (['purchased', 'reference'] as const).filter((k) => (request?.counts[k] ?? 0) > 0);
  const label = { purchased: 'Purchased parts', reference: 'Reference parts' };
  return (
    <dialog
      ref={ref}
      aria-label={request?.title ?? 'Export'}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      style={styles.dialog}
    >
      {request && (
        <div style={styles.body}>
          <h2 style={styles.title}>{request.title}</h2>
          <div style={styles.row}>
            <span style={styles.key}>What</span>
            <span>
              {request.name} ({request.kind}, {request.instances} {unit(request)})
            </span>
          </div>
          <div style={styles.row}>
            <span style={styles.key}>Include</span>
            <span style={styles.checks}>
              {kinds.map((k) => (
                <label key={k} style={styles.check}>
                  <input
                    type="checkbox"
                    checked={include[k]}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setInclude((c) => ({ ...c, [k]: on }));
                    }}
                  />
                  {label[k]} ({request.counts[k]})
                </label>
              ))}
            </span>
          </div>
          <div style={styles.actions}>
            <button type="button" onClick={onCancel} style={styles.cancelBtn}>
              Cancel
            </button>
            <button type="button" onClick={() => onExport(include)} style={styles.exportBtn} autoFocus>
              Export
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

type Pending = { request: ExportDialogRequest; resolve: (include: ExportIncludeChoice | null) => void };

/** The dialog's element, to mount once, and `ask`, which resolves with the choice or null when cancelled. */
export function useExportDialog(): {
  ask: (request: ExportDialogRequest) => Promise<ExportIncludeChoice | null>;
  element: React.ReactElement;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const ask = useCallback(
    (request: ExportDialogRequest) =>
      new Promise<ExportIncludeChoice | null>((resolve) => setPending({ request, resolve })),
    [],
  );
  const element = (
    <ExportDialog
      request={pending?.request ?? null}
      onExport={(include) => {
        pending?.resolve(include);
        setPending(null);
      }}
      onCancel={() => {
        pending?.resolve(null);
        setPending(null);
      }}
    />
  );
  return { ask, element };
}

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(92vw, 420px)',
    padding: 0,
    border: 'none',
    borderRadius: 10,
    boxShadow: '0 20px 50px rgba(0, 0, 0, 0.2)',
    background: '#ffffff',
    color: '#333',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  body: { padding: 20, display: 'flex', flexDirection: 'column', gap: 14 },
  title: { margin: 0, fontSize: 15, fontWeight: 600, color: '#222' },
  row: { display: 'flex', gap: 12, fontSize: 13, color: '#444', alignItems: 'flex-start' },
  key: { width: 56, flexShrink: 0, color: '#888' },
  checks: { display: 'flex', flexDirection: 'column', gap: 6 },
  check: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  cancelBtn: {
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 500,
    background: '#f5f5f5',
    color: '#333',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  exportBtn: {
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 600,
    background: '#1a6fd1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
