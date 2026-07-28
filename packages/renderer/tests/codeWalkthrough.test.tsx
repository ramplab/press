// Code-walkthrough and code-figure tests at the spec seam: spec JSON goes in
// through @ramplab/spec parsing, and assertions cover only user-visible
// behavior.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
import codeLab from './fixtures/code-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(codeLab));
  // Controlled chapter view: widget suites open the module directly.
  return render(<Lab spec={spec} activeModuleId="parsing-seam" />);
}

/** The base walkthrough section (the overlay one has its own title). */
function walkthrough() {
  return screen.getByLabelText('How a spec gets parsed');
}

/** The step currently in focus (full contrast, driving the code panel). */
function activeStep(root: HTMLElement): HTMLElement {
  const node = root.querySelector('[data-step-index][data-active="true"]');
  if (!(node instanceof HTMLElement)) throw new Error('no active step');
  return node;
}

/** Gutter numbers of the currently highlighted excerpt lines. */
function litLineNumbers(root: HTMLElement) {
  return [...root.querySelectorAll('[data-hl="true"]')].map(
    (line) => line.querySelector('span')?.textContent,
  );
}

describe('code-walkthrough widget', () => {
  it('renders the bar with the source path and starts on step 1', () => {
    renderFixtureLab();
    const widget = walkthrough();
    expect(within(widget).getByText('walkthrough')).toBeVisible();
    expect(within(widget).getByText('packages/spec/src/parse.ts')).toBeVisible();
    expect(within(widget).getByText('step 1 of 3')).toBeVisible();
    // All steps are on the page (pinned-panel pattern); step 1 is the active one.
    expect(
      within(widget).getByText('Non-objects are rejected before Zod ever runs.'),
    ).toBeVisible();
    expect(activeStep(widget)).toHaveTextContent('Non-objects are rejected');
  });

  it("highlights exactly the first step's line range, numbered from the source line", () => {
    renderFixtureLab();
    // The excerpt starts at source line 24, so step 1 (excerpt lines 1-2)
    // shows gutter numbers 24 and 25.
    expect(litLineNumbers(walkthrough())).toEqual(['24', '25']);
  });

  it('disables prev on the first step', () => {
    renderFixtureLab();
    expect(within(walkthrough()).getByRole('button', { name: '← prev' })).toBeDisabled();
  });

  it('next moves the highlight and swaps the commentary; prev comes back', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    await user.click(within(widget).getByRole('button', { name: 'next →' }));

    expect(within(widget).getByText('step 2 of 3')).toBeVisible();
    expect(litLineNumbers(widget)).toEqual(['26', '27']);
    // Every step stays on the page; the active one moved to step 2.
    expect(activeStep(widget)).toHaveTextContent(
      'The version gate comes first, so old parsers fail loudly.',
    );

    await user.click(within(widget).getByRole('button', { name: '← prev' }));
    expect(within(widget).getByText('step 1 of 3')).toBeVisible();
    expect(litLineNumbers(widget)).toEqual(['24', '25']);
  });

  it('offers restart on the last step and wraps back to step 1', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    await user.click(within(widget).getByRole('button', { name: 'next →' }));
    await user.click(within(widget).getByRole('button', { name: 'next →' }));
    expect(within(widget).getByText('step 3 of 3')).toBeVisible();
    expect(litLineNumbers(widget)).toEqual(['28', '29']);

    const restart = within(widget).getByRole('button', { name: 'restart ↺' });
    await user.click(restart);
    expect(within(widget).getByText('step 1 of 3')).toBeVisible();
    expect(litLineNumbers(widget)).toEqual(['24', '25']);
  });

  it('jumps directly to a step via its dot', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    await user.click(within(widget).getByRole('button', { name: 'Go to step 3' }));

    expect(within(widget).getByText('step 3 of 3')).toBeVisible();
    expect(within(widget).getByText('Only then does the schema get its say.')).toBeVisible();
    expect(within(widget).getByRole('button', { name: 'Go to step 3' })).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('activates a step when its prose is clicked', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    await user.click(within(widget).getByText('Only then does the schema get its say.'));

    expect(within(widget).getByText('step 3 of 3')).toBeVisible();
  });

  it('leaves the step alone when the click merely ended a text selection', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    // Selecting a sentence to copy it out fires a click on the step. That is
    // reading, not navigation: yanking the code panel mid-sentence loses the
    // reader's place.
    const selection = { isCollapsed: false } as Selection;
    const getSelection = vi.spyOn(globalThis, 'getSelection').mockReturnValue(selection);
    try {
      await user.click(within(widget).getByText('Only then does the schema get its say.'));
      expect(within(widget).getByText('step 1 of 3')).toBeVisible();
    } finally {
      getSelection.mockRestore();
    }
  });

  it('an arrow key does not re-arm scroll-sync against the reader', async () => {
    // Scroll-sync arms on keys that move the page, so that reading a chapter
    // with Space or PageDown keeps the panel following. ←/→ are this widget's
    // own stepper: arming on them let the scroll that followed a jump
    // recompute the nearest step and undo the step just chosen.
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    widget.focus();
    await user.keyboard('{ArrowRight}');
    window.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    expect(within(widget).getByText('step 2 of 3')).toBeVisible();
  });

  it('steps with arrow keys once the panel has focus', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    widget.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(within(widget).getByText('step 3 of 3')).toBeVisible();

    // Clamped at the ends rather than wrapping.
    await user.keyboard('{ArrowRight}');
    expect(within(widget).getByText('step 3 of 3')).toBeVisible();

    await user.keyboard('{ArrowLeft}');
    expect(within(widget).getByText('step 2 of 3')).toBeVisible();
  });

  it('shows clickable anchor chips for the current step commentary', async () => {
    const user = userEvent.setup();
    renderFixtureLab();
    const widget = walkthrough();

    const chip = within(widget).getByRole('link', {
      name: /packages\/spec\/src\/parse\.ts · safeParseLabSpec/,
    });
    expect(chip).toBeVisible();
    // Provenance (fixture repo) makes the chip a real source permalink.
    expect(chip.getAttribute('href')).toContain('/blob/HEAD/packages/spec/src/parse.ts');
  });

  it('renders the unanchored overlay walkthrough with the team-note badge', () => {
    renderFixtureLab();
    const overlay = screen.getByLabelText('What actually bites people');
    expect(overlay).toHaveAttribute('data-origin', 'overlay');
    expect(within(overlay).getByText('team note')).toBeVisible();
    expect(
      within(overlay).getByText(/most bad specs are just missing schemaVersion/),
    ).toBeVisible();
  });
});

describe('code-figure widget', () => {
  function figure(container: HTMLElement) {
    const figures = container.querySelectorAll('[data-widget="code-figure"]');
    return figures[0] as HTMLElement;
  }

  it('renders the excerpt with its source path and highlighted lines', () => {
    const { container } = renderFixtureLab();
    const widget = figure(container);
    expect(within(widget).getByText('packages/spec/src/schema.ts')).toBeVisible();
    expect(within(widget).getByText(/lines 30–33/)).toBeVisible();
    // highlight 2-3 lights exactly two lines of the four-line excerpt.
    expect(widget.querySelectorAll('[data-hl="true"]')).toHaveLength(2);
    expect(within(widget).getByText('anchorSchema')).toBeVisible();
  });

  it('renders the caption with clickable anchor chips', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const widget = figure(container);

    expect(
      within(widget).getByText('File is the only required coordinate; symbol sharpens it.'),
    ).toBeVisible();
    const chip = within(widget).getByRole('link', {
      name: /packages\/spec\/src\/schema\.ts · anchorSchema/,
    });
    expect(chip).toBeVisible();
    expect(chip.getAttribute('href')).toContain('/blob/HEAD/packages/spec/src/schema.ts');
  });

  it('acknowledges the copy button even without a clipboard (jsdom)', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const widget = figure(container);

    await user.click(within(widget).getByRole('button', { name: 'copy' }));
    expect(within(widget).getByRole('button', { name: 'copied ✓' })).toBeVisible();
  });

  it('renders the unanchored overlay figure with the team-note badge', () => {
    const { container } = renderFixtureLab();
    const figures = container.querySelectorAll('[data-widget="code-figure"]');
    expect(figures).toHaveLength(2);
    const overlay = figures[1] as HTMLElement;
    expect(overlay).toHaveAttribute('data-origin', 'overlay');
    expect(within(overlay).getByText('team note')).toBeVisible();
    expect(within(overlay).getByText(/over-anchor, staleness detection is free/)).toBeVisible();
  });
});
