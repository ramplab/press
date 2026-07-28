import type { ModelRunner, StageRequest, StageResponse } from './pipeline.js';

/**
 * The live `ModelRunner`: runs a stage as a Claude Agent SDK session over
 * the repository directory with read-only tools.
 *
 * CI never touches this module's runtime path — tests inject fakes at the
 * `ModelRunner` seam — so the SDK import is lazy: `@ramplab/generator` can
 * be loaded (and everything else tested) without the SDK spawning anything.
 *
 * Auth: the SDK spawns the Claude Code CLI, which resolves credentials the
 * way Claude Code itself does — `ANTHROPIC_API_KEY` first, then
 * `CLAUDE_CODE_OAUTH_TOKEN`, then the stored Claude Code login. Both paths
 * generate identical labs; they differ in who pays. See {@link describeAuth},
 * which the live entry points print so a run always says which one it is on.
 */

/** The agent may look, not touch: exploration tools only. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

/** Everything with side effects or network reach is denied outright. */
const DENIED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
];

/**
 * Which credential a live run will spend (founder, 2026-07-25). Populating
 * the library used to mean an API key and a metered bill — around $17-21 a
 * pressing at recent Caddy sizes. The SDK's CLI will just as happily use the
 * Claude Code login, which spends session allowance instead of API credit, so
 * both are allowed and the run says out loud which one it took.
 */
export type AuthMode = 'api-key' | 'claude-code';

export interface AuthDescription {
  mode: AuthMode;
  /** One line for the run banner. */
  label: string;
  /**
   * True when the run bills the Anthropic API account — i.e. when a reported
   * `costUsd` is real money. False on the Claude Code credential, where the
   * SDK's cost figure is a token-priced estimate nobody is invoiced for.
   */
  billedToApiAccount: boolean;
}

/**
 * Report the credential the SDK will resolve, without spending anything. A
 * non-empty `ANTHROPIC_API_KEY` wins because that is the CLI's own precedence;
 * everything else falls through to the Claude Code login (which may still not
 * exist — that surfaces as an SDK auth error on the first stage, not here).
 */
export function describeAuth(env: NodeJS.ProcessEnv = process.env): AuthDescription {
  const apiKey = env['ANTHROPIC_API_KEY'];
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      mode: 'api-key',
      label: 'ANTHROPIC_API_KEY — billed to the Anthropic API account',
      billedToApiAccount: true,
    };
  }
  return {
    mode: 'claude-code',
    label:
      'Claude Code credential (no ANTHROPIC_API_KEY set) — spends session ' +
      'allowance, not API credit; reported costs are estimates, not charges',
    billedToApiAccount: false,
  };
}

export interface AgentSdkRunnerOptions {
  /**
   * Cap on agentic turns per stage call — a cost guard, not a tuning knob.
   *
   * 100 because 50 is not enough to author a chapter against a large
   * repository: the eval harness raised its own default for exactly this
   * reason (`evals/src/cliArgs.ts`), and the product path never got the
   * lesson. Exhausting it is not a slow chapter, it is a dead press —
   * the SDK returns `error_max_turns`, this module throws on it, and no
   * stage catches it (#177).
   * @default 100
   */
  maxTurns?: number;
  /**
   * Abort a stage that has gone completely silent for this long. A working
   * session streams messages continuously; one that stops yielding has
   * stalled on a network read and will never resume on its own.
   * @default 15 minutes
   */
  stallTimeoutMs?: number;
}

/** 15 minutes: far longer than a healthy turn, far shorter than a hang. */
export const DEFAULT_STALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface StallWatchdog {
  /** (Re)start the countdown — call on every sign of life. */
  arm(): void;
  /** Stop the countdown for good. */
  disarm(): void;
  /** True once the countdown expired and `onStall` fired. */
  get stalled(): boolean;
}

/**
 * A dead-man's switch for a streaming session (founder, 2026-07-26).
 *
 * A Caddy eval sat in pass-1 authoring for 5h24m having burned 16 seconds of
 * CPU: the SDK session stopped yielding and `for await` waited forever, with
 * `maxTurns` no help because a turn cap is not a clock. Nothing downstream
 * had a wall-clock guard either, so the whole run hung until it was killed by
 * hand. This watchdog is the missing clock — idle-based rather than total, so
 * a legitimately long stage is never cut off, only a silent one.
 */
export function createStallWatchdog(timeoutMs: number, onStall: () => void): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  return {
    arm(): void {
      if (stalled) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        onStall();
      }, timeoutMs);
      // Never hold the process open on the watchdog's account.
      timer.unref?.();
    },
    disarm(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get stalled(): boolean {
      return stalled;
    },
  };
}

/** Minimal structural view of the SDK's result message. */
interface AgentResultMessage {
  type: string;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
}

/** Turns per stage call. See {@link AgentSdkRunnerOptions.maxTurns} (#177). */
export const DEFAULT_MAX_TURNS = 100;

export function createAgentSdkRunner(options: AgentSdkRunnerOptions = {}): ModelRunner {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  return {
    async runStage(request: StageRequest): Promise<StageResponse> {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      // The CLI's dying words. A bare "exited with code 1" cost a day of
      // guessing (2026-07-13); keep the tail and attach it to any failure.
      let stderrTail = '';
      const withStderr = (message: string): string =>
        stderrTail.length > 0 ? `${message}\nCLI stderr (tail):\n${stderrTail.trim()}` : message;

      const abortController = new AbortController();
      const watchdog = createStallWatchdog(stallTimeoutMs, () => abortController.abort());

      const session = query({
        prompt: request.prompt,
        options: {
          model: request.model,
          cwd: request.repoDir,
          allowedTools: READ_ONLY_TOOLS,
          disallowedTools: DENIED_TOOLS,
          permissionMode: 'bypassPermissions',
          // Zero infra assumptions: never load user/project settings.
          settingSources: [],
          maxTurns,
          abortController,
          stderr: (data: string) => {
            stderrTail = `${stderrTail}${data}`.slice(-2000);
          },
        },
      });

      const stalledError = (): Error =>
        new Error(
          withStderr(
            `Agent SDK session for stage "${request.stage}" produced no output for ` +
              `${Math.round(stallTimeoutMs / 60000)} minute(s) and was aborted. The ` +
              `session had stalled, not slowed: raise stallTimeoutMs only if a healthy ` +
              `stage genuinely goes silent that long.`,
          ),
        );

      let result: AgentResultMessage | undefined;
      try {
        watchdog.arm();
        for await (const message of session) {
          watchdog.arm(); // any message is a sign of life
          const candidate = message as unknown as AgentResultMessage;
          if (candidate.type === 'result') {
            result = candidate;
          }
        }
      } catch (cause) {
        // An abort we caused reads as a generic cancellation; say what it was.
        if (watchdog.stalled) throw stalledError();
        throw new Error(withStderr((cause as Error).message), { cause });
      } finally {
        watchdog.disarm();
      }

      // A stall can also surface as a clean end-of-iteration after the abort.
      if (watchdog.stalled) throw stalledError();
      if (result === undefined) {
        throw new Error(
          withStderr(`Agent SDK session for stage "${request.stage}" ended without a result message.`),
        );
      }
      if (result.is_error === true || result.subtype !== 'success') {
        throw new Error(
          withStderr(
            `Agent SDK session for stage "${request.stage}" failed` +
              `${result.subtype !== undefined ? ` (${result.subtype})` : ''}.`,
          ),
        );
      }

      return {
        output: result.result ?? '',
        ...(result.total_cost_usd !== undefined ? { costUsd: result.total_cost_usd } : {}),
      };
    },
  };
}
