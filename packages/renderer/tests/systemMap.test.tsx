// System-map tests live at the spec seam: spec JSON goes in through
// @ramplab/spec parsing and only user-visible behavior is asserted.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
import systemMapLab from './fixtures/system-map-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(systemMapLab));
  render(<Lab spec={spec} activeModuleId="architecture" />);
  return spec;
}

describe('<SystemMap /> through the spec seam', () => {
  it('renders every node from the spec as a clickable diagram node', () => {
    renderFixtureLab();
    for (const label of ['Lab spec', 'Renderer', 'Playground']) {
      expect(screen.getByRole('button', { name: label })).toBeVisible();
    }
  });

  it('shows the widget title; edge labels live in the annotation card', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    expect(screen.getByText('RampLab, end to end')).toBeVisible();
    // Edge labels never float free on the plate (research.md §2.3): they
    // appear with the connection list once a node is annotated.
    expect(screen.queryByText(/parsed spec JSON/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lab spec' }));
    expect(screen.getByText(/parsed spec JSON/)).toBeVisible();
  });

  it('starts with no node selected and a prompt instead of an annotation', () => {
    renderFixtureLab();
    expect(screen.getByText(/click a node to see/i)).toBeVisible();
    expect(
      screen.queryByText('Versioned Zod schemas', { exact: false }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lab spec' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking a node highlights it and reveals its annotation with anchor chips', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    const specNode = screen.getByRole('button', { name: 'Lab spec' });
    await user.click(specNode);

    expect(specNode).toHaveAttribute('aria-pressed', 'true');
    expect(specNode).toHaveAttribute('data-selected', 'true');
    expect(
      screen.getByText('Versioned Zod schemas; the contract everything meets.'),
    ).toBeVisible();

    // Anchor chips are provenance linking to the source.
    const chip = screen.getByRole('link', {
      name: /packages\/spec\/src\/schema\.ts · labSpecSchema/,
    });
    expect(chip).toBeVisible();
    expect(
      screen.getByRole('link', { name: /parse\.ts · parseLabSpec.*:60–66/ }),
    ).toBeVisible();
  });

  it('lists the selected node’s connections, including edge commentary anchors', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'Lab spec' }));

    const connection = screen.getByText('Renderer', { selector: 'li, li *', exact: false });
    const item = connection.closest('li');
    expect(item).not.toBeNull();
    expect(item).toHaveTextContent('Renderer: parsed spec JSON');
    expect(
      within(item as HTMLElement).getByRole('link', { name: /safeParseLabSpec/ }),
    ).toBeVisible();
  });

  it('selecting another node swaps the annotation and the highlight', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    const specNode = screen.getByRole('button', { name: 'Lab spec' });
    const rendererNode = screen.getByRole('button', { name: 'Renderer' });

    await user.click(specNode);
    await user.click(rendererNode);

    expect(rendererNode).toHaveAttribute('aria-pressed', 'true');
    expect(specNode).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Fixed, hand-built React widget library.')).toBeVisible();
    expect(
      screen.queryByText('Versioned Zod schemas', { exact: false }),
    ).not.toBeInTheDocument();
  });

  it('annotates bare structural nodes with just their connections', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'Playground' }));

    // No description and no anchors in the spec — but the annotation still
    // names the node and its incoming connection.
    expect(screen.queryByText(/click a node to see/i)).not.toBeInTheDocument();
    const item = screen.getByText('Renderer', { selector: 'li, li *', exact: false }).closest('li');
    expect(item).toHaveTextContent('Renderer');
  });
});
