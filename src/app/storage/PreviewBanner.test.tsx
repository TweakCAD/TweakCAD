import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreviewBanner } from './PreviewBanner';

describe('the preview banner', () => {
  it('names the revision as read-only, with Restore and Close', () => {
    const html = renderToStaticMarkup(
      <PreviewBanner label="Created (Fri 6 Nov 10:00)" onRestore={() => Promise.resolve()} onClose={() => undefined} />,
    );
    expect(html).toContain('Preview of <b>Created (Fri 6 Nov 10:00)</b> — read-only');
    expect(html).toMatch(/<button[^>]*>Restore<\/button>/);
    expect(html).toMatch(/<button[^>]*>Close<\/button>/);
    expect(html).toContain('role="status"');
  });

  it('offers no Restore where the revision cannot be restored', () => {
    const html = renderToStaticMarkup(<PreviewBanner label="r" onClose={() => undefined} />);
    expect(html).not.toContain('Restore');
    expect(html).toContain('Close');
  });
});
