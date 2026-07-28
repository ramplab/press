import { describe, expect, it } from 'vitest';
import { parseLabSpec } from '@ramplab/spec';
import {
  LANDING_MODULE_ID,
  PlanStageError,
  generateLab,
  generateLabPass1,
  parseTraceCandidates,
  runMapStage,
  runPlanStage,
  selectFlagshipModule,
  selectTraceFlagship,
  type TraceCandidate,
} from '../src/index.js';
import {
  AUTHOR_SCRIPTS,
  REPO,
  ScriptedRunner,
  mapPayload,
  mapPayloadWithTraces,
  planPayload,
  traceCandidatesPayload,
} from './harness.js';

/**
 * The issue-#18 pedagogy redesign, exercised with fake runners only: trace
 * candidates out of the map stage, trace-first flagship selection (intake
 * override, centrality fallback), the plan stage's curriculum contract
 * (ledger fields, landing module, pinned trace), and the ledger slice +
 * style contract in the author prompts.
 */

const TRACE_CANDIDATES = traceCandidatesPayload() as TraceCandidate[];

function minimalMapSpec(): ReturnType<typeof parseLabSpec> {
  return parseLabSpec({
    schemaVersion: 1,
    id: 'unit',
    title: 'Unit fixture',
    base: {
      modules: [
        {
          id: 'repo-overview',
          title: 'Tour',
          widgets: [
            {
              id: 'system-map',
              type: 'system-map',
              nodes: [
                {
                  id: 'greeter',
                  label: 'Greeter',
                  description: 'TypeScript greeting service.',
                  anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
                },
              ],
              edges: [],
            },
          ],
        },
      ],
    },
    overlay: [],
  });
}

describe('map stage: trace-candidate parsing', () => {
  it('asks the map agent for trace candidates and returns the parsed list', async () => {
    const runner = new ScriptedRunner({ map: [JSON.stringify(mapPayloadWithTraces())] });

    const result = await runMapStage(runner, REPO, { model: 'claude-sonnet-5' });

    expect(runner.requests[0]!.prompt).toContain('"traceCandidates"');
    expect(runner.requests[0]!.prompt).toContain('front door');
    expect(result.traceCandidates?.map((c) => c.id)).toEqual([
      'greeting-flow',
      'order-total',
    ]);
    expect(result.traceCandidates?.[0]).toEqual({
      id: 'greeting-flow',
      action: 'a greeting request is served',
      description: 'From the entry point to the greeting string.',
      keyFiles: ['src/greeter.ts'],
    });
  });

  it('returns an empty list for an old-shape map payload without candidates', async () => {
    const runner = new ScriptedRunner({ map: [JSON.stringify(mapPayload())] });

    const result = await runMapStage(runner, REPO, { model: 'claude-sonnet-5' });

    expect(result.traceCandidates).toEqual([]);
  });

  it('drops malformed candidates and duplicate ids without failing the stage', () => {
    const parsed = parseTraceCandidates({
      traceCandidates: [
        { id: 'good', action: 'a request is served', keyFiles: ['src/a.ts'] },
        { id: 'NOT-KEBAB', action: 'bad id', keyFiles: ['src/a.ts'] },
        { id: 'no-files', action: 'no key files', keyFiles: [] },
        { id: 'no-action', keyFiles: ['src/a.ts'] },
        { id: 'good', action: 'duplicate id — dropped', keyFiles: ['src/b.ts'] },
        'not even an object',
      ],
    });

    expect(parsed).toEqual([
      { id: 'good', action: 'a request is served', keyFiles: ['src/a.ts'] },
    ]);
  });

  it('treats a missing or non-array traceCandidates key as no candidates', () => {
    expect(parseTraceCandidates({})).toEqual([]);
    expect(parseTraceCandidates({ traceCandidates: 'nope' })).toEqual([]);
  });
});

describe('flagship: trace selection', () => {
  it('selects the first candidate — the map orders most-representative-first', () => {
    const selection = selectTraceFlagship(TRACE_CANDIDATES);

    expect(selection).toMatchObject({
      basis: 'trace',
      traceAction: 'a greeting request is served',
    });
    expect(selection?.nodeId).toBeUndefined();
    expect(selection?.plannedModule).toMatchObject({
      id: 'greeting-flow',
      title: 'End to end: a greeting request is served',
      keyFiles: ['src/greeter.ts'],
      assumes: [],
    });
    expect(selection?.plannedModule.focus).toContain('end to end');
    expect(selection?.plannedModule.focus).toContain('a greeting request is served');
    // Iteration-2 pedagogy (issue #18): the trace module must open on walked
    // code, never a diagram.
    expect(selection?.plannedModule.focus).toContain('MUST open with a code-walkthrough');
    expect(selection?.plannedModule.teaches.length).toBeGreaterThan(0);
  });

  it('lets an intake hint override the representativeness order', () => {
    const selection = selectTraceFlagship(TRACE_CANDIDATES, {
      weekOneMastery: ['order totals and money handling'],
    });

    expect(selection).toMatchObject({
      basis: 'trace-intake',
      traceAction: 'an order total is computed',
      matchedHint: 'order totals and money handling',
    });
    expect(selection?.plannedModule.id).toBe('order-total');
    expect(selection?.plannedModule.focus).toContain('order totals and money handling');
  });

  it('keeps the first candidate when no intake hint matches any candidate', () => {
    const selection = selectTraceFlagship(TRACE_CANDIDATES, {
      weekOneMastery: ['kubernetes deployment topology'],
    });

    expect(selection).toMatchObject({ basis: 'trace', traceAction: 'a greeting request is served' });
  });

  it('returns undefined when there are no candidates', () => {
    expect(selectTraceFlagship(undefined)).toBeUndefined();
    expect(selectTraceFlagship([])).toBeUndefined();
  });

  it('suffixes candidate ids reserved by other pipeline stages', () => {
    const reserved: TraceCandidate[] = [
      { id: LANDING_MODULE_ID, action: 'a PR is opened', keyFiles: ['src/a.ts'] },
    ];
    expect(selectTraceFlagship(reserved)?.plannedModule.id).toBe(
      `${LANDING_MODULE_ID}-trace`,
    );

    const overview: TraceCandidate[] = [
      { id: 'repo-overview', action: 'a request is served', keyFiles: ['src/a.ts'] },
    ];
    expect(selectTraceFlagship(overview)?.plannedModule.id).toBe('repo-overview-trace');
  });

  it('selectFlagshipModule prefers a trace and falls back to centrality without one', () => {
    const spec = minimalMapSpec();

    const withTraces = selectFlagshipModule(spec, undefined, TRACE_CANDIDATES);
    expect(withTraces.basis).toBe('trace');
    expect(withTraces.traceAction).toBe('a greeting request is served');

    const withoutTraces = selectFlagshipModule(spec, undefined, []);
    expect(withoutTraces.basis).toBe('centrality');
    expect(withoutTraces.nodeId).toBe('greeter');
    expect(withoutTraces.traceAction).toBeUndefined();
    // The fallback brief now carries a ledger too (author prompts need it).
    expect(withoutTraces.plannedModule.assumes).toEqual([]);
    expect(withoutTraces.plannedModule.teaches.length).toBeGreaterThan(0);
  });
});

describe('pass 1: the preview module is the trace', () => {
  it('authors the selected trace end to end', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayloadWithTraces())],
      author: AUTHOR_SCRIPTS,
    });

    const result = await generateLabPass1(REPO, { runner });

    expect(result.flagship).toMatchObject({
      basis: 'trace',
      traceAction: 'a greeting request is served',
    });
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'greeting-flow',
      'repo-overview',
    ]);

    // The author's brief is the trace, with the module-1 ledger slice.
    const prompt = runner.authorRequests()[0]!.prompt;
    expect(prompt).toContain('Module id: greeting-flow');
    expect(prompt).toContain('end to end');
    expect(prompt).toContain('a greeting request is served');
    expect(prompt).toContain("this is the learner's first hands-on module");
  });

  it('still works against an old-shape map (no candidates): centrality fallback', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      // Flagship module ids are system-map node ids on the fallback path.
      author: { greeter: AUTHOR_SCRIPTS['greetings']! },
    });

    const result = await generateLabPass1(REPO, { runner });

    expect(result.flagship.basis).toBe('centrality');
    expect(result.spec.base.modules.map((m) => m.id)).toEqual(['greeter', 'repo-overview']);
  });
});

describe('plan stage: the curriculum contract parse gate', () => {
  const model = 'claude-sonnet-5';

  it('rejects a plan whose modules lack the ledger fields', async () => {
    const legacyShape = {
      modules: [
        {
          id: 'greetings',
          title: 'The greeting path',
          focus: 'How greetings are built.',
          keyFiles: ['src/greeter.ts'],
        },
      ],
    };
    const runner = new ScriptedRunner({ map: [], plan: [JSON.stringify(legacyShape)] });

    const error = await runPlanStage(runner, REPO, {
      model,
      mapSpec: minimalMapSpec(),
      maxRetries: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanStageError);
    expect((error as PlanStageError).lastFailure).toMatch(/assumes|teaches/);
  });

  it('rejects a plan that does not end with the landing module', async () => {
    const runner = new ScriptedRunner({
      map: [],
      plan: [JSON.stringify(planPayload(['greetings', 'orders']))],
    });

    const error = await runPlanStage(runner, REPO, {
      model,
      mapSpec: minimalMapSpec(),
      maxRetries: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanStageError);
    expect((error as PlanStageError).lastFailure).toContain(LANDING_MODULE_ID);
  });

  it('feeds the landing-module failure into the retry prompt, then accepts the fix', async () => {
    const runner = new ScriptedRunner({
      map: [],
      plan: [
        JSON.stringify(planPayload(['greetings'])),
        JSON.stringify(planPayload(['greetings', 'first-contribution'])),
      ],
    });

    const result = await runPlanStage(runner, REPO, {
      model,
      mapSpec: minimalMapSpec(),
    });

    expect(result.attempts).toBe(2);
    const retryPrompt = runner.requests.at(-1)!.prompt;
    expect(retryPrompt).toContain('previous attempt was rejected');
    expect(retryPrompt).toContain(LANDING_MODULE_ID);
    expect(result.plan.modules.map((m) => m.id)).toEqual([
      'greetings',
      'first-contribution',
    ]);
  });

  it('pins module 1 to the flagship trace and canonicalizes its title/focus', async () => {
    const trace = selectTraceFlagship(TRACE_CANDIDATES)!;
    // The planner restates the trace module with drifted title/focus but the
    // right id — accepted, then canonicalized from the selection.
    const drifted = planPayload(['greeting-flow', 'first-contribution']) as {
      modules: Record<string, unknown>[];
    };
    drifted.modules[0]!['title'] = 'A rephrased title';
    drifted.modules[0]!['focus'] = 'A rephrased focus.';
    const runner = new ScriptedRunner({ map: [], plan: [JSON.stringify(drifted)] });

    const result = await runPlanStage(runner, REPO, {
      model,
      mapSpec: minimalMapSpec(),
      traceModule: trace.plannedModule,
    });

    // The prompt carries the pinned contract.
    const prompt = runner.requests[0]!.prompt;
    expect(prompt).toContain('MODULE 1 IS AN END-TO-END TRACE');
    expect(prompt).toContain(`id: ${trace.plannedModule.id}`);
    expect(prompt).toContain(`The FIRST module's id is "${trace.plannedModule.id}"`);
    expect(prompt).toContain(`The LAST module's id is "${LANDING_MODULE_ID}"`);

    const first = result.plan.modules[0]!;
    expect(first.id).toBe(trace.plannedModule.id);
    expect(first.title).toBe(trace.plannedModule.title);
    expect(first.focus).toBe(trace.plannedModule.focus);
  });

  it('rejects a plan whose first module is not the pinned trace', async () => {
    const trace = selectTraceFlagship(TRACE_CANDIDATES)!;
    const runner = new ScriptedRunner({
      map: [],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
    });

    const error = await runPlanStage(runner, REPO, {
      model,
      mapSpec: minimalMapSpec(),
      traceModule: trace.plannedModule,
      maxRetries: 0,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanStageError);
    expect((error as PlanStageError).lastFailure).toContain('greeting-flow');
    expect((error as PlanStageError).lastFailure).toContain('greetings');
  });

  it('asks the planner to pick its own front-door action when no trace was selected', async () => {
    const runner = new ScriptedRunner({
      map: [],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
    });

    await runPlanStage(runner, REPO, { model, mapSpec: minimalMapSpec() });

    const prompt = runner.requests[0]!.prompt;
    expect(prompt).toContain('MODULE 1 IS AN END-TO-END TRACE');
    expect(prompt).toContain('Pick ONE "front door" user action');
    expect(prompt).not.toContain('The FIRST module\'s id is');
  });
});

describe('author stage: ledger slice and style contract in every prompt', () => {
  it('threads each module its assumes/teaches and earlier module titles', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'orders', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, { runner, full: true });

    const promptFor = (id: string): string =>
      runner.authorRequests().find((r) => r.prompt.includes(`Module id: ${id}`))!.prompt;

    // Module 1: empty ledger, nothing to reference.
    const first = promptFor('greetings');
    expect(first).toContain("this is the learner's first hands-on module");
    expect(first).toContain('(none — this is the first module)');
    expect(first).toContain('- how a greeting is built');

    // Module 2: assumes what module 1 taught, may reference it by title.
    const second = promptFor('orders');
    expect(second).toContain('The learner has already seen:');
    expect(second).toContain('- how a greeting is built');
    expect(second).toContain('Do not re-explain any of it; build on it');
    expect(second).toContain('This module must teach:');
    expect(second).toContain('- how order totals are summed in integer cents');
    expect(second).toContain('Earlier modules you may reference by title: "The greeting path"');

    // The landing module sees both earlier titles.
    const landing = promptFor('first-contribution');
    expect(landing).toContain('"The greeting path", "Order totals"');

    // The style contract is in every author prompt.
    for (const request of runner.authorRequests()) {
      expect(request.prompt).toContain('Style contract');
      expect(request.prompt).toContain('knows nothing about THIS codebase');
      expect(request.prompt).toContain('concrete instance first');
      expect(request.prompt).toContain('jargon');
      expect(request.prompt).toContain('Every analogy must be immediately followed');
      expect(request.prompt).toContain('"X calls Y" by itself is the failure mode');
      // The iteration-2 pedagogy additions (issue #18): a structural
      // capability close, in the ledger and echoed at the widget menu.
      expect(request.prompt).toContain(
        'The last widget before the closing quiz must be a callout stating plainly what the learner can now DO',
      );
      expect(request.prompt).toContain('close with the capability callout, then one quiz');
    }
  });
});

describe('pass 1 → pass 2: the trace stays canonical across passes', () => {
  it('pass 2 pins its plan to the same trace pass 1 previewed', async () => {
    const pass1Runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayloadWithTraces())],
      author: AUTHOR_SCRIPTS,
    });
    const pass1 = await generateLabPass1(REPO, { runner: pass1Runner });
    expect(pass1.flagship.plannedModule.id).toBe('greeting-flow');

    const pass2Runner = new ScriptedRunner({
      map: [], // reused — any map call would throw
      plan: [JSON.stringify(planPayload(['greeting-flow', 'orders', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });
    const pass2 = await generateLab(REPO, {
      runner: pass2Runner,
      full: true,
      mapResult: pass1.mapResult,
    });

    // The plan prompt pinned pass 1's exact trace module.
    const planPrompt = pass2Runner.requests.find((r) => r.stage === 'plan')!.prompt;
    expect(planPrompt).toContain(`id: ${pass1.flagship.plannedModule.id}`);
    expect(planPrompt).toContain(pass1.flagship.plannedModule.focus);

    // Module 1 of the final lab is the re-authored trace, canonical id/title,
    // ahead of the map's overview.
    expect(pass2.spec.base.modules.map((m) => m.id)).toEqual([
      'greeting-flow',
      'repo-overview',
      'orders',
      'first-contribution',
    ]);
    expect(pass2.plan?.modules[0]).toMatchObject({
      id: pass1.flagship.plannedModule.id,
      title: pass1.flagship.plannedModule.title,
      focus: pass1.flagship.plannedModule.focus,
    });
  });
});
