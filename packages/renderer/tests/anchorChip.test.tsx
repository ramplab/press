// Anchor chips only afford what they can deliver (founder feedback from the
// hosted reader: chips rendered as buttons with nowhere to go). With known
// repo provenance they are real source permalinks; with a host handler they
// are buttons; with neither they are inert labels.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseLabSpec, type Anchor } from '@ramplab/spec';
import {
  AnchorChip,
  AnchorSourceContext,
  anchorHrefBuilder,
  Lab,
  widgetDomId,
} from '../src/index.js';
import twoModuleLab from './fixtures/two-module-lab.json';

const anchor: Anchor = {
  file: 'modules/caddyhttp/app.go',
  symbol: 'Handler',
  lines: { start: 10, end: 20 },
};

describe('anchorHrefBuilder', () => {
  it('builds blob permalinks from every provenance form we store', () => {
    for (const repo of [
      'github.com/caddyserver/caddy',
      'https://github.com/caddyserver/caddy.git',
      'git@github.com:caddyserver/caddy.git',
      'caddyserver/caddy',
    ]) {
      expect(anchorHrefBuilder(repo)?.(anchor)).toBe(
        'https://github.com/caddyserver/caddy/blob/HEAD/modules/caddyhttp/app.go#L10-L20',
      );
    }
  });

  it('omits the line fragment when the anchor has no lines', () => {
    expect(anchorHrefBuilder('a/b')?.({ file: 'src/x.ts' })).toBe(
      'https://github.com/a/b/blob/HEAD/src/x.ts',
    );
  });

  it('declines provenance it cannot place (no false links)', () => {
    expect(anchorHrefBuilder(undefined)).toBeUndefined();
    expect(anchorHrefBuilder('https://gitlab.com/x/y')).toBeUndefined();
    expect(anchorHrefBuilder('gitlab.com/x/y')).toBeUndefined();
    expect(anchorHrefBuilder('not a repo')).toBeUndefined();
  });
});

describe('AnchorChip', () => {
  it('is a source link when the surface knows the repo', () => {
    render(
      <AnchorSourceContext.Provider value={anchorHrefBuilder('caddyserver/caddy')}>
        <AnchorChip anchor={anchor} className="chip" />
      </AnchorSourceContext.Provider>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toContain('/blob/HEAD/modules/caddyhttp/app.go');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('is a button when only a host handler is wired', async () => {
    const user = userEvent.setup();
    const onAnchorClick = vi.fn();
    render(<AnchorChip anchor={anchor} className="chip" onAnchorClick={onAnchorClick} />);
    await user.click(screen.getByRole('button'));
    expect(onAnchorClick).toHaveBeenCalledWith(anchor);
  });

  it('is an inert label with nowhere to go', () => {
    render(<AnchorChip anchor={anchor} className="chip" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/app\.go/)).toBeDefined();
  });

  it('the link takes precedence over a handler (a destination beats a callback)', () => {
    render(
      <AnchorSourceContext.Provider value={anchorHrefBuilder('caddyserver/caddy')}>
        <AnchorChip anchor={anchor} className="chip" onAnchorClick={vi.fn()} />
      </AnchorSourceContext.Provider>,
    );
    expect(screen.getByRole('link')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Lab provenance', () => {
  it('chapter anchor chips link to the source (spec.repo) and widget wrappers carry DOM ids', async () => {
    const user = userEvent.setup();
    const spec = parseLabSpec(structuredClone(twoModuleLab));
    render(<Lab spec={spec} />);
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    await user.click(within(nav).getByRole('button', { name: /First Module/ }));

    // Fixture repo is `ramplab/ramplab`; the callout anchors become links.
    const link = screen
      .getAllByRole('link')
      .find((el) => el.getAttribute('href')?.includes('/blob/HEAD/'));
    expect(link?.getAttribute('href')).toContain(
      'https://github.com/ramplab/ramplab/blob/HEAD/packages/spec/src/',
    );

    // The wrapper id is what the hosted reader scrolls to from a "See:" chip.
    expect(document.getElementById(widgetDomId('first-module', 'why-anchor'))).not.toBeNull();
  });

  it('a spec without provenance renders no source links', async () => {
    const user = userEvent.setup();
    const bare = structuredClone(twoModuleLab) as { repo?: string };
    delete bare.repo;
    const spec = parseLabSpec(bare);
    render(<Lab spec={spec} />);
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    await user.click(within(nav).getByRole('button', { name: /First Module/ }));
    expect(
      screen.queryAllByRole('link').filter((el) => el.getAttribute('href')?.includes('/blob/')),
    ).toHaveLength(0);
  });
});
