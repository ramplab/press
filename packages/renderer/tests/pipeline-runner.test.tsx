// Pipeline-runner widget tests at the spec seam: spec JSON goes in through
// @ramplab/spec parsing, and assertions cover only user-visible behavior.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
import pipelineLab from './fixtures/pipeline-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(pipelineLab));
  return render(<Lab spec={spec} activeModuleId="doc-validation" />);
}

function stageStates(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll('[data-widget="pipeline"] [data-state]'),
    (el) => el.getAttribute('data-state') ?? '',
  );
}

const playButton = () => screen.getByRole('button', { name: '▶ play' });
const stepButton = () => screen.getByRole('button', { name: 'step →' });
const resetButton = () => screen.getByRole('button', { name: '↺ reset' });

/** The reference lab's per-stage cadence, mirrored by the component. */
const STEP_MS = 640;

afterEach(() => {
  vi.useRealTimers();
});

describe('pipeline-runner widget', () => {
  it('renders the title, every stage, and the idle placeholder', () => {
    const { container } = renderFixtureLab();
    expect(screen.getByText('Document validation pipeline')).toBeVisible();
    for (const label of ['OCR / Textract', 'Classify', 'Adequacy', 'Verdict']) {
      expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument();
    }
    expect(
      screen.getByText('Press play, or step through the pipeline stage by stage.'),
    ).toBeVisible();
    expect(stageStates(container)).toEqual(['idle', 'idle', 'idle', 'idle']);
    expect(resetButton()).toBeDisabled();
  });

  it('stepping activates stages in order, showing each description and its anchors', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(stepButton());
    expect(stageStates(container)).toEqual(['active', 'idle', 'idle', 'idle']);
    expect(
      screen.getByText('Extract raw text and key-value pairs from the upload.', { exact: false }),
    ).toBeVisible();
    const chip = screen.getByRole('link', { name: /ai\/document-validation\/ocr\.ts/ });
    expect(chip).toHaveTextContent('extractText');
    await user.click(chip); // clickable without blowing up, even with no handler wired

    await user.click(stepButton());
    expect(stageStates(container)).toEqual(['done', 'active', 'idle', 'idle']);
    expect(
      screen.getByText('Decide what kind of document this is.', { exact: false }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: /ai\/document-validation\/classify\.ts/ }),
    ).toHaveTextContent(':10–42');
  });

  it('shows what flows in and out of the active stage as data progresses', async () => {
    const user = userEvent.setup();
    renderFixtureLab();

    await user.click(stepButton());
    expect(screen.getByText('uploaded document')).toBeVisible();
    expect(screen.getByText('1,240 chars · 14 KV pairs')).toBeVisible();

    // The done stage keeps its flow caption inside the stage box.
    await user.click(stepButton());
    const ocrStage = screen.getByRole('button', { name: /OCR \/ Textract/ });
    expect(ocrStage).toHaveTextContent('uploaded document → 1,240 chars · 14 KV pairs');
  });

  it('stepping past the last stage completes the run and disables step', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    for (let i = 0; i < 5; i += 1) await user.click(stepButton());

    expect(stageStates(container)).toEqual(['done', 'done', 'done', 'done']);
    expect(screen.getByText('Pipeline complete: all 4 stages run.')).toBeVisible();
    expect(stepButton()).toBeDisabled();
  });

  it('clicking a stage jumps the playhead straight to it', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(screen.getByRole('button', { name: /Adequacy/ }));

    expect(stageStates(container)).toEqual(['done', 'done', 'active', 'idle']);
    // A stage without a description still names itself in the info panel.
    expect(screen.getByText('Adequacy', { selector: 'b' })).toBeVisible();
  });

  it('reset returns the pipeline to idle', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    await user.click(stepButton());
    await user.click(stepButton());
    await user.click(resetButton());

    expect(stageStates(container)).toEqual(['idle', 'idle', 'idle', 'idle']);
    expect(
      screen.getByText('Press play, or step through the pipeline stage by stage.'),
    ).toBeVisible();
  });

  // The play tests drive time with fake timers, so clicks use the synchronous
  // fireEvent (userEvent's event loop does not mix with vitest's fake clock).
  it('play animates stage by stage to completion, then can replay', () => {
    vi.useFakeTimers();
    const { container } = renderFixtureLab();

    fireEvent.click(playButton());
    // The first stage lights up immediately; each tick advances the flow.
    expect(stageStates(container)).toEqual(['active', 'idle', 'idle', 'idle']);
    expect(screen.getByRole('button', { name: '❚❚ pause' })).toBeVisible();

    act(() => void vi.advanceTimersByTime(STEP_MS));
    expect(stageStates(container)).toEqual(['done', 'active', 'idle', 'idle']);

    // Each tick schedules the next from a React effect, so advance tick by tick.
    for (let i = 0; i < 3; i += 1) act(() => void vi.advanceTimersByTime(STEP_MS));
    expect(stageStates(container)).toEqual(['done', 'done', 'done', 'done']);
    expect(screen.getByText('Pipeline complete: all 4 stages run.')).toBeVisible();
    expect(playButton()).toBeVisible(); // playback stopped

    // Play again restarts from the top.
    fireEvent.click(playButton());
    expect(stageStates(container)).toEqual(['active', 'idle', 'idle', 'idle']);
  });

  it('pause freezes the playhead where it is', () => {
    vi.useFakeTimers();
    const { container } = renderFixtureLab();

    fireEvent.click(playButton());
    act(() => void vi.advanceTimersByTime(STEP_MS));
    fireEvent.click(screen.getByRole('button', { name: '❚❚ pause' }));

    act(() => void vi.advanceTimersByTime(5 * STEP_MS));
    expect(stageStates(container)).toEqual(['done', 'active', 'idle', 'idle']);
  });

  it('supports keyboard-driven stepping', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();

    stepButton().focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(stageStates(container)).toEqual(['done', 'active', 'idle', 'idle']);
  });
});
