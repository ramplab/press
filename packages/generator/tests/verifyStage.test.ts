import { describe, expect, it } from 'vitest';
import { safeParseLabSpec, type QuizWidget } from '@ramplab/spec';
import { VerifyStageError, generateLab } from '../src/index.js';
import {
  AUTHOR_SCRIPTS,
  REPO,
  ScriptedRunner,
  claimIdsIn,
  firstContributionModulePayload,
  greetingsModulePayload,
  mapPayload,
  planPayload,
  verdictsPayload,
} from './harness.js';

/**
 * The adversarial verify stage, end-to-end through `generateLab` with the
 * scripted runner (no live API calls; see ./harness.ts). The scripted
 * verifier verifies every claim by default; individual tests override
 * verdicts per claim id to exercise refutations, unverifiable claims, quiz
 * question drops, empty-module cleanup, retries, and terminal failures.
 */

/** A single-callout module: refuting its one claim empties the module. */
function soloCalloutPayload(): Record<string, unknown> {
  return {
    summary: 'One lonely claim.',
    widgets: [
      {
        id: 'shout-upper',
        type: 'callout',
        kind: 'why',
        body: 'shout upper-cases the greeting message.',
        anchors: [{ file: 'src/greeter.ts', symbol: 'shout', lines: { start: 9, end: 11 } }],
      },
    ],
  };
}

/** A two-question quiz module, both questions anchored to the fixture. */
function quizHeavyPayload(): Record<string, unknown> {
  return {
    summary: 'Greeting checkpoint.',
    widgets: [
      {
        id: 'shout-upper',
        type: 'callout',
        kind: 'why',
        body: 'shout upper-cases the greeting message.',
        anchors: [{ file: 'src/greeter.ts', symbol: 'shout', lines: { start: 9, end: 11 } }],
      },
      {
        id: 'greetings-quiz',
        type: 'quiz',
        questions: [
          {
            id: 'q-greet-return',
            prompt: 'What does greet return?',
            options: [
              { id: 'opt-string', label: 'A plain string' },
              { id: 'opt-greeting', label: 'A Greeting object' },
            ],
            correctOptionId: 'opt-greeting',
            explanation: {
              body: 'greet returns { message } — a Greeting.',
              anchors: [{ file: 'src/greeter.ts', symbol: 'Greeting' }],
            },
          },
          {
            id: 'q-shout-case',
            prompt: 'What casing does shout produce?',
            options: [
              { id: 'opt-lower', label: 'Lowercase' },
              { id: 'opt-upper', label: 'Uppercase' },
            ],
            correctOptionId: 'opt-upper',
            explanation: {
              body: 'shout calls toUpperCase on the message.',
              anchors: [{ file: 'src/greeter.ts', symbol: 'shout' }],
            },
          },
        ],
      },
    ],
  };
}

function greetingsOnlyRunner(
  overrides: {
    author?: Record<string, (string | { output: string })[]>;
    verify?: ConstructorParameters<typeof ScriptedRunner>[0]['verify'];
  } = {},
): ScriptedRunner {
  return new ScriptedRunner({
    map: [JSON.stringify(mapPayload())],
    plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
    author: {
      greetings: [JSON.stringify(greetingsModulePayload())],
      'first-contribution': [JSON.stringify(firstContributionModulePayload())],
      ...overrides.author,
    },
    ...(overrides.verify !== undefined ? { verify: overrides.verify } : {}),
  });
}

describe('verify stage: happy path', () => {
  it('verifies every claim, keeps the spec intact, and reports a perfect pass rate', async () => {
    const runner = greetingsOnlyRunner();

    const result = await generateLab(REPO, { runner, full: true });

    // One batch per assembled module, after assembly.
    expect(runner.verifyRequests()).toHaveLength(3);
    expect(runner.requests.map((r) => r.stage).slice(-3)).toEqual([
      'verify',
      'verify',
      'verify',
    ]);

    // Nothing dropped; the spec still validates.
    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).toEqual([
      'greet-walkthrough',
      'shout-reuses-greet',
      'greetings-quiz',
    ]);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);

    // Report shape: per-claim verdicts with reasons, summary, drops.
    const verification = result.verification!;
    expect(verification.summary).toEqual({
      // 3 overview claims + walkthrough step + callout + quiz question,
      // plus the landing module's callout + quiz question.
      totalClaims: 8,
      verified: 8,
      refuted: 0,
      unverifiable: 0,
      passRate: 1,
    });
    expect(verification.drops).toEqual({ widgets: [], questions: [], modules: [] });
    for (const claim of verification.claims) {
      expect(claim.verdict).toBe('verified');
      expect(claim.reason.length).toBeGreaterThan(0);
      expect(claim.anchors.length).toBeGreaterThan(0);
    }
    expect(verification.claims.map((c) => c.claimId)).toEqual([
      'greet-walkthrough#step-1',
      'shout-reuses-greet#body',
      'greetings-quiz#question-q-greet-return',
      'system-map#node-greeter',
      'system-map#node-orders',
      'why-polyglot#body',
      'starter-area#body',
      'contribution-quiz#question-q-starter',
    ]);

    // One clean attempt per module batch.
    expect(result.verifyAttempts).toEqual({
      'repo-overview': 1,
      greetings: 1,
      'first-contribution': 1,
    });
  });

  it('feeds the verifier the ACTUAL anchored code content, not just the reference', async () => {
    const runner = greetingsOnlyRunner();

    await generateLab(REPO, { runner, full: true });

    const greetingsPrompt = runner
      .verifyRequests()
      .find((r) => r.prompt.includes('Claims from module "greetings"'))!.prompt;

    // The callout anchors src/greeter.ts lines 9-11: the shout implementation.
    expect(greetingsPrompt).toContain('return greet(name).message.toUpperCase();');
    // The walkthrough commentary anchors the greet symbol (whole file).
    expect(greetingsPrompt).toContain('return { message: `Hello, ${name}!` };');
    // Quiz claims put the correct answer itself on trial.
    expect(greetingsPrompt).toContain('Claimed correct answer: A Greeting object');
    // Anchor coordinates ride along with the content.
    expect(greetingsPrompt).toContain('src/greeter.ts, lines 9-11, symbol "shout"');

    const overviewPrompt = runner
      .verifyRequests()
      .find((r) => r.prompt.includes('Claims from module "repo-overview"'))!.prompt;
    // The system-map node anchors src/greeter.ts lines 5-7.
    expect(overviewPrompt).toContain('export function greet(name: string): Greeting {');
  });
});

describe('verify stage: drops', () => {
  it('drops a refuted unit from the base spec, keeping the spec valid', async () => {
    const runner = greetingsOnlyRunner({
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'shout-reuses-greet#body': {
                verdict: 'refuted',
                reason: 'shout transforms the message with toUpperCase — it is not a thin wrapper.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).toEqual(['greet-walkthrough', 'greetings-quiz']);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);

    const verification = result.verification!;
    expect(verification.summary).toMatchObject({
      totalClaims: 8,
      verified: 7,
      refuted: 1,
      unverifiable: 0,
    });
    expect(verification.summary.passRate).toBeCloseTo(7 / 8);
    expect(verification.drops.widgets).toEqual([
      {
        moduleId: 'greetings',
        widgetId: 'shout-reuses-greet',
        reasons: [
          'shout-reuses-greet#body: refuted — shout transforms the message with toUpperCase — it is not a thin wrapper.',
        ],
      },
    ]);
    expect(verification.drops.questions).toEqual([]);
    expect(verification.drops.modules).toEqual([]);
  });

  it('treats unverifiable claims as drops, with the reason recorded', async () => {
    const runner = greetingsOnlyRunner({
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'greet-walkthrough#step-1': {
                verdict: 'unverifiable',
                reason: 'The anchored code never mentions wrapping semantics.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).toEqual(['shout-reuses-greet', 'greetings-quiz']);
    const claim = result.verification!.claims.find(
      (c) => c.claimId === 'greet-walkthrough#step-1',
    )!;
    expect(claim.verdict).toBe('unverifiable');
    expect(claim.reason).toBe('The anchored code never mentions wrapping semantics.');
    expect(result.verification!.drops.widgets.map((w) => w.widgetId)).toEqual([
      'greet-walkthrough',
    ]);
  });

  it('drops only the failed quiz question while other questions survive', async () => {
    const runner = greetingsOnlyRunner({
      author: { greetings: [JSON.stringify(quizHeavyPayload())] },
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'greetings-quiz#question-q-greet-return': {
                verdict: 'refuted',
                reason: 'greet returns a Greeting object, so the claimed answer is wrong.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    const quiz = greetings.widgets.find((w) => w.id === 'greetings-quiz') as QuizWidget;
    expect(quiz.questions.map((q) => q.id)).toEqual(['q-shout-case']);
    expect(result.verification!.drops.questions).toEqual([
      {
        moduleId: 'greetings',
        widgetId: 'greetings-quiz',
        questionId: 'q-greet-return',
        reason: 'refuted — greet returns a Greeting object, so the claimed answer is wrong.',
      },
    ]);
    // The quiz widget itself survives.
    expect(result.verification!.drops.widgets).toEqual([]);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('drops the whole quiz widget when every question fails', async () => {
    const runner = greetingsOnlyRunner({
      author: { greetings: [JSON.stringify(quizHeavyPayload())] },
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'greetings-quiz#question-q-greet-return': {
                verdict: 'refuted',
                reason: 'Wrong answer.',
              },
              'greetings-quiz#question-q-shout-case': {
                verdict: 'unverifiable',
                reason: 'The anchored code does not show casing.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).toEqual(['shout-upper']);
    expect(result.verification!.drops.questions.map((q) => q.questionId)).toEqual([
      'q-greet-return',
      'q-shout-case',
    ]);
    expect(result.verification!.drops.widgets).toEqual([
      expect.objectContaining({ moduleId: 'greetings', widgetId: 'greetings-quiz' }),
    ]);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('removes a module emptied by drops and records it in the report', async () => {
    const runner = greetingsOnlyRunner({
      author: { greetings: [JSON.stringify(soloCalloutPayload())] },
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'shout-upper#body': {
                verdict: 'refuted',
                reason: 'The fixture disagrees.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    // The emptied module is gone; the spec still parses.
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'repo-overview',
      'first-contribution',
    ]);
    expect(result.verification!.drops.modules).toEqual(['greetings']);
    expect(result.verification!.drops.widgets).toEqual([
      expect.objectContaining({ moduleId: 'greetings', widgetId: 'shout-upper' }),
    ]);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('never touches the human overlay', async () => {
    // The map/author path emits an empty overlay; verification must leave
    // whatever is there untouched even while dropping base content.
    const runner = greetingsOnlyRunner({
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'shout-reuses-greet#body': { verdict: 'refuted', reason: 'Nope.' },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    expect(result.spec.overlay).toEqual([]);
  });
});

describe('verify stage: a deliberately false claim is caught end-to-end', () => {
  it('drops an authored claim that contradicts the fixture code', async () => {
    // The anchor RESOLVES (file, lines, and symbol all check out), so
    // mechanical resolution keeps it — only adversarial verification against
    // the anchored content can catch that the claim is false: greet returns
    // a Greeting object, not a plain string.
    const falseClaim = {
      id: 'false-return-claim',
      type: 'callout',
      kind: 'why',
      body: 'greet returns the greeting as a plain string.',
      anchors: [{ file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 } }],
    };
    const payload = greetingsModulePayload();
    (payload['widgets'] as unknown[]).push(falseClaim);

    const runner = greetingsOnlyRunner({
      author: { greetings: [JSON.stringify(payload)] },
      verify: {
        greetings: [
          (prompt) =>
            verdictsPayload(prompt, {
              'false-return-claim#body': {
                verdict: 'refuted',
                reason:
                  'The anchored lines return `{ message: ... }` — a Greeting object, not a plain string.',
              },
            }),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    // Resolution let it through; verification killed it.
    expect(
      result.resolution.units.find((u) => u.widgetId === 'false-return-claim')?.outcome,
    ).toBe('resolved');
    const greetings = result.spec.base.modules.find((m) => m.id === 'greetings')!;
    expect(greetings.widgets.map((w) => w.id)).not.toContain('false-return-claim');

    const claim = result.verification!.claims.find(
      (c) => c.claimId === 'false-return-claim#body',
    )!;
    expect(claim.verdict).toBe('refuted');
    expect(claim.reason).toContain('Greeting object');
    // The verifier saw the code that contradicts the claim.
    const prompt = runner
      .verifyRequests()
      .find((r) => r.prompt.includes('false-return-claim#body'))!.prompt;
    expect(prompt).toContain('return { message: `Hello, ${name}!` };');
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });
});

describe('verify stage: model routing and concurrency', () => {
  it('routes verify batches to the configured verify model', async () => {
    const runner = greetingsOnlyRunner();

    const result = await generateLab(REPO, {
      runner,
      full: true,
      models: { verify: 'claude-opus-4-8' },
    });

    expect(runner.verifyRequests().length).toBeGreaterThan(0);
    for (const request of runner.verifyRequests()) {
      expect(request.model).toBe('claude-opus-4-8');
    }
    // Other stages keep the default.
    expect(runner.requests.find((r) => r.stage === 'author')!.model).toBe('claude-sonnet-5');
    expect(result.models.verify).toBe('claude-opus-4-8');
  });

  it('runs verify batches in parallel under the shared concurrency cap', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [
        JSON.stringify(planPayload(['greetings', 'orders', 'sessions', 'first-contribution'])),
      ],
      author: AUTHOR_SCRIPTS,
      verifyDelayMs: 20,
    });

    await generateLab(REPO, { runner, full: true, concurrency: 2 });

    // Five modules (overview + four authored), cap of two.
    expect(runner.verifyRequests()).toHaveLength(5);
    expect(runner.maxVerifiersInFlight).toBe(2);
  });

  it('adds verifier cost into the run total', async () => {
    const runner = new ScriptedRunner({
      map: [{ output: JSON.stringify(mapPayload()), costUsd: 0.1 }],
      plan: [
        {
          output: JSON.stringify(planPayload(['greetings', 'first-contribution'])),
          costUsd: 0.2,
        },
      ],
      author: {
        greetings: [{ output: JSON.stringify(greetingsModulePayload()), costUsd: 0.3 }],
        'first-contribution': [
          { output: JSON.stringify(firstContributionModulePayload()), costUsd: 0.1 },
        ],
      },
      verify: {
        'repo-overview': [(prompt) => ({ output: verdictsPayload(prompt), costUsd: 0.05 })],
        greetings: [(prompt) => ({ output: verdictsPayload(prompt), costUsd: 0.07 })],
        // first-contribution falls to the default agreeable verifier (no cost).
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    expect(result.costUsd).toBeCloseTo(0.82);
  });
});

describe('verify stage: bounded retry and failure', () => {
  it('re-prompts a batch whose verdicts do not cover every claim, then succeeds', async () => {
    const runner = greetingsOnlyRunner({
      verify: {
        greetings: [
          // Attempt 1: drops one verdict — invalid coverage.
          (prompt) => {
            const payload = JSON.parse(verdictsPayload(prompt)) as {
              verdicts: unknown[];
            };
            payload.verdicts.pop();
            return JSON.stringify(payload);
          },
          // Attempt 2: full coverage.
          (prompt) => verdictsPayload(prompt),
        ],
      },
    });

    const result = await generateLab(REPO, { runner, full: true });

    expect(result.verifyAttempts).toEqual({
      'repo-overview': 1,
      greetings: 2,
      'first-contribution': 1,
    });
    const retry = runner
      .verifyRequests()
      .find((r) => r.attempt === 2 && r.prompt.includes('Claims from module "greetings"'))!;
    expect(retry.prompt).toContain('previous attempt was rejected');
    expect(retry.prompt).toContain('missing verdict for claim id');
    expect(result.verification!.summary.passRate).toBe(1);
  });

  it('fails the run with an error naming the module when retries are exhausted', async () => {
    const runner = greetingsOnlyRunner({
      verify: {
        greetings: ['not json', 'still not json'],
      },
    });

    const error = await generateLab(REPO, { runner, full: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VerifyStageError);
    const verifyError = error as VerifyStageError;
    expect(verifyError.message).toContain('module "greetings"');
    expect(verifyError.message).toContain('2 attempts');
    expect(verifyError.failures).toEqual([
      expect.objectContaining({ moduleId: 'greetings', attempts: 2 }),
    ]);
    // The healthy batch still ran — failures are reported after the pool settles.
    expect(
      runner.verifyRequests().filter((r) => r.prompt.includes('Claims from module "repo-overview"')),
    ).toHaveLength(1);
  });
});

describe('verify stage: claim id extraction helper sanity', () => {
  it('lists every claim exactly once per batch prompt', async () => {
    const runner = greetingsOnlyRunner();

    await generateLab(REPO, { runner, full: true });

    const greetingsPrompt = runner
      .verifyRequests()
      .find((r) => r.prompt.includes('Claims from module "greetings"'))!.prompt;
    expect(claimIdsIn(greetingsPrompt)).toEqual([
      'greet-walkthrough#step-1',
      'shout-reuses-greet#body',
      'greetings-quiz#question-q-greet-return',
    ]);
  });
});
