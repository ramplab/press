import { basename } from 'node:path';
import { z } from 'zod';
import { idSchema, safeParseLabSpec, type LabSpec } from '@ramplab/spec';
import { dropUnanchoredProse, fromSource, type ProseDrop } from './dropUnanchoredProse.js';
import { normalizeModelJson } from './normalizeModelJson.js';
import type { ModelRunner, StageResponse } from './pipeline.js';

/**
 * The map stage (PLAN.md §4, pass 1): an agent explores the repository and
 * produces (a) a system-map widget of the architecture, (b) one module of
 * anchored callouts introducing the repo, and (c) 2–3 candidate "front door"
 * trace actions — real user-triggered entry-point scenarios ("an HTTP
 * request is served", "a file is sent") with the files along each action's
 * path. The candidates seed flagship selection (issue #18): the lab's
 * opening module traces one of them end to end.
 *
 * The model returns a small JSON payload; this module owns the output
 * contract (prompt), the payload → LabSpec assembly, and the bounded retry
 * on schema-invalid output. Validation is a single path: the assembled spec
 * must pass `parseLabSpec` — there is no separate payload schema to drift
 * out of sync with `@ramplab/spec`. Trace candidates are deliberately
 * advisory: a malformed candidate is dropped (flagship selection has a
 * mechanical fallback), never a reason to reject the whole map.
 */

export interface MapStageOptions {
  model: string;
  /** Lab id; defaults to a slug of the repo directory name. */
  labId?: string;
  /**
   * How many times to re-prompt after schema-invalid output.
   * @default 1
   */
  maxRetries?: number;
}

/**
 * One candidate "front door" user action proposed by the map agent — an
 * entry-point scenario a real user triggers, with the files along its path.
 * Pipeline-internal (never part of the lab spec): it exists to seed the
 * flagship trace selection in `flagship.ts`.
 */
export const traceCandidateSchema = z.object({
  /** Stable kebab-case id — becomes the trace module's id when selected. */
  id: idSchema,
  /** The user-visible action, e.g. "an HTTP request is served". */
  action: z.string().min(1, 'trace candidate action must be non-empty'),
  /** Optional one-liner: where the action enters and what it passes through. */
  description: z.string().min(1).optional(),
  /** Repo-relative files along the action's path, entry point first. */
  keyFiles: z
    .array(z.string().min(1))
    .min(1, 'a trace candidate needs at least one key file'),
});

export type TraceCandidate = z.infer<typeof traceCandidateSchema>;

export interface MapStageResult {
  /** A valid lab spec — not yet anchor-resolved. */
  spec: LabSpec;
  /** Total attempts made (1 = no retry needed). */
  attempts: number;
  /** Summed cost across attempts, if the runner reports cost. */
  costUsd: number | undefined;
  /**
   * Candidate front-door trace actions, most representative first. Always
   * present (possibly empty) on fresh runs; optional so map results captured
   * before issue #18 (e.g. a reused `config.mapResult`) remain valid — every
   * consumer must treat a missing/empty list as "no candidates" and fall
   * back mechanically.
   */
  traceCandidates?: TraceCandidate[];
  /**
   * Map prose the model wrote without grounding it, removed before validation
   * (see `dropUnanchoredProse.ts`). Optional for the same reason as
   * `traceCandidates`: a map result captured before this existed is still a
   * valid one, and an absent list reads as "none".
   */
  proseDrops?: ProseDrop[];
}

/** Raised when the model's output stays schema-invalid after all retries. */
export class MapStageError extends Error {
  readonly attempts: number;
  /** The validation failure of the final attempt. */
  readonly lastFailure: string;

  constructor(attempts: number, lastFailure: string) {
    super(
      `Map stage failed: model output did not produce a valid lab spec after ` +
        `${attempts} attempt${attempts === 1 ? '' : 's'}.\nLast failure:\n${lastFailure}`,
    );
    this.name = 'MapStageError';
    this.attempts = attempts;
    this.lastFailure = lastFailure;
  }
}

export async function runMapStage(
  runner: ModelRunner,
  repoDir: string,
  options: MapStageOptions,
): Promise<MapStageResult> {
  const maxRetries = options.maxRetries ?? 1;
  const maxAttempts = 1 + Math.max(0, maxRetries);
  const labId = options.labId ?? slugify(basename(repoDir));
  const basePrompt = buildMapPrompt();

  let costUsd: number | undefined;
  let lastFailure = 'no attempt was made';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const prompt =
      attempt === 1 ? basePrompt : `${basePrompt}\n\n${retryPreamble(lastFailure)}`;

    const response: StageResponse = await runner.runStage({
      stage: 'map',
      model: options.model,
      repoDir,
      prompt,
      attempt,
    });
    if (response.costUsd !== undefined) {
      costUsd = (costUsd ?? 0) + response.costUsd;
    }

    const outcome = assembleSpec(response.output, labId);
    if (outcome.ok) {
      return {
        spec: outcome.spec,
        attempts: attempt,
        costUsd,
        traceCandidates: outcome.traceCandidates,
        proseDrops: outcome.proseDrops,
      };
    }
    lastFailure = outcome.failure;
  }

  throw new MapStageError(maxAttempts, lastFailure);
}

// ---------------------------------------------------------------------------
// Payload → spec assembly (the single validation path)
// ---------------------------------------------------------------------------

type AssembleOutcome =
  | { ok: true; spec: LabSpec; traceCandidates: TraceCandidate[]; proseDrops: ProseDrop[] }
  | { ok: false; failure: string };

/**
 * Parse the model's text output as the map-stage payload and assemble the
 * lab spec around it. Any problem — unparseable JSON, wrong envelope, or a
 * spec-schema violation — becomes a `failure` string that feeds the retry
 * prompt verbatim.
 */
function assembleSpec(output: string, labId: string): AssembleOutcome {
  const json = extractJson(output);
  if (json === undefined) {
    return { ok: false, failure: 'The output did not contain a parseable JSON object.' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, failure: 'The output JSON must be an object.' };
  }

  const payload = json as Record<string, unknown>;
  const callouts = Array.isArray(payload['callouts']) ? payload['callouts'] : [];

  // Prose the model did not ground is dropped, not fatal — the arrow keeps
  // its place in the diagram, the phrase that cited nothing does not. Done in
  // the model's own coordinates so a reported drop reads as `systemMap.…`.
  const systemMap = dropUnanchoredProse(payload['systemMap'], 'systemMap');
  const pruned = callouts.map((callout, index) =>
    dropUnanchoredProse(callout, `callouts[${index}]`),
  );
  const proseDrops = fromSource(
    [...systemMap.drops, ...pruned.flatMap((entry) => entry.drops)],
    'map',
  );

  const candidate = {
    schemaVersion: 1,
    id: labId,
    title: payload['title'],
    base: {
      modules: [
        {
          id: 'repo-overview',
          title: payload['moduleTitle'],
          ...(typeof payload['moduleSummary'] === 'string'
            ? { summary: payload['moduleSummary'] }
            : {}),
          widgets: [systemMap.value, ...pruned.map((entry) => entry.value)],
        },
      ],
    },
    overlay: [],
  };

  // An empty optional field is the absence it means, not a validation
  // failure worth six minutes of somebody's run (#107).
  const parsed = safeParseLabSpec(normalizeModelJson(candidate));
  if (!parsed.success) {
    return { ok: false, failure: inPayloadCoordinates(parsed.error) };
  }
  return {
    ok: true,
    spec: parsed.data,
    traceCandidates: parseTraceCandidates(payload),
    proseDrops,
  };
}

/**
 * Say where the problem is in the JSON the model actually wrote.
 *
 * The map payload is `{ systemMap, callouts }`; this stage wraps it in a lab
 * spec before validating, so zod reports `base.modules[0].widgets[3]` — a path
 * that appears nowhere in the output contract the model was given, or in its
 * own reply. The retry then asks it to fix a coordinate it has to reverse
 * engineer, and `widgets[3]` → `callouts[2]` is an off-by-one waiting to
 * happen. Every other stage validates the payload in the shape the model wrote
 * it; this is the one that cannot, so it translates back instead.
 */
export function inPayloadCoordinates(failure: string): string {
  return failure
    .replace(/base\.modules\[0\]\.widgets\[(\d+)\]/g, (_match, index: string) =>
      // Widget 0 is the system map; the rest are the callouts, in order.
      Number(index) === 0 ? 'systemMap' : `callouts[${Number(index) - 1}]`,
    )
    .replace(/base\.modules\[0\]\.widgets\b/g, 'systemMap/callouts')
    .replace(/base\.modules\[0\]\.title\b/g, 'moduleTitle')
    .replace(/base\.modules\[0\]\.summary\b/g, 'moduleSummary')
    .replace(/base\.modules\[0\]/g, 'the module');
}

/**
 * Lenient trace-candidate parsing: keep every entry that satisfies
 * {@link traceCandidateSchema} (first occurrence wins on a duplicate id),
 * silently drop the rest. Advisory data gets advisory validation — flagship
 * selection falls back to centrality when nothing usable survives, so a
 * sloppy candidate must never fail (or force a retry of) the map stage.
 */
export function parseTraceCandidates(payload: Record<string, unknown>): TraceCandidate[] {
  const raw = payload['traceCandidates'];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const candidates: TraceCandidate[] = [];
  for (const entry of raw) {
    const parsed = traceCandidateSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    candidates.push(parsed.data);
  }
  return candidates;
}

/**
 * Pull a JSON value out of agent output that may wrap it in prose or a
 * markdown fence. Tries, in order: the raw text, the last ```json fence,
 * and the outermost `{...}` span.
 */
export function extractJson(output: string): unknown {
  const candidates: string[] = [output.trim()];

  const fences = [...output.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const lastFence = fences[fences.length - 1];
  if (lastFence?.[1] !== undefined) {
    candidates.push(lastFence[1].trim());
  }

  const first = output.indexOf('{');
  const last = output.lastIndexOf('}');
  if (first !== -1 && last > first) {
    candidates.push(output.slice(first, last + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next extraction strategy
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

function retryPreamble(failure: string): string {
  return (
    `IMPORTANT — your previous attempt was rejected because it did not ` +
    `validate against the lab spec schema:\n\n${failure}\n\n` +
    `Fix these problems and respond again with ONLY the corrected JSON object.`
  );
}

function buildMapPrompt(): string {
  return `You are analyzing the repository in your working directory to build the "map" stage of a codebase onboarding lab: an architecture overview a new hire sees first.

Explore the repository using the read-only tools available to you (Read, Glob, Grep). Do not modify anything.

When you are done exploring, respond with ONLY a single JSON object (no prose before or after) with exactly this shape:

{
  "title": "<the project's REAL name, verbatim, followed by ' Onboarding Lab' — e.g. 'Caddy Onboarding Lab'>",
  "moduleTitle": "<title for the intro module>",
  "moduleSummary": "<2-3 sentence orientation for a new engineer>",
  "systemMap": {
    "id": "system-map",
    "type": "system-map",
    "title": "<diagram title>",
    "nodes": [
      {
        "id": "<kebab-case-id>",
        "label": "<short label>",
        "description": "<what this part does>",
        "anchors": [{ "file": "<repo-relative path>", "symbol": "<identifier in that file>", "lines": { "start": N, "end": M } }]
      }
    ],
    "edges": [
      { "from": "<node-id>", "to": "<node-id>", "label": "<what flows here>", "anchors": [{ "file": "...", "symbol": "..." }] },
      { "from": "<node-id>", "to": "<node-id>" }
    ]
  },
  "callouts": [
    {
      "id": "<kebab-case-id>",
      "type": "callout",
      "kind": "why" | "warning" | "connects-to",
      "title": "<optional short title>",
      "body": "<one teachable insight about this codebase>",
      "anchors": [{ "file": "<repo-relative path>", "symbol": "<identifier>", "lines": { "start": N, "end": M } }]
    }
  ],
  "traceCandidates": [
    {
      "id": "<kebab-case-id>",
      "action": "<a 'front door' user action, e.g. 'an HTTP request is served', 'a file is sent'>",
      "description": "<one sentence: where the action enters and what it passes through>",
      "keyFiles": ["<repo-relative file on the action's path, entry point first>", "..."]
    }
  ]
}

Trace candidates — the lab's opening module will follow ONE real user action end to end through the code, and you are proposing the candidates:
- Propose 2 or 3, each a scenario a real user actually triggers from outside (a request served, a file sent, a command run) — not an internal subroutine.
- Order them most representative first: the first candidate should be the action whose path exercises the most of this codebase's core.
- "keyFiles" lists 2-6 files you actually read, in the order the action reaches them, entry point first.
- Candidates are advisory: a malformed candidate is dropped rather than causing rejection, so keep them simple and real.

Hard requirements — the JSON is machine-validated and rejected on any violation:
- The "title" MUST use the project's REAL name exactly as it appears in the repository — take it verbatim from the "name" field in package.json, the project title in the README, or failing those the repository/directory name — then append " Onboarding Lab". Do NOT invent, guess, abbreviate, translate, rebrand, or otherwise alter the name (for example, never turn "cal.com" into "Cal.diy"). Copy the real name character for character; a wrong project name is a credibility failure on a customer's own repo.
- Every "id" is kebab-case: lowercase letters, digits, and hyphens, starting with a letter or digit.
- The system map has at least one node; every edge's "from"/"to" names an existing node id; node ids are unique.
- Any node with a "description" and any edge with a "label" MUST carry at least one anchor. Bare structural nodes/edges (no description/label) may omit anchors — the second edge in the skeleton above is a complete, valid edge.
- If you cannot cite real code for an edge's label or a node's description, drop the LABEL OR DESCRIPTION, not the edge or node. An arrow with no words is honest structure and is kept; a phrase with no anchor is an ungrounded claim and is discarded before the lab is built. Never invent an anchor to keep a sentence.
- Every callout MUST carry at least one anchor. Produce 3 to 6 callouts introducing the repo (why it is structured this way, warnings about gotchas, how parts connect).
- Anchors are mechanically verified against the repository:
  - "file" is a repo-relative path to a file that exists.
  - "lines", if given, is a 1-based inclusive range within the file's real line count.
  - "symbol", if given, appears as a whole token inside the anchored region.
  Only anchor code you actually read. Content whose anchors fail verification is dropped from the lab.
- Do not include a "fingerprint" field on any anchor.
- In every prose string (node "description"s, edge "label"s, callout "body"s and "title"s), wrap each code identifier, symbol, type, function, file path, and package name in backticks the moment it appears — e.g. \`ServeHTTP\`, \`caddyhttp.Server\`, \`internal/caddyhttp/server.go\`. The renderer sets backticked spans as inline code.
- Strings are non-empty. "kind" is exactly one of "why", "warning", "connects-to".`;
}

// ---------------------------------------------------------------------------

/** Turn a directory name into a schema-valid kebab-case lab id. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'generated-lab';
}
