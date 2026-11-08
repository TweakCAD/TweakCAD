/**
 * The React side of an assembly panel, after the feature panels: the form
 * is local state; a moment after it changes, the preview shows the
 * assembly with the pending rows, solved; OK writes them, with the pose
 * they solve to, as one undo step; Cancel writes nothing.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Editor, EditorCommand } from '@tweakcad/editor';
import type { PanelProps } from '../AppShell';
import type { AppServices } from '../services';
import { PREVIEW_DELAY } from '../modeling/usePanel';
import { candidateOf, commitSolved } from './commit';
import { currentAssembly, warn } from './commands';
import { assemblyOf } from './assembly';
import { useDocument } from '../hooks';

export type RowsBuilt =
  { ok: true; commands: EditorCommand[]; label: string } | { ok: false; message: string; quiet?: boolean };

export interface AssemblyPanelSpec<F> {
  title: string;
  /** The form the panel opens with; null when it cannot open on the request. */
  create(services: AppServices, assembly: string, request: PanelProps['request']): F | null;
  /** What the user is told when `create` gives nothing in an open assembly. */
  refusal?: string;
  build(editor: Editor, assembly: string, form: F): RowsBuilt;
  /** What follows a written OK, once the panel has closed (Insert goes on to drag the new instance). */
  after?(services: AppServices, built: Extract<RowsBuilt, { ok: true }>): void;
}

export interface AssemblyPanel<F> {
  assembly: string;
  form: F;
  update(patch: Partial<F> | ((f: F) => Partial<F>)): void;
  error: string | null;
  setError(message: string | null): void;
  busy: boolean;
  confirm(): void;
}

export function useAssemblyPanel<F>(
  { services, request, close }: PanelProps,
  spec: AssemblyPanelSpec<F>,
): AssemblyPanel<F> | null {
  const { editor, scheduler } = services;
  const setup = useMemo(() => {
    const assembly = currentAssembly(services);
    if (!assembly || !assemblyOf(editor.document, assembly)) return null;
    const form = spec.create(services, assembly, request);
    return form ? { assembly, form } : null;
    // Settled when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (setup) return;
    const assembly = currentAssembly(services);
    const open = assembly !== null && assemblyOf(editor.document, assembly) !== undefined;
    warn(spec.title, open && spec.refusal ? spec.refusal : `Open an assembly to use ${spec.title}`);
    close();
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [form, setForm] = useState<F | null>(() => setup?.form ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(form);
  useLayoutEffect(() => {
    latest.current = form;
  });
  // While OK writes, the preview it solves is not replaced; once closed, nothing it started touches the panel.
  const committing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const doc = useDocument(editor);

  // A form that cannot build shows the assembly without its preview at once.
  useEffect(() => {
    if (!setup || form === null || committing.current) return;
    const built = spec.build(editor, setup.assembly, form);
    if (!built.ok) scheduler.setPreview(null);
    const timer = setTimeout(() => {
      if (committing.current) return;
      if (!built.ok) {
        setError(built.quiet ? null : built.message);
        return;
      }
      const candidate = candidateOf(editor.document, built.commands);
      setError(candidate.ok ? null : candidate.message);
      scheduler.setPreview(candidate.ok ? candidate.doc : null);
    }, PREVIEW_DELAY);
    return () => clearTimeout(timer);
    // `spec` is a module constant of each panel; `doc` rebuilds the preview when the document changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, form, editor, scheduler, doc]);
  useEffect(() => () => scheduler.setPreview(null), [scheduler]);

  const update = useCallback((patch: Partial<F> | ((f: F) => Partial<F>)) => {
    setForm((f) => (f === null ? f : { ...f, ...(typeof patch === 'function' ? patch(f) : patch) }));
    setError(null);
  }, []);

  const confirm = useCallback(() => {
    if (!setup || latest.current === null || busy) return;
    const built = spec.build(editor, setup.assembly, latest.current);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    committing.current = true;
    void commitSolved(services, built.label, built.commands, () => mounted.current).then((written) => {
      committing.current = false;
      if (!mounted.current) return;
      setBusy(false);
      if (written.ok) {
        close();
        spec.after?.(services, built);
      } else setError(written.message);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, editor, close, busy]);

  if (!setup || form === null) return null;
  return { assembly: setup.assembly, form, update, error, setError, busy, confirm };
}
