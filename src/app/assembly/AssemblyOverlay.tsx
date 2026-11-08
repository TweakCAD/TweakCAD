/**
 * What the assembly tools draw over the viewport: while a part is edited in
 * an assembly's context, a bar naming them with Finish; each captured
 * context that is out of date, with why and Update, and whether it updates
 * by itself; and the Components panel.
 */
import { useEffect, useState } from 'react';
import { isEditableTarget } from '../../components/toolShortcuts.ts';
import { getSaasState, isSaasAvailable } from '../../storage/saasState.ts';
import { AlertTriangle, PenLine } from 'lucide-react';
import type { AppServices } from '../services';
import { useDocument, useSlice } from '../hooks';
import { partOf } from '../features';
import { assemblyOf } from './assembly';
import { finishInPlace, reported } from './commands';
import { ComponentsPanel } from './ComponentsPanel';
import { outOfDate, setPolicy, updateContext } from './contexts';
import { inContextOf } from './focus';
import { useReadOnly } from '../storage/preview';

export function AssemblyOverlay({ services }: { services: AppServices }) {
  const doc = useDocument(services.editor);
  const display = useSlice(services.display, (s) => s.display);
  const preview = useSlice(services.display, (s) => s.preview);
  const focus = useSlice(services.app, (s) => s.focus);
  const componentsOpen = useSlice(services.app, (s) => s.componentsOpen);
  const [updating, setUpdating] = useState<string | null>(null);
  const readOnly = useReadOnly(services.session);
  const context = inContextOf(doc, focus);
  // A read-only preview offers no context update: it would write.
  const stale = preview || readOnly ? [] : outOfDate(doc, display);

  // Ctrl+I opens and closes the Components panel, as the title bar's button says; like the button, only with a site to list them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.defaultPrevented ||
        isEditableTarget(e.target) ||
        !(e.ctrlKey || e.metaKey) ||
        e.key.toLowerCase() !== 'i' ||
        !isSaasAvailable(getSaasState())
      )
        return;
      e.preventDefault();
      services.app.setState({ componentsOpen: !services.app.getState().componentsOpen });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [services]);

  return (
    <>
      {context && (
        <div style={styles.bar}>
          <PenLine size={13} color="#1a6fd1" />
          <span>
            Editing <b>{String(partOf(doc, context.part)?.name ?? 'part')}</b> in{' '}
            <b>{String(assemblyOf(doc, context.assembly)?.name ?? 'assembly')}</b>
          </span>
          <button type="button" style={styles.finish} onClick={() => finishInPlace(services)}>
            Finish
          </button>
        </div>
      )}
      {stale.length > 0 && (
        <div style={styles.notices}>
          {stale.map((s) => (
            <div key={s.context} style={styles.notice} role="status">
              <AlertTriangle size={13} color="#d97706" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1 }}>
                <div>
                  The context of <b>{s.partName}</b> is out of date: {s.reasons.join('; ')}.
                </div>
                <label style={styles.auto}>
                  <input
                    type="checkbox"
                    checked={s.policy === 'automatic'}
                    onChange={(e) =>
                      reported('Context', setPolicy(services, s.context, e.target.checked ? 'automatic' : 'manual'))
                    }
                  />
                  Update automatically
                </label>
              </div>
              <button
                type="button"
                style={styles.update}
                disabled={updating === s.context}
                onClick={() => {
                  setUpdating(s.context);
                  void updateContext(services, s.part, s.context).then((written) => {
                    setUpdating(null);
                    reported('Update context', written);
                  });
                }}
              >
                {updating === s.context ? 'Updating' : 'Update'}
              </button>
            </div>
          ))}
        </div>
      )}
      {componentsOpen && (
        <ComponentsPanel services={services} onClose={() => services.app.setState({ componentsOpen: false })} />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'absolute',
    top: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px 5px 10px',
    background: '#fff',
    border: '1px solid #a8cef0',
    borderRadius: 6,
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
    fontSize: 12,
    color: '#333',
    zIndex: 15,
  },
  finish: {
    border: 'none',
    borderRadius: 4,
    background: '#1a6fd1',
    color: '#fff',
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    cursor: 'pointer',
  },
  notices: {
    position: 'absolute',
    left: 8,
    bottom: 44,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    maxWidth: 380,
    zIndex: 15,
  },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '7px 9px',
    background: '#fffbeb',
    border: '1px solid #fcd34d',
    borderRadius: 6,
    boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    fontSize: 12,
    color: '#444',
  },
  auto: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 11, color: '#666' },
  update: {
    border: '1px solid #d97706',
    borderRadius: 4,
    background: '#fff',
    color: '#b45309',
    fontSize: 11,
    fontWeight: 600,
    padding: '3px 8px',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
