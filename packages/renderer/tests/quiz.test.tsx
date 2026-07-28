// Checkpoint-quiz tests at the spec seam: spec JSON goes in through
// @ramplab/spec parsing, and assertions cover only user-visible behavior.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab, progressStorageKey } from '../src/index.js';
import quizLab from './fixtures/quiz-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(quizLab));
  // Controlled chapter view: the checkpoint suite opens its module directly.
  return render(<Lab spec={spec} activeModuleId="parsing-module" />);
}

function question(id: string): HTMLElement {
  const node = document.querySelector(`[data-question-id="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`question "${id}" not rendered`);
  return node;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('checkpoint quiz widget', () => {
  it('renders the checkpoint frame with its questions and options', () => {
    renderFixtureLab();
    expect(screen.getByText('Checkpoint: parsing')).toBeVisible();
    expect(screen.getByText('0 / 2 passed')).toBeVisible();
    const first = question('unknown-version');
    expect(within(first).getByText(/schemaVersion 99/)).toBeVisible();
    expect(within(first).getAllByRole('button')).toHaveLength(4); // 3 options + check
    expect(within(first).getByRole('button', { name: 'Check answer' })).toBeDisabled();
  });

  it('keeps the explanation hidden until the answer is checked', () => {
    renderFixtureLab();
    expect(screen.queryByText(/version gate runs first/)).not.toBeInTheDocument();
  });

  it('selecting then checking the right answer shows correct feedback and the anchored explanation', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const first = question('unknown-version');

    const option = within(first).getByRole('button', {
      name: 'Rejects it before schema validation even runs',
    });
    await user.click(option);
    expect(option).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(first).getByRole('button', { name: 'Check answer' }));

    expect(first).toHaveAttribute('data-outcome', 'correct');
    expect(within(first).getByText('Correct.')).toBeVisible();
    expect(option).toHaveAttribute('data-state', 'correct');
    // Anchored explanation revealed.
    expect(within(first).getByText(/version gate runs first/)).toBeVisible();
    expect(
      within(first).getByRole('link', { name: /packages\/spec\/src\/parse\.ts · safeParseLabSpec/ }),
    ).toBeVisible();
    // Options lock after a correct answer.
    expect(option).toBeDisabled();
    expect(screen.getByText('1 / 2 passed')).toBeVisible();
  });

  it('checking a wrong answer shows incorrect feedback, reveals the correct option, and allows retry', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const first = question('unknown-version');

    const wrong = within(first).getByRole('button', { name: 'Coerces it down to version 1' });
    await user.click(wrong);
    await user.click(within(first).getByRole('button', { name: 'Check answer' }));

    expect(first).toHaveAttribute('data-outcome', 'incorrect');
    expect(within(first).getByText('Not quite.')).toBeVisible();
    expect(wrong).toHaveAttribute('data-state', 'wrong');
    expect(
      within(first).getByRole('button', { name: 'Rejects it before schema validation even runs' }),
    ).toHaveAttribute('data-state', 'correct');
    // The explanation still teaches the why.
    expect(within(first).getByText(/version gate runs first/)).toBeVisible();

    // Retry resets the question.
    await user.click(within(first).getByRole('button', { name: 'Try again' }));
    expect(first).not.toHaveAttribute('data-outcome');
    expect(within(first).queryByText(/version gate runs first/)).not.toBeInTheDocument();
    expect(
      within(first).getByRole('button', { name: 'Coerces it down to version 1' }),
    ).toBeEnabled();
  });

  it('shows the completion state once every question is answered correctly', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    expect(document.querySelector('[data-quiz-complete]')).toBeNull();

    const first = question('unknown-version');
    await user.click(
      within(first).getByRole('button', { name: 'Rejects it before schema validation even runs' }),
    );
    await user.click(within(first).getByRole('button', { name: 'Check answer' }));

    const second = question('unanchored-callout');
    await user.click(
      within(second).getByRole('button', {
        name: 'Schema validation fails — grounding is structural',
      }),
    );
    await user.click(within(second).getByRole('button', { name: 'Check answer' }));

    expect(screen.getByText(/Checkpoint passed: all 2 questions/)).toBeVisible();
    expect(screen.getByText('2 / 2 passed')).toBeVisible();
  });

  it('marks the chapter complete in the contents once its checkpoints pass', async () => {
    const user = userEvent.setup();
    // Uncontrolled: start at the contents, walk the real journey.
    const spec = parseLabSpec(structuredClone(quizLab));
    render(<Lab spec={spec} />);

    const nav = () => screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav()).getByRole('button', { name: /Spec Parsing/ })).not.toHaveAttribute(
      'data-completed',
    );

    await user.click(within(nav()).getByRole('button', { name: /Spec Parsing/ }));
    for (const [questionId, answer] of [
      ['unknown-version', 'Rejects it before schema validation even runs'],
      ['unanchored-callout', 'Schema validation fails — grounding is structural'],
    ] as const) {
      const box = question(questionId);
      await user.click(within(box).getByRole('button', { name: answer }));
      await user.click(within(box).getByRole('button', { name: 'Check answer' }));
    }
    expect(screen.getByText('2 / 2 passed')).toBeVisible();

    // Back at the contents, the chapter carries its completion proof mark.
    await user.click(screen.getByRole('button', { name: 'Contents' }));
    const moduleItem = within(nav()).getByRole('button', { name: /Spec Parsing/ });
    expect(moduleItem).toHaveAttribute('data-completed', 'true');
    expect(within(moduleItem).getByRole('img', { name: 'completed' })).toBeVisible();
    // A module without checkpoints is never marked complete.
    expect(within(nav()).getByRole('button', { name: /No Checkpoints Here/ })).not.toHaveAttribute(
      'data-completed',
    );
  });

  it('restores passed checkpoints, module completion, and locked questions after a remount', async () => {
    const user = userEvent.setup();
    const first = renderFixtureLab();

    for (const [questionId, answer] of [
      ['unknown-version', 'Rejects it before schema validation even runs'],
      ['unanchored-callout', 'Schema validation fails — grounding is structural'],
    ] as const) {
      const box = question(questionId);
      await user.click(within(box).getByRole('button', { name: answer }));
      await user.click(within(box).getByRole('button', { name: 'Check answer' }));
    }
    first.unmount();

    // Fresh mount = reload: progress comes back from localStorage.
    const second = renderFixtureLab();
    expect(screen.getByText('2 / 2 passed')).toBeVisible();
    expect(screen.getByText(/Checkpoint passed: all 2 questions/)).toBeVisible();
    const restored = question('unknown-version');
    expect(restored).toHaveAttribute('data-outcome', 'correct');
    expect(within(restored).getByText(/version gate runs first/)).toBeVisible();
    expect(
      within(restored).getByRole('button', {
        name: 'Rejects it before schema validation even runs',
      }),
    ).toBeDisabled();
    // The contents page shows the restored completion mark too.
    second.unmount();
    render(<Lab spec={parseLabSpec(structuredClone(quizLab))} />);
    const nav = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav).getByRole('button', { name: /Spec Parsing/ })).toHaveAttribute(
      'data-completed',
      'true',
    );
  });

  it('does not restore wrong answers as passed after a remount', async () => {
    const user = userEvent.setup();
    const first = renderFixtureLab();

    const box = question('unknown-version');
    await user.click(within(box).getByRole('button', { name: 'Coerces it down to version 1' }));
    await user.click(within(box).getByRole('button', { name: 'Check answer' }));
    first.unmount();

    renderFixtureLab();
    expect(screen.getByText('0 / 2 passed')).toBeVisible();
    const restored = question('unknown-version');
    expect(restored).not.toHaveAttribute('data-outcome');
    expect(
      within(restored).getByRole('button', { name: 'Coerces it down to version 1' }),
    ).toBeEnabled();
    // The wrong attempt is still persisted as the latest checkpoint result.
    const raw = window.localStorage.getItem(progressStorageKey('quiz-renderer-fixture'));
    expect(raw).toContain('"correct":false');
  });
});
