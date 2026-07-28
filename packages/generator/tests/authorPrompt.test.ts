import { describe, expect, it } from 'vitest';
import {
  buildAuthorPrompt,
  DEEP_WIDGET_RANGE,
  DEFAULT_WIDGET_RANGE,
} from '../src/authorStage.js';
import type { PlannedModule } from '../src/planStage.js';

/**
 * The prompt IS the product contract for authored content; these tests pin
 * the founder-approved Edition v2 threads so a future rewording cannot
 * silently drop one.
 */

const planned: PlannedModule = {
  id: 'movement',
  title: 'How tiles move',
  focus: 'The merge algorithm.',
  keyFiles: ['js/game_manager.js'],
  assumes: [],
  teaches: ['the merge pass'],
};

describe('the author prompt carries the Edition v2 content contract', () => {
  const prompt = buildAuthorPrompt(planned, [], DEFAULT_WIDGET_RANGE);

  it('demands the four field threads, each conditioned on real material', () => {
    for (const thread of ['RUN IT', 'THE NUMBERS THAT MATTER', 'WHEN IT BREAKS', 'HOW IT IS TESTED']) {
      expect(prompt).toContain(thread);
    }
    expect(prompt).toContain('Never fabricate');
    expect(prompt).toContain('Never invent a command');
  });

  it('the weave rule ties threads to the journey, not to checklists', () => {
    expect(prompt).toContain('THE WEAVE RULE');
    expect(prompt).toContain('never appended as a checklist section');
    expect(prompt).toContain("by that chapter's name");
    // Threads arrive assigned by the plan, not stamped on every chapter.
    expect(prompt).toContain('The plan assigns each module the threads');
  });

  it('demands prediction-style checkpoints', () => {
    expect(prompt).toContain('2-4 questions');
    expect(prompt).toContain('PREDICT');
  });

  it('interpolates the tiered widget range', () => {
    expect(prompt).toContain('Produce 6 to 10 widgets');
    const deep = buildAuthorPrompt(planned, [], DEEP_WIDGET_RANGE);
    expect(deep).toContain('Produce 7 to 12 widgets');
  });

  it('keeps the craft rule from the curriculum contract', () => {
    expect(prompt).toContain('Teach the craft alongside the behavior');
  });
});

/**
 * The diagram budget (founder, 2026-07-25). Editions pressed on 2026-07-14
 * carried one system map where 2026-07-13's carried three to five, because
 * diagrams were the only optional widget family competing with the threads
 * for an unchanged budget. These pin the fix.
 */
describe('the author prompt budgets diagrams instead of leaving them over', () => {
  const prompt = buildAuthorPrompt(planned, [], DEFAULT_WIDGET_RANGE);

  it('states the shape contract, with one cue per diagram type', () => {
    expect(prompt).toContain('Draw the shape');
    for (const cue of ['→ system-map', '→ state-machine', '→ pipeline', '→ data-model']) {
      expect(prompt).toContain(cue);
    }
  });

  it('keeps the honesty escape hatch — no shape, no diagram; no anchor, no shape', () => {
    expect(prompt).toContain('one linear read of one file');
    expect(prompt).toContain('Never invent structure the code does not have');
    expect(prompt).toContain('a shape you cannot anchor is a shape you must not draw');
  });

  it('floors the budget above the module the threads already spend', () => {
    // Five slots are effectively spoken for before a diagram is considered:
    // quiz, capability callout, "when it breaks" warning, and the threads.
    expect(DEFAULT_WIDGET_RANGE.min).toBeGreaterThan(5);
    expect(DEEP_WIDGET_RANGE.min).toBeGreaterThan(DEFAULT_WIDGET_RANGE.min);
  });

  it('lists diagrams above code-figure and quiz, not last', () => {
    expect(prompt.indexOf('3. Diagram widgets')).toBeGreaterThan(0);
    expect(prompt.indexOf('3. Diagram widgets')).toBeLessThan(prompt.indexOf('4. Code figure'));
    expect(prompt.indexOf('4. Code figure')).toBeLessThan(prompt.indexOf('5. Quiz'));
  });
});

/**
 * The catalog lights the OPENING module's system-map as the edition's cover
 * (apps/web `featured.ts` gates hero eligibility on it). Two Caddy runs hours
 * apart produced four maps and one, so the opening map is asked for by name.
 */
describe('the opening chapter is told it owns the cover map', () => {
  it('asks the flagship for a trace-recap map', () => {
    const opening = buildAuthorPrompt(planned, [], DEFAULT_WIDGET_RANGE);
    expect(opening).toContain('THIS IS THE OPENING CHAPTER');
    expect(opening).toContain('recaps the path just walked');
    expect(opening).toContain("must be THIS chapter's journey");
  });

  it('says nothing of the sort to a later chapter', () => {
    const later = buildAuthorPrompt(planned, ['How tiles move'], DEFAULT_WIDGET_RANGE);
    expect(later).not.toContain('THIS IS THE OPENING CHAPTER');
    // The shape contract still applies to every chapter.
    expect(later).toContain('Draw the shape');
  });
});
