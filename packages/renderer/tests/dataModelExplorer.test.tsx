// Seam tests for the annotated data-model explorer: spec JSON goes through
// @ramplab/spec parsing, assertions cover only user-visible behavior.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { DataModelExplorer, Lab } from '../src/index.js';
import dataModelLab from './fixtures/data-model-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(dataModelLab));
  render(<Lab spec={spec} activeModuleId="the-data-model" />);
  return spec;
}

function notesPanel() {
  return screen.getByRole('complementary', { name: 'Field notes' });
}

describe('<DataModelExplorer />', () => {
  it('renders the widget frame with title and source file', () => {
    renderFixtureLab();
    const explorer = screen.getByRole('region', { name: 'ApplicationData explorer' });
    expect(explorer).toBeVisible();
    expect(within(explorer).getByText('lib/types/application-data.ts')).toBeVisible();
  });

  it('shows the whole field tree expanded by default, with example values', () => {
    renderFixtureLab();
    for (const key of ['fields', 'company_name', 'people', 'source', 'meta']) {
      expect(screen.getByRole('button', { name: key })).toBeVisible();
    }
    expect(screen.getByText('"Nimbus Retail Ltd"')).toBeVisible();
    expect(screen.getByText('8000000')).toBeVisible();
    expect(screen.getByText('true')).toBeVisible();
    // Nodes without an example fall back to their display type.
    expect(screen.getByText('ApplicationMeta')).toBeVisible();
  });

  it('prompts until a key is selected', () => {
    renderFixtureLab();
    expect(notesPanel()).toHaveTextContent('click a key to see what it means');
  });

  it('collapses and re-expands a node, hiding its children', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    const toggle = screen.getByRole('button', { name: 'Collapse fields' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(toggle);
    expect(screen.queryByRole('button', { name: 'company_name' })).not.toBeInTheDocument();
    // Sibling subtrees are unaffected.
    expect(screen.getByRole('button', { name: 'source' })).toBeVisible();

    const collapsed = screen.getByRole('button', { name: 'Expand fields' });
    expect(collapsed).toHaveAttribute('aria-expanded', 'false');
    await user.click(collapsed);
    expect(screen.getByRole('button', { name: 'company_name' })).toBeVisible();
  });

  it('shows the annotation for a clicked key: path, type, body, readers, anchors', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'source' }));

    const panel = notesPanel();
    expect(within(panel).getByRole('heading', { level: 4 })).toHaveTextContent(
      'people.source · PersonSource',
    );
    expect(
      within(panel).getByText('A soft delete that preserves the audit trail.'),
    ).toBeVisible();
    expect(within(panel).getByText('Read by: getActivePeople().')).toBeVisible();

    const chip = within(panel).getByRole('link', { name: /lib\/people\/active\.ts/ });
    expect(chip).toBeVisible();
    expect(chip).toHaveTextContent('getActivePeople');
    expect(chip).toHaveTextContent(':8–21');

    expect(screen.getByRole('button', { name: 'source' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('says so when a clicked key has no notes', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'meta' }));
    expect(notesPanel()).toHaveTextContent('No notes for this key yet.');
  });

  it('reports anchor chip clicks to the host', async () => {
    const user = userEvent.setup();
    const spec = parseLabSpec(structuredClone(dataModelLab));
    const widget = spec.base.modules[0]?.widgets[0];
    if (widget?.type !== 'data-model') throw new Error('expected a data-model widget');
    const onAnchorClick = vi.fn();
    render(<DataModelExplorer widget={widget} onAnchorClick={onAnchorClick} />);

    await user.click(screen.getByRole('button', { name: 'company_name' }));
    await user.click(screen.getByRole('button', { name: /lib\/enrichment\/registry\.ts/ }));

    expect(onAnchorClick).toHaveBeenCalledWith({
      file: 'lib/enrichment/registry.ts',
      symbol: 'applyRegistryFields',
    });
  });
});
