// The Atlas Codex hero (#26). It composes into a static edition on first
// render (the SSR poster) and enriches after mount; jsdom has no matchMedia
// or real layout, so these assertions cover the composed static state: the
// featured title/chapter furniture and the real, focusable cover-map nodes.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SystemMapWidget } from '@ramplab/spec';
import { AtlasCodex, coverLabelRect, visibleCoverLabels } from '../src/AtlasCodex.js';

// The whole-codebase map (#27): the union of every module's system map. The
// three journey nodes below are the flagship trace; `admin` and `config` are
// other modules' nodes, present on the cover as faint decorative etching only.
const MAP: SystemMapWidget = {
  id: 'codebase-map',
  type: 'system-map',
  title: 'The whole codebase, mapped',
  nodes: [
    {
      id: 'client',
      label: 'Client',
      description: 'Opens a connection and sends an HTTP request.',
      anchors: [{ file: 'server.go', symbol: 'Listen' }],
    },
    {
      id: 'serve-http',
      label: 'Server.ServeHTTP',
      description: 'The first Caddy code every request touches.',
      anchors: [{ file: 'server.go', symbol: 'ServeHTTP' }],
    },
    {
      id: 'file-server',
      label: 'file_server',
      description: 'Terminal handler: streams the file and ends the chain.',
      anchors: [{ file: 'staticfiles.go', symbol: 'SanitizedPathJoin' }],
    },
    // Nodes from other modules' maps — part of the union, not the journey.
    {
      id: 'admin-api',
      label: 'Admin API',
      description: 'The live-reload configuration endpoint.',
      anchors: [{ file: 'admin.go', symbol: 'Serve' }],
    },
    {
      id: 'config-loader',
      label: 'Config loader',
      description: 'Parses the Caddyfile into JSON.',
      anchors: [{ file: 'caddyfile.go', symbol: 'Adapt' }],
    },
  ],
  edges: [
    { from: 'client', to: 'serve-http' },
    { from: 'serve-http', to: 'file-server' },
    { from: 'admin-api', to: 'config-loader' },
  ],
};

const JOURNEY = ['client', 'serve-http', 'file-server'];

function renderHero() {
  render(
    <AtlasCodex
      title="Caddy Onboarding Lab"
      chapters={7}
      map={MAP}
      journey={JOURNEY}
      chapterLabel="Chapter I · End to end: a request served"
      setFrom="trace-http-request-served"
      href="/lab/caddy"
    />,
  );
}

describe('<AtlasCodex />', () => {
  it('features the edition title and its chapter count as book furniture', () => {
    renderHero();
    // Title appears on the cover, the spine and the caption.
    expect(screen.getAllByText('Caddy Onboarding Lab').length).toBeGreaterThan(0);
    // The chapter count drives the roman-numeral furniture and the scene label.
    expect(screen.getByRole('group', { name: /VII chapters/ })).toBeInTheDocument();
    // Seven spine bands, numbered I…VII.
    expect(screen.getByText('VII')).toBeInTheDocument();
  });

  it('renders each journey node as a real focusable button with a text equivalent', () => {
    renderHero();
    const client = screen.getByRole('button', { name: /Stop 1 of 3: Client/ });
    expect(client).toBeInTheDocument();
    expect(client).toHaveAttribute('tabindex', '0');
    expect(
      screen.getByRole('button', { name: /Stop 3 of 3: file_server/ }),
    ).toBeInTheDocument();
    // The journey is a 3-stop subset of the 5-node union map.
    expect(screen.queryByRole('button', { name: /Stop 4 of/ })).toBeNull();
  });

  it('etches the whole-codebase map: non-journey nodes are faint, not focusable', () => {
    renderHero();
    // Union nodes off the journey are decorative etching — no button role, and
    // the cover map's text equivalent names the full node count and the journey.
    expect(screen.queryByRole('button', { name: /Admin API/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Config loader/ })).toBeNull();
    expect(
      screen.getByRole('group', { name: /5 modules and connections.*3-stop journey/ }),
    ).toBeInTheDocument();
  });

  it('reveals a node’s role, chapter and anchor when clicked', async () => {
    const user = userEvent.setup();
    renderHero();
    await user.click(screen.getByRole('button', { name: /Stop 1 of 3: Client/ }));
    expect(screen.getByText('Opens a connection and sends an HTTP request.')).toBeVisible();
    expect(screen.getByText('Chapter I · End to end: a request served')).toBeVisible();
    expect(screen.getByText('server.go · Listen')).toBeVisible();
    expect(screen.getByText('Path stop · 1 of 3')).toBeVisible();
  });

  it('offers a link to open the featured edition', () => {
    renderHero();
    expect(screen.getByRole('link', { name: /Open this edition/ })).toHaveAttribute(
      'href',
      '/lab/caddy',
    );
  });
});

// The cover-label collision handling (#27): dense union maps (calcom,
// excalidraw) crowd several journey stops together; their etched labels must
// never overlap. `visibleCoverLabels` culls greedily in journey order.
describe('cover-label collision handling', () => {
  const ETCH_WIDTH = 240;

  function overlap(a: ReturnType<typeof coverLabelRect>, b: ReturnType<typeof coverLabelRect>) {
    return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  }

  it('keeps every label when the stops are spread out', () => {
    const inputs = [
      { id: 'a', cx: 30, cy: 20, text: 'Alpha' },
      { id: 'b', cx: 30, cy: 120, text: 'Beta' },
      { id: 'c', cx: 30, cy: 220, text: 'Gamma' },
    ];
    expect(visibleCoverLabels(inputs, ETCH_WIDTH)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('culls labels in a dense cluster and never returns two that overlap', () => {
    // Eight stops piled into a tiny region — real dense-cover conditions.
    const inputs = Array.from({ length: 8 }, (_, i) => ({
      id: `n${i}`,
      cx: 60 + (i % 2) * 8,
      cy: 40 + i * 3,
      text: `Handler number ${i}`,
    }));
    const shown = visibleCoverLabels(inputs, ETCH_WIDTH);
    // Some labels are dropped (they cannot all fit legibly).
    expect(shown.size).toBeLessThan(inputs.length);
    expect(shown.size).toBeGreaterThan(0);
    // No two SHOWN labels overlap.
    const shownRects = inputs
      .filter((input) => shown.has(input.id))
      .map((input) => coverLabelRect(input, ETCH_WIDTH));
    for (let i = 0; i < shownRects.length; i++) {
      for (let j = i + 1; j < shownRects.length; j++) {
        expect(overlap(shownRects[i]!, shownRects[j]!)).toBe(false);
      }
    }
  });

  it('gives journey-order (earlier) stops priority over later collisions', () => {
    const inputs = [
      { id: 'first', cx: 40, cy: 50, text: 'First stop label' },
      { id: 'second', cx: 40, cy: 52, text: 'Second stop label' }, // collides with first
    ];
    const shown = visibleCoverLabels(inputs, ETCH_WIDTH);
    expect(shown.has('first')).toBe(true);
    expect(shown.has('second')).toBe(false);
  });
});
