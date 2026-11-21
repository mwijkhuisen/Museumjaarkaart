import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as icons from '../src/components/ui/icons.tsx';

describe('icons', () => {
  const all = Object.entries(icons);
  it('exports the nine icons', () => expect(all).toHaveLength(9));
  it.each(all)('%s is decorative and style-free', (_name, Icon) => {
    const html = renderToStaticMarkup(<Icon className="x" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('class="icon x"');
    expect(html).not.toContain('style=');
    expect(html).not.toMatch(/<title|aria-label|alt=/);
  });
});
