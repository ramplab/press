/**
 * Pipeline plumbing shared by every generation stage (PLAN.md §4).
 *
 * Two concerns live here, both deliberately tiny so later slices (plan,
 * author, verify, assemble) reuse them unchanged:
 *
 * - **Per-stage model configuration.** Reasoning-heavy stages default to
 *   `claude-sonnet-5`; the **map** stage defaults to Haiku (structural
 *   exploration — an A/B measured it 2× faster / 4.4× cheaper with usable
 *   quality; see `evals/results/pass1-timing.md`). Callers override per stage
 *   so validation runs can A/B alternatives (PLAN.md §10).
 * - **The `ModelRunner` boundary.** Stage logic never talks to the Claude
 *   Agent SDK directly — it hands a `StageRequest` to an injected runner and
 *   gets text back. CI tests inject a fake runner; the live path injects
 *   `createAgentSdkRunner()`. This is the seam that keeps model calls out of
 *   CI.
 */

/**
 * The five pipeline stages, in execution order (PLAN.md §4) — which this said
 * it was and was not: assembly runs before verification, and listing them the
 * other way round put a press's remaining work on screen in an order it never
 * happens in.
 */
export const GENERATION_STAGES = ['map', 'plan', 'author', 'assemble', 'verify'] as const;

export type GenerationStageName = (typeof GENERATION_STAGES)[number];

/** Default for reasoning-heavy stages: plan, author, verify, assemble (PLAN.md §10). */
export const DEFAULT_STAGE_MODEL = 'claude-sonnet-5';

/**
 * The map stage's default. Mapping is structural exploration + summarization,
 * not authoring — an A/B on localsend (2026-07-09) measured Haiku 2× faster
 * and 4.4× cheaper here with usable quality, while authoring quality visibly
 * dropped on Haiku (see `evals/results/pass1-timing.md`). The map also streams
 * first, so this is the lever that pulls first-paint toward the 3–5 min target.
 */
export const MAP_STAGE_MODEL = 'claude-haiku-4-5-20251001';

/** Per-stage default models — Haiku for map, Sonnet everywhere else. */
const STAGE_DEFAULT_MODELS: Record<GenerationStageName, string> = {
  map: MAP_STAGE_MODEL,
  plan: DEFAULT_STAGE_MODEL,
  author: DEFAULT_STAGE_MODEL,
  verify: DEFAULT_STAGE_MODEL,
  assemble: DEFAULT_STAGE_MODEL,
};

/** Per-stage model overrides; omitted stages fall back to the stage default. */
export type StageModelConfig = Partial<Record<GenerationStageName, string>>;

/**
 * Expand a (possibly partial) per-stage model map into a complete one: every
 * stage present, defaulting per {@link STAGE_DEFAULT_MODELS} (Haiku map,
 * Sonnet elsewhere), with explicit overrides honored verbatim.
 */
export function resolveStageModels(
  overrides: StageModelConfig = {},
): Record<GenerationStageName, string> {
  const resolved = {} as Record<GenerationStageName, string>;
  for (const stage of GENERATION_STAGES) {
    resolved[stage] = overrides[stage] ?? STAGE_DEFAULT_MODELS[stage];
  }
  return resolved;
}

/** One request across the model boundary: everything a runner needs. */
export interface StageRequest {
  stage: GenerationStageName;
  /** Model id for this stage, already resolved through the config map. */
  model: string;
  /** The repository being analyzed — a plain local directory. */
  repoDir: string;
  /** Full instructions for the agent, including the output contract. */
  prompt: string;
  /** 1-based attempt counter; > 1 means this is a retry after invalid output. */
  attempt: number;
}

/** What comes back across the boundary. */
export interface StageResponse {
  /** The agent's final text output (expected to contain JSON). */
  output: string;
  /** Cost of this call in USD, when the runner can report it. */
  costUsd?: number;
}

/**
 * The injectable agent-invocation boundary. Implementations:
 * - `createAgentSdkRunner()` — the real Claude Agent SDK (live runs),
 * - fakes/recordings in tests (no API calls in CI).
 */
export interface ModelRunner {
  runStage(request: StageRequest): Promise<StageResponse>;
}

/**
 * Run `fn` over `items` with at most `limit` promises in flight: a fixed
 * pool of workers pulls the next index until the list is exhausted, and
 * `Promise.all` joins the pool. Results keep input order. Shared by every
 * fan-out stage (author, verify).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index] as T);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
