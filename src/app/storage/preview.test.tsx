import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolRibbon, type RibbonToolGroup } from '../../components/MainToolbar.tsx';
import { createAppStore } from '../appState';
import { closedForPreview, readOnlyTools } from './preview';

const tool = (id: string) => ({ id, label: id, icon: null, onClick: () => undefined });
const GROUPS: RibbonToolGroup[] = [
  { label: 'CREATE', tools: [tool('sketch'), tool('extrude')] },
  { label: 'INSPECT', tools: [tool('section'), tool('measure')] },
];

describe('the app while a revision is previewed', () => {
  it('disables every ribbon tool but Section and Measure', () => {
    const html = renderToStaticMarkup(<ToolRibbon groups={readOnlyTools(GROUPS)} />);
    const buttons = [...html.matchAll(/<button[^>]*title="([^"]+)"[^>]*>/g)].map((m) => ({
      title: m[1],
      disabled: / disabled=""/.test(m[0]),
    }));
    expect(buttons).toEqual([
      { title: 'sketch', disabled: true },
      { title: 'extrude', disabled: true },
      { title: 'section', disabled: false },
      { title: 'measure', disabled: false },
    ]);
  });

  it('closes sketch mode, editing panels, parameters and components, and keeps Measure', () => {
    const app = createAppStore();
    expect(closedForPreview(app.getState())).toBeNull();
    app.setState({
      mode: { kind: 'sketch', part: 'p', feature: 'f' },
      panel: { kind: 'extrude' },
      parametersOpen: true,
      componentsOpen: true,
    });
    expect(closedForPreview(app.getState())).toEqual({
      mode: { kind: 'model' },
      panel: null,
      parametersOpen: false,
      componentsOpen: false,
    });
    app.setState({ mode: { kind: 'model' }, panel: { kind: 'measure' }, parametersOpen: false, componentsOpen: false });
    expect(closedForPreview(app.getState())).toBeNull();
  });
});
