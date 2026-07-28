import { describe, expect, it } from 'vitest';
import { safeParseLabSpec } from '@ramplab/spec';
import {
  AuthorStageError,
  MAP_STAGE_MODEL,
  PlanStageError,
  generateLab,
  type StageRequest,
} from '../src/index.js';
import {
  AUTHOR_SCRIPTS,
  REPO,
  ScriptedRunner,
  firstContributionModulePayload,
  greetingsModulePayload,
  mapPayload,
  ordersModulePayload,
  planPayload,
  sessionsModulePayload,
} from './harness.js';

/**
 * The full pipeline (map → plan → author fan-out → assemble → verify)
 * exercised end-to-end against the polyglot fixture repo with a scripted
 * ModelRunner — no live API calls (see ./harness.ts). The verify stage's own
 * behavior (drops, batching, retries) is covered in ./verifyStage.test.ts;
 * here the scripted verifier verifies everything unless a test says
 * otherwise.
 */

describe('full pipeline: happy path', () => {
  it('runs map → plan → author fan-out → assemble → verify into one valid, resolved spec', async () => {
    const runner = new ScriptedRunner({
      map: [{ output: JSON.stringify(mapPayload()), costUsd: 0.1 }],
      plan: [
        {
          output: JSON.stringify(
            planPayload(['greetings', 'orders', 'sessions', 'first-contribution']),
          ),
          costUsd: 0.2,
        },
      ],
      author: {
        greetings: [{ output: JSON.stringify(greetingsModulePayload()), costUsd: 0.3 }],
        orders: [{ output: JSON.stringify(ordersModulePayload()), costUsd: 0.4 }],
        sessions: [{ output: JSON.stringify(sessionsModulePayload()), costUsd: 0.5 }],
        'first-contribution': [
          { output: JSON.stringify(firstContributionModulePayload()), costUsd: 0.1 },
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    // One map call, one plan call, one author call per planned module, one
    // MORE author call re-writing the overview chapter (2026-07-26 — it is
    // held to the same contracts as every other chapter now), then one verify
    // batch per assembled module (overview + four authored).
    expect(runner.requests.map((r) => r.stage)).toEqual([
      'map',
      'plan',
      'author',
      'author',
      'author',
      'author',
      'author',
      'verify',
      'verify',
      'verify',
      'verify',
      'verify',
    ]);

    // The assembled spec: the plan-head trace leads, then the overview as
    // the zoom-out, then the remaining authored modules in plan order.
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'greetings',
      'repo-overview',
      'orders',
      'sessions',
      'first-contribution',
    ]);
    expect(result.spec.schemaVersion).toBe(1);
    expect(result.spec.id).toBe('polyglot');

    // The merged spec validates after a JSON round-trip.
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);

    // Every anchor resolved against the fixture repo and got fingerprinted.
    expect(result.resolution.summary.unresolvedUnits).toBe(0);
    expect(result.resolution.summary.resolvedAnchors).toBe(
      result.resolution.summary.totalAnchors,
    );
    for (const anchor of result.resolution.anchors) {
      expect(anchor.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // Every claim verified — nothing dropped by the adversarial pass.
    expect(result.verification?.summary.passRate).toBe(1);
    expect(result.verification?.drops).toEqual({ widgets: [], questions: [], modules: [] });

    // Plan and per-module attempts are reported; cost sums across stages.
    expect(result.plan?.modules.map((m) => m.id)).toEqual([
      'greetings',
      'orders',
      'sessions',
      'first-contribution',
    ]);
    // The learner-state ledger survives parsing into the plan.
    expect(result.plan?.modules[0]?.assumes).toEqual([]);
    expect(result.plan?.modules[1]?.assumes).toEqual(['how a greeting is built']);
    expect(result.plan?.modules[1]?.teaches).toEqual([
      'how order totals are summed in integer cents',
    ]);
    expect(result.authorAttempts).toEqual({
      greetings: 1,
      orders: 1,
      sessions: 1,
      'first-contribution': 1,
    });
    expect(result.costUsd).toBeCloseTo(1.6);

    // Every author prompt carries the inline-code style contract, and the map
    // prompt does too — prose identifiers must be backticked (refs #23).
    for (const request of runner.authorRequests()) {
      expect(request.prompt).toContain('wrap every code identifier');
    }
    const mapRequest = runner.requests.find((r) => r.stage === 'map');
    expect(mapRequest?.prompt).toContain('wrap each code identifier');
    // The title stage must use the repo's REAL project name verbatim and never
    // invent/rebrand it (the calcom regen came out "Cal.diy" — refs #27).
    expect(mapRequest?.prompt).toContain("MUST use the project's REAL name exactly as it appears");
    expect(mapRequest?.prompt).toContain('never turn "cal.com" into "Cal.diy"');
    expect(mapRequest?.prompt).toContain('Do NOT invent, guess, abbreviate, translate, rebrand');
  });

  it('stays a map-only tracer by default (no full flag)', async () => {
    const runner = new ScriptedRunner({ map: [JSON.stringify(mapPayload())] });

    const result = await generateLab(REPO, { runner });

    expect(runner.requests.map((r) => r.stage)).toEqual(['map']);
    expect(result.plan).toBeUndefined();
    expect(result.authorAttempts).toBeUndefined();
    expect(result.verification).toBeUndefined();
    expect(result.spec.base.modules.map((m) => m.id)).toEqual(['repo-overview']);
  });
});

describe('full pipeline: curriculum budget', () => {
  it('caps the plan at budget.maxModules, always keeping the landing module', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      // The model over-delivers: five modules against a budget of two.
      plan: [
        JSON.stringify(
          planPayload(['greetings', 'orders', 'sessions', 'invoices', 'first-contribution']),
        ),
      ],
      author: AUTHOR_SCRIPTS,
    });

    const result = await generateLab(REPO, {
      runner,
      full: true,
      budget: { maxModules: 2 },
    });

    // Truncation trims the end of the middle: the head (the journey's
    // opening) and the landing module are curriculum invariants.
    expect(result.plan?.modules.map((m) => m.id)).toEqual([
      'greetings',
      'first-contribution',
    ]);
    // Authoring fans out for exactly the budgeted modules, plus the one
    // re-write of the overview chapter — nothing more.
    expect(runner.authorRequests()).toHaveLength(2 + 1);
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'greetings',
      'repo-overview',
      'first-contribution',
    ]);
  });

  it('threads the budget cap and scope hints into the plan prompt', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, {
      runner,
      full: true,
      budget: { maxModules: 3, scopeHints: ['focus on the greeting path', 'skip invoices'] },
    });

    const planRequest = runner.requests.find((r) => r.stage === 'plan')!;
    expect(planRequest.prompt).toContain('AT MOST 3');
    expect(planRequest.prompt).toContain('focus on the greeting path');
    expect(planRequest.prompt).toContain('skip invoices');
    // The map stage's system map seeds the planner's context.
    expect(planRequest.prompt).toContain('Greeter');
  });

  it('retries the plan stage on schema-invalid output, then fails clearly', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: ['not json at all', JSON.stringify({ modules: [] })],
    });

    const error = await generateLab(REPO, { runner, full: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlanStageError);
    expect((error as PlanStageError).attempts).toBe(2);
    expect(runner.requests.filter((r) => r.stage === 'plan')).toHaveLength(2);
    // The retry prompt carries the failure back to the model.
    expect(runner.requests.at(-1)!.prompt).toContain('previous attempt was rejected');
  });
});

describe('full pipeline: author fan-out and concurrency', () => {
  it('authors modules in parallel but never exceeds the configured cap', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [
        JSON.stringify(planPayload(['greetings', 'orders', 'sessions', 'first-contribution'])),
      ],
      author: AUTHOR_SCRIPTS,
      authorDelayMs: 20,
    });

    await generateLab(REPO, { runner, full: true, concurrency: 2 });

    // Four modules, cap of two: genuinely parallel, never over the cap. The
    // overview re-write adds a fifth call, run on its own after the fan-out.
    expect(runner.authorRequests()).toHaveLength(4 + 1);
    expect(runner.maxAuthorsInFlight).toBe(2);
  });

  it('retries a schema-invalid module and records its attempts', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'orders', 'first-contribution']))],
      author: {
        ...AUTHOR_SCRIPTS,
        // First attempt is invalid (empty widgets), second is good.
        orders: [
          JSON.stringify({ summary: 'empty', widgets: [] }),
          JSON.stringify(ordersModulePayload()),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    expect(result.authorAttempts).toEqual({
      greetings: 1,
      orders: 2,
      'first-contribution': 1,
    });
    const retry = runner
      .authorRequests()
      .find((r) => r.attempt === 2 && r.prompt.includes('Module id: orders'));
    expect(retry?.prompt).toContain('previous attempt was rejected');
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'greetings',
      'repo-overview',
      'orders',
      'first-contribution',
    ]);
  });

  it('authors a module whose optional fields were spelled empty rather than omitted', async () => {
    // The map stage learned this in #174 and the author stage did not, though
    // it writes most of a lab's anchors. Every empty field here is optional:
    // the model said "nothing to add" the long way round.
    const payload = {
      summary: 'How totals are computed.',
      widgets: [
        {
          id: 'total-cents-figure',
          type: 'code-figure',
          title: '',
          code: ['  def total_cents', '', '  end'],
          source: { file: 'lib/order.rb', symbol: 'total_cents', lines: { start: 8, end: 10 } },
          caption: {
            body: 'Totals are integer cents summed over line items.',
            anchors: [{ file: 'lib/order.rb', symbol: '' }],
          },
        },
        {
          id: 'order-shape',
          type: 'data-model',
          nodes: [
            {
              name: 'items',
              type: 'LineItem[]',
              annotation: {
                body: 'Each line item carries an integer price.',
                readBy: '',
                anchors: [{ file: 'lib/order.rb', symbol: 'price_cents' }],
              },
            },
          ],
        },
        {
          id: 'totals-pipeline',
          type: 'pipeline',
          stages: [
            {
              id: 'sum',
              label: 'Sum',
              flow: { in: 'line items', out: '' },
              description: {
                body: 'Sums the integer cents.',
                anchors: [{ file: 'lib/order.rb', symbol: 'total_cents' }],
              },
            },
          ],
        },
        // The module's closing quiz, unchanged from the fixture.
        (ordersModulePayload()['widgets'] as unknown[])[1],
      ],
    };
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'orders', 'first-contribution']))],
      author: { ...AUTHOR_SCRIPTS, orders: [JSON.stringify(payload)] },
    });

    const result = await generateLab(REPO, { runner, full: true });

    // One attempt: nothing was rejected, so no retry was spent.
    expect(result.authorAttempts?.['orders']).toBe(1);

    const orders = result.spec.base.modules.find((m) => m.id === 'orders');
    const figure = orders?.widgets.find((w) => w.id === 'total-cents-figure');
    expect(figure).toBeDefined();
    // The empty optionals are gone; the blank line in the excerpt is not.
    expect(figure).not.toHaveProperty('title');
    expect(figure?.type === 'code-figure' ? figure.code : undefined).toEqual([
      '  def total_cents',
      '',
      '  end',
    ]);
    // A file-level anchor is still an anchor: resolved and fingerprinted.
    const caption = figure?.type === 'code-figure' ? figure.caption : undefined;
    expect(caption?.anchors?.[0]).toEqual({
      file: 'lib/order.rb',
      fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('fails the run with an error naming the module when retries are exhausted', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [
        JSON.stringify(planPayload(['greetings', 'orders', 'sessions', 'first-contribution'])),
      ],
      author: {
        ...AUTHOR_SCRIPTS,
        orders: ['not json', 'still not json'],
      },
    });

    const error = await generateLab(REPO, { runner, full: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthorStageError);
    const authorError = error as AuthorStageError;
    expect(authorError.message).toContain('module "orders"');
    expect(authorError.message).toContain('2 attempts');
    expect(authorError.failures).toEqual([
      expect.objectContaining({ moduleId: 'orders', attempts: 2 }),
    ]);
    // The healthy modules still ran — the failure is reported after the fan-out settles.
    expect(
      runner.authorRequests().filter((r) => r.prompt.includes('Module id: greetings')),
    ).toHaveLength(1);
    expect(
      runner.authorRequests().filter((r) => r.prompt.includes('Module id: sessions')),
    ).toHaveLength(1);
  });
});

describe('full pipeline: assembly and grounding', () => {
  it('drops an authored unit whose anchor fails resolution, keeping the spec valid', async () => {
    const badWidget = {
      id: 'hallucinated',
      type: 'callout',
      kind: 'warning',
      body: 'This claim anchors a file that does not exist.',
      anchors: [{ file: 'src/imaginary.ts', symbol: 'nope' }],
    };
    const payload = greetingsModulePayload();
    (payload['widgets'] as unknown[]).push(badWidget);

    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: { ...AUTHOR_SCRIPTS, greetings: [JSON.stringify(payload)] },
    });

    const result = await generateLab(REPO, { runner, full: true });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).not.toContain('hallucinated');
    const unit = result.resolution.units.find((u) => u.widgetId === 'hallucinated');
    expect(unit?.outcome).toBe('dropped');
    // The dropped unit never reaches the verifier.
    expect(result.verification?.claims.map((c) => c.widgetId)).not.toContain('hallucinated');
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('keeps and flags unresolved authored units under the flag policy', async () => {
    const payload = greetingsModulePayload();
    (payload['widgets'] as unknown[]).push({
      id: 'hallucinated',
      type: 'callout',
      kind: 'warning',
      body: 'Bad anchor, kept for review.',
      anchors: [{ file: 'src/imaginary.ts' }],
    });

    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: { ...AUTHOR_SCRIPTS, greetings: [JSON.stringify(payload)] },
    });

    const result = await generateLab(REPO, {
      runner,
      full: true,
      resolutionPolicy: 'flag',
    });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).toContain('hallucinated');
    expect(
      result.resolution.units.find((u) => u.widgetId === 'hallucinated')?.outcome,
    ).toBe('flagged');
    // Flagged units are already awaiting human review — verification skips
    // them instead of second-guessing the review flow.
    expect(result.verification?.claims.map((c) => c.widgetId)).not.toContain('hallucinated');
  });
});

describe('full pipeline: per-stage model overrides', () => {
  it('routes each stage to its configured model', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    const result = await generateLab(REPO, {
      runner,
      full: true,
      models: { plan: 'claude-opus-4-8', author: 'claude-haiku-4-5' },
    });

    const byStage = (stage: string): StageRequest[] =>
      runner.requests.filter((r) => r.stage === stage);
    expect(byStage('map')[0]!.model).toBe(MAP_STAGE_MODEL);
    expect(byStage('plan')[0]!.model).toBe('claude-opus-4-8');
    for (const request of byStage('author')) {
      expect(request.model).toBe('claude-haiku-4-5');
    }
    // Unconfigured stages (here: verify) fall back to the default model.
    for (const request of byStage('verify')) {
      expect(request.model).toBe('claude-sonnet-5');
    }
    expect(result.models).toMatchObject({
      map: MAP_STAGE_MODEL,
      plan: 'claude-opus-4-8',
      author: 'claude-haiku-4-5',
      verify: 'claude-sonnet-5',
    });
  });
});
