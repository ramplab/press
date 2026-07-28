import { z } from 'zod';
import { idSchema, type LabSpec } from '@ramplab/spec';
import { renderIntakeSection, type LeadIntake } from './intake.js';
import { extractJson } from './mapStage.js';
import type { ModelRunner, StageResponse } from './pipeline.js';

/**
 * The curriculum-plan stage (PLAN.md §4, pass 2): given the map-stage output
 * (the system map is the model's index of the repo's subsystems), an agent
 * plans the lab as a **journey, not a survey** (issue #18). The curriculum
 * contract, enforced by the parse gate where it can be mechanical:
 *
 * - **Module 1 is an end-to-end trace** of one front-door user action. When
 *   the flagship trace was already selected (see `flagship.ts`), the plan's
 *   first module must carry its id, and its title/focus are canonicalized
 *   from the selection after parsing — pass 2's re-authoring of the pass-1
 *   preview stays canonical instead of re-negotiated per run.
 * - **Dependency order, concrete to abstract**: each module relies only on
 *   what earlier modules taught.
 * - **The learner-state ledger**: every planned module declares `assumes`
 *   (what the learner knows on arrival) and `teaches` (what it adds). The
 *   author stage hands each parallel author its slice, buying narrative
 *   continuity without serializing the fan-out.
 * - **The final module is always "your first contribution"** (id
 *   `first-contribution`): starter areas, test conventions, CI gates, PR
 *   norms — thin if the repo's material is thin, never fabricated.
 *
 * The plan is **pipeline-internal state** — it never appears in a lab spec,
 * so its schema lives here, not in `@ramplab/spec`. Downstream, the author
 * stage fans out one agent per planned module and the assemble stage merges
 * the authored modules in plan order.
 *
 * Budget semantics: the cap is a **config property, not a repo property**.
 * The prompt asks for at most `budget.maxModules` modules; if the model
 * over-delivers anyway, the plan is truncated to the cap after validation.
 * Truncation drops modules from the end of the middle: the opening trace
 * and the landing `first-contribution` module always survive, because they
 * are curriculum invariants, not centrality picks.
 */

/** Default cap on planned modules when the config does not set one. */
export const DEFAULT_MAX_MODULES = 6;

/** The centrality budget: caps scope by config, never by repo size. */
export interface CurriculumBudget {
  /**
   * Hard cap on the number of authored modules (the map stage's overview
   * module is not counted against it).
   * @default 6
   */
  maxModules?: number;
  /**
   * Free-form scope steering from the lead's intake ("focus on billing",
   * "skip the legacy importer"). Injected into the plan prompt verbatim.
   */
  scopeHints?: string[];
}

/** The map stage owns this module id; planned modules must not collide. */
const RESERVED_MODULE_IDS = new Set(['repo-overview']);

/**
 * The mandated landing module (issue #18): every curriculum ends with "your
 * first contribution" under this id, so its presence is a mechanical check.
 */
export const LANDING_MODULE_ID = 'first-contribution';

/**
 * Internal Zod schema for one planned module. Deliberately NOT part of
 * `@ramplab/spec`: the plan (including the learner-state ledger) is an
 * intermediate artifact between stages and never reaches the lab spec.
 */
export const plannedModuleSchema = z.object({
  /** Stable kebab-case id — becomes the authored module's id in the spec. */
  id: idSchema,
  title: z.string().min(1, 'planned module title must be non-empty'),
  /** What this module must teach — the author agent's brief. */
  focus: z.string().min(1, 'planned module focus must be non-empty'),
  /** Repo-relative paths the author agent should start from. */
  keyFiles: z.array(z.string().min(1)).min(1, 'a planned module needs at least one key file'),
  /**
   * Ledger: what the learner already knows on arrival — established by
   * earlier modules. Empty for the opening trace module.
   */
  assumes: z.array(z.string().min(1, 'assumes entries must be non-empty')),
  /** Ledger: what this module adds to the learner's understanding. */
  teaches: z
    .array(z.string().min(1, 'teaches entries must be non-empty'))
    .min(1, 'a planned module must teach at least one thing'),
});

export const curriculumPlanSchema = z
  .object({
    modules: z.array(plannedModuleSchema).min(1, 'a plan needs at least one module'),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.modules.forEach((module, index) => {
      if (seen.has(module.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['modules', index, 'id'],
          message: `duplicate planned module id "${module.id}"`,
        });
      }
      seen.add(module.id);
      if (RESERVED_MODULE_IDS.has(module.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['modules', index, 'id'],
          message: `module id "${module.id}" is reserved for the map stage's overview module`,
        });
      }
    });
    const last = plan.modules[plan.modules.length - 1];
    if (last !== undefined && last.id !== LANDING_MODULE_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['modules', plan.modules.length - 1, 'id'],
        message:
          `the final module must be the "your first contribution" landing module ` +
          `with id "${LANDING_MODULE_ID}" (got "${last.id}")`,
      });
    }
  });

export type PlannedModule = z.infer<typeof plannedModuleSchema>;
export type CurriculumPlan = z.infer<typeof curriculumPlanSchema>;

export interface PlanStageOptions {
  model: string;
  /** The map-stage output — its system map seeds the centrality ranking. */
  mapSpec: LabSpec;
  budget?: CurriculumBudget;
  /**
   * The lead's intake answers (PLAN.md §4 curation loop). Rendered into the
   * plan prompt so they steer module selection and ordering.
   */
  intake?: LeadIntake;
  /**
   * The flagship trace module selected in `flagship.ts` (pass 1's preview
   * module). When present, the plan's first module must carry this id (parse
   * gate) and its title/focus are canonicalized from it after parsing, so
   * pass 2 re-authors the same trace the learner previewed in pass 1. Absent
   * when the map yielded no usable trace candidates — the prompt then asks
   * the planner to pick its own front-door action for module 1.
   */
  traceModule?: PlannedModule;
  /**
   * How many times to re-prompt after schema-invalid output.
   * @default 1
   */
  maxRetries?: number;
}

export interface PlanStageResult {
  /** Validated plan, ordered most-central-first, capped at the budget. */
  plan: CurriculumPlan;
  /** Total attempts made (1 = no retry needed). */
  attempts: number;
  /** Summed cost across attempts, if the runner reports cost. */
  costUsd: number | undefined;
}

/** Raised when the model's output stays schema-invalid after all retries. */
export class PlanStageError extends Error {
  readonly attempts: number;
  readonly lastFailure: string;

  constructor(attempts: number, lastFailure: string) {
    super(
      `Plan stage failed: model output did not produce a valid curriculum plan after ` +
        `${attempts} attempt${attempts === 1 ? '' : 's'}.\nLast failure:\n${lastFailure}`,
    );
    this.name = 'PlanStageError';
    this.attempts = attempts;
    this.lastFailure = lastFailure;
  }
}

export async function runPlanStage(
  runner: ModelRunner,
  repoDir: string,
  options: PlanStageOptions,
): Promise<PlanStageResult> {
  const maxRetries = options.maxRetries ?? 1;
  const maxAttempts = 1 + Math.max(0, maxRetries);
  const maxModules = options.budget?.maxModules ?? DEFAULT_MAX_MODULES;
  const basePrompt = buildPlanPrompt(
    options.mapSpec,
    maxModules,
    options.budget?.scopeHints,
    options.intake,
    options.traceModule,
  );

  let costUsd: number | undefined;
  let lastFailure = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1 ? basePrompt : `${basePrompt}\n\n${retryPreamble(lastFailure)}`;

    const response: StageResponse = await runner.runStage({
      stage: 'plan',
      model: options.model,
      repoDir,
      prompt,
      attempt,
    });
    if (response.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + response.costUsd;
    }

    const outcome = parsePlan(response.output, options.traceModule);
    if (outcome.ok) {
      return { plan: capPlan(outcome.plan, maxModules), attempts: attempt, costUsd };
    }
    lastFailure = outcome.failure;
  }

  throw new PlanStageError(maxAttempts, lastFailure);
}

/**
 * Enforce the budget mechanically, preserving the curriculum invariants:
 * the opening trace (head of the plan) and the landing `first-contribution`
 * module (tail) always survive; over-delivery is trimmed from the end of
 * the middle. This makes the cap a config guarantee rather than a hope
 * about model obedience.
 */
function capPlan(plan: CurriculumPlan, maxModules: number): CurriculumPlan {
  if (plan.modules.length <= maxModules) return plan;
  const landing = plan.modules[plan.modules.length - 1] as PlannedModule;
  return { modules: [...plan.modules.slice(0, Math.max(0, maxModules - 1)), landing] };
}

type ParseOutcome = { ok: true; plan: CurriculumPlan } | { ok: false; failure: string };

/**
 * The parse gate: schema validation (ledger fields, landing module, ids)
 * plus the flagship-trace contract when a trace module was pre-selected —
 * the first module must carry the trace's id, and its title/focus are then
 * overwritten with the canonical selection so the trace's identity is owned
 * by flagship selection, not re-negotiated by the planner. The planner still
 * owns the trace module's keyFiles (it explored the repo) and its ledger.
 */
export function parsePlan(output: string, traceModule?: PlannedModule): ParseOutcome {
  const json = extractJson(output);
  if (json === undefined) {
    return { ok: false, failure: 'The output did not contain a parseable JSON object.' };
  }
  const parsed = curriculumPlanSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, failure: z.prettifyError(parsed.error) };
  }
  const plan = parsed.data;
  if (traceModule !== undefined) {
    const first = plan.modules[0] as PlannedModule;
    if (first.id !== traceModule.id) {
      return {
        ok: false,
        failure:
          `The first module must be the already-selected flagship trace module ` +
          `with id "${traceModule.id}" (got "${first.id}").`,
      };
    }
    plan.modules[0] = { ...first, title: traceModule.title, focus: traceModule.focus };
  }
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

function retryPreamble(failure: string): string {
  return (
    `IMPORTANT — your previous attempt was rejected because it did not ` +
    `validate against the curriculum-plan schema:\n\n${failure}\n\n` +
    `Fix these problems and respond again with ONLY the corrected JSON object.`
  );
}

/** Render the map stage's system map as compact context for the planner. */
function describeSystemMap(mapSpec: LabSpec): string {
  const lines: string[] = [];
  for (const module of mapSpec.base.modules) {
    for (const widget of module.widgets) {
      if (widget.type !== 'system-map') continue;
      for (const node of widget.nodes) {
        const files = (node.anchors ?? []).map((a) => a.file).join(', ');
        lines.push(
          `- ${node.label} (${node.id})` +
            (node.description !== undefined ? `: ${node.description}` : '') +
            (files.length > 0 ? ` [${files}]` : ''),
        );
      }
      for (const edge of widget.edges) {
        lines.push(`- edge ${edge.from} -> ${edge.to}${edge.label !== undefined ? `: ${edge.label}` : ''}`);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no system map available)';
}

function buildPlanPrompt(
  mapSpec: LabSpec,
  maxModules: number,
  scopeHints: string[] | undefined,
  intake: LeadIntake | undefined,
  traceModule: PlannedModule | undefined,
): string {
  const hints =
    scopeHints !== undefined && scopeHints.length > 0
      ? `\nScope hints from the onboarding lead — respect them when choosing and ordering modules:\n${scopeHints.map((h) => `- ${h}`).join('\n')}\n`
      : '';

  const traceContract =
    traceModule !== undefined
      ? `The trace has already been selected — your FIRST module MUST use exactly this id (its title and focus are fixed; restate them verbatim):
   - id: ${traceModule.id}
   - title: ${traceModule.title}
   - focus: ${traceModule.focus}
   Plan its "keyFiles" from the files along the action's path (start from: ${traceModule.keyFiles.join(', ')}), and fill in its ledger ("assumes" is [] — the learner arrives knowing nothing).`
      : `Pick ONE "front door" user action — a real scenario a user triggers from outside (a request served, a file sent, a command run) — and make module 1 follow it end to end through the code, entry point to effect, before anything abstract.`;

  return `You are planning the curriculum for a codebase onboarding lab — a JOURNEY that takes a sharp engineer from zero knowledge of this repository to first-meaningful-PR readiness. A previous mapping pass produced this system map of the repository in your working directory:

${describeSystemMap(mapSpec)}

Explore the repository with the read-only tools available to you (Read, Glob, Grep) to confirm what each module should teach. Do not modify anything.
${renderIntakeSection(intake)}${hints}
Curriculum contract — every plan must satisfy all five points:

1. MODULE 1 IS AN END-TO-END TRACE. ${traceContract}

2. DEPENDENCY ORDER, CONCRETE TO ABSTRACT. Order the modules so each relies only on what earlier modules taught. Concrete mechanisms come before the abstractions and architecture built from them; a learner must meet every concept through a concrete instance before any module treats it abstractly. Do not plan a "most important areas" survey — plan a path.

3. THE LEARNER-STATE LEDGER. Every module declares:
   - "assumes": what the learner already knows on arrival — only things an EARLIER module in this plan teaches (empty for module 1).
   - "teaches": what this module adds. Together, the "teaches" lists are the whole journey.

4. THE CRAFT IS CURRICULUM. The journey must teach how this codebase is BUILT, not only what it does — woven into the modules where each is most concrete, never quarantined into one abstract survey module:
   - the CODE PATTERNS the repo actually uses, called by their names at the places they occur (a plugin registry, dependency injection, a worker pool — whatever this repo truly exhibits);
   - the SYSTEM DESIGN decisions the code embodies and the tradeoffs they bought;
   - the ARCHITECTURE'S rationale: not just what talks to what, but why it is shaped that way.
   Reflect this in the modules' "focus" and "teaches" entries so the authoring pass delivers it. Only claim patterns and decisions the code actually shows — never import textbook patterns the repo does not have.

   DISTRIBUTE THE FIELD THREADS. Four field threads run through an edition: RUN IT (the repo's own run/demo commands), THE NUMBERS THAT MATTER (embedded constants and why), WHEN IT BREAKS (the subsystem's debugging front door), and HOW IT IS TESTED (where the tests live and how to run just them). Assign each thread to the ONE OR TWO modules where it is load-bearing — run-it belongs where the reader first has something to run, when-it-breaks where the operational risk lives, how-it-is-tested where the test suite actually concentrates — and NAME the assigned threads in those modules' "focus". A module stamped with all four reads as a checklist and breaks the journey; a thread assigned nowhere is a gap.

5. THE FINAL MODULE IS "YOUR FIRST CONTRIBUTION", id exactly "${LANDING_MODULE_ID}". It teaches where starter work lives, the repo's test conventions and how to run them, the CI gates a PR must pass, and contribution/PR norms.${
    intake !== undefined ? ` The onboarding lead's "active development" and "week-one" answers above tell you which starter areas matter most.` : ''
  } Ground every claim in material that actually exists in the repo (CONTRIBUTING/docs, CI configs, test directories, tooling). If the repo offers little such material, keep this module thin — NEVER fabricate conventions the repo does not have.

Hard budget: plan AT MOST ${maxModules} module${maxModules === 1 ? '' : 's'} INCLUDING the trace and the "${LANDING_MODULE_ID}" module. If you over-deliver, modules are discarded from the end of the middle (the trace and the landing module always survive) — make every middle module earn its slot.

When you are done, respond with ONLY a single JSON object (no prose before or after) with exactly this shape:

{
  "modules": [
    {
      "id": "<kebab-case-id, stable across regenerations>",
      "title": "<module title a learner sees>",
      "focus": "<2-4 sentences: what this module must teach and why it matters>",
      "keyFiles": ["<repo-relative path>", "..."],
      "assumes": ["<something an earlier module taught>", "..."],
      "teaches": ["<something this module adds>", "..."]
    }
  ]
}

Hard requirements — the JSON is machine-validated and rejected on any violation:
- Every "id" is kebab-case (lowercase letters, digits, hyphens), unique, and NOT "repo-overview" (that id is reserved for the intro module).${
    traceModule !== undefined ? `\n- The FIRST module's id is "${traceModule.id}".` : ''
  }
- The LAST module's id is "${LANDING_MODULE_ID}".
- Every module has "assumes" (a list, may be empty) and "teaches" (at least one entry).
- "keyFiles" lists 1-6 repo-relative paths to files that actually exist — only list files you confirmed.
- Strings are non-empty. At most ${maxModules} entries in "modules".`;
}
