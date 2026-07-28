// THE golden fixture test. packages/spec/tests/fixtures/golden.json is the
// reference lab hand-written as spec #1 (PLAN.md §9, issue #10): the canonical
// example spec and the regression net for all future renderer changes. This
// suite loads that exact file (no copy), pushes it through the real
// parse → resolve → render path, and asserts every widget type appears with
// its core teaching content — tests at the spec seam, user-visible behavior
// only.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseLabSpec, resolveModules, type LabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
// The playground's bundled fixture IS the golden asset — imported directly so
// this suite and ?spec=golden can never drift apart.
import goldenJson from '../../spec/tests/fixtures/golden.json';

/** All 8 widget types of PLAN.md §3 — figures + walkthroughs count as two. */
const ALL_WIDGET_TYPES = [
  'callout',
  'code-figure',
  'code-walkthrough',
  'data-model',
  'decision-table',
  'pipeline',
  'quiz',
  'state-machine',
  'system-map',
];

function loadGolden(): LabSpec {
  return parseLabSpec(structuredClone(goldenJson));
}

/** Open a chapter from the contents (via the running head when in a chapter). */
async function openModule(user: ReturnType<typeof userEvent.setup>, title: RegExp) {
  if (screen.queryByRole('navigation', { name: 'Modules' }) === null) {
    await user.click(screen.getByRole('button', { name: 'Contents' }));
  }
  const nav = screen.getByRole('navigation', { name: 'Modules' });
  await user.click(within(nav).getByRole('button', { name: title }));
}

/** data-widget is the uniform per-widget seam shared with the e2e suite. */
function widgetTypesOnScreen(): Set<string> {
  const seen = new Set<string>();
  for (const el of document.querySelectorAll('[data-widget]')) {
    seen.add(el.getAttribute('data-widget') as string);
  }
  return seen;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('golden fixture (the hand-written reference lab)', () => {
  it('parses as a valid v1 lab spec and exercises every widget type', () => {
    const spec = loadGolden();
    expect(spec.id).toBe('reference-lab');

    const modules = resolveModules(spec);
    expect(modules).toHaveLength(9);

    const types = new Set(
      modules.flatMap((module) => module.widgets.map((resolved) => resolved.widget.type)),
    );
    expect([...types].sort()).toEqual(ALL_WIDGET_TYPES);

    // The reference lab's 11 checkpoints survive translation.
    const questionCount = modules
      .flatMap((module) => module.widgets)
      .filter((resolved) => resolved.widget.type === 'quiz')
      .reduce(
        (count, resolved) =>
          count + (resolved.widget.type === 'quiz' ? resolved.widget.questions.length : 0),
        0,
      );
    expect(questionCount).toBe(11);

    // One human-overlay note ("where to go next"), unanchored by design.
    expect(spec.overlay).toHaveLength(1);
  });

  // The heaviest render in the suite (the whole reference lab); slow CI
  // runners have crossed the 5s default (#96's PR run). Generous ceiling.
  it('renders the full lab: every module, every widget type, core content', { timeout: 20_000 }, async () => {
    const user = userEvent.setup();
    render(<Lab spec={loadGolden()} />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'The Reference Lab · Interactive Codebase Onboarding',
      }),
    ).toBeVisible();

    const nav = screen.getByRole('navigation', { name: 'Modules' });
    expect(within(nav).getAllByRole('button')).toHaveLength(9);
    // The running head carries the capability unlock count (6 of the reference
    // lab's chapters close with a capability callout), named so it cannot be
    // read as chapters completed.
    expect(screen.getByTestId('capability-count')).toHaveTextContent('0/6 capabilities');

    const seen = widgetTypesOnScreen();

    // Module 1 — the clickable system map with the real subsystem nodes.
    await openModule(user, /The System, On One Screen/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByRole('button', { name: 'application-service' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rule engine (mirror)' })).toBeVisible();

    // Module 2 — data model explorer, document state machine, provenance figure.
    await openModule(user, /The Data Model/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByText('ApplicationData explorer')).toBeVisible();
    expect(screen.getByText(/Why one JSONB blob\?/)).toBeVisible();
    expect(screen.getByText('DocumentStatus state machine')).toBeVisible();
    expect(screen.getAllByText(/FieldValueMeta/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Gotcha you will hit in week one/)).toBeVisible();

    // Module 3 — visibility decision table plus the deriveStages walkthrough.
    await openModule(user, /Config → Wizard/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(
      screen.getByText('Stage derivation playground — does the field render?'),
    ).toBeVisible();
    expect(screen.getByText('step 1 of 7')).toBeVisible();
    expect(screen.getAllByText(/lib\/stages\/derive-stages\.ts/).length).toBeGreaterThan(0);

    // Module 4 — the six-case personal-guarantee rule playground.
    await openModule(user, /The Rule Engine/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByText('Rule playground — "needs personal guarantee"')).toBeVisible();
    // Defaults match no case: the computed value's default outcome wins.
    expect(screen.getAllByText(/needs_personal_guarantee = false/).length).toBeGreaterThan(0);

    // Module 5 — three-phase ownership pipeline and the frontier-loop code.
    await openModule(user, /Ownership/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(
      screen.getByText('Three-phase engine trace — explore, cumulate, render'),
    ).toBeVisible();
    expect(screen.getByText(/The bug class this design kills/)).toBeVisible();

    // Module 6 — application status lifecycle.
    await openModule(user, /Lifecycle/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByRole('button', { name: 'in_progress' })).toBeVisible();
    expect(
      screen.getAllByText(/lock → guard → merge → recompute → commit → notify/).length,
    ).toBeGreaterThan(0);

    // Module 7 — the autosave keystroke journey.
    await openModule(user, /Autosave/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(
      screen.getByText('The autosave loop — the full journey of a keystroke'),
    ).toBeVisible();

    // Module 8 — the validation pipeline and its verbatim verdict function.
    await openModule(user, /Document Validation/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByText('Validation pipeline — OCR to verdict')).toBeVisible();
    expect(screen.getAllByText(/determineValidationStatus/).length).toBeGreaterThan(0);

    // Module 9 — auth lanes plus the unanchored human-overlay note.
    await openModule(user, /Auth & Plumbing/);
    for (const el of widgetTypesOnScreen()) seen.add(el);
    expect(screen.getByRole('button', { name: 'Analyst · login' })).toBeVisible();
    const overlayNote = screen
      .getByText(/where to go next/)
      .closest('[data-origin="overlay"]');
    expect(overlayNote).not.toBeNull();
    expect(within(overlayNote as HTMLElement).getByText('team note')).toBeVisible();

    // Across the full lab, all 8 widget types (9 spec types) rendered.
    expect([...seen].sort()).toEqual(ALL_WIDGET_TYPES);
  });

  it('steps a walkthrough and passes a checkpoint, updating lab progress', async () => {
    const user = userEvent.setup();
    render(<Lab spec={loadGolden()} />);

    // Step the deriveStages walkthrough.
    await openModule(user, /Config → Wizard/);
    const walkthrough = screen.getByRole('region', {
      name: 'How that works — the real derivation, stepped through',
    });
    expect(within(walkthrough).getByText('step 1 of 7')).toBeVisible();
    await user.click(within(walkthrough).getByRole('button', { name: 'next →' }));
    expect(within(walkthrough).getByText('step 2 of 7')).toBeVisible();
    expect(
      within(walkthrough).getByText(/that call is the rule engine/),
    ).toBeVisible();

    // Pass one checkpoint question; the quiz tally moves inside the widget.
    await openModule(user, /The Data Model/);
    const quiz = document.querySelector('[data-widget="quiz"]') as HTMLElement;
    const question = within(quiz).getByRole('group', { name: 'Question 2' });
    await user.click(
      within(question).getByRole('button', { name: 'accepted, forced, and skipped' }),
    );
    await user.click(within(question).getByRole('button', { name: 'Check answer' }));
    expect(question).toHaveAttribute('data-outcome', 'correct');
    expect(within(question).getByText(/accept-anyway or re-upload/)).toBeVisible();
    expect(within(quiz).getByText('1 / 2 passed')).toBeVisible();
  });
});
