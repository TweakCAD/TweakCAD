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
import { ExternalLink } from 'lucide-react';
import { BetterAuthIdentityProvider } from '@tweakcad/cloud-providers';
import { refreshSaasState } from '../storage/saasState.ts';
import {
  onSocialProvidersChange,
  type SocialProvider,
} from '../storage/socialProviders.ts';

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
  beforeRedirect,
}: {
  open: boolean;
  onClose: () => void;
  onSignedIn?: () => void;
  /**
   * Awaited immediately before a social sign-in navigates the page away.
   * App.tsx passes the autosave scheduler's `flushNow`: autosave is debounced
   * 2s and its timer resets on every change, so without this an edit made
   * shortly before clicking a provider button would be lost when the tab
   * unloads. (The document survives via IndexedDB; the in-memory undo stack
   * does not, which is inherent to a full-page OAuth redirect.)
   */
  beforeRedirect?: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [socialProviders, setSocialProviders] = useState<SocialProvider[]>([]);
  const [redirecting, setRedirecting] = useState<string | null>(null);

  // Populated by the boot-time fetch in App.tsx; stays empty in standalone
  // mode and whenever the deployment has no provider credentials set.
  useEffect(() => onSocialProvidersChange(setSocialProviders), []);

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

  /**
   * Social sign-in. Flushes pending autosave, then hands off to the provider —
   * on success this navigates away and nothing below runs.
   */
  async function onSocial(providerId: string, label: string) {
    setError(null);
    setRedirecting(label);
    try {
      await beforeRedirect?.();
    } catch (err) {
      // A failed flush is not a reason to lose the sign-in, but the user
      // should know their last edits may not have made it to disk.
      console.warn('[signin] autosave flush before redirect failed', err);
    }
    // `callbackURL` is a path, resolved by Better Auth against ITS OWN
    // baseURL — not against this page's origin. In prod that's the same host
    // (the editor is served at /cad by the site) so the user lands back in
    // the editor. In dev the CAD app is on :5173 while the SaaS is on :3000,
    // so the round trip ends on the site rather than back here. That's a
    // dev-only artifact of the split ports, not a bug to route around.
    const result = await provider().signInSocial({
      provider: providerId,
      callbackURL: window.location.pathname,
    });
    // `redirected: true` means the navigation is under way — leave the
    // spinner up and let the page unload.
    if (!result.redirected) {
      setError(result.message);
      setRedirecting(null);
    }
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

        {socialProviders.length > 0 && (
          <div style={styles.socialGroup}>
            {socialProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={submitting || redirecting !== null}
                onClick={() => void onSocial(p.id, p.label)}
                style={{
                  ...styles.socialBtn,
                  cursor: redirecting !== null ? 'wait' : 'pointer',
                  opacity: submitting || redirecting !== null ? 0.6 : 1,
                }}
              >
                {redirecting === p.label
                  ? `Redirecting to ${p.label}...`
                  : `Continue with ${p.label}`}
              </button>
            ))}
            <div style={styles.divider}>
              <span style={styles.dividerLine} />
              <span style={styles.dividerText}>or</span>
              <span style={styles.dividerLine} />
            </div>
          </div>
        )}

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
          {submitting ? 'Signing in...' : 'Sign in'}
        </button>

        <div style={styles.footer}>
          <span style={styles.footerText}>No account?</span>
          <a
            href="/signup"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Create one (opens in a new tab)"
            style={{ ...styles.signupLink, display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            Create one
            <ExternalLink size={11} aria-hidden />
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
  socialGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  socialBtn: {
    width: '100%',
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 500,
    background: '#ffffff',
    color: '#333',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    fontFamily: 'inherit',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: '#e5e5e5',
  },
  dividerText: {
    fontSize: 11,
    color: '#999',
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
