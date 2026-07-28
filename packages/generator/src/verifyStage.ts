import { z } from 'zod';
import {
  parseLabSpec,
  type Anchor,
  type BaseWidget,
  type DataModelNode,
  type LabModule,
  type LabSpec,
} from '@ramplab/spec';
import { extractJson } from './mapStage.js';
import { mapWithConcurrency, type ModelRunner, type StageResponse } from './pipeline.js';
import { createAnchorFileCache, readAnchorRegion, type AnchorFileCache } from './resolveAnchors.js';

/**
 * The verify stage (PLAN.md §3–§4): adversarial grounding enforcement.
 *
 * Anchor resolution proves a claim *points at real code*; this stage proves
 * the claim is *true of that code*. An independent verifier agent receives
 * each machine-generated claim together with the ACTUAL content of its
 * anchored regions (read via the same `readAnchorRegion` that resolution
 * fingerprints, so verifier and resolver see identical bytes) and tries to
 * REFUTE it. Per-claim verdicts: `verified` | `refuted` | `unverifiable`,
 * each with a reason. Anything not verified is dropped from the base spec —
 * the overlay (human tribal knowledge) is never touched.
 *
 * **Batching (deliberate):** one verifier call per module, covering every
 * claim in that module's widgets. Per-claim calls would cost one agent
 * invocation per sentence of the lab; per-module batches keep the call count
 * at the same order as the author fan-out (which produced the claims in the
 * first place), keep each prompt's code context focused on one subsystem's
 * files, and still yield strictly per-claim verdicts because the output
 * contract demands exactly one verdict per listed claim id. Batches run in
 * parallel under the same worker-pool/concurrency cap as authoring.
 *
 * **Drop semantics:** the unit of removal is the whole teachable widget —
 * consistent with `UnitResolution` granularity in anchor resolution — with
 * one refinement: a quiz drops only the failed question, and the quiz widget
 * itself only when no questions remain. A module emptied by drops is removed
 * (the spec schema demands ≥1 widget-bearing structure stays parseable) and
 * recorded in the report.
 *
 * **Failure policy (consistent with the author stage):** a batch whose
 * verifier output is still invalid after bounded retries fails the whole
 * stage with an error naming the module — verification is a grounding
 * guarantee, so there is no silent-skip mode. Other in-flight batches finish
 * first so all failures are reported at once.
 */

/** Default cap on concurrent verifier agents. */
export const DEFAULT_VERIFY_CONCURRENCY = 4;

/** The three per-claim verdicts. Only `verified` keeps a claim in the lab. */
export type ClaimVerdictValue = 'verified' | 'refuted' | 'unverifiable';

/** One machine-generated claim, extracted from a base widget. */
export interface VerificationClaim {
  moduleId: string;
  widgetId: string;
  /**
   * Stable claim id, unique within its module batch:
   * `<widgetId>#<part>` (e.g. `greet-walkthrough#step-1`,
   * `greetings-quiz#question-q-greet-return`).
   */
  claimId: string;
  /** For quiz claims: the question id, so drops can target the question. */
  questionId?: string;
  /** The claim text shown to the verifier. */
  claim: string;
  /** The anchors grounding the claim, as they appear in the spec. */
  anchors: Anchor[];
}

/** A claim plus its verdict — one row of the verification report. */
export interface ClaimVerdict extends VerificationClaim {
  verdict: ClaimVerdictValue;
  /** The verifier's justification (or the mechanical reason). */
  reason: string;
}

export interface VerificationDroppedWidget {
  moduleId: string;
  widgetId: string;
  /** One entry per failed claim: `<claimId>: <verdict> — <reason>`. */
  reasons: string[];
}

export interface VerificationDroppedQuestion {
  moduleId: string;
  widgetId: string;
  questionId: string;
  reason: string;
}

export interface VerificationDrops {
  /** Whole widgets removed (any failed claim; quizzes only when emptied). */
  widgets: VerificationDroppedWidget[];
  /** Individual quiz questions removed. */
  questions: VerificationDroppedQuestion[];
  /** Modules removed because verification left them without widgets. */
  modules: string[];
}

export interface VerificationSummary {
  totalClaims: number;
  verified: number;
  refuted: number;
  unverifiable: number;
  /** `verified / totalClaims`; 1 when there were no claims to check. */
  passRate: number;
}

/** Structured report of a full verification pass over a spec's base content. */
export interface VerificationReport {
  /** Every claim checked, in spec order, with its verdict and reason. */
  claims: ClaimVerdict[];
  drops: VerificationDrops;
  summary: VerificationSummary;
}

export interface VerifyStageOptions {
  model: string;
  /** The assembled, anchor-resolved spec whose base content is on trial. */
  spec: LabSpec;
  /**
   * Units already flagged by anchor resolution (the `flag` policy keeps
   * them for human review). Verification skips them: their grounding failed
   * mechanically, so there is no anchored code to check the claim against,
   * and dropping them here would defeat the review-flow policy.
   */
  flaggedUnits?: readonly { moduleId: string; widgetId: string }[];
  /**
   * How many times to re-prompt a batch after invalid verifier output.
   * @default 1
   */
  maxRetries?: number;
  /**
   * Max verifier agents in flight at once.
   * @default 4
   */
  concurrency?: number;
}

export interface VerifyStageResult {
  /** The spec with every non-verified unit dropped, revalidated. */
  spec: LabSpec;
  report: VerificationReport;
  /**
   * Verifier attempts per module batch (1 = first output was valid).
   * Modules whose claims never needed a model call are absent.
   */
  attempts: Record<string, number>;
  /** Summed cost across all batches and attempts, if the runner reports it. */
  costUsd: number | undefined;
}

/** One batch's terminal failure inside the verify stage. */
export interface VerifyBatchFailure {
  moduleId: string;
  attempts: number;
  lastFailure: string;
}

/** Raised when at least one module batch never produced valid verdicts. */
export class VerifyStageError extends Error {
  readonly failures: readonly VerifyBatchFailure[];

  constructor(failures: readonly VerifyBatchFailure[]) {
    const detail = failures
      .map(
        (f) =>
          `- module "${f.moduleId}" failed after ${f.attempts} attempt` +
          `${f.attempts === 1 ? '' : 's'}:\n${indent(f.lastFailure)}`,
      )
      .join('\n');
    super(
      `Verify stage failed: ${failures.length} module batch` +
        `${failures.length === 1 ? '' : 'es'} did not produce valid verdicts.\n${detail}`,
    );
    this.name = 'VerifyStageError';
    this.failures = failures;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export async function runVerifyStage(
  runner: ModelRunner,
  repoDir: string,
  options: VerifyStageOptions,
): Promise<VerifyStageResult> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_VERIFY_CONCURRENCY);
  const skip = new Set(
    (options.flaggedUnits ?? []).map((u) => unitKey(u.moduleId, u.widgetId)),
  );
  const fileCache = createAnchorFileCache();

  const batches = options.spec.base.modules
    .map((module) => ({
      module,
      claims: collectModuleClaims(module).filter(
        (claim) => !skip.has(unitKey(claim.moduleId, claim.widgetId)),
      ),
    }))
    .filter((batch) => batch.claims.length > 0);

  const outcomes = await mapWithConcurrency(batches, concurrency, (batch) =>
    verifyBatch(runner, repoDir, batch.module.id, batch.claims, {
      model: options.model,
      maxRetries: options.maxRetries ?? 1,
      fileCache,
    }),
  );

  let costUsd: number | undefined;
  const attempts: Record<string, number> = {};
  const claims: ClaimVerdict[] = [];
  const failures: VerifyBatchFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + outcome.costUsd;
    }
    if (outcome.attempts > 0) {
      attempts[outcome.moduleId] = outcome.attempts;
    }
    if (outcome.failure !== undefined) {
      failures.push(outcome.failure);
    } else {
      claims.push(...outcome.verdicts);
    }
  }
  if (failures.length > 0) {
    throw new VerifyStageError(failures);
  }

  const { spec, drops } = applyVerdicts(options.spec, claims);
  const verified = claims.filter((c) => c.verdict === 'verified').length;
  const report: VerificationReport = {
    claims,
    drops,
    summary: {
      totalClaims: claims.length,
      verified,
      refuted: claims.filter((c) => c.verdict === 'refuted').length,
      unverifiable: claims.filter((c) => c.verdict === 'unverifiable').length,
      passRate: claims.length === 0 ? 1 : verified / claims.length,
    },
  };
  return { spec, report, attempts, costUsd };
}

// ---------------------------------------------------------------------------
// Claim extraction (one entry per machine-generated teachable statement)
// ---------------------------------------------------------------------------

/** Extract every claim carried by a module's widgets, in spec order. */
export function collectModuleClaims(module: LabModule): VerificationClaim[] {
  const claims: VerificationClaim[] = [];
  for (const widget of module.widgets) {
    collectWidgetClaims(module.id, widget, claims);
  }
  return claims;
}

function collectWidgetClaims(
  moduleId: string,
  widget: BaseWidget,
  out: VerificationClaim[],
): void {
  const add = (part: string, claim: string, anchors: Anchor[], questionId?: string): void => {
    out.push({
      moduleId,
      widgetId: widget.id,
      claimId: `${widget.id}#${part}`,
      claim,
      anchors,
      ...(questionId !== undefined ? { questionId } : {}),
    });
  };

  switch (widget.type) {
    case 'callout':
      add(
        'body',
        widget.title !== undefined ? `${widget.title}: ${widget.body}` : widget.body,
        widget.anchors,
      );
      return;
    case 'code-walkthrough':
      widget.steps.forEach((step, index) => {
        add(
          `step-${index + 1}`,
          `Walkthrough step ${index + 1} (excerpt lines ${step.lines.start}-${step.lines.end}): ${step.commentary.body}`,
          step.commentary.anchors,
        );
      });
      return;
    case 'code-figure':
      add('caption', widget.caption.body, widget.caption.anchors);
      return;
    case 'quiz':
      for (const question of widget.questions) {
        const correct = question.options.find((o) => o.id === question.correctOptionId);
        add(
          `question-${question.id}`,
          `Quiz question: ${question.prompt}\n` +
            `Claimed correct answer: ${correct?.label ?? question.correctOptionId}\n` +
            `Explanation: ${question.explanation.body}`,
          question.explanation.anchors,
          question.id,
        );
      }
      return;
    case 'system-map':
      for (const node of widget.nodes) {
        if (node.description !== undefined) {
          add(
            `node-${node.id}`,
            `System-map node "${node.label}": ${node.description}`,
            node.anchors ?? [],
          );
        }
      }
      widget.edges.forEach((edge, index) => {
        if (edge.label !== undefined) {
          add(
            `edge-${index + 1}`,
            `System-map edge ${edge.from} -> ${edge.to}: ${edge.label}`,
            edge.anchors ?? [],
          );
        }
      });
      return;
    case 'state-machine':
      for (const state of widget.states) {
        if (state.description !== undefined) {
          add(
            `state-${state.id}`,
            `State "${state.label}": ${state.description.body}`,
            state.description.anchors,
          );
        }
      }
      widget.transitions.forEach((transition, index) => {
        if (transition.commentary !== undefined) {
          add(
            `transition-${index + 1}`,
            `Transition ${transition.from} -> ${transition.to} on "${transition.trigger}": ${transition.commentary.body}`,
            transition.commentary.anchors,
          );
        }
      });
      return;
    case 'pipeline':
      for (const stage of widget.stages) {
        if (stage.description !== undefined) {
          add(
            `stage-${stage.id}`,
            `Pipeline stage "${stage.label}": ${stage.description.body}`,
            stage.description.anchors,
          );
        }
      }
      return;
    case 'data-model':
      collectDataModelClaims(widget.nodes, [], add);
      return;
    case 'decision-table':
      widget.rules.forEach((rule, index) => {
        add(
          `rule-${index + 1}`,
          `Decision rule ${index + 1} (outcome "${rule.outcome}"): ${rule.explanation.body}`,
          rule.explanation.anchors,
        );
      });
      if (widget.defaultOutcome?.explanation !== undefined) {
        add(
          'default-outcome',
          `Default outcome "${widget.defaultOutcome.outcome}": ${widget.defaultOutcome.explanation.body}`,
          widget.defaultOutcome.explanation.anchors,
        );
      }
      return;
    default:
      assertNever(widget);
  }
}

function collectDataModelClaims(
  nodes: readonly DataModelNode[],
  path: readonly string[],
  add: (part: string, claim: string, anchors: Anchor[]) => void,
): void {
  for (const node of nodes) {
    const nodePath = [...path, node.name];
    if (node.annotation !== undefined) {
      add(
        `field-${nodePath.join('.')}`,
        `Data-model field "${nodePath.join('.')}" (${node.type}): ${node.annotation.body}`,
        node.annotation.anchors,
      );
    }
    if (node.children !== undefined) {
      collectDataModelClaims(node.children, nodePath, add);
    }
  }
}

function assertNever(value: never): never {
  throw new Error(`verifyStage: unhandled widget shape ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// One module batch: bounded-retry verification
// ---------------------------------------------------------------------------

interface BatchConfig {
  model: string;
  maxRetries: number;
  fileCache: AnchorFileCache;
}

interface BatchOutcome {
  moduleId: string;
  verdicts: ClaimVerdict[];
  /** 0 = every claim was settled mechanically, no model call was made. */
  attempts: number;
  costUsd: number | undefined;
  failure?: VerifyBatchFailure;
}

async function verifyBatch(
  runner: ModelRunner,
  repoDir: string,
  moduleId: string,
  claims: readonly VerificationClaim[],
  config: BatchConfig,
): Promise<BatchOutcome> {
  // Render every claim with the actual anchored code. A claim none of whose
  // anchors can be read (possible only if the repo changed between anchor
  // resolution and now, or under the `flag` policy misuse) is mechanically
  // unverifiable — there is nothing to check it against.
  const mechanical = new Map<string, ClaimVerdict>();
  const checkable: RenderedClaim[] = [];
  for (const claim of claims) {
    const rendered = renderClaim(claim, repoDir, config.fileCache);
    if (rendered.readableAnchors === 0) {
      mechanical.set(claim.claimId, {
        ...claim,
        verdict: 'unverifiable',
        reason: `None of the claim's anchors could be read: ${rendered.problems.join('; ')}`,
      });
    } else {
      checkable.push(rendered);
    }
  }

  const finish = (byId: Map<string, ClaimVerdict>, attempts: number, costUsd: number | undefined): BatchOutcome => ({
    moduleId,
    verdicts: claims.map((claim) => {
      const verdict = mechanical.get(claim.claimId) ?? byId.get(claim.claimId);
      /* v8 ignore next 3 -- parseVerdicts guarantees full coverage */
      if (verdict === undefined) {
        throw new Error(`verifyStage: missing verdict for claim "${claim.claimId}"`);
      }
      return verdict;
    }),
    attempts,
    costUsd,
  });

  if (checkable.length === 0) {
    return finish(new Map(), 0, undefined);
  }

  const basePrompt = buildVerifyPrompt(moduleId, checkable);
  const maxAttempts = 1 + Math.max(0, config.maxRetries);

  let costUsd: number | undefined;
  let lastFailure = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1 ? basePrompt : `${basePrompt}\n\n${retryPreamble(lastFailure)}`;

    const response: StageResponse = await runner.runStage({
      stage: 'verify',
      model: config.model,
      repoDir,
      prompt,
      attempt,
    });
    if (response.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + response.costUsd;
    }

    const outcome = parseVerdicts(response.output, checkable.map((c) => c.claim));
    if (outcome.ok) {
      return finish(outcome.byId, attempt, costUsd);
    }
    lastFailure = outcome.failure;
  }

  return {
    moduleId,
    verdicts: [],
    attempts: maxAttempts,
    costUsd,
    failure: { moduleId, attempts: maxAttempts, lastFailure },
  };
}

// ---------------------------------------------------------------------------
// Verifier output contract
// ---------------------------------------------------------------------------

const verdictEntrySchema = z.object({
  claimId: z.string().min(1),
  verdict: z.enum(['verified', 'refuted', 'unverifiable']),
  reason: z.string().min(1, 'every verdict needs a non-empty reason'),
});

const verifyResponseSchema = z.object({
  verdicts: z.array(verdictEntrySchema),
});

type ParseOutcome =
  | { ok: true; byId: Map<string, ClaimVerdict> }
  | { ok: false; failure: string };

/**
 * Parse the verifier's text as the verdict payload and enforce exact claim
 * coverage: one verdict per listed claim id — no omissions, extras, or
 * duplicates. Any problem becomes a `failure` string feeding the retry.
 */
function parseVerdicts(output: string, claims: readonly VerificationClaim[]): ParseOutcome {
  const json = extractJson(output);
  if (json === undefined) {
    return { ok: false, failure: 'The output did not contain a parseable JSON object.' };
  }
  const parsed = verifyResponseSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, failure: z.prettifyError(parsed.error) };
  }

  const claimsById = new Map(claims.map((claim) => [claim.claimId, claim]));
  const byId = new Map<string, ClaimVerdict>();
  const problems: string[] = [];
  for (const entry of parsed.data.verdicts) {
    const claim = claimsById.get(entry.claimId);
    if (claim === undefined) {
      problems.push(`verdict for unknown claim id "${entry.claimId}"`);
      continue;
    }
    if (byId.has(entry.claimId)) {
      problems.push(`duplicate verdict for claim id "${entry.claimId}"`);
      continue;
    }
    byId.set(entry.claimId, { ...claim, verdict: entry.verdict, reason: entry.reason });
  }
  for (const claim of claims) {
    if (!byId.has(claim.claimId)) {
      problems.push(`missing verdict for claim id "${claim.claimId}"`);
    }
  }
  if (problems.length > 0) {
    return {
      ok: false,
      failure: `The verdicts must cover exactly the listed claim ids:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    };
  }
  return { ok: true, byId };
}

// ---------------------------------------------------------------------------
// Prompting (claim text + the ACTUAL anchored code content)
// ---------------------------------------------------------------------------

interface RenderedClaim {
  claim: VerificationClaim;
  /** The claim's prompt block, anchored code inlined. */
  text: string;
  readableAnchors: number;
  problems: string[];
}

function renderClaim(
  claim: VerificationClaim,
  repoDir: string,
  fileCache: AnchorFileCache,
): RenderedClaim {
  const parts = [
    `### Claim ${claim.claimId}`,
    `Widget: "${claim.widgetId}"`,
    `Claim: ${claim.claim}`,
  ];
  let readableAnchors = 0;
  const problems: string[] = [];
  claim.anchors.forEach((anchor, index) => {
    const where = [
      anchor.file,
      anchor.lines !== undefined ? `lines ${anchor.lines.start}-${anchor.lines.end}` : undefined,
      anchor.symbol !== undefined ? `symbol "${anchor.symbol}"` : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(', ');
    const region = readAnchorRegion(anchor, repoDir, fileCache);
    if (region.kind === 'ok') {
      readableAnchors += 1;
      parts.push(`Anchor ${index + 1} — ${where}:`, '```', region.text, '```');
    } else {
      problems.push(region.detail);
      parts.push(`Anchor ${index + 1} — ${where}: could not be read (${region.detail})`);
    }
  });
  return { claim, text: parts.join('\n'), readableAnchors, problems };
}

function retryPreamble(failure: string): string {
  return (
    `IMPORTANT — your previous attempt was rejected because it did not ` +
    `validate against the verdict schema:\n\n${failure}\n\n` +
    `Fix these problems and respond again with ONLY the corrected JSON object.`
  );
}

function buildVerifyPrompt(moduleId: string, rendered: readonly RenderedClaim[]): string {
  return `You are the adversarial verifier for a codebase onboarding lab about the repository in your working directory. A previous authoring pass produced the claims below; your job is to try to REFUTE each one against the code it cites.

Each claim is followed by the ACTUAL content of every code region its anchors point at, read directly from the repository. Judge the claim against that code. You may use the read-only tools available to you (Read, Glob, Grep) to examine surrounding context, but the cited code is the evidence that counts. Do not modify anything.

Be skeptical — a claim earns "verified" only if the anchored code actually substantiates it:
- "verified": the anchored code substantiates the claim.
- "refuted": the anchored code contradicts the claim (wrong behavior, wrong name, wrong direction, wrong answer).
- "unverifiable": the anchored code neither supports nor contradicts the claim — it is about something else, or the claim asserts things the code cannot show.

Claims from module "${moduleId}":

${rendered.map((r) => r.text).join('\n\n')}

When you are done, respond with ONLY a single JSON object (no prose before or after) with exactly this shape:

{
  "verdicts": [
    { "claimId": "<claim id from above>", "verdict": "verified" | "refuted" | "unverifiable", "reason": "<1-2 sentences>" }
  ]
}

Hard requirements — the JSON is machine-validated and rejected on any violation:
- Exactly one verdict per claim id listed above: no omissions, no extras, no duplicates, ids copied verbatim.
- "verdict" is exactly one of "verified", "refuted", "unverifiable".
- "reason" is non-empty: for "verified", name what in the code substantiates the claim; for "refuted" or "unverifiable", say precisely why. Claims that are not verified are dropped from the lab, and your reasons are shown to the lab's maintainer.`;
}

// ---------------------------------------------------------------------------
// Applying verdicts (drops + structural cleanup)
// ---------------------------------------------------------------------------

/**
 * Remove every unit with a non-verified claim, without mutating the input:
 * quiz questions individually (the quiz widget only when emptied), whole
 * widgets otherwise, and modules that end up widget-less. The overlay is
 * untouched. The result is revalidated through `parseLabSpec` — the same
 * single validation path the assemble stage uses.
 */
function applyVerdicts(
  spec: LabSpec,
  claims: readonly ClaimVerdict[],
): { spec: LabSpec; drops: VerificationDrops } {
  const failedByUnit = new Map<string, ClaimVerdict[]>();
  for (const claim of claims) {
    if (claim.verdict === 'verified') continue;
    const key = unitKey(claim.moduleId, claim.widgetId);
    const list = failedByUnit.get(key) ?? [];
    list.push(claim);
    failedByUnit.set(key, list);
  }

  const drops: VerificationDrops = { widgets: [], questions: [], modules: [] };
  const out = structuredClone(spec);

  for (const module of out.base.modules) {
    module.widgets = module.widgets.filter((widget) => {
      const failures = failedByUnit.get(unitKey(module.id, widget.id));
      if (failures === undefined) return true;
      const reasons = failures.map((f) => `${f.claimId}: ${f.verdict} — ${f.reason}`);

      if (widget.type === 'quiz') {
        const failedQuestions = new Map(
          failures.map((f) => [f.questionId, f] as const),
        );
        widget.questions = widget.questions.filter((question) => {
          const failure = failedQuestions.get(question.id);
          if (failure === undefined) return true;
          drops.questions.push({
            moduleId: module.id,
            widgetId: widget.id,
            questionId: question.id,
            reason: `${failure.verdict} — ${failure.reason}`,
          });
          return false;
        });
        if (widget.questions.length > 0) return true;
        // Every question failed: the widget itself goes.
        drops.widgets.push({ moduleId: module.id, widgetId: widget.id, reasons });
        return false;
      }

      drops.widgets.push({ moduleId: module.id, widgetId: widget.id, reasons });
      return false;
    });
  }

  drops.modules = out.base.modules
    .filter((module) => module.widgets.length === 0)
    .map((module) => module.id);
  out.base.modules = out.base.modules.filter((module) => module.widgets.length > 0);

  if (out.base.modules.length === 0) {
    throw new Error(
      'Verification dropped every module in the lab — no machine-generated claim survived. ' +
        'Refusing to emit an empty spec; regenerate with better anchoring or review the verifier reasons in the report.',
    );
  }

  // Single validation path: a JSON round-trip plus parseLabSpec guarantees
  // the post-drop spec is exactly what a consumer would load from disk.
  return { spec: parseLabSpec(JSON.parse(JSON.stringify(out))), drops };
}

function unitKey(moduleId: string, widgetId: string): string {
  return `${moduleId} ${widgetId}`;
}
