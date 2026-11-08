/**
 * The ribbon's ASSEMBLE group: New Assembly and New Part, Insert and
 * Components, Joint, Drag, Rigid Group and Contact Set from the selection,
 * Motion Link, Component Pattern, Component Mirror and Replicate, Capture
 * Position, Exploded View, Derive into a part, and Hole Through Parts.
 */
import {
  Camera,
  Copy,
  CopyPlus,
  Expand,
  Layers,
  Link2,
  Move3d,
  Package,
  PackagePlus,
  Cog,
  SquareStack,
  Shapes,
  FilePlus2,
} from 'lucide-react';
import { HoleIcon, MirrorIcon, PatternIcon } from '../../icons/cadIcons.tsx';
import type { ModelTool } from '../modeling/ribbons';
import { startPanel } from '../modeling/commands';
import { getSaasState, isSaasAvailable } from '../../storage/saasState.ts';
import { capturePosition, groupSelected, newAssembly, newPart, startAssemblyPanel } from './commands';

const C = '#6366f1';

export const ASSEMBLY_TOOLS: readonly ModelTool[] = [
  {
    id: 'newAssembly',
    label: 'New Assembly',
    group: 'ASSEMBLE',
    icon: <Layers size={26} color={C} />,
    run: (s) => void newAssembly(s),
  },
  {
    id: 'newPart',
    label: 'New Part',
    group: 'ASSEMBLE',
    primary: false,
    icon: <FilePlus2 size={26} color={C} />,
    run: (s) => void newPart(s),
  },
  {
    id: 'insert',
    label: 'Insert',
    group: 'ASSEMBLE',
    icon: <PackagePlus size={26} color={C} />,
    panel: 'assembly.insert',
    run: (s) => startAssemblyPanel(s, 'assembly.insert', 'Insert'),
  },
  {
    id: 'components',
    label: 'Components',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Package size={26} color={C} />,
    // The catalogue is the site's: without one there is nothing to list, as the title bar's button is absent.
    available: () => isSaasAvailable(getSaasState()),
    run: (s) => s.app.setState({ componentsOpen: !s.app.getState().componentsOpen }),
  },
  {
    id: 'joint',
    label: 'Joint',
    group: 'ASSEMBLE',
    shortcut: 'J',
    icon: <Link2 size={26} color={C} />,
    panel: 'assembly.joint',
    run: (s) => startAssemblyPanel(s, 'assembly.joint', 'Joint'),
  },
  {
    id: 'moveInstance',
    label: 'Drag',
    group: 'ASSEMBLE',
    icon: <Move3d size={26} color={C} />,
    panel: 'assembly.move',
    run: (s) => startAssemblyPanel(s, 'assembly.move', 'Drag'),
  },
  {
    id: 'motionLink',
    label: 'Motion Link',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Cog size={26} color={C} />,
    panel: 'assembly.relation',
    run: (s) => startAssemblyPanel(s, 'assembly.relation', 'Motion Link'),
  },
  {
    id: 'rigidGroup',
    label: 'Rigid Group',
    group: 'ASSEMBLE',
    primary: false,
    icon: <SquareStack size={26} color={C} />,
    run: (s) => void groupSelected(s, 'rigidGroups'),
  },
  {
    id: 'contactSet',
    label: 'Contact Set',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Shapes size={26} color={C} />,
    run: (s) => void groupSelected(s, 'contactSets'),
  },
  {
    id: 'asmPattern',
    label: 'Component Pattern',
    group: 'ASSEMBLE',
    primary: false,
    icon: <PatternIcon size={26} color={C} />,
    panel: 'assembly.pattern',
    run: (s) => startAssemblyPanel(s, 'assembly.pattern', 'Component Pattern'),
  },
  {
    id: 'asmMirror',
    label: 'Component Mirror',
    group: 'ASSEMBLE',
    primary: false,
    icon: <MirrorIcon size={26} color={C} />,
    panel: 'assembly.mirror',
    run: (s) => startAssemblyPanel(s, 'assembly.mirror', 'Component Mirror'),
  },
  {
    id: 'asmReplicate',
    label: 'Replicate',
    group: 'ASSEMBLE',
    primary: false,
    icon: <CopyPlus size={26} color={C} />,
    panel: 'assembly.replicate',
    run: (s) => startAssemblyPanel(s, 'assembly.replicate', 'Replicate'),
  },
  {
    id: 'position',
    label: 'Capture Position',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Camera size={26} color={C} />,
    run: (s) => void capturePosition(s),
  },
  {
    id: 'exploded',
    label: 'Exploded View',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Expand size={26} color={C} />,
    panel: 'assembly.exploded',
    run: (s) => startAssemblyPanel(s, 'assembly.exploded', 'Exploded View'),
  },
  {
    id: 'derive',
    label: 'Derive',
    group: 'ASSEMBLE',
    primary: false,
    icon: <Copy size={26} color={C} />,
    panel: 'derive',
    run: (s) => startPanel(s, 'derive', 'Derive'),
  },
  {
    id: 'multiHole',
    label: 'Hole Through Parts',
    group: 'ASSEMBLE',
    primary: false,
    icon: <HoleIcon size={26} color="#f97316" />,
    panel: 'assembly.hole',
    run: (s) => startAssemblyPanel(s, 'assembly.hole', 'Hole Through Parts'),
  },
];
