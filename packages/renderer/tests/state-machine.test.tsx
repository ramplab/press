// State-machine widget tests at the spec seam: spec JSON goes in through
// @ramplab/spec parsing, and assertions cover only user-visible behavior.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
import stateMachineLab from './fixtures/state-machine-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(stateMachineLab));
  return render(<Lab spec={spec} activeModuleId="doc-lifecycle" />);
}

function litPaths(container: HTMLElement) {
  return container.querySelectorAll('path[data-lit="true"]');
}

describe('state-machine widget', () => {
  it('renders the widget title and every state as a clickable node', () => {
    renderFixtureLab();
    expect(screen.getByText('DocumentStatus state machine')).toBeVisible();
    for (const label of ['pending', 'validating', 'accepted', 'rejected']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('starts with a placeholder and no highlighted transition paths', () => {
    const { container } = renderFixtureLab();
    expect(screen.getByText('Click a state above.')).toBeVisible();
    expect(litPaths(container)).toHaveLength(0);
  });

  it('selecting a state highlights exactly its outgoing transition paths', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'validating' }));

    expect(screen.getByRole('button', { name: 'validating' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // validating has two ways out: PASSED and FAILED.
    expect(litPaths(container)).toHaveLength(2);
    expect(screen.queryByText('Click a state above.')).not.toBeInTheDocument();
  });

  it('shows edge commentary with clickable anchor chips for the selected state', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'validating' }));

    expect(screen.getByText('A clean verdict marks the document complete.')).toBeVisible();
    const chip = screen.getByRole('link', { name: /lib\/validation\/verdict\.ts/ });
    expect(chip).toBeVisible();
    expect(chip).toHaveTextContent('applyVerdict');
    await user.click(chip); // clickable without blowing up, even with no handler wired
  });

  it('shows the state description and its anchors when the state carries one', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'pending' }));

    expect(
      screen.getByText('Just uploaded; waiting for the validator to pick it up.', {
        exact: false,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: /lib\/types\/application-data\.ts/ }),
    ).toBeVisible();
    // pending's only exit is the SSE-opens edge.
    expect(litPaths(container)).toHaveLength(1);
    expect(screen.getByText('The wizard opens the validation stream', { exact: false })).toBeVisible();
  });

  it('marks terminal states and clears highlights when selection moves', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(screen.getByRole('button', { name: 'validating' }));
    expect(litPaths(container)).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'accepted' }));
    expect(litPaths(container)).toHaveLength(0);
    expect(screen.getByText('Terminal state: no outgoing transitions.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'validating' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('supports keyboard selection of a state node', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    const node = screen.getByRole('button', { name: 'rejected' });
    (node as HTMLElement | SVGElement).focus();
    await user.keyboard('{Enter}');

    expect(node).toHaveAttribute('aria-pressed', 'true');
    expect(litPaths(container)).toHaveLength(1);
    expect(screen.getByText('re-upload', { selector: 'span' })).toBeVisible();
  });
});
