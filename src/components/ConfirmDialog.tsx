/**
 * Confirmation modal — replaces `window.confirm()` with a styled dialog
 * that matches the rest of the editor UI.
 *
 * Uses native <dialog> + showModal() so we get focus trapping, Esc-to-cancel,
 * and backdrop click for free.
 *
 * Imperative `useConfirm()` hook gives a Promise-based API. Mount the
 * returned `element` once near the React root, then call `confirm(opts)`
 * from anywhere it's in scope.
 *
 * Example:
 *   const { confirm, element } = useConfirm();
 *   ...
 *   if (await confirm({ title: 'Discard changes?', tone: 'danger' })) doIt();
 *   return <>{element}<App /></>;
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ConfirmOptions = {
  title: string;
  /** Optional body text. Plain string only — keep it short. */
  message?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  /** Visual emphasis: 'danger' uses a red confirm button. */
  tone?: 'default' | 'danger' | undefined;
};

type DialogProps = {
  open: boolean;
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({ open, options, onConfirm, onCancel }: DialogProps) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    // Click on the backdrop = cancel.
    if (e.target === e.currentTarget) onCancel();
  }

  function onDialogCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    // Esc fires a 'cancel' event before the dialog closes.
    e.preventDefault();
    onCancel();
  }

  const tone = options.tone ?? 'default';
  const confirmBg = tone === 'danger' ? '#dc2626' : '#1a6fd1';
  const confirmHoverBg = tone === 'danger' ? '#b91c1c' : '#1557a0';

  return (
    <dialog ref={ref} onClick={onDialogClick} onCancel={onDialogCancel} style={styles.dialog}>
      <div style={styles.body}>
        <h2 style={styles.title}>{options.title}</h2>
        {options.message && <p style={styles.message}>{options.message}</p>}
        <div style={styles.actions}>
          <button
            type="button"
            onClick={onCancel}
            style={styles.cancelBtn}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#ebebeb';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#f5f5f5';
            }}
          >
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{ ...styles.confirmBtn, background: confirmBg }}
            // Autofocus the safe action when it's destructive — user shouldn't
            // accidentally Enter their way into a delete.
            autoFocus={tone !== 'danger'}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = confirmHoverBg;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = confirmBg;
            }}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

// --- Imperative hook ------------------------------------------------------

type Pending = {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
};

export function useConfirm(): {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  element: React.ReactElement;
} {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setPending({ options: opts, resolve });
    });
  }, []);

  const onConfirm = useCallback(() => {
    if (pending) {
      pending.resolve(true);
      setPending(null);
    }
  }, [pending]);
  const onCancel = useCallback(() => {
    if (pending) {
      pending.resolve(false);
      setPending(null);
    }
  }, [pending]);

  const element = (
    <ConfirmDialog
      open={pending !== null}
      options={pending?.options ?? { title: '' }}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );

  return { confirm, element };
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    // Center horizontally + vertically. Native <dialog> only centers
    // horizontally by default; inset:0 + margin:auto centers in both axes.
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
  body: {
    padding: '20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  message: {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.5,
    color: '#555',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  cancelBtn: {
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 500,
    background: '#f5f5f5',
    color: '#333',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
  },
  confirmBtn: {
    padding: '7px 14px',
    fontSize: 13,
    fontWeight: 500,
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
  },
};
