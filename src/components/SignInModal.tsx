/**
 * Inline sign-in modal for the CAD app.
 *
 * Calls /api/v1/auth/sign-in/email directly (same origin in prod;
 * Vite proxy in dev). On success, kicks off a SaaS state refresh so
 * cloud features become available immediately.
 *
 * Sign-UP is deliberately not handled here — it requires email
 * verification which is a multi-step flow that pulls the user out of the
 * editor anyway. The "Create account" link bounces to /signup on the
 * host site for that.
 *
 * Uses inline styles to match the rest of the app (no Tailwind here).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BetterAuthIdentityProvider } from '@tweakcad/cloud-providers';
import { refreshSaasState } from '../storage/saasState.ts';

let cachedProvider: BetterAuthIdentityProvider | null = null;
function provider(): BetterAuthIdentityProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = new BetterAuthIdentityProvider({ baseUrl: '' });
  return cachedProvider;
}

export function SignInModal({
  open,
  onClose,
  onSignedIn,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn?: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      // Reset form whenever the modal reopens.
      setEmail('');
      setPassword('');
      setError(null);
      setSubmitting(false);
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await provider().signInEmail({ email, password });
    if (!result.ok) {
      setError(result.message);
      setSubmitting(false);
      return;
    }
    // Refresh the SaaS probe — UI will re-render with signedIn = true.
    await refreshSaasState();
    setSubmitting(false);
    onSignedIn?.();
    onClose();
  }

  function onDialogClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function onDialogCancel(e: React.SyntheticEvent<HTMLDialogElement>) {
    e.preventDefault();
    onClose();
  }

  return (
    <dialog
      ref={ref}
      onClick={onDialogClick}
      onCancel={onDialogCancel}
      style={styles.dialog}
    >
      <form onSubmit={onSubmit} style={styles.body}>
        <div>
          <h2 style={styles.title}>Sign in</h2>
          <p style={styles.subtitle}>
            Sign in to sync this project with your cloud account.
          </p>
        </div>

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoFocus
          required
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          required
        />

        {error && <div style={styles.error}>{error}</div>}

        <button
          type="submit"
          disabled={submitting}
          style={{
            ...styles.submitBtn,
            opacity: submitting ? 0.5 : 1,
            cursor: submitting ? 'wait' : 'pointer',
          }}
          onMouseEnter={(e) => {
            if (!submitting) (e.currentTarget as HTMLButtonElement).style.background = '#1557a0';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#1a6fd1';
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>

        <div style={styles.footer}>
          <span style={styles.footerText}>No account?</span>
          <a
            href="/signup"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.signupLink}
          >
            Create one →
          </a>
          <span style={styles.footerSpacer} />
          <button type="button" onClick={onClose} style={styles.cancelBtn}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

// ---- Field ----

function Field({
  label,
  type,
  value,
  onChange,
  required,
  autoFocus,
}: {
  label: string;
  type: 'email' | 'password' | 'text';
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        autoFocus={autoFocus}
        style={styles.input}
      />
    </label>
  );
}

// ---- Styles ----

const styles: Record<string, React.CSSProperties> = {
  dialog: {
    inset: 0,
    margin: 'auto',
    width: 'min(92vw, 380px)',
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
    gap: 14,
  },
  title: {
    margin: 0,
    fontSize: 15,
    fontWeight: 600,
    color: '#222',
  },
  subtitle: {
    margin: '4px 0 0',
    fontSize: 12,
    lineHeight: 1.4,
    color: '#666',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: 500,
    color: '#555',
  },
  input: {
    width: '100%',
    height: 32,
    padding: '0 10px',
    border: '1px solid #d0d0d0',
    borderRadius: 5,
    fontSize: 13,
    color: '#333',
    outline: 'none',
    background: '#ffffff',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  error: {
    fontSize: 12,
    color: '#dc2626',
    background: '#fee2e2',
    padding: '6px 10px',
    borderRadius: 5,
    border: '1px solid #fecaca',
  },
  submitBtn: {
    marginTop: 4,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 500,
    background: '#1a6fd1',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    transition: 'background 0.12s',
    fontFamily: 'inherit',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
    borderTop: '1px solid #eee',
    fontSize: 11,
  },
  footerText: {
    color: '#888',
  },
  signupLink: {
    color: '#1a6fd1',
    textDecoration: 'none',
    fontWeight: 500,
  },
  footerSpacer: {
    flex: 1,
  },
  cancelBtn: {
    padding: '5px 10px',
    fontSize: 11,
    background: 'transparent',
    color: '#666',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
