/**
 * Cloudflare Turnstile widget.
 *
 * Rendered in the sign-in modal when the SaaS reports that social sign-in
 * needs a captcha. The site key arrives from `/api/v1/auth-providers` rather
 * than from build-time config: the editor is a static bundle with no server
 * env, and the requirement is an admin setting that can change under a
 * loaded page.
 *
 * Renders nothing without a key, so a standalone build — which never reaches
 * the SaaS — never loads Cloudflare's script.
 *
 * The token is single-use and expires after a few minutes, so the parent
 * bumps `resetKey` after a failed attempt to mint a fresh one; replaying a
 * spent token fails for a reason the user cannot act on.
 */
import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export function Turnstile({
  siteKey,
  onToken,
  resetKey = 0,
}: {
  siteKey: string;
  /** Called with the token, or null when it expires or the widget resets. */
  onToken: (token: string | null) => void;
  /** Bumped by the parent after a submit to force a fresh token. */
  resetKey?: number;
}) {
  const holder = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  // Through a ref so a parent passing a fresh closure each render does not
  // re-run the effect below and re-render the widget.
  const onTokenRef = useRef(onToken);
  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;

    const render = () => {
      if (cancelled || !holder.current || !window.turnstile) return;
      if (widgetId.current !== null) return;
      widgetId.current = window.turnstile.render(holder.current, {
        sitekey: siteKey,
        callback: (token: string) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      });
    };

    if (window.turnstile) {
      render();
      return () => {
        cancelled = true;
      };
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', render);
    if (!existing) {
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    // The widget is not removed on cleanup: StrictMode double-runs effects in
    // dev, and removing it there leaves an empty container with no way to
    // render into it again.
    return () => {
      cancelled = true;
      script.removeEventListener('load', render);
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || widgetId.current === null) return;
    window.turnstile?.reset(widgetId.current);
    onTokenRef.current(null);
  }, [resetKey]);

  if (!siteKey) return null;
  return <div ref={holder} style={{ marginBottom: 8 }} />;
}
