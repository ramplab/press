import type { LabSpec } from '@ramplab/spec';
import { createAgentSdkRunner } from './agentSdkRunner.js';
import { assembleLab } from './assembleStage.js';
import { runAuthorStage, type AuthoredModule } from './authorStage.js';
import type { ProseDrop } from './dropUnanchoredProse.js';
import { selectFlagshipModule, type FlagshipSelection } from './flagship.js';
import { assertDirectory, sumCosts, type GenerateLabConfig } from './generateLab.js';
import { runMapStage, type MapStageResult } from './mapStage.js';
import { resolveStageModels, type GenerationStageName } from './pipeline.js';
import type { GenerationProgressEvent } from './progress.js';
import { resolveAnchors, type ResolutionReport } from './resolveAnchors.js';

/**
 * `generateLabPass1(repoDir, config)` — pass 1 of the two-pass runtime
 * (PLAN.md §4): the ~3–5 minute streamed preview, the self-serve "whoa"
 * moment. Map the repo, pick ONE flagship module — the most representative
 * front-door trace action the map proposed, authored as "follow this action
 * end to end through the code"; intake hints can override, and subsystem
 * centrality remains the fallback when the map yields no usable candidates
 * (see `flagship.ts`) — author only that module, and assemble a small valid
 * lab spec: the system-map overview module plus the flagship module.
 *
 * **A separate entry point, not another `generateLab` flag — deliberately.**
 * `generateLab` already multiplexes tracer/full on one result type via
 * optional fields; a third mode would make every field's presence contingent
 * on flag combinations. Pass 1 has its own result shape (flagship selection,
 * timing, a `mapResult` to hand to pass 2) and its own verification
 * semantics, so it gets its own function with non-optional fields. Both
 * entry points share `GenerateLabConfig` (minus the pass-2-only knobs) and
 * all stage plumbing.
 *
 * **Lightly verified (the plan's words):** validation + anchor resolution
 * only — every claim in the preview provably points at real code (unresolved
 * units are dropped/flagged per policy), but the adversarial verifier agent
 * does NOT run. That is pass 2's job; spending verifier calls here would
 * blow the 3–5 minute target for content pass 2 re-authors anyway.
 *
 * **Streaming:** progress surfaces through `config.onProgress` (see
 * `progress.ts`) tagged `pass: 'pass1'` — the callback IS the streaming
 * seam; no network transport in this slice. `spec-updated` fires first with
 * the overview-only spec (renderable the moment the map lands) and again
 * with the final two-module spec.
 *
 * **Timing:** measured with `config.clock` (injected in tests; defaults to
 * `Date.now` on the live path) and reported as `timing` in the result.
 */

export type GenerateLabPass1Config = Omit<
  GenerateLabConfig,
  'full' | 'budget' | 'concurrency' | 'mapResult'
>;

/** One stage's share of a pass's wall clock (and spend, when reported). */
export interface StageTiming {
  stage: 'map' | 'author' | 'assemble';
  durationMs: number;
  costUsd?: number;
}

export interface Pass1Timing {
  /** `clock()` at entry. */
  startedAtMs: number;
  /** Total wall-clock duration of pass 1 in milliseconds. */
  durationMs: number;
  /**
   * Per-stage split (#31): committed telemetry used to record only the total,
   * so a 40-minute run couldn't say whether the map or the author ate it —
   * the A/B in `evals/results/pass1-timing.md` had to be hand-timed. Now every
   * run is attributable.
   */
  stages: StageTiming[];
}

export interface GenerateLabPass1Result {
  /** The validated, anchor-resolved preview spec: overview + flagship. */
  spec: LabSpec;
  /** Anchor-resolution report over the assembled preview spec. */
  resolution: ResolutionReport;
  /** The fully-resolved per-stage model map used for this run. */
  models: Record<GenerationStageName, string>;
  /** Total model cost in USD (map + flagship authoring), when reported. */
  costUsd: number | undefined;
  /** Map-stage attempts (1 = first output was already valid). */
  attempts: number;
  /** Which system-map node became the flagship module, and why. */
  flagship: FlagshipSelection;
  /** Authoring attempts for the flagship module. */
  authorAttempts: Record<string, number>;
  /** Wall-clock timing of the whole pass (PLAN.md's 3–5 minute target). */
  timing: Pass1Timing;
  /**
   * The raw map-stage output. Hand it to pass 2 as `config.mapResult` so the
   * full pipeline skips its map stage instead of re-mapping the repo.
   */
  mapResult: MapStageResult;
  /**
   * Prose the models wrote without grounding it, removed before validation
   * rather than costing the pass (see `dropUnanchoredProse.ts`).
   */
  proseDrops: ProseDrop[];
}

export async function generateLabPass1(
  repoDir: string,
  config: GenerateLabPass1Config = {},
): Promise<GenerateLabPass1Result> {
  assertDirectory(repoDir);

  const clock = config.clock ?? Date.now;
  const startedAtMs = clock();
  const models = resolveStageModels(config.models);
  const runner = config.runner ?? createAgentSdkRunner();
  const policy = config.resolutionPolicy ?? 'drop';
  const emit = (event: GenerationProgressEvent): void => config.onProgress?.(event);

  const stages: StageTiming[] = [];

  emit({ type: 'stage-started', pass: 'pass1', stage: 'map' });
  const mapStartedMs = clock();
  const mapResult = await runMapStage(runner, repoDir, {
    model: models.map,
    ...(config.labId !== undefined ? { labId: config.labId } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
  });
  stages.push({
    stage: 'map',
    durationMs: clock() - mapStartedMs,
    ...(mapResult.costUsd !== undefined ? { costUsd: mapResult.costUsd } : {}),
  });
  emit({ type: 'stage-completed', pass: 'pass1', stage: 'map' });

  // The map alone is already renderable: stream it out before authoring.
  emit({
    type: 'spec-updated',
    pass: 'pass1',
    spec: resolveAnchors(mapResult.spec, repoDir, { policy }).spec,
  });

  // Flagship choice is mechanical (trace candidates first, intake override
  // respected, centrality fallback) — no model call, so it costs nothing and
  // cannot hallucinate. See flagship.ts.
  const flagship = selectFlagshipModule(
    mapResult.spec,
    config.intake,
    mapResult.traceCandidates,
  );

  emit({ type: 'stage-started', pass: 'pass1', stage: 'author' });
  const authorStartedMs = clock();
  const authorResult = await runAuthorStage(runner, repoDir, {
    model: models.author,
    plan: { modules: [flagship.plannedModule] },
    concurrency: 1,
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    onModuleAuthored: (authored: AuthoredModule) =>
      emit({
        type: 'module-authored',
        pass: 'pass1',
        moduleId: authored.module.id,
        attempts: authored.attempts,
      }),
  });
  stages.push({
    stage: 'author',
    durationMs: clock() - authorStartedMs,
    ...(authorResult.costUsd !== undefined ? { costUsd: authorResult.costUsd } : {}),
  });
  emit({ type: 'stage-completed', pass: 'pass1', stage: 'author' });

  // "Lightly verified": assembly revalidates the merged spec and resolves
  // every anchor; the adversarial verifier agent is pass 2's job.
  emit({ type: 'stage-started', pass: 'pass1', stage: 'assemble' });
  const assembleStartedMs = clock();
  const { spec, report } = assembleLab(
    mapResult.spec,
    authorResult.modules.map((m) => m.module),
    repoDir,
    { policy, leadModuleId: flagship.plannedModule.id },
  );
  stages.push({ stage: 'assemble', durationMs: clock() - assembleStartedMs });
  emit({ type: 'stage-completed', pass: 'pass1', stage: 'assemble' });
  emit({ type: 'spec-updated', pass: 'pass1', spec });

  return {
    spec,
    resolution: report,
    models,
    costUsd: sumCosts(mapResult.costUsd, authorResult.costUsd),
    attempts: mapResult.attempts,
    flagship,
    authorAttempts: Object.fromEntries(
      authorResult.modules.map((m) => [m.module.id, m.attempts]),
    ),
    timing: { startedAtMs, durationMs: clock() - startedAtMs, stages },
    mapResult,
    proseDrops: [...(mapResult.proseDrops ?? []), ...authorResult.proseDrops],
  };
}
