/**
 * The toolbar's badges while geometry imports run: what each is doing, the
 * seconds it has taken, and Cancel. They read the import list themselves, so
 * only the badges render as an import goes.
 */
import { useEffect, useState } from 'react';
import { useSlice } from '../hooks';
import { statusText } from '../display/status';
import { importJobs } from './importJobs';

export function ImportBadges() {
  const jobs = useSlice(importJobs, (s) => s.jobs);
  const [now, setNow] = useState(() => Date.now());
  const running = jobs.length > 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <>
      {jobs.map((job) => {
        const text = `Importing ${job.name}: ${statusText(job.status, Math.max(0, now - job.since))}`;
        return (
          <span key={job.id} style={styles.badge} title={text} data-testid="import-badge">
            <span style={styles.text}>{text}</span>
            <button type="button" style={styles.cancel} onClick={() => job.cancel()}>
              Cancel
            </button>
          </span>
        );
      })}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    fontWeight: 700,
    color: '#ffffff',
    background: '#1565c0',
    padding: '2px 4px 2px 8px',
    borderRadius: 10,
    letterSpacing: 0.3,
    marginRight: 8,
    maxWidth: 480,
    fontVariantNumeric: 'tabular-nums',
  },
  text: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cancel: {
    fontSize: 11,
    fontWeight: 700,
    color: '#1565c0',
    background: '#ffffff',
    border: 'none',
    borderRadius: 8,
    padding: '1px 8px',
    cursor: 'pointer',
    flexShrink: 0,
  },
};
