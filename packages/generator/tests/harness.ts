import { fileURLToPath } from 'node:url';
import type { ModelRunner, StageRequest, StageResponse } from '../src/index.js';

/**
 * Shared full-pipeline test harness: a scripted ModelRunner (no live API
 * calls) plus the fixture payloads whose anchors all verify against
 * `tests/fixtures/polyglot`. The runner records every request (stage, model,
 * prompt, attempt) and tracks how many author calls are in flight at once,
 * so tests can assert fan-out, concurrency caps, and prompt contents
 * mechanically.
 */

export const REPO = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

/** A scripted reply: literal text/response, or a function of the prompt. */
export type ScriptedResponse =
  | string
  | StageResponse
  | ((prompt: string) => string | StageResponse);

export interface RunnerScript {
  map: ScriptedResponse[];
  plan?: ScriptedResponse[];
  /** Author responses keyed by planned module id (routed via the prompt). */
  author?: Record<string, ScriptedResponse[]>;
  /** Simulated latency per author call, so calls genuinely overlap. */
  authorDelayMs?: number;
  /**
   * Verify responses keyed by module id (routed via the prompt). Modules
   * without an entry auto-verify every claim listed in the prompt.
   */
  verify?: Record<string, ScriptedResponse[]>;
  /** Simulated latency per verify call, so calls genuinely overlap. */
  verifyDelayMs?: number;
}

export class ScriptedRunner implements ModelRunner {
  readonly requests: StageRequest[] = [];
  /** High-water mark of concurrently in-flight author calls. */
  maxAuthorsInFlight = 0;
  /** High-water mark of concurrently in-flight verify calls. */
  maxVerifiersInFlight = 0;
  private authorsInFlight = 0;
  private verifiersInFlight = 0;

  constructor(private readonly script: RunnerScript) {}

  async runStage(request: StageRequest): Promise<StageResponse> {
    this.requests.push(request);

    if (request.stage === 'map') {
      return pick(this.script.map, request, 'map');
    }
    if (request.stage === 'plan') {
      return pick(this.script.plan ?? [], request, 'plan');
    }
    if (request.stage === 'author') {
      this.authorsInFlight += 1;
      this.maxAuthorsInFlight = Math.max(this.maxAuthorsInFlight, this.authorsInFlight);
      try {
        await delay(this.script.authorDelayMs ?? 5);
        const moduleId = /^Module id: ([a-z0-9-]+)$/m.exec(request.prompt)?.[1];
        const responses =
          moduleId !== undefined ? this.script.author?.[moduleId] : undefined;
        if (responses === undefined) {
          throw new Error(`ScriptedRunner: no author script for module "${moduleId}"`);
        }
        return pick(responses, request, `author:${moduleId}`);
      } finally {
        this.authorsInFlight -= 1;
      }
    }
    if (request.stage === 'verify') {
      this.verifiersInFlight += 1;
      this.maxVerifiersInFlight = Math.max(
        this.maxVerifiersInFlight,
        this.verifiersInFlight,
      );
      try {
        await delay(this.script.verifyDelayMs ?? 0);
        const moduleId = /^Claims from module "([a-z0-9-]+)":$/m.exec(request.prompt)?.[1];
        const responses =
          moduleId !== undefined ? this.script.verify?.[moduleId] : undefined;
        if (responses !== undefined) {
          return pick(responses, request, `verify:${moduleId}`);
        }
        // Default: an agreeable verifier — every listed claim is verified.
        return { output: verdictsPayload(request.prompt) };
      } finally {
        this.verifiersInFlight -= 1;
      }
    }
    throw new Error(`ScriptedRunner: unexpected stage "${request.stage}"`);
  }

  authorRequests(): StageRequest[] {
    return this.requests.filter((r) => r.stage === 'author');
  }

  verifyRequests(): StageRequest[] {
    return this.requests.filter((r) => r.stage === 'verify');
  }
}

function pick(
  responses: ScriptedResponse[],
  request: StageRequest,
  label: string,
): StageResponse {
  const entry = responses[Math.min(request.attempt, responses.length) - 1];
  if (entry === undefined) {
    throw new Error(`ScriptedRunner: no scripted response for ${label}`);
  }
  const response = typeof entry === 'function' ? entry(request.prompt) : entry;
  return typeof response === 'string' ? { output: response } : response;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Verify-prompt helpers
// ---------------------------------------------------------------------------

/** The claim ids a verify prompt lists (its `### Claim <id>` markers). */
export function claimIdsIn(prompt: string): string[] {
  return [...prompt.matchAll(/^### Claim (\S+)$/gm)].map((m) => m[1]!);
}

export interface VerdictOverride {
  verdict: 'verified' | 'refuted' | 'unverifiable';
  reason?: string;
}

/**
 * A schema-valid verdict payload covering every claim in the prompt:
 * verified by default, with per-claim overrides for refutations etc.
 */
export function verdictsPayload(
  prompt: string,
  overrides: Record<string, VerdictOverride> = {},
): string {
  return JSON.stringify({
    verdicts: claimIdsIn(prompt).map((claimId) => ({
      claimId,
      verdict: overrides[claimId]?.verdict ?? 'verified',
      reason:
        overrides[claimId]?.reason ?? 'The anchored code substantiates the claim.',
    })),
  });
}

// ---------------------------------------------------------------------------
// Scripted payloads (all anchors verify against tests/fixtures/polyglot)
// ---------------------------------------------------------------------------

export function mapPayload(): Record<string, unknown> {
  return {
    title: 'Polyglot Onboarding Lab',
    moduleTitle: 'Repo tour',
    moduleSummary: 'Nine tiny services, one per language.',
    systemMap: {
      id: 'system-map',
      type: 'system-map',
      title: 'How the pieces fit',
      nodes: [
        {
          id: 'greeter',
          label: 'Greeter',
          description: 'TypeScript greeting service.',
          anchors: [{ file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 } }],
        },
        {
          id: 'orders',
          label: 'Orders',
          description: 'Ruby order aggregate.',
          anchors: [{ file: 'lib/order.rb', symbol: 'total_cents' }],
        },
        { id: 'sessions', label: 'Sessions' },
      ],
      edges: [{ from: 'greeter', to: 'orders' }],
    },
    callouts: [
      {
        id: 'why-polyglot',
        type: 'callout',
        kind: 'why',
        body: 'Each service demonstrates anchor resolution in a different language.',
        anchors: [{ file: 'app/models.py', symbol: 'find_user' }],
      },
    ],
  };
}

/**
 * A plan payload in the issue-#18 shape: every module carries its ledger
 * (`assumes`/`teaches`), and callers end the list with `first-contribution`
 * (the mandated landing module) to satisfy the parse gate.
 */
/**
 * Trace candidates in the map payload's shape (issue #18): the first is the
 * most representative (the map prompt's ordering contract), keyed to files
 * that exist in the polyglot fixture.
 */
export function traceCandidatesPayload(): unknown[] {
  return [
    {
      id: 'greeting-flow',
      action: 'a greeting request is served',
      description: 'From the entry point to the greeting string.',
      keyFiles: ['src/greeter.ts'],
    },
    {
      id: 'order-total',
      action: 'an order total is computed',
      keyFiles: ['lib/order.rb'],
    },
  ];
}

/** `mapPayload()` plus trace candidates — the post-#18 map output shape. */
export function mapPayloadWithTraces(): Record<string, unknown> {
  return { ...mapPayload(), traceCandidates: traceCandidatesPayload() };
}

export function planPayload(moduleIds: string[]): Record<string, unknown> {
  const byId: Record<string, Record<string, unknown>> = {
    'greeting-flow': {
      id: 'greeting-flow',
      title: 'End to end: a greeting request is served',
      focus: 'Follow one greeting request end to end through the code.',
      keyFiles: ['src/greeter.ts'],
      assumes: [],
      teaches: ['how a greeting flows end to end through this codebase'],
    },
    greetings: {
      id: 'greetings',
      title: 'The greeting path',
      focus: 'How a greeting is built and shouted. Central: every request flows through it.',
      keyFiles: ['src/greeter.ts'],
      assumes: [],
      teaches: ['how a greeting is built', 'why shout wraps greet'],
    },
    orders: {
      id: 'orders',
      title: 'Order totals',
      focus: 'How order totals are computed from line items.',
      keyFiles: ['lib/order.rb'],
      assumes: ['how a greeting is built'],
      teaches: ['how order totals are summed in integer cents'],
    },
    sessions: {
      id: 'sessions',
      title: 'Session lifecycle',
      focus: 'How sessions are created and expire.',
      keyFiles: ['app/Session.kt'],
      assumes: ['how order totals are summed in integer cents'],
      teaches: ['how sessions expire lazily'],
    },
    invoices: {
      id: 'invoices',
      title: 'Invoice math',
      focus: 'How invoices apply tax.',
      keyFiles: ['Services/Invoice.cs'],
      assumes: ['how order totals are summed in integer cents'],
      teaches: ['how invoices apply tax'],
    },
    'first-contribution': {
      id: 'first-contribution',
      title: 'Your first contribution',
      focus: 'Where starter work lives, the test conventions, and how a change lands.',
      keyFiles: ['src/greeter.ts'],
      assumes: ['how a greeting is built'],
      teaches: ['where to make a first change and how to check it'],
    },
  };
  return {
    modules: moduleIds.map((id) => {
      const module = byId[id];
      if (module === undefined) throw new Error(`no plan template for "${id}"`);
      return module;
    }),
  };
}

export function greetingsModulePayload(): Record<string, unknown> {
  return {
    summary: 'Where greetings come from.',
    widgets: [
      {
        id: 'greet-walkthrough',
        type: 'code-walkthrough',
        title: 'greet, step by step',
        code: [
          'export function greet(name: string): Greeting {',
          '  return { message: `Hello, ${name}!` };',
          '}',
        ],
        source: { file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 } },
        steps: [
          {
            lines: { start: 1, end: 3 },
            commentary: {
              body: 'greet wraps the name in a Greeting object.',
              anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
            },
          },
        ],
      },
      {
        id: 'shout-reuses-greet',
        type: 'callout',
        kind: 'connects-to',
        body: 'shout is a thin wrapper over greet — one source of truth for the message.',
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
        ],
      },
    ],
  };
}

export function ordersModulePayload(): Record<string, unknown> {
  return {
    summary: 'How totals are computed.',
    widgets: [
      {
        id: 'total-cents-figure',
        type: 'code-figure',
        code: ['  def total_cents', '    items.sum { |item| item[:price_cents] }', '  end'],
        source: { file: 'lib/order.rb', symbol: 'total_cents', lines: { start: 8, end: 10 } },
        caption: {
          body: 'Totals are integer cents summed over line items — no floats.',
          anchors: [{ file: 'lib/order.rb', symbol: 'total_cents' }],
        },
        highlight: { start: 2, end: 2 },
      },
      {
        id: 'orders-quiz',
        type: 'quiz',
        questions: [
          {
            id: 'q-total-unit',
            prompt: 'What unit does total_cents use?',
            options: [
              { id: 'opt-dollars', label: 'Floating-point dollars' },
              { id: 'opt-cents', label: 'Integer cents' },
            ],
            correctOptionId: 'opt-cents',
            explanation: {
              body: 'The sum is over item[:price_cents].',
              anchors: [{ file: 'lib/order.rb', symbol: 'price_cents' }],
            },
          },
        ],
      },
    ],
  };
}

export function sessionsModulePayload(): Record<string, unknown> {
  return {
    summary: 'Sessions expire by elapsed time.',
    widgets: [
      {
        id: 'session-lifecycle',
        type: 'state-machine',
        title: 'Session lifecycle',
        states: [
          {
            id: 'active',
            label: 'Active',
            description: {
              body: 'A new session starts with a one-hour TTL.',
              anchors: [{ file: 'app/Session.kt', symbol: 'newSession' }],
            },
          },
          { id: 'expired', label: 'Expired' },
        ],
        transitions: [
          {
            from: 'active',
            to: 'expired',
            trigger: 'ttl elapsed',
            commentary: {
              body: 'Expiry is a pure comparison of elapsed seconds against the TTL.',
              anchors: [{ file: 'app/Session.kt', symbol: 'isExpired' }],
            },
          },
        ],
      },
      {
        id: 'sessions-quiz',
        type: 'quiz',
        questions: [
          {
            id: 'q-expiry-check',
            prompt: 'How is expiry determined?',
            options: [
              { id: 'opt-timer', label: 'A background timer deletes sessions' },
              { id: 'opt-lazy', label: 'A pure check compares elapsed time to the TTL' },
            ],
            correctOptionId: 'opt-lazy',
            explanation: {
              body: 'isExpired compares elapsedSeconds >= ttlSeconds.',
              anchors: [{ file: 'app/Session.kt', symbol: 'isExpired' }],
            },
          },
        ],
      },
    ],
  };
}

/** The flagship trace module (module ids match traceCandidatesPayload()). */
export function greetingFlowModulePayload(): Record<string, unknown> {
  return {
    summary: 'One greeting request, followed end to end.',
    widgets: [
      {
        id: 'flow-entry',
        type: 'callout',
        kind: 'why',
        body: 'The request enters at greet — everything downstream is built from its return value.',
        anchors: [{ file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 } }],
      },
      {
        id: 'flow-quiz',
        type: 'quiz',
        questions: [
          {
            id: 'q-flow-entry',
            prompt: 'Where does a greeting request enter?',
            options: [
              { id: 'opt-shout', label: 'shout' },
              { id: 'opt-greet', label: 'greet' },
            ],
            correctOptionId: 'opt-greet',
            explanation: {
              body: 'greet builds the Greeting; shout only wraps it.',
              anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
            },
          },
        ],
      },
    ],
  };
}

/** The mandated landing module: "your first contribution". */
export function firstContributionModulePayload(): Record<string, unknown> {
  return {
    summary: 'Where a first change lands and how to check it.',
    widgets: [
      {
        id: 'starter-area',
        type: 'callout',
        kind: 'connects-to',
        body: 'The greeter is the friendliest starter area: small, typed, and covered by direct call sites.',
        anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
      },
      {
        id: 'contribution-quiz',
        type: 'quiz',
        questions: [
          {
            id: 'q-starter',
            prompt: 'Which service is the suggested starter area?',
            options: [
              { id: 'opt-orders', label: 'Orders' },
              { id: 'opt-greeter', label: 'Greeter' },
            ],
            correctOptionId: 'opt-greeter',
            explanation: {
              body: 'The greeter is small and self-contained.',
              anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
            },
          },
        ],
      },
    ],
  };
}

export const AUTHOR_SCRIPTS: Record<string, ScriptedResponse[]> = {
  'greeting-flow': [JSON.stringify(greetingFlowModulePayload())],
  greetings: [JSON.stringify(greetingsModulePayload())],
  orders: [JSON.stringify(ordersModulePayload())],
  sessions: [JSON.stringify(sessionsModulePayload())],
  'first-contribution': [JSON.stringify(firstContributionModulePayload())],
};
