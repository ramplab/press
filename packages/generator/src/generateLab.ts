import { statSync } from 'node:fs';
import type { LabSpec } from '@ramplab/spec';
import { createAgentSdkRunner } from './agentSdkRunner.js';
import { assembleLab } from './assembleStage.js';
import { DEEP_WIDGET_RANGE, runAuthorStage, type AuthoredModule } from './authorStage.js';
import type { ProseDrop } from './dropUnanchoredProse.js';
import { selectTraceFlagship } from './flagship.js';
import type { LeadIntake } from './intake.js';
import { runMapStage, type MapStageResult } from './mapStage.js';
import {
  resolveStageModels,
  type GenerationStageName,
  type ModelRunner,
  type StageModelConfig,
} from './pipeline.js';
import {
  runPlanStage,
  type CurriculumBudget,
  type CurriculumPlan,
  type PlannedModule,
} from './planStage.js';
import { measureRepo, plannedModulesFor } from './repoSize.js';
import type { ProgressCallback } from './progress.js';
import {
  resolveAnchors,
  type ResolutionPolicy,
  type ResolutionReport,
} from './resolveAnchors.js';
import { runVerifyStage, type VerificationReport } from './verifyStage.js';

/**
 * `generateLab(repoDir, config)` — the generator entry point (PLAN.md §4).
 *
 * Two modes on the same config/runner plumbing:
 *
 * - **Tracer (default, `full` unset/false):** the map stage only — agent
 *   explores the repo (read-only), emits a system-map widget plus one module
 *   of anchored callouts. Predates the two-pass runtime; for the streamed
 *   pass-1 preview (map + flagship module) use `generateLabPass1` in
 *   `pass1.ts`. The tracer emits no progress events.
 * - **Full pipeline (`full: true`) — pass 2 of the two-pass runtime:**
 *   map → curriculum plan → author (parallel per planned module,
 *   concurrency-capped) → assemble → verify. The plan stage plans a
 *   dependency-ordered journey (issue #18) within `config.budget` (a config
 *   cap, never repo size), steered by the lead's `config.intake` answers
 *   when present: module 1 is pinned to the flagship trace when the map
 *   proposed candidates, every module carries an `assumes`/`teaches`
 *   learner-state ledger, and the final module is always "your first
 *   contribution". Each planned module is authored by its own agent call
 *   (with its ledger slice and the style contract in the prompt); assembly
 *   merges everything into one spec, revalidates, and runs anchor resolution
 *   per policy; the verify stage then adversarially checks every surviving
 *   claim against its anchored code and drops what it cannot verify
 *   (PLAN.md §3).
 *
 * **Map reuse (`config.mapResult`):** pass 2 normally runs right after pass 1
 * on the same repo snapshot, so callers hand pass 1's `mapResult` in and the
 * map stage is skipped entirely — no second map agent call. The reused map's
 * cost is NOT re-counted in this run's `costUsd` (it was paid in pass 1).
 * The pass-1 **flagship module is deliberately re-authored, not reused**:
 * the plan stage owns pass 2's curriculum (ids, ordering, briefs), and
 * splicing a module authored against pass 1's ad-hoc brief into it would
 * make the draft's shape depend on which pass wrote which module. Pass 1 is
 * a preview; pass 2 is the canonical draft.
 *
 * **Progress (`config.onProgress`):** full-pipeline runs emit typed events
 * (see `progress.ts`) tagged `pass: 'pass2'` — stage boundaries,
 * per-module authoring, and `spec-updated` snapshots that are always valid
 * and anchor-resolved, so a caller can render each one as it lands.
 *
 * Zero infra assumptions: the input is a plain local directory. No cloning,
 * no network beyond the model API (and none at all with an injected fake
 * runner).
 */

export interface GenerateLabConfig {
  /**
   * Run the full pipeline (map → plan → author → assemble → verify) instead
   * of the map-only tracer.
   * @default false
   */
  full?: boolean;
  /**
   * Per-stage model map. Every stage defaults to `claude-sonnet-5`;
   * overrides are honored per stage (PLAN.md §10).
   */
  models?: StageModelConfig;
  /**
   * Curriculum budget for the plan stage (full pipeline only): max module
   * count and scope hints. Caps lab scope by config, not repo size.
   */
  budget?: CurriculumBudget;
  /**
   * The lead's 2-minute intake (PLAN.md §4 curation loop). Threaded into the
   * curriculum-plan prompt so the answers steer module selection/ordering,
   * and into pass 1's flagship choice (see `flagship.ts`).
   */
  intake?: LeadIntake;
  /**
   * Progress-event callback — the streaming seam (see `progress.ts`).
   * Full-pipeline runs emit `pass: 'pass2'` events; the tracer emits none.
   */
  onProgress?: ProgressCallback;
  /**
   * A previous map-stage result (typically pass 1's `result.mapResult`).
   * When present, the map stage is skipped and this output is used verbatim;
   * its cost is not re-counted. Full pipeline only.
   */
  mapResult?: MapStageResult;
  /**
   * Millisecond clock for timing measurements, injectable for tests.
   * Only the live path should rely on the `Date.now` default.
   * @default Date.now
   */
  clock?: () => number;
  /**
   * Max authoring agents in flight at once (full pipeline only).
   * @default 4
   */
  concurrency?: number;
  /**
   * What to do with teachable units whose anchors fail to resolve:
   * `drop` (default) removes them; `flag` keeps them and only reports.
   */
  resolutionPolicy?: ResolutionPolicy;
  /**
   * The agent-invocation boundary. Defaults to the real Claude Agent SDK
   * runner; tests inject a fake so CI never makes live API calls.
   */
  runner?: ModelRunner;
  /**
   * Bounded retries per stage (and per authored module) when the model's
   * output is schema-invalid.
   * @default 1
   */
  maxRetries?: number;
  /** Lab id override; defaults to a slug of the repo directory name. */
  labId?: string;
  /**
   * Turns per stage call, when this builds its own runner. Threaded rather
   * than left to callers constructing a runner themselves: on the CLI's live
   * path that would suppress the credential banner, which keys off whether a
   * runner was supplied (#177).
   */
  maxTurns?: number;
}

export interface GenerateLabResult {
  /** The validated, anchor-resolved lab spec. */
  spec: LabSpec;
  /** Full anchor-resolution report (what resolved, dropped, or flagged). */
  resolution: ResolutionReport;
  /** The fully-resolved per-stage model map used for this run. */
  models: Record<GenerationStageName, string>;
  /** Total model cost in USD across all stages, when the runner reports cost. */
  costUsd: number | undefined;
  /** Map-stage attempts (1 = first output was already valid). */
  attempts: number;
  /** The curriculum plan, present only on full-pipeline runs. */
  plan?: CurriculumPlan;
  /** Per-module authoring attempts, present only on full-pipeline runs. */
  authorAttempts?: Record<string, number>;
  /**
   * Adversarial verification report (per-claim verdicts, pass rate, drops),
   * present only on full-pipeline runs.
   */
  verification?: VerificationReport;
  /** Per-module verifier attempts, present only on full-pipeline runs. */
  verifyAttempts?: Record<string, number>;
  /**
   * Prose the models wrote without grounding it, removed before validation
   * rather than costing the run (see `dropUnanchoredProse.ts`). Empty on a
   * run where every claim was anchored, which is the common case.
   */
  proseDrops: ProseDrop[];
}

export async function generateLab(
  repoDir: string,
  config: GenerateLabConfig = {},
): Promise<GenerateLabResult> {
  assertDirectory(repoDir);

  const models = resolveStageModels(config.models);
  const runner =
    config.runner ??
    createAgentSdkRunner(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {});
  const policy = config.resolutionPolicy ?? 'drop';
  // The tracer predates the two-pass runtime and emits no events; only the
  // full pipeline is "pass 2".
  const emit = config.full === true ? config.onProgress : undefined;

  const mapReused = config.mapResult !== undefined;
  let mapResult: MapStageResult;
  if (config.mapResult !== undefined) {
    mapResult = config.mapResult;
  } else {
    emit?.({ type: 'stage-started', pass: 'pass2', stage: 'map' });
    mapResult = await runMapStage(runner, repoDir, {
      model: models.map,
      ...(config.labId !== undefined ? { labId: config.labId } : {}),
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    });
    emit?.({ type: 'stage-completed', pass: 'pass2', stage: 'map' });
  }

  if (config.full !== true) {
    const { spec, report } = resolveAnchors(mapResult.spec, repoDir, { policy });
    return {
      spec,
      resolution: report,
      models,
      costUsd: mapResult.costUsd,
      attempts: mapResult.attempts,
      proseDrops: mapResult.proseDrops ?? [],
    };
  }

  // First renderable snapshot: the overview module alone, anchor-resolved.
  emit?.({
    type: 'spec-updated',
    pass: 'pass2',
    spec: resolveAnchors(mapResult.spec, repoDir, { policy }).spec,
  });

  // The same mechanical trace selection pass 1 makes (see flagship.ts): the
  // plan's module 1 is pinned to it, so pass 2's re-authoring of the trace
  // stays canonical. Undefined when the map proposed no usable candidates
  // (including old-shape reused map results) — the planner then picks its
  // own front-door action.
  const traceFlagship = selectTraceFlagship(mapResult.traceCandidates, config.intake);

  // Right-size the plan to the repository unless the caller pinned a cap:
  // a budget reads as a quota to the planner, so the cap must carry the
  // size signal itself (5 to 8 chapters once the overview joins).
  const budget: CurriculumBudget =
    config.budget?.maxModules !== undefined
      ? config.budget
      : { ...config.budget, maxModules: plannedModulesFor(measureRepo(repoDir)) };

  emit?.({ type: 'stage-started', pass: 'pass2', stage: 'plan' });
  const planResult = await runPlanStage(runner, repoDir, {
    model: models.plan,
    mapSpec: mapResult.spec,
    ...(traceFlagship !== undefined ? { traceModule: traceFlagship.plannedModule } : {}),
    budget,
    ...(config.intake !== undefined ? { intake: config.intake } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
  });
  emit?.({ type: 'stage-completed', pass: 'pass2', stage: 'plan' });
  // What the rest of the run is now committed to. Authoring is the longest
  // stretch of a pressing and the only stage with a countable total, so this
  // is what lets a display measure it rather than guess at it (#164).
  emit?.({
    type: 'plan-ready',
    pass: 'pass2',
    modules: planResult.plan.modules.map((module) => ({ id: module.id, title: module.title })),
  });

  emit?.({ type: 'stage-started', pass: 'pass2', stage: 'author' });
  // Live preview between the pass-boundary snapshots: after each authored
  // module, assemble what exists so far and emit it. Authoring is the longest
  // stretch of a pressing (15 of localsend's 31 minutes) and used to render
  // nothing at all. Best-effort by design: a partial set that cannot
  // assemble validly skips its snapshot, never the pressing.
  const authoredSoFar: AuthoredModule[] = [];
  const planOrder = new Map(planResult.plan.modules.map((m, i) => [m.id, i]));
  // Bigger repos earn deeper chapters, not only more of them.
  const widgetRange =
    budget.maxModules !== undefined && budget.maxModules >= 7 ? DEEP_WIDGET_RANGE : undefined;
  const authorResult = await runAuthorStage(runner, repoDir, {
    model: models.author,
    plan: planResult.plan,
    ...(widgetRange !== undefined ? { widgetRange } : {}),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(emit !== undefined
      ? {
          onModuleAuthored: (authored: AuthoredModule) => {
            emit({
              type: 'module-authored',
              pass: 'pass2',
              moduleId: authored.module.id,
              attempts: authored.attempts,
            });
            authoredSoFar.push(authored);
            try {
              const partial = assembleLab(
                mapResult.spec,
                [...authoredSoFar]
                  .sort(
                    (a, b) =>
                      (planOrder.get(a.module.id) ?? Number.MAX_SAFE_INTEGER) -
                      (planOrder.get(b.module.id) ?? Number.MAX_SAFE_INTEGER),
                  )
                  .map((m) => m.module),
                repoDir,
                { policy, leadModuleId: planResult.plan.modules[0]?.id },
              );
              emit({ type: 'spec-updated', pass: 'pass2', spec: partial.spec });
            } catch {
              // an unassemblable partial set waits for the next module
            }
          },
        }
      : {}),
  });
  // The zoom-out chapter, re-authored (founder, 2026-07-26). The map stage
  // assembles `repo-overview` mechanically — a system map plus callouts —
  // before the flagship trace even exists, so it is the one chapter with no
  // learner ledger, no capability callout and no quiz. Sitting at position 2,
  // immediately after the trace, that broke the chain: the pedagogy judge
  // docked BOTH of the criteria that have never scored 5, naming this module
  // each time ("a generic, non-referential architecture overview that
  // restates concepts at the same abstract altitude"; "Module 2 has no such
  // statement, breaking the pattern"). Re-authoring it through the same stage
  // as every other chapter gives it the ledger, the contracts, and the close.
  const overviewSpec = await reauthorOverview(runner, repoDir, {
    mapSpec: mapResult.spec,
    plan: planResult.plan,
    model: models.author,
    ...(widgetRange !== undefined ? { widgetRange } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    ...(emit !== undefined
      ? {
          onAuthored: (authored: AuthoredModule) =>
            emit({
              type: 'module-authored',
              pass: 'pass2',
              moduleId: authored.module.id,
              attempts: authored.attempts,
            }),
        }
      : {}),
  });
  // Authoring closes AFTER the zoom-out, because the zoom-out is authoring.
  // Reported complete before it, the display had no active stage for the
  // minutes it takes: `✓ authored` on top, every later stage still pending,
  // no spinner and no clock. A press that was working looked exactly like one
  // that had died, which is the single thing this output exists to answer.
  emit?.({ type: 'stage-completed', pass: 'pass2', stage: 'author' });

  emit?.({ type: 'stage-started', pass: 'pass2', stage: 'assemble' });
  // The plan's head is the opening trace by the plan-stage contract, so it
  // leads the assembled lab; the overview follows as the zoom-out.
  const { spec, report } = assembleLab(
    overviewSpec.spec,
    authorResult.modules.map((m) => m.module),
    repoDir,
    { policy, leadModuleId: planResult.plan.modules[0]?.id },
  );
  emit?.({ type: 'stage-completed', pass: 'pass2', stage: 'assemble' });
  emit?.({ type: 'spec-updated', pass: 'pass2', spec });

  // Adversarial verification: every claim that survived anchor resolution is
  // checked against its anchored code; unverified claims are dropped. Units
  // the `flag` policy deliberately kept for human review are skipped.
  emit?.({ type: 'stage-started', pass: 'pass2', stage: 'verify' });
  const verifyResult = await runVerifyStage(runner, repoDir, {
    model: models.verify,
    spec,
    flaggedUnits: report.units
      .filter((unit) => unit.outcome === 'flagged')
      .map((unit) => ({ moduleId: unit.moduleId, widgetId: unit.widgetId })),
    ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
    ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
  });
  emit?.({ type: 'stage-completed', pass: 'pass2', stage: 'verify' });
  emit?.({ type: 'spec-updated', pass: 'pass2', spec: verifyResult.spec });

  return {
    spec: verifyResult.spec,
    resolution: report,
    models,
    costUsd: sumCosts(
      // A reused map's cost was paid (and reported) by the pass that ran it.
      mapReused ? undefined : mapResult.costUsd,
      planResult.costUsd,
      authorResult.costUsd,
      overviewSpec.costUsd,
      verifyResult.costUsd,
    ),
    attempts: mapResult.attempts,
    plan: planResult.plan,
    authorAttempts: Object.fromEntries([
      ...authorResult.modules.map((m) => [m.module.id, m.attempts] as const),
      ...(overviewSpec.attempts !== undefined
        ? [[OVERVIEW_MODULE_ID, overviewSpec.attempts] as const]
        : []),
    ]),
    verification: verifyResult.report,
    verifyAttempts: verifyResult.attempts,
    proseDrops: [
      ...(mapResult.proseDrops ?? []),
      ...authorResult.proseDrops,
      ...overviewSpec.proseDrops,
    ],
  };
}

/** The map stage's zoom-out chapter — a stable id learner progress keys off. */
export const OVERVIEW_MODULE_ID = 'repo-overview';

interface ReauthorOverviewOptions {
  mapSpec: LabSpec;
  plan: CurriculumPlan;
  model: string;
  widgetRange?: { min: number; max: number };
  maxRetries?: number;
  onAuthored?: (authored: AuthoredModule) => void;
}

interface ReauthoredOverview {
  /** The map spec with its overview chapter replaced, or the original. */
  spec: LabSpec;
  costUsd: number | undefined;
  attempts: number | undefined;
  proseDrops: ProseDrop[];
}

/**
 * Build the planned-module brief for the zoom-out chapter: what the reader
 * already walked (the flagship trace's `teaches`), and what this chapter owes
 * them. Exported for tests — the brief IS the fix, so it is worth pinning.
 */
export function plannedOverviewModule(
  mapSpec: LabSpec,
  plan: CurriculumPlan,
): PlannedModule | undefined {
  const overview = mapSpec.base.modules.find((m) => m.id === OVERVIEW_MODULE_ID);
  const trace = plan.modules[0];
  if (overview === undefined || trace === undefined) return undefined;

  // Teach from what the map already found worth mapping: the files its system
  // map anchors. No second exploration budget needed to know where to look.
  const keyFiles = new Set<string>();
  for (const widget of overview.widgets) {
    if (widget.type !== 'system-map') continue;
    for (const node of widget.nodes) {
      for (const anchor of node.anchors ?? []) keyFiles.add(anchor.file);
    }
  }

  return {
    id: OVERVIEW_MODULE_ID,
    title: overview.title,
    focus:
      'The zoom-out. The reader has just walked ONE path end to end; this chapter shows ' +
      'them the whole tree that path moved through — the subsystems, what each one owns, ' +
      'and how they connect. Open by placing the trace they just followed ON that map, by ' +
      'name, so the wider picture arrives as an expansion of something concrete they ' +
      'already hold rather than a fresh set of abstractions. Carry a system-map of the ' +
      'whole codebase. Every subsystem you name is somewhere a later chapter will go, so ' +
      'say what it is FOR, not merely what it is called.',
    keyFiles: [...keyFiles],
    assumes: trace.teaches,
    teaches: [
      'the whole-system map: the major subsystems and what each owns',
      'where the path they already traced sits inside that map',
      'which subsystem to look in first for a given kind of change',
    ],
  };
}

/**
 * Re-author the overview chapter through the ordinary author stage so it is
 * held to the same contracts as every other chapter.
 *
 * Best-effort by design: a pressing must not die because the zoom-out failed
 * to validate. On any failure the map stage's original overview is kept — the
 * lab is then exactly what it would have been before this step existed.
 */
async function reauthorOverview(
  runner: ModelRunner,
  repoDir: string,
  options: ReauthorOverviewOptions,
): Promise<ReauthoredOverview> {
  const { mapSpec, plan } = options;
  const planned = plannedOverviewModule(mapSpec, plan);
  const traceTitle = plan.modules[0]?.title;
  if (planned === undefined || traceTitle === undefined) {
    return { spec: mapSpec, costUsd: undefined, attempts: undefined, proseDrops: [] };
  }

  try {
    const result = await runAuthorStage(runner, repoDir, {
      model: options.model,
      plan: { modules: [planned] },
      concurrency: 1,
      // The reader meets the trace first, so the overview is never the
      // opening chapter — without this it would be briefed as the flagship.
      precedingTitles: [traceTitle],
      ...(options.widgetRange !== undefined ? { widgetRange: options.widgetRange } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      ...(options.onAuthored !== undefined ? { onModuleAuthored: options.onAuthored } : {}),
    });
    const authored = result.modules[0];
    if (authored === undefined) {
      return { spec: mapSpec, costUsd: result.costUsd, attempts: undefined, proseDrops: result.proseDrops };
    }
    return {
      spec: {
        ...mapSpec,
        base: {
          ...mapSpec.base,
          modules: mapSpec.base.modules.map((m) =>
            m.id === OVERVIEW_MODULE_ID ? authored.module : m,
          ),
        },
      },
      costUsd: result.costUsd,
      attempts: authored.attempts,
      proseDrops: result.proseDrops,
    };
  } catch {
    // Keep the map's own overview; the lab is still whole.
    return { spec: mapSpec, costUsd: undefined, attempts: undefined, proseDrops: [] };
  }
}

export function sumCosts(...costs: (number | undefined)[]): number | undefined {
  let total: number | undefined;
  for (const cost of costs) {
    if (cost !== undefined) {
      total = (total ?? 0) + cost;
    }
  }
  return total;
}

export function assertDirectory(repoDir: string): void {
  let isDirectory = false;
  try {
    isDirectory = statSync(repoDir).isDirectory();
  } catch {
    // fall through to the error below
  }
  if (!isDirectory) {
    throw new Error(`generateLab: repoDir "${repoDir}" is not an existing directory.`);
  }
}
