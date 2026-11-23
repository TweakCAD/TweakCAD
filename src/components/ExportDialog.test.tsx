import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExportDialog, type ExportDialogRequest } from './ExportDialog';

const none = () => undefined;

const request = (o: Partial<ExportDialogRequest> = {}): ExportDialogRequest => ({
  title: 'Export 3MF',
  kind: 'assembly',
  name: 'Arm',
  instances: 12,
  counts: { purchased: 4, reference: 1 },
  initial: { purchased: false, reference: true },
  ...o,
});

describe('the Export dialog', () => {
  it('names what is exported and offers each kind it places, ticked as asked', () => {
    const html = renderToStaticMarkup(<ExportDialog request={request()} onExport={none} onCancel={none} />);
    expect(html).toContain('Export 3MF');
    expect(html).toContain('Arm (assembly, 12 instances)');
    expect(html).toContain('Purchased parts (4)');
    expect(html).toContain('Reference parts (1)');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it('counts the parts of a design', () => {
    const html = renderToStaticMarkup(
      <ExportDialog request={request({ kind: 'design', name: 'Fan', instances: 3 })} onExport={none} onCancel={none} />,
    );
    expect(html).toContain('Fan (design, 3 parts)');
  });

  it('leaves out a kind the assembly does not place', () => {
    const html = renderToStaticMarkup(
      <ExportDialog request={request({ counts: { purchased: 3, reference: 0 } })} onExport={none} onCancel={none} />,
    );
    expect(html).toContain('Purchased parts (3)');
    expect(html).not.toContain('Reference parts');
  });

  it('shows nothing without a request', () => {
    const html = renderToStaticMarkup(<ExportDialog request={null} onExport={none} onCancel={none} />);
    expect(html).not.toContain('Include');
  });
});
