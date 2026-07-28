import { describe, expect, it } from 'vitest';
import { buildAuthorPrompt } from '../src/authorStage.js';
import { OVERVIEW_MODULE_ID, plannedOverviewModule } from '../src/generateLab.js';
import type { CurriculumPlan } from '../src/planStage.js';
import type { LabSpec } from '@ramplab/spec';

/**
 * The zoom-out chapter (founder, 2026-07-26). Emitted mechanically by the map
 * stage, `repo-overview` was the one chapter with no ledger, no capability
 * callout and no quiz — and sitting at position 2 it broke the narrative
 * chain, costing points on BOTH criteria that have never scored 5. The judge
 * named it twice: "a generic, non-referential architecture overview that
 * restates concepts at the same abstract altitude" and "Module 2 has no such
 * statement, breaking the pattern".
 */

const mapSpec = {
  schemaVersion: 1,
  id: 'demo',
  title: 'Demo Onboarding Lab',
  base: {
    modules: [
      {
        id: OVERVIEW_MODULE_ID,
        title: 'How Demo Works',
        widgets: [
          {
            id: 'map',
            type: 'system-map',
            title: 'The tree',
            nodes: [
              { id: 'a', label: 'Server', anchors: [{ file: 'src/server.ts' }] },
              { id: 'b', label: 'Router', anchors: [{ file: 'src/router.ts' }] },
            ],
            edges: [{ from: 'a', to: 'b' }],
          },
        ],
      },
    ],
  },
  overlay: [],
} as unknown as LabSpec;

const plan: CurriculumPlan = {
  modules: [
    {
      id: 'serve-a-request',
      title: 'End to end: serving one request',
      focus: 'Follow a GET through the server.',
      keyFiles: ['src/server.ts'],
      assumes: [],
      teaches: ['how a request reaches a handler', 'where the router is built'],
    },
    {
      id: 'router-internals',
      title: 'Inside the router',
      focus: 'Route matching.',
      keyFiles: ['src/router.ts'],
      assumes: ['how a request reaches a handler'],
      teaches: ['match order'],
    },
  ],
};

describe('the overview chapter is briefed as a chapter, not a preamble', () => {
  const planned = plannedOverviewModule(mapSpec, plan);

  it('keeps the stable id and the map stage’s own title', () => {
    expect(planned?.id).toBe(OVERVIEW_MODULE_ID);
    expect(planned?.title).toBe('How Demo Works');
  });

  it('assumes exactly what the flagship trace already taught', () => {
    // This is the fix for builds-on-earlier: the chapter cannot restate the
    // trace at the same altitude if it is told what the reader already holds.
    expect(planned?.assumes).toEqual(plan.modules[0]?.teaches);
  });

  it('is told to place the walked path on the wider map', () => {
    expect(planned?.focus).toContain('whole tree');
    expect(planned?.focus).toContain('by name');
    expect(planned?.focus).toContain('system-map');
  });

  it('takes its key files from what the map already anchored', () => {
    expect(planned?.keyFiles).toEqual(['src/server.ts', 'src/router.ts']);
  });

  it('yields nothing when there is no overview or no trace to build on', () => {
    expect(plannedOverviewModule(mapSpec, { modules: [] })).toBeUndefined();
    const noOverview = {
      ...mapSpec,
      base: { modules: [] },
    } as unknown as LabSpec;
    expect(plannedOverviewModule(noOverview, plan)).toBeUndefined();
  });
});

describe('the overview’s prompt carries the chapter contracts', () => {
  const planned = plannedOverviewModule(mapSpec, plan);
  // The trace precedes it, so it is briefed as a later chapter — never as the
  // opening one, which is what an empty ledger would signal.
  const prompt = buildAuthorPrompt(
    planned!,
    ['End to end: serving one request'],
    { min: 6, max: 10 },
  );

  it('is not mistaken for the flagship', () => {
    expect(prompt).not.toContain('THIS IS THE OPENING CHAPTER');
  });

  it('must name something specific from the chapter before it', () => {
    expect(prompt).toContain('CARRY THE THREAD FORWARD');
    expect(prompt).toContain('End to end: serving one request');
    expect(prompt).toContain('A generic nod ("as we saw earlier") does not count');
  });

  it('owes the reader a capability close like every other chapter', () => {
    expect(prompt).toContain('what the learner can now DO');
    expect(prompt).toContain('breaks the pattern the reader has learned to expect');
  });

  it('is held to the show-the-code floor', () => {
    expect(prompt).toContain('SHOW THE CODE');
    expect(prompt).toContain('At least TWO widgets');
  });
});
