// Decision-table widget tests at the spec seam: spec JSON goes in through
// @ramplab/spec parsing, and assertions cover only user-visible behavior.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import { Lab } from '../src/index.js';
import decisionTableLab from './fixtures/decision-table-lab.json';

function renderFixtureLab() {
  const spec = parseLabSpec(structuredClone(decisionTableLab));
  return render(<Lab spec={spec} activeModuleId="parse-gate" />);
}

/** The machine-base playground (the overlay table renders alongside it). */
function baseWidget(container: HTMLElement): HTMLElement {
  const widget = container.querySelector('[data-widget="decision-table"][data-origin="base"]');
  if (!(widget instanceof HTMLElement)) throw new Error('base decision table not rendered');
  return widget;
}

function hitRows(scope: HTMLElement) {
  return scope.querySelectorAll('[data-rule-status="hit"]');
}

/** The verdict flag showing the winning outcome and its explanation. */
function verdict(scope: HTMLElement): HTMLElement {
  const flag = scope.querySelector('[data-matched]');
  if (!(flag instanceof HTMLElement)) throw new Error('verdict flag not rendered');
  return flag;
}

function statusOf(scope: HTMLElement, rule: string): string | null {
  return scope.querySelector(`[data-rule="${rule}"]`)?.getAttribute('data-rule-status') ?? null;
}

describe('decision-table widget', () => {
  it('renders the title, every declared input, and every rule row', () => {
    const { container } = renderFixtureLab();
    const widget = baseWidget(container);

    expect(screen.getByText('safeParseLabSpec — first rejection wins')).toBeVisible();
    expect(
      within(widget).getByRole('combobox', { name: 'Shape of the incoming JSON' }),
    ).toBeVisible();
    expect(within(widget).getByRole('group', { name: 'schemaVersion is 1' })).toBeVisible();
    expect(
      within(widget).getByRole('group', { name: 'Every machine claim carries an anchor' }),
    ).toBeVisible();
    for (const rule of ['1', '2', '3', 'default']) {
      expect(widget.querySelector(`[data-rule="${rule}"]`)).not.toBeNull();
    }
  });

  it('evaluates the declared defaults on load: no rule matches, the default wins', () => {
    const { container } = renderFixtureLab();
    const widget = baseWidget(container);

    expect(hitRows(widget)).toHaveLength(1);
    expect(statusOf(widget, 'default')).toBe('hit');
    expect(within(verdict(widget)).getByText('parsed — LabSpec returned')).toBeVisible();
    expect(
      within(verdict(widget)).getByText('Every gate passed; the caller gets a typed LabSpec.'),
    ).toBeVisible();
    // Non-matching rules were evaluated and missed.
    expect(statusOf(widget, '1')).toBe('miss');
    expect(statusOf(widget, '3')).toBe('miss');
  });

  it('re-evaluates on input change and moves the highlight to the matched rule', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const widget = baseWidget(container);

    const anchorsGroup = within(widget).getByRole('group', {
      name: 'Every machine claim carries an anchor',
    });
    await user.click(within(anchorsGroup).getByRole('button', { name: 'No' }));

    expect(hitRows(widget)).toHaveLength(1);
    expect(statusOf(widget, '3')).toBe('hit');
    expect(statusOf(widget, 'default')).toBe('skip');
    expect(within(verdict(widget)).getByText('rejected — unanchored claim')).toBeVisible();
    expect(
      within(verdict(widget)).getByText(
        'Machine-generated content without at least one code anchor fails the schema outright.',
      ),
    ).toBeVisible();
    // The matched explanation carries an anchor chip linking to the source.
    const chip = within(widget).getByRole('link', {
      name: /packages\/spec\/src\/schema\.ts · calloutWidgetSchema/,
    });
    expect(chip.getAttribute('href')).toContain('/blob/HEAD/packages/spec/src/schema.ts');
  });

  it('first matching rule wins: later true rules are marked not evaluated', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const widget = baseWidget(container);

    // Make rule 3 true first...
    const anchorsGroup = within(widget).getByRole('group', {
      name: 'Every machine claim carries an anchor',
    });
    await user.click(within(anchorsGroup).getByRole('button', { name: 'No' }));
    expect(statusOf(widget, '3')).toBe('hit');

    // ...then make rule 1 true as well: it wins and rule 3 goes grey.
    await user.selectOptions(
      within(widget).getByRole('combobox', { name: 'Shape of the incoming JSON' }),
      'array',
    );
    expect(hitRows(widget)).toHaveLength(1);
    expect(statusOf(widget, '1')).toBe('hit');
    expect(statusOf(widget, '3')).toBe('skip');
    expect(widget.querySelector('[data-rule="3"]')).toHaveTextContent('not evaluated');
    expect(within(verdict(widget)).getByText('rejected — not an object')).toBeVisible();
  });

  it('returns to the default outcome when the inputs stop matching every rule', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const widget = baseWidget(container);

    const versionGroup = within(widget).getByRole('group', { name: 'schemaVersion is 1' });
    await user.click(within(versionGroup).getByRole('button', { name: 'No' }));
    expect(statusOf(widget, '2')).toBe('hit');
    expect(within(verdict(widget)).getByText('rejected — unsupported schemaVersion')).toBeVisible();

    await user.click(within(versionGroup).getByRole('button', { name: 'Yes' }));
    expect(statusOf(widget, 'default')).toBe('hit');
    expect(within(verdict(widget)).getByText('parsed — LabSpec returned')).toBeVisible();
  });

  it('renders the human-overlay table with unanchored explanations and no chips', async () => {
    const user = userEvent.setup();
    const { container } = renderFixtureLab();
    const overlay = container.querySelector(
      '[data-widget="decision-table"][data-origin="overlay"]',
    );
    if (!(overlay instanceof HTMLElement)) throw new Error('overlay decision table not rendered');

    expect(within(overlay).getByText('team note')).toBeVisible();
    // Bare default outcome: no explanation, no anchors.
    expect(within(verdict(overlay)).getByText('keep digging')).toBeVisible();

    const group = within(overlay).getByRole('group', { name: 'Blocked for more than a day' });
    await user.click(within(group).getByRole('button', { name: 'Yes' }));

    expect(within(verdict(overlay)).getByText('ping the lead')).toBeVisible();
    expect(
      within(verdict(overlay)).getByText('Unanchored tribal knowledge: a nudge beats a ticket.'),
    ).toBeVisible();
    expect(within(overlay).queryByRole('button', { name: /packages\// })).not.toBeInTheDocument();
  });
});
