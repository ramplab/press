import { z } from 'zod';
import { moduleSchema, type LabModule } from '@ramplab/spec';
import { dropUnanchoredProse, fromSource, type ProseDrop } from './dropUnanchoredProse.js';
import { extractJson } from './mapStage.js';
import { normalizeModelJson } from './normalizeModelJson.js';
import { mapWithConcurrency, type ModelRunner, type StageResponse } from './pipeline.js';
import type { CurriculumPlan, PlannedModule } from './planStage.js';

/**
 * The author stage (PLAN.md §4, pass 2): fan out one authoring agent per
 * planned module, in parallel under a small concurrency cap. Each agent
 * writes a full module — a mix of anchored widgets (callouts, code
 * walkthroughs, code figures, diagrams, and a closing quiz) — validated
 * against `@ramplab/spec`'s module schema with the same bounded retry the
 * other stages use.
 *
 * Diagrams are budgeted, not left over (founder, 2026-07-25): the Edition v2
 * threads gave every module several prose obligations inside an unchanged
 * 4-to-8 widget budget, and the only widget family described as optional —
 * the diagrams — is what got squeezed out. Live editions pressed on 2026-07-13
 * carried 3-5 system maps; those pressed on 2026-07-14 carried 1-2, with the
 * callout share climbing from 29% to 50% across the same five editions. The
 * range now starts higher, the diagram catalogue sits above code-figure and
 * quiz rather than last, and {@link SHAPE_CONTRACT} states the expectation
 * outright. The escape hatch stays honest: no diagram where the code has no
 * shape, and every node still carries its own anchor.
 *
 * Narrative continuity without serializing the fan-out (issue #18): each
 * author prompt carries its module's **learner-state ledger slice** — what
 * the learner has already seen (`assumes`, plus the titles of earlier
 * modules it may reference), and what this module must add (`teaches`) —
 * plus the **style contract** (concrete before abstract, jargon defined at
 * first use, analogies anchored, mechanism-and-why over structural survey).
 *
 * Failure policy (deliberate, documented): a module that is still
 * schema-invalid after its retries **fails the whole stage** with an error
 * naming the module — there is no silent-skip mode. A planned module is a
 * curriculum commitment; dropping it quietly would ship a lab with a hole
 * the lead never sees. Other in-flight modules finish before the error is
 * raised, so all failures are reported at once.
 */

/** Default cap on concurrent authoring agents. */
export const DEFAULT_AUTHOR_CONCURRENCY = 4;

/**
 * Widgets per authored chapter. The floor clears the module's mandatory prose
 * — a quiz, the capability callout, the "when it breaks" warning, the threads
 * the plan assigned — so a diagram has somewhere to go.
 */
export const DEFAULT_WIDGET_RANGE = { min: 6, max: 10 } as const;

/** Widgets per chapter for repos deep enough to earn a 7-module plan. */
export const DEEP_WIDGET_RANGE = { min: 7, max: 12 } as const;

export interface AuthorStageOptions {
  /**
   * Widget count guidance interpolated into the prompt. Bigger repos earn
   * deeper chapters, not only more of them. The floor has to clear the
   * module's mandatory prose (a quiz, the capability callout, the "when it
   * breaks" warning, the threads the plan assigned) before a diagram can fit
   * at all — see the module comment. @default 6 to 10
   */
  widgetRange?: { min: number; max: number };
  model: string;
  plan: CurriculumPlan;
  /**
   * How many times to re-prompt a single module after schema-invalid output.
   * @default 1
   */
  maxRetries?: number;
  /**
   * Max authoring agents in flight at once.
   * @default 4
   */
  concurrency?: number;
  /**
   * Titles of chapters the reader meets BEFORE this plan's modules in the
   * finished lab. Prepended to every module's ledger slice. Needed when a
   * plan covers only part of the book — re-authoring the overview chapter
   * passes the flagship trace's title here, so the overview is told to build
   * on the trace instead of being mistaken for the opening chapter (which is
   * what an empty ledger means).
   */
  precedingTitles?: readonly string[];
  /**
   * Called as soon as each module validates — while other modules are still
   * in flight. This is the fan-out's progress seam: `generateLab` and pass 1
   * forward it as `module-authored` events. Invoked synchronously and not
   * awaited; completion order follows the fan-out, not plan order.
   */
  onModuleAuthored?: (authored: AuthoredModule) => void;
}

export interface AuthoredModule {
  /** A valid lab module — not yet anchor-resolved. */
  module: LabModule;
  /** Attempts spent on this module (1 = no retry needed). */
  attempts: number;
  /**
   * Prose this module's author wrote without grounding it, removed before
   * validation (see `dropUnanchoredProse.ts`). The author's diagram widgets
   * carry the same optional prose the map's do, and lose a module to an
   * unsourced phrase the same way.
   */
  proseDrops: ProseDrop[];
}

export interface AuthorStageResult {
  /** One authored module per planned module, in plan order. */
  modules: AuthoredModule[];
  /** Summed cost across all modules and attempts, if the runner reports cost. */
  costUsd: number | undefined;
  /** Every module's prose drops, in plan order. */
  proseDrops: ProseDrop[];
}

/** One module's terminal failure inside the author stage. */
export interface AuthorModuleFailure {
  moduleId: string;
  attempts: number;
  lastFailure: string;
}

/** Raised when at least one planned module never produced a valid module. */
export class AuthorStageError extends Error {
  readonly failures: readonly AuthorModuleFailure[];

  constructor(failures: readonly AuthorModuleFailure[]) {
    const detail = failures
      .map(
        (f) =>
          `- module "${f.moduleId}" failed after ${f.attempts} attempt` +
          `${f.attempts === 1 ? '' : 's'}:\n${indent(f.lastFailure)}`,
      )
      .join('\n');
    super(
      `Author stage failed: ${failures.length} planned module` +
        `${failures.length === 1 ? '' : 's'} did not produce valid output.\n${detail}`,
    );
    this.name = 'AuthorStageError';
    this.failures = failures;
  }
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export async function runAuthorStage(
  runner: ModelRunner,
  repoDir: string,
  options: AuthorStageOptions,
): Promise<AuthorStageResult> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_AUTHOR_CONCURRENCY);
  const planned = options.plan.modules;

  // Each module's ledger slice includes the titles of the modules before it —
  // any chapters preceding this plan entirely, then the plan's own earlier
  // modules — the names an author may reference for continuity.
  const preceding = options.precedingTitles ?? [];
  const entries = planned.map((module, index) => ({
    module,
    earlierTitles: [...preceding, ...planned.slice(0, index).map((earlier) => earlier.title)],
  }));
  const outcomes = await mapWithConcurrency(entries, concurrency, (entry) =>
    authorModule(runner, repoDir, entry.module, entry.earlierTitles, options),
  );

  let costUsd: number | undefined;
  const modules: AuthoredModule[] = [];
  const failures: AuthorModuleFailure[] = [];
  for (const outcome of outcomes) {
    if (outcome.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + outcome.costUsd;
    }
    if (outcome.ok) {
      modules.push({
        module: outcome.module,
        attempts: outcome.attempts,
        proseDrops: outcome.proseDrops,
      });
    } else {
      failures.push(outcome.failure);
    }
  }

  if (failures.length > 0) {
    throw new AuthorStageError(failures);
  }
  return { modules, costUsd, proseDrops: modules.flatMap((m) => m.proseDrops) };
}

// ---------------------------------------------------------------------------
// One module: bounded-retry authoring
// ---------------------------------------------------------------------------

type ModuleOutcome =
  | {
      ok: true;
      module: LabModule;
      attempts: number;
      costUsd: number | undefined;
      proseDrops: ProseDrop[];
    }
  | { ok: false; failure: AuthorModuleFailure; costUsd: number | undefined };

async function authorModule(
  runner: ModelRunner,
  repoDir: string,
  planned: PlannedModule,
  earlierTitles: readonly string[],
  options: AuthorStageOptions,
): Promise<ModuleOutcome> {
  const maxRetries = options.maxRetries ?? 1;
  const maxAttempts = 1 + Math.max(0, maxRetries);
  const range = options.widgetRange ?? DEFAULT_WIDGET_RANGE;
  const basePrompt = buildAuthorPrompt(planned, earlierTitles, range);

  let costUsd: number | undefined;
  let lastFailure = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1 ? basePrompt : `${basePrompt}\n\n${retryPreamble(lastFailure)}`;

    const response: StageResponse = await runner.runStage({
      stage: 'author',
      model: options.model,
      repoDir,
      prompt,
      attempt,
    });
    if (response.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + response.costUsd;
    }

    const outcome = assembleModule(response.output, planned);
    if (outcome.ok) {
      const authored: AuthoredModule = {
        module: outcome.module,
        attempts: attempt,
        proseDrops: outcome.proseDrops,
      };
      options.onModuleAuthored?.(authored);
      return { ok: true, ...authored, costUsd };
    }
    lastFailure = outcome.failure;
  }

  return {
    ok: false,
    failure: { moduleId: planned.id, attempts: maxAttempts, lastFailure },
    costUsd,
  };
}

type AssembleOutcome =
  | { ok: true; module: LabModule; proseDrops: ProseDrop[] }
  | { ok: false; failure: string };

/**
 * Parse the model's text as the author payload and assemble the module
 * around the plan's stable id/title. Validation is a single path: the
 * assembled module must pass `@ramplab/spec`'s module schema, plus a
 * non-empty-widgets floor (an empty module teaches nothing).
 */
function assembleModule(output: string, planned: PlannedModule): AssembleOutcome {
  const json = extractJson(output);
  if (json === undefined) {
    return { ok: false, failure: 'The output did not contain a parseable JSON object.' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, failure: 'The output JSON must be an object.' };
  }
  const payload = json as Record<string, unknown>;

  // Ungrounded prose is dropped, not fatal — a diagram's unsourced edge label
  // must not cost the chapter it sits in. See `dropUnanchoredProse.ts`.
  const widgets = payload['widgets'];
  const pruned = Array.isArray(widgets)
    ? widgets.map((widget, index) => dropUnanchoredProse(widget, `widgets[${index}]`))
    : undefined;

  const candidate = {
    id: planned.id,
    title: planned.title,
    ...(typeof payload['summary'] === 'string' && payload['summary'].length > 0
      ? { summary: payload['summary'] }
      : {}),
    widgets: pruned !== undefined ? pruned.map((entry) => entry.value) : widgets,
  };

  // An empty optional field is the absence it means, not a validation failure
  // worth a chapter (#107). The author stage writes most of a lab's anchors,
  // so it is the stage most exposed to the `"symbol": ""` that started this.
  const parsed = moduleSchema.safeParse(normalizeModelJson(candidate));
  if (!parsed.success) {
    return { ok: false, failure: z.prettifyError(parsed.error) };
  }
  if (parsed.data.widgets.length === 0) {
    return { ok: false, failure: 'The module must contain at least one widget.' };
  }
  return {
    ok: true,
    module: parsed.data,
    // Attributed to the chapter, because `widgets[2]` means something
    // different in every author's reply.
    proseDrops: fromSource(pruned?.flatMap((entry) => entry.drops) ?? [], planned.id),
  };
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

function retryPreamble(failure: string): string {
  return (
    `IMPORTANT — your previous attempt was rejected because it did not ` +
    `validate against the lab module schema:\n\n${failure}\n\n` +
    `Fix these problems and respond again with ONLY the corrected JSON object.`
  );
}

/** The ledger slice rendered into one author's prompt (issue #18). */
function renderLedgerSection(
  planned: PlannedModule,
  earlierTitles: readonly string[],
): string {
  const alreadySeen =
    planned.assumes.length > 0
      ? planned.assumes.map((a) => `  - ${a}`).join('\n')
      : '  - nothing about this codebase yet — this is the learner\'s first hands-on module';
  const references =
    earlierTitles.length > 0
      ? earlierTitles.map((t) => `"${t}"`).join(', ')
      : '(none — this is the first module)';
  // The opening chapter is the flagship trace, and the catalog lights ITS
  // system-map as the edition's cover journey (apps/web featured.ts gates
  // hero eligibility on module 0 carrying a map). Left unstated, that map
  // came out a coin flip: two Caddy runs hours apart produced four maps and
  // one. Ask for it by name.
  const flagship =
    earlierTitles.length === 0
      ? `\n- THIS IS THE OPENING CHAPTER — the flagship trace, the first thing anyone reads. Close the trace with a system-map that recaps the path just walked: one node per component the trace actually passed through, edges in the order control moved between them. The catalog lights this map as the edition's cover, so it must be THIS chapter's journey — not a general architecture diagram of the repo.`
      : '';
  return `Learner-state ledger — this module is one stop on a longer journey:${flagship}
- The learner has already seen:
${alreadySeen}
  Do not re-explain any of it; build on it (e.g. "you saw X in an earlier module — here is who calls it").
- This module must teach:
${planned.teaches.map((t) => `  - ${t}`).join('\n')}
- Earlier modules you may reference by title: ${references}.${
    earlierTitles.length > 0
      ? `
- CARRY THE THREAD FORWARD. At least once, name a specific thing an earlier chapter already showed the reader — a function, struct, field, or moment, by name — and say what THIS chapter adds to it ("you watched \`ServeHTTP\` hand off to the route chain in ${earlierTitles[0] !== undefined ? `"${earlierTitles[0]}"` : 'the opening chapter'}; here is who builds that chain"). A generic nod ("as we saw earlier") does not count: the reader must be able to place it. Restating something at the same altitude the reader already met it is the failure mode.`
      : ''
  }
- The last widget before the closing quiz must be a callout stating plainly what the learner can now DO that they could not before this module — concrete capabilities ("You can now trace any request from listener to handler", "You can now add and register a config adapter"), not a list of topics covered. Every chapter carries one; a chapter that ends without it breaks the pattern the reader has learned to expect.`;
}

/** The style contract every author writes under (issue #18). */
const STYLE_CONTRACT = `Style contract — how to write every word of this module:
- Write for a sharp engineer who knows nothing about THIS codebase. Never dumb anything down, and never assume repo-specific knowledge beyond the ledger above.
- Introduce every abstraction through a concrete instance first: show a real value, call, or file, then name the pattern it is an instance of.
- Define project-specific jargon the first time it appears.
- Reach for an analogy whenever it makes a mechanism click — a good module has one or two. Every analogy must be immediately followed by the precise mechanism it stands for, anchored to the code.
- Teach mechanism and why, not structure alone. "X calls Y" by itself is the failure mode: say what X passes, what Y decides or returns, and why the code is built that way.
- Teach the craft alongside the behavior. Where a key file exhibits a real code pattern, name it at the moment it appears and anchor it; where the code embodies a system-design decision or an architectural tradeoff, say what was traded away and why this shape won. "why" callouts are the natural home for these. Only name patterns and decisions the code in front of you actually shows — never import textbook material the repo does not have.
- In prose, wrap every code identifier, symbol, type, function, method, variable, file path, and package name in backticks the moment it appears — e.g. \`ServeHTTP\`, \`caddyhttp.Server\`, \`changeConfig\`, \`internal/caddyhttp/server.go\`. The renderer sets backticked spans as inline code; unbacked identifiers read as ordinary prose. This applies to every prose field (callout/plate bodies, walkthrough commentary, figure captions, quiz explanations, node/state/stage descriptions and edge labels, data-model annotations) — never to the verbatim "code" lines, which are already code.`;

const CONTENT_CONTRACT = `Field threads — the details a colleague at the next desk would actually give you. The plan assigns each module the threads that are load-bearing THERE (look for them in this module's focus); carry those, and add another only where the material demands it. THE WEAVE RULE governs all of them: a thread is part of this chapter's story, told at the moment it becomes relevant, never appended as a checklist section — and where it touches something an earlier chapter taught, it says so by that chapter's name ("the config reload you traced in Chapter II is what this timeout guards"). Never fabricate:
- RUN IT. When the module teaches something observable, show how to see it live: the repo's OWN install/run/demo commands, taken verbatim from its README, package scripts, Makefile, or docs, anchored to where they are written. A reader should be able to run what they just learned. Never invent a command the repo does not document.
- THE NUMBERS THAT MATTER. Surface the constants the code actually embeds — timeouts, sizes, retry counts, thresholds, magic values — anchored, each with why that value matters to behavior the reader has already met.
- WHEN IT BREAKS. One "warning" callout naming this module's debugging front door: the file, log line, flag, or state a person should inspect FIRST when this subsystem misbehaves, and why, anchored — tied to the mechanism this chapter just taught, not generic advice.
- HOW IT IS TESTED. Where this module's key files are tested, what those tests pin down, and the exact command the repo's own tooling uses to run just them, anchored to the test files. If the repo has no tests for this area, say nothing rather than inventing.`;

/**
 * The diagram budget (founder, 2026-07-25). Prose and code teach only what a
 * reader can hold in a line; the shapes are what a newcomer draws on a napkin
 * and keeps. Stated as its own contract so a diagram competes with the
 * threads for a slot instead of taking whatever is left after them.
 */
const SHAPE_CONTRACT = `Draw the shape. A chapter of nothing but prose and code teaches only what a reader can hold in a single line; the shapes are what they will redraw from memory a week later. Where this module's material HAS a shape, carry at least one diagram widget for it — and where it has two, carry two:
- components and the calls between them → system-map
- one thing that occupies several states and moves between them → state-machine
- a fixed sequence of stages, each handing to the next → pipeline
- a payload, config, or record whose fields carry meaning → data-model
Skip the diagram only when the module is genuinely one linear read of one file. Never invent structure the code does not have: every node, state, stage, and field is a claim like any other and carries its own anchor, so a shape you cannot anchor is a shape you must not draw.

SHOW THE CODE. Shapes and prose orient the reader; only the source convinces them. At least TWO widgets in this chapter must put real lines in front of the reader — code-walkthrough or code-figure, copied verbatim from the files. A chapter that describes a codebase without ever showing it is a summary, not a lab, however many diagrams and callouts it carries. The only chapter that may fall below two is one whose subject genuinely is not code (a contribution-process chapter, say) — and even there, prefer showing the config, the test, or the CI file to describing it.`;

/** Exported for prompt-contract tests; not part of the stage's runtime API. */
export function buildAuthorPrompt(
  planned: PlannedModule,
  earlierTitles: readonly string[],
  range: { min: number; max: number },
): string {
  return `You are authoring one module of a codebase onboarding lab for the repository in your working directory.

Module id: ${planned.id}
Module title: ${planned.title}
Focus: ${planned.focus}
Key files to teach from:
${planned.keyFiles.map((f) => `- ${f}`).join('\n')}

${renderLedgerSection(planned, earlierTitles)}

${STYLE_CONTRACT}

${CONTENT_CONTRACT}

${SHAPE_CONTRACT}

Explore the repository with the read-only tools available to you (Read, Glob, Grep) — start from the key files, follow the code where the focus leads. Do not modify anything.

When you are done, respond with ONLY a single JSON object (no prose before or after):

{
  "summary": "<2-3 sentence module summary for a new engineer>",
  "widgets": [ ...${range.min} to ${range.max} widgets, mixing the types below... ]
}

Widget types (choose what fits the material; close with the capability callout, then one quiz):

1. Callout — one teachable insight:
   { "id": "<kebab-id>", "type": "callout", "kind": "why" | "warning" | "connects-to", "title": "<optional>", "body": "<insight>", "anchors": [<anchor>, ...] }

2. Code walkthrough — step through an excerpt:
   { "id": "<kebab-id>", "type": "code-walkthrough", "title": "<optional>", "code": ["<line 1>", "<line 2>", ...], "source": <anchor for where the excerpt lives>, "steps": [{ "lines": { "start": N, "end": M }, "commentary": { "body": "<what these lines do>", "anchors": [<anchor>] } }] }
   Copy "code" lines verbatim from the file; step "lines" are 1-based within the excerpt and must not exceed its length.

3. Diagram widgets — one per shape the module's material actually has (see the shape contract above):
   - system-map: { "id", "type": "system-map", "title", "nodes": [{ "id", "label", "description": "<plain string>", "anchors": [<anchor>, ...] }], "edges": [{ "from", "to", "label": "<plain string>", "anchors": [<anchor>, ...] }] } — CAUTION: unlike the widgets below, a node "description" and an edge "label" are PLAIN STRINGS, never { "body", "anchors" } objects; their anchors go in the sibling "anchors" array. A node with a description (or an edge with a label) requires at least one anchor there. Edge endpoints must name existing node ids.
   - state-machine: { "id", "type": "state-machine", "title", "states": [{ "id", "label", "description": { "body", "anchors": [...] } }], "transitions": [{ "from", "to", "trigger", "commentary": { "body", "anchors": [...] } }] }
   - pipeline: { "id", "type": "pipeline", "title", "stages": [{ "id", "label", "description": { "body", "anchors": [...] }, "flow": { "in": "...", "out": "..." } }] }
   - data-model: { "id", "type": "data-model", "title", "source": <anchor>, "nodes": [{ "name", "type", "example": <optional>, "annotation": { "body", "anchors": [...] }, "children": [...] }] }

4. Code figure — one highlighted excerpt with an anchored caption:
   { "id": "<kebab-id>", "type": "code-figure", "code": ["..."], "source": <anchor>, "caption": { "body": "<the point of this excerpt>", "anchors": [<anchor>] }, "highlight": { "start": N, "end": M } }

5. Quiz — end-of-module checkpoint (2-4 questions; at least one must ask the reader to PREDICT what the code does for a concrete input or event, not recall what the prose said):
   { "id": "<kebab-id>", "type": "quiz", "title": "<optional>", "questions": [{ "id": "<kebab-id>", "prompt": "<question>", "options": [{ "id": "<kebab-id>", "label": "<answer>" }, ...>= 2], "correctOptionId": "<option id>", "explanation": { "body": "<why>", "anchors": [<anchor>] } }] }

An <anchor> is { "file": "<repo-relative path>", "symbol": "<identifier>", "lines": { "start": N, "end": M } } — "symbol" and "lines" are optional but sharpen the reference.

Hard requirements — the JSON is machine-validated and rejected on any violation:
- Every "id" is kebab-case (lowercase letters, digits, hyphens) and unique within its scope.
- Every teachable claim (callout, commentary, caption, explanation, description, annotation) carries at least one anchor. Where the claim is a { "body", "anchors" } object the anchors go inside it; where it is a plain string (system-map node descriptions, system-map edge labels) the anchors go in the sibling "anchors" array.
- Where a claim is OPTIONAL and you cannot cite real code for it — a system-map edge "label" or node "description", a state's "description", a transition's "commentary", a stage's "description", a field's "annotation" — omit the claim, keeping the shape it hung on. A bare arrow, state or stage is honest structure and is kept; an unanchored sentence is discarded before the chapter is built. Never invent an anchor to keep a sentence.
- Anchors are mechanically verified against the repository: "file" must exist repo-relative, "lines" must be a valid 1-based inclusive range in that file, and "symbol" must appear as a whole token inside the anchored region. Only anchor code you actually read — content whose anchors fail verification is dropped from the lab.
- Do not include a "fingerprint" field on any anchor.
- Strings are non-empty. Produce ${range.min} to ${range.max} widgets and at least one quiz.`;
}
