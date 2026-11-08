/**
 * The shell with the modelling tools in its slots: the Sketch and Extrude
 * tools in the ribbon, their panels, and sketch mode with its own ribbon.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell, type AppShellProps, type PanelProps, type SketchSlotProps } from './AppShell';
import { ExtrudePanel } from './modeling/ExtrudePanel';
import { LoftPanel } from './modeling/LoftPanel';
import { RevolvePanel } from './modeling/RevolvePanel';
import { SweepPanel } from './modeling/SweepPanel';
import { ChamferPanel, FilletPanel } from './modeling/BlendPanels';
import { HolePanel } from './modeling/HolePanel';
import { ThreadPanel } from './modeling/ThreadPanel';
import { BooleanPanel, MirrorPanel, PatternPanel, RemoveBodyPanel, ShellPanel } from './modeling/BodyPanels';
import { MoveBodiesPanel } from './modeling/MoveBodiesPanel';
import { PrimitivePanel } from './modeling/PrimitivePanel';
import { ConstructionPanel } from './modeling/ConstructionPanel';
import { MeasurePanel, MeasureValuesPanel } from './modeling/MeasurePanel';
import { useModelingRibbon, useSketchRibbon } from './modeling/ribbons';
import { SketchMode, createSessionStore } from './modeling/SketchMode';
import { SketchPlanePanel } from './modeling/SketchPlanePanel';
import { AssemblyOverlay } from './assembly/AssemblyOverlay';
import { AssemblyTree } from './assembly/AssemblyTree';
import { DerivePanel } from './assembly/DerivePanel';
import { AsmMirrorPanel, AsmPatternPanel, AsmReplicatePanel } from './assembly/AsmFeaturePanels';
import { ComponentEditPanel } from './assembly/ComponentEditPanel';
import { DrivePanel } from './assembly/DrivePanel';
import { ExplodedPanel } from './assembly/ExplodedPanel';
import { InsertPanel } from './assembly/InsertPanel';
import { JointPanel } from './assembly/JointPanel';
import { MoveInstancePanel } from './assembly/MoveInstancePanel';
import { MultiHolePanel } from './assembly/MultiHolePanel';
import { RelationPanel } from './assembly/RelationPanel';
import { followContextUpdates } from './assembly/contexts';

const PANELS: Record<string, (props: PanelProps) => React.ReactNode> = {
  sketchPlane: (props) => <SketchPlanePanel {...props} />,
  extrude: (props) => <ExtrudePanel {...props} />,
  revolve: (props) => <RevolvePanel {...props} />,
  loft: (props) => <LoftPanel {...props} />,
  sweep: (props) => <SweepPanel {...props} />,
  fillet: (props) => <FilletPanel {...props} />,
  chamfer: (props) => <ChamferPanel {...props} />,
  hole: (props) => <HolePanel {...props} />,
  thread: (props) => <ThreadPanel {...props} />,
  shell: (props) => <ShellPanel {...props} />,
  pattern: (props) => <PatternPanel {...props} />,
  mirror: (props) => <MirrorPanel {...props} />,
  move: (props) => <MoveBodiesPanel {...props} />,
  combine: (props) => <BooleanPanel {...props} />,
  cut: (props) => <BooleanPanel {...props} />,
  intersect: (props) => <BooleanPanel {...props} />,
  removeBody: (props) => <RemoveBodyPanel {...props} />,
  primitive: (props) => <PrimitivePanel {...props} />,
  'primitive.box': (props) => <PrimitivePanel {...props} />,
  'primitive.cylinder': (props) => <PrimitivePanel {...props} />,
  'primitive.sphere': (props) => <PrimitivePanel {...props} />,
  'primitive.cone': (props) => <PrimitivePanel {...props} />,
  'primitive.torus': (props) => <PrimitivePanel {...props} />,
  'construction.plane': (props) => <ConstructionPanel {...props} />,
  'construction.offsetPlane': (props) => <ConstructionPanel {...props} />,
  'construction.planeFromFace': (props) => <ConstructionPanel {...props} />,
  'construction.axis': (props) => <ConstructionPanel {...props} />,
  'construction.midplane': (props) => <ConstructionPanel {...props} />,
  'construction.axisThroughCylinder': (props) => <ConstructionPanel {...props} />,
  'construction.pointAtCenter': (props) => <ConstructionPanel {...props} />,
  'construction.point': (props) => <ConstructionPanel {...props} />,
  'construction.frame': (props) => <ConstructionPanel {...props} />,
  measure: (props) => <MeasurePanel {...props} />,
  measureValues: (props) => <MeasureValuesPanel {...props} />,
  derive: (props) => <DerivePanel {...props} />,
  'assembly.insert': (props) => <InsertPanel {...props} />,
  'assembly.joint': (props) => <JointPanel {...props} />,
  'assembly.drive': (props) => <DrivePanel {...props} />,
  'assembly.move': (props) => <MoveInstancePanel {...props} />,
  'assembly.relation': (props) => <RelationPanel {...props} />,
  'assembly.exploded': (props) => <ExplodedPanel {...props} />,
  'assembly.hole': (props) => <MultiHolePanel {...props} />,
  'assembly.component': (props) => <ComponentEditPanel {...props} />,
  'assembly.pattern': (props) => <AsmPatternPanel {...props} />,
  'assembly.mirror': (props) => <AsmMirrorPanel {...props} />,
  'assembly.replicate': (props) => <AsmReplicatePanel {...props} />,
};

export type WorkspaceProps = Omit<
  AppShellProps,
  'tools' | 'sketchTools' | 'panels' | 'renderSketch' | 'overlay' | 'assemblyTree'
>;

export function Workspace(props: WorkspaceProps) {
  const [sessions] = useState(createSessionStore);
  const tools = useModelingRibbon(props.services);
  const sketchTools = useSketchRibbon(sessions);
  const renderSketch = useCallback(
    (slot: SketchSlotProps) => (
      <SketchMode key={`${slot.mode.part}|${slot.mode.feature}`} {...slot} sessions={sessions} />
    ),
    [sessions],
  );
  // Automatic context updates follow every edit (12.4).
  useEffect(() => followContextUpdates(props.services), [props.services]);
  return (
    <AppShell
      {...props}
      tools={tools}
      sketchTools={sketchTools}
      panels={PANELS}
      renderSketch={renderSketch}
      overlay={<AssemblyOverlay services={props.services} />}
      assemblyTree={<AssemblyTree services={props.services} />}
    />
  );
}
