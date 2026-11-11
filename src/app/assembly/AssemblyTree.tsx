/**
 * The assemblies in the browser: each assembly with its instances (grounded
 * ones pinned), joints with their values (locked ones marked, renamed in
 * place), motion links, rigid groups, contact sets, the assembly features
 * that copy instances (patterns, mirrors, replicates), positions (the active
 * one marked, Current included) and exploded views (the shown one marked).
 * Each row's menu runs its commands; a paused row shows red with its message,
 * as a failed feature does.
 */
import { useEffect, useRef, useState } from 'react';
import {
  Box,
  Cog,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  Layers,
  Link2,
  Lock,
  LockOpen,
  Move3d,
  Pause,
  PenLine,
  Play,
  ExternalLink,
  Expand,
  Trash2,
  Camera,
  RefreshCw,
  CircleDot,
  Circle,
  Puzzle,
} from 'lucide-react';
import { isPlainObject } from '@tweakcad/format';
import type { AppServices } from '../services';
import { useDocument, useSlice } from '../hooks';
import { useKeptInWindow } from '../menuPlacement';
import { MenuButton, RenameField, TreeNode, browserStyles as styles } from '../BrowserTree';
import { FeatureSuppressedIcon, FeatureWarningIcon, getFeatureIcon } from '../../icons/cadIcons.tsx';
import { editFeature } from '../modeling/commands';
import { asmTimelineRows, copiesOf } from './asmFeatures';
import { commitSolved } from './commit';
import { animateJoint, editJoint } from './jointActions';
import { DOF_LABELS, assemblyView, assembliesOf, isTranslation, type AssemblyView } from './assembly';
import {
  activatePosition,
  editInPlace,
  open,
  partOfInstance,
  removeInstance,
  removeJoint,
  removePosition,
  removeRow,
  renameJoint,
  reported,
  setInstanceFlag,
  setJointLocked,
  setJointSuppressed,
  showExploded,
  startAssemblyPanel,
  updatePosition,
} from './commands';
import { shownAssembly } from './focus';
import { useReadOnly } from '../storage/preview';
import { toggleNode, useTreeOpen } from '../treeOpen';

type Menu = {
  x: number;
  y: number;
  assembly: string;
  row: { kind: 'instance' | 'joint' | 'relation' | 'group' | 'position' | 'exploded' | 'feature'; id: string };
};

const fmt = (dof: string, v: number) =>
  `${DOF_LABELS[dof] ?? dof} ${Math.round(v * 100) / 100}${isTranslation(dof) ? ' mm' : '°'}`;

export function AssemblyTree({ services }: { services: AppServices }) {
  const doc = useDocument(services.editor);
  const display = useSlice(services.display, (s) => s.display);
  const focus = useSlice(services.app, (s) => s.focus);
  const exploded = useSlice(services.app, (s) => s.exploded);
  const isOpen = useTreeOpen();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useKeptInWindow(menuRef, menu);
  const shown = shownAssembly(doc, focus);
  // A read-only preview: rows select and expand, but have no menus, double-clicks or position changes.
  const readOnly = useReadOnly(services.session);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);

  const toggle = toggleNode;
  const views = assembliesOf(doc).flatMap((a) => assemblyView(doc, String(a.id), display) ?? []);

  const row = (
    key: string,
    depth: number,
    icon: React.ReactNode,
    label: string,
    o: {
      status?: 'success' | 'failed';
      message?: string;
      dim?: boolean;
      trailing?: React.ReactNode;
      onClick?: () => void;
      onDoubleClick?: () => void;
      onMenu?: (e: React.MouseEvent) => void;
      title?: string;
      onRename?: (name: string | null) => void;
    } = {},
  ) =>
    o.onRename ? (
      <div
        key={key}
        style={{
          ...styles.featureNode,
          paddingLeft: 8 + depth * 14,
          paddingRight: 28,
          borderLeft: '2px solid transparent',
        }}
      >
        <span style={styles.featureIconWrap}>{icon}</span>
        <RenameField name={label} onDone={o.onRename} />
      </div>
    ) : (
      <div key={key} style={{ position: 'relative' }}>
        <button
          type="button"
          style={{
            ...styles.featureNode,
            paddingLeft: 8 + depth * 14,
            paddingRight: 28,
            borderLeft: '2px solid transparent',
            opacity: o.dim ? 0.5 : 1,
            ...(o.status === 'failed' ? { color: '#dc2626' } : {}),
          }}
          onClick={o.onClick}
          onDoubleClick={readOnly ? undefined : o.onDoubleClick}
          onContextMenu={(e) => {
            if (!o.onMenu || readOnly) return;
            e.preventDefault();
            o.onMenu(e);
          }}
          title={o.message ?? o.title ?? label}
        >
          <span style={styles.featureIconWrap}>{o.status === 'failed' ? <FeatureWarningIcon size={12} /> : icon}</span>
          <span style={styles.featureName}>{label}</span>
        </button>
        {o.trailing}
      </div>
    );

  const menuAt = (assembly: string, kind: Menu['row']['kind'], id: string) => (e: React.MouseEvent) =>
    setMenu({ x: e.clientX, y: e.clientY, assembly, row: { kind, id } });

  const assemblyNode = (a: AssemblyView) => {
    const here = shown === a.id;
    const features = asmTimelineRows(doc, a.id, display);
    return (
      <TreeNode
        key={a.id}
        label={a.name}
        icon={<Layers size={13} color="#6366f1" />}
        expanded={isOpen(a.id)}
        onToggle={() => toggle(a.id)}
        depth={1}
        bold
        {...(!here
          ? {
              trailingAction: {
                icon: <ExternalLink size={11} color="#777" />,
                onClick: () => open(services, { assembly: a.id }),
                ariaLabel: `Open ${a.name}`,
              },
            }
          : {})}
      >
        <TreeNode
          label="Instances"
          icon={<Box size={12} color="#ff9800" />}
          expanded={isOpen(`${a.id}/inst`)}
          onToggle={() => toggle(`${a.id}/inst`)}
          depth={2}
          count={a.instances.length}
        >
          {a.instances.length === 0 && <span style={{ ...styles.emptyText, paddingLeft: 56 }}>No instances</span>}
          {a.instances.map((i) =>
            row(i.id, 3, <Box size={12} color="#ff9800" />, i.label, {
              status: i.status,
              ...(i.message ? { message: i.message } : {}),
              dim: i.suppressed,
              onMenu: menuAt(a.id, 'instance', i.id),
              onDoubleClick: () => {
                if (i.part) editInPlace(services, a.id, i.id);
              },
              trailing: i.grounded ? (
                <span style={{ ...styles.trailingActionBtn, cursor: 'default' }} title="Grounded">
                  <Lock size={10} color="#777" />
                </span>
              ) : undefined,
            }),
          )}
        </TreeNode>
        <TreeNode
          label="Joints"
          icon={<Link2 size={12} color="#6366f1" />}
          expanded={isOpen(`${a.id}/jnt`)}
          onToggle={() => toggle(`${a.id}/jnt`)}
          depth={2}
          count={a.joints.length}
        >
          {a.joints.length === 0 && <span style={{ ...styles.emptyText, paddingLeft: 56 }}>No joints</span>}
          {a.joints.map((j) =>
            renaming === j.id
              ? row(j.id, 3, <Link2 size={12} color="#6366f1" />, j.label, {
                  onRename: (name) => {
                    setRenaming(null);
                    if (name !== null && name.trim() !== j.label) void renameJoint(services, a.id, j.id, name);
                  },
                })
              : row(
                  j.id,
                  3,
                  <Link2 size={12} color="#6366f1" />,
                  `${j.label}${
                    Object.keys(j.values).length > 0
                      ? `  ${Object.entries(j.values)
                          .map(([d, v]) => fmt(d, v))
                          .join(', ')}`
                      : ''
                  }`,
                  {
                    status: j.status,
                    ...(j.message ? { message: j.message } : {}),
                    dim: j.suppressed,
                    onMenu: menuAt(a.id, 'joint', j.id),
                    onDoubleClick: () => editJoint(services, j.id),
                    trailing: j.locked ? (
                      <span style={{ ...styles.trailingActionBtn, cursor: 'default' }} title="Locked">
                        <Lock size={10} color="#777" />
                      </span>
                    ) : undefined,
                  },
                ),
          )}
        </TreeNode>
        {a.relations.length > 0 && (
          <TreeNode
            label="Motion Links"
            icon={<Cog size={12} color="#6366f1" />}
            expanded={isOpen(`${a.id}/rel`)}
            onToggle={() => toggle(`${a.id}/rel`)}
            depth={2}
            count={a.relations.length}
          >
            {a.relations.map((r) =>
              row(r.id, 3, <Cog size={12} color="#6366f1" />, r.label, {
                status: r.status,
                ...(r.message ? { message: r.message } : {}),
                onMenu: menuAt(a.id, 'relation', r.id),
              }),
            )}
          </TreeNode>
        )}
        {(a.rigidGroups.length > 0 || a.contactSets.length > 0) && (
          <TreeNode
            label="Groups"
            icon={<Layers size={12} color="#64748b" />}
            expanded={isOpen(`${a.id}/grp`)}
            onToggle={() => toggle(`${a.id}/grp`)}
            depth={2}
            count={a.rigidGroups.length + a.contactSets.length}
          >
            {[...a.rigidGroups, ...a.contactSets].map((g) =>
              row(g.id, 3, <Layers size={12} color="#64748b" />, `${g.label}: ${g.members.join(', ')}`, {
                onMenu: menuAt(a.id, 'group', g.id),
              }),
            )}
          </TreeNode>
        )}
        {features.length > 0 && (
          <TreeNode
            label="Features"
            icon={<Copy size={12} color="#6366f1" />}
            expanded={isOpen(`${a.id}/feat`)}
            onToggle={() => toggle(`${a.id}/feat`)}
            depth={2}
            count={features.length}
          >
            {features.map((f) => {
              const copies = copiesOf(display, a.id, f.id);
              return row(
                f.id,
                3,
                <span style={{ color: '#6366f1', display: 'inline-flex' }}>{getFeatureIcon(f.iconKey, 12)}</span>,
                f.name,
                {
                  status: f.status === 'failed' ? 'failed' : 'success',
                  ...(f.message ? { message: f.message } : {}),
                  title: `${f.name}: ${copies} ${copies === 1 ? 'copy' : 'copies'}`,
                  dim: f.suppressed,
                  onMenu: menuAt(a.id, 'feature', f.id),
                  onDoubleClick: () => editFeature(services, f.id),
                  trailing: f.suppressed ? (
                    <span style={{ ...styles.trailingActionBtn, cursor: 'default' }} title="Suppressed">
                      <FeatureSuppressedIcon size={10} />
                    </span>
                  ) : undefined,
                },
              );
            })}
          </TreeNode>
        )}
        <TreeNode
          label="Positions"
          icon={<Camera size={12} color="#0d9488" />}
          expanded={isOpen(`${a.id}/pos`)}
          onToggle={() => toggle(`${a.id}/pos`)}
          depth={2}
          count={a.positions.length}
        >
          {row(
            `${a.id}/current`,
            3,
            a.activePosition === null ? <CircleDot size={12} color="#0d9488" /> : <Circle size={12} color="#0d9488" />,
            'Current',
            {
              onClick: () => {
                if (a.activePosition !== null && !readOnly) void activatePosition(services, a.id);
              },
            },
          )}
          {a.positions.map((p) =>
            row(
              p.id,
              3,
              a.activePosition === p.id ? (
                <CircleDot size={12} color="#0d9488" />
              ) : (
                <Circle size={12} color="#0d9488" />
              ),
              p.name,
              {
                onClick: () => {
                  if (a.activePosition !== p.id && !readOnly) void activatePosition(services, a.id, p.id);
                },
                onMenu: menuAt(a.id, 'position', p.id),
              },
            ),
          )}
        </TreeNode>
        {a.explodedViews.length > 0 && (
          <TreeNode
            label="Exploded Views"
            icon={<Expand size={12} color="#6366f1" />}
            expanded={isOpen(`${a.id}/exp`)}
            onToggle={() => toggle(`${a.id}/exp`)}
            depth={2}
            count={a.explodedViews.length}
          >
            {a.explodedViews.map((e) =>
              row(e.id, 3, <Expand size={12} color="#6366f1" />, e.name, {
                onClick: () => {
                  if (shown === a.id) showExploded(services, e.id);
                },
                onMenu: menuAt(a.id, 'exploded', e.id),
                trailing:
                  shown === a.id ? (
                    <button
                      type="button"
                      style={styles.trailingActionBtn}
                      aria-label={exploded === e.id ? `Hide ${e.name}` : `Show ${e.name}`}
                      title={exploded === e.id ? 'Hide' : 'Show'}
                      onClick={() => showExploded(services, e.id)}
                    >
                      {exploded === e.id ? <Eye size={11} strokeWidth={1.5} /> : <EyeOff size={11} strokeWidth={1.5} />}
                    </button>
                  ) : undefined,
              }),
            )}
          </TreeNode>
        )}
      </TreeNode>
    );
  };

  const close = () => setMenu(null);
  const menuView = menu ? views.find((v) => v.id === menu.assembly) : undefined;
  const instance = menu?.row.kind === 'instance' ? menuView?.instances.find((i) => i.id === menu.row.id) : undefined;
  const joint = menu?.row.kind === 'joint' ? menuView?.joints.find((j) => j.id === menu.row.id) : undefined;
  const feature =
    menu?.row.kind === 'feature'
      ? asmTimelineRows(doc, menu.assembly, display).find((f) => f.id === menu.row.id)
      : undefined;
  const here = menu ? shown === menu.assembly : false;

  return (
    <>
      {views.map(assemblyNode)}
      {menu && (
        <div ref={menuRef} style={{ ...styles.contextMenu, left: menu.x, top: menu.y }}>
          {instance && (
            <>
              {instance.part && (
                <MenuButton
                  icon={<PenLine size={14} />}
                  label="Edit in Place"
                  onClick={() => {
                    close();
                    editInPlace(services, menu.assembly, instance.id);
                  }}
                />
              )}
              {instance.part && (
                <MenuButton
                  icon={<ExternalLink size={14} />}
                  label="Open Part"
                  onClick={() => {
                    close();
                    const part = partOfInstance(services, menu.assembly, instance.id);
                    if (part) open(services, { part });
                  }}
                />
              )}
              {isPlainObject(instance.of.component) && (
                <MenuButton
                  icon={<Puzzle size={14} />}
                  label="Edit Component..."
                  onClick={() => {
                    close();
                    services.app.setState({
                      panel: { kind: 'assembly.component', feature: instance.id, from: menu.assembly },
                    });
                  }}
                />
              )}
              {here && (
                <MenuButton
                  icon={<Move3d size={14} />}
                  label="Move"
                  onClick={() => {
                    close();
                    startAssemblyPanel(services, 'assembly.move', 'Move', instance.id);
                  }}
                />
              )}
              <MenuButton
                icon={instance.grounded ? <LockOpen size={14} /> : <Lock size={14} />}
                label={instance.grounded ? 'Unground' : 'Ground'}
                onClick={() => {
                  close();
                  void setInstanceFlag(services, menu.assembly, instance.id, 'grounded', !instance.grounded);
                }}
              />
              <MenuButton
                icon={<Pause size={14} />}
                label={instance.suppressed ? 'Unsuppress' : 'Suppress'}
                onClick={() => {
                  close();
                  void setInstanceFlag(services, menu.assembly, instance.id, 'suppressed', !instance.suppressed);
                }}
              />
              <div style={styles.contextDivider} />
              <MenuButton
                icon={<Trash2 size={14} />}
                label="Delete"
                danger
                onClick={() => {
                  close();
                  void removeInstance(services, menu.assembly, instance.id);
                }}
              />
            </>
          )}
          {joint && (
            <>
              {here && (
                <MenuButton
                  icon={<Link2 size={14} />}
                  label="Edit Joint"
                  onClick={() => {
                    close();
                    startAssemblyPanel(services, 'assembly.joint', 'Edit Joint', joint.id);
                  }}
                />
              )}
              <MenuButton
                icon={<PenLine size={14} />}
                label="Rename"
                onClick={() => {
                  close();
                  setRenaming(joint.id);
                }}
              />
              {here && !joint.locked && (
                <MenuButton
                  icon={<Gauge size={14} />}
                  label="Drive Joint"
                  onClick={() => {
                    close();
                    startAssemblyPanel(services, 'assembly.drive', 'Drive Joint', joint.id);
                  }}
                />
              )}
              {here && !joint.locked && (
                <MenuButton
                  icon={<Play size={14} />}
                  label="Animate Joint"
                  onClick={() => {
                    close();
                    void animateJoint(services, menu.assembly, joint.id);
                  }}
                />
              )}
              <MenuButton
                icon={joint.locked ? <LockOpen size={14} /> : <Lock size={14} />}
                label={joint.locked ? 'Unlock Motion' : 'Lock Motion'}
                onClick={() => {
                  close();
                  void setJointLocked(services, menu.assembly, joint.id, !joint.locked);
                }}
              />
              <MenuButton
                icon={<Pause size={14} />}
                label={joint.suppressed ? 'Unsuppress' : 'Suppress'}
                onClick={() => {
                  close();
                  void setJointSuppressed(services, menu.assembly, joint.id, !joint.suppressed);
                }}
              />
              <div style={styles.contextDivider} />
              <MenuButton
                icon={<Trash2 size={14} />}
                label="Delete"
                danger
                onClick={() => {
                  close();
                  void removeJoint(services, menu.assembly, joint.id);
                }}
              />
            </>
          )}
          {feature && (
            <>
              <MenuButton
                icon={<PenLine size={14} />}
                label="Edit Feature"
                onClick={() => {
                  close();
                  editFeature(services, feature.id);
                }}
              />
              <MenuButton
                icon={<Pause size={14} />}
                label={feature.suppressed ? 'Unsuppress' : 'Suppress'}
                onClick={() => {
                  close();
                  const label = `${feature.suppressed ? 'Unsuppress' : 'Suppress'} ${feature.name}`;
                  void commitSolved(services, label, [
                    { type: 'setSuppressed', feature: feature.id, suppressed: !feature.suppressed },
                  ]).then((w) => reported(label, w));
                }}
              />
              <div style={styles.contextDivider} />
              <MenuButton
                icon={<Trash2 size={14} />}
                label="Delete"
                danger
                onClick={() => {
                  close();
                  void commitSolved(services, `Delete ${feature.name}`, [
                    { type: 'removeFeature', feature: feature.id },
                  ]).then((w) => reported('Delete', w));
                }}
              />
            </>
          )}
          {menu.row.kind === 'position' && (
            <>
              <MenuButton
                icon={<RefreshCw size={14} />}
                label="Update to Current"
                onClick={() => {
                  close();
                  void updatePosition(services, menu.assembly, menu.row.id);
                }}
              />
              <div style={styles.contextDivider} />
              <MenuButton
                icon={<Trash2 size={14} />}
                label="Delete"
                danger
                onClick={() => {
                  close();
                  void removePosition(services, menu.assembly, menu.row.id);
                }}
              />
            </>
          )}
          {menu.row.kind === 'exploded' && here && (
            <MenuButton
              icon={<PenLine size={14} />}
              label="Edit"
              onClick={() => {
                close();
                startAssemblyPanel(services, 'assembly.exploded', 'Exploded View', menu.row.id);
              }}
            />
          )}
          {(menu.row.kind === 'relation' || menu.row.kind === 'group' || menu.row.kind === 'exploded') && (
            <MenuButton
              icon={<Trash2 size={14} />}
              label="Delete"
              danger
              onClick={() => {
                close();
                void removeRow(services, menu.row.id, 'Delete');
              }}
            />
          )}
        </div>
      )}
    </>
  );
}
