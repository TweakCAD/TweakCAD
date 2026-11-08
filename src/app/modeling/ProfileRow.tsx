/**
 * The Profile row of a feature built from sketch regions: what the picked
 * profiles read as, and under it, when there is more than one or one is
 * missing, each profile on its own line with a remove button, a missing one
 * in red. A region clicked while one is missing takes its place.
 */
import { X } from 'lucide-react';
import type { ExtrudeProfile } from './extrude';
import { MISSING_COLOR, styles } from './panelKit';
import { isMissingProfile, profilesLabel } from './profiles';

export function ProfileRow({
  profiles,
  sketchName,
  onActivate,
  onRemove,
}: {
  profiles: readonly ExtrudeProfile[];
  sketchName: string;
  /** A click on the row: clicks in the view pick profiles again. */
  onActivate?: () => void;
  /** Drops the profile at this index of `profiles`. */
  onRemove: (index: number) => void;
}) {
  const label = profilesLabel(profiles, sketchName);
  const anyFound = profiles.some((p) => !isMissingProfile(p));
  const listed = profiles.length > 1 || profiles.some(isMissingProfile);
  let found = 0;
  return (
    <>
      <div style={styles.row} onClick={onActivate}>
        <span style={styles.label}>Profile</span>
        {label === null ? (
          <span style={hint}>Click a closed region</span>
        ) : (
          <span style={{ ...value, color: anyFound ? '#2196f3' : MISSING_COLOR }}>{label}</span>
        )}
      </div>
      {listed && (
        <div style={list}>
          {profiles.map((p, i) => {
            const missing = isMissingProfile(p);
            if (!missing) found++;
            return (
              <div key={i} style={styles.pickRow}>
                <span style={{ ...styles.pickLabel, ...(missing ? { color: MISSING_COLOR } : {}) }}>
                  {missing ? 'Missing profile' : `Profile ${found}`}
                </span>
                <button
                  type="button"
                  style={styles.pickRemove}
                  title="Remove"
                  aria-label={missing ? 'Remove missing profile' : `Remove profile ${found}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(i);
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

const value: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const hint: React.CSSProperties = { fontSize: 11, color: '#aaa', fontStyle: 'italic' };
const list: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, padding: '0 12px 6px' };
