import type { LabSpec, SystemMapEdge, SystemMapNode, SystemMapWidget } from '@ramplab/spec';
import { hasIntakeAnswers, type LeadIntake } from './intake.js';
import type { TraceCandidate } from './mapStage.js';
import {
  LANDING_MODULE_ID,
  plannedModuleSchema,
  type PlannedModule,
} from './planStage.js';

/**
 * Pass-1 flagship selection (PLAN.md §4, issue #18): pick the ONE module
 * worth authoring in the 3–5 minute preview. The flagship is a **trace**:
 * the most representative candidate "front door" user action the map stage
 * proposed, authored as "follow this action end to end through the code".
 *
 * The selection is mechanical — no model call — and documented here because
 * it IS the product decision:
 *
 * 1. **Trace candidates first.** When the map proposed candidates
 *    (`MapStageResult.traceCandidates`), the flagship is one of them:
 *    - **Intake override**: the lead's answers are scanned in priority order
 *      (`weekOneMastery` before `activeDevelopment`; `gotchas` flavor
 *      prompts but never pick) and the first candidate whose action/
 *      description/key files match a hint wins (`basis: 'trace-intake'`).
 *    - **Otherwise the first candidate wins** (`basis: 'trace'`): the map
 *      prompt orders candidates most-representative-first, so map order is
 *      the representativeness ranking.
 * 2. **Fallback: subsystem centrality over the system map** — the pre-#18
 *    heuristic, kept for maps with no usable candidates (including reused
 *    map results captured before trace candidates existed). Candidates are
 *    anchored nodes; an intake hint match overrides (`basis: 'intake'`);
 *    otherwise the highest-degree node wins (`basis: 'centrality'`, ties
 *    keep map order).
 *
 * The winner is packaged as a `PlannedModule` (same brief the plan stage
 * would emit, ledger included) so pass 1 reuses the author stage unchanged,
 * and pass 2's plan stage pins its module 1 to the same id/title/focus.
 */

/** Why the flagship won — trace-based first, node-based fallback. */
export type FlagshipBasis = 'trace' | 'trace-intake' | 'intake' | 'centrality';

export interface FlagshipSelection {
  /** Why it won (see the module doc for the selection order). */
  basis: FlagshipBasis;
  /** Trace-based selection: the chosen front-door action. */
  traceAction?: string;
  /** Node-based fallback: the chosen system-map node. */
  nodeId?: string;
  /** Node-based fallback: incident edge count of the chosen node. */
  degree?: number;
  /** When `basis` is `trace-intake` or `intake`: the hint that matched. */
  matchedHint?: string;
  /** The authoring brief handed to the author stage. */
  plannedModule: PlannedModule;
}

/** Raised when the map offers nothing teachable to author. */
export class FlagshipSelectionError extends Error {
  constructor(message: string) {
    super(`Flagship selection failed: ${message}`);
    this.name = 'FlagshipSelectionError';
  }
}

export function selectFlagshipModule(
  mapSpec: LabSpec,
  intake?: LeadIntake,
  traceCandidates?: readonly TraceCandidate[],
): FlagshipSelection {
  const fromTrace = selectTraceFlagship(traceCandidates, intake);
  if (fromTrace !== undefined) return fromTrace;
  return selectCentralityFlagship(mapSpec, intake);
}

// ---------------------------------------------------------------------------
// Trace-based selection (the primary path)
// ---------------------------------------------------------------------------

/**
 * Select the flagship trace from the map's candidate actions, or `undefined`
 * when there are no candidates (callers fall back to centrality). Exported
 * separately because pass 2 uses it too: the plan stage pins its module 1 to
 * the same selection pass 1 previewed.
 */
export function selectTraceFlagship(
  traceCandidates: readonly TraceCandidate[] | undefined,
  intake?: LeadIntake,
): FlagshipSelection | undefined {
  if (traceCandidates === undefined || traceCandidates.length === 0) return undefined;

  const searchable = traceCandidates.map((candidate) => ({
    candidate,
    searchText: [
      candidate.id,
      candidate.action,
      candidate.description ?? '',
      ...candidate.keyFiles,
    ]
      .join(' ')
      .toLowerCase(),
  }));

  const fromIntake = matchIntakeHints(searchable, intake);
  if (fromIntake !== undefined) {
    return toTraceSelection(fromIntake.matched.candidate, 'trace-intake', intake, fromIntake.hint);
  }
  // Map order is the representativeness ranking (see the map prompt).
  const first = traceCandidates[0] as TraceCandidate;
  return toTraceSelection(first, 'trace', intake);
}

/**
 * Ids owned by other parts of the pipeline: the map stage's overview module
 * and the plan stage's mandated landing module. A colliding candidate id is
 * suffixed rather than rejected.
 */
function traceModuleId(candidateId: string): string {
  return candidateId === 'repo-overview' || candidateId === LANDING_MODULE_ID
    ? `${candidateId}-trace`
    : candidateId;
}

function toTraceSelection(
  candidate: TraceCandidate,
  basis: 'trace' | 'trace-intake',
  intake: LeadIntake | undefined,
  matchedHint?: string,
): FlagshipSelection {
  const focusParts: string[] = [
    `This module is the lab's opening trace: follow ONE real user action end to ` +
      `end through the code. The action: ${candidate.action}.`,
  ];
  if (candidate.description !== undefined) {
    focusParts.push(candidate.description);
  }
  focusParts.push(
    `Start at the entry point and walk the exact path the action takes — file by ` +
      `file, layer by layer — teaching each mechanism concretely as the action ` +
      `reaches it, before naming any abstraction it exemplifies.`,
    `Widget order is part of the pedagogy: the module MUST open with a ` +
      `code-walkthrough stepping through this action's entry point — the learner's ` +
      `first contact is real code being walked, never a diagram. A system-map of ` +
      `the path may appear only after the walkthroughs, as a recap of ground ` +
      `already covered.`,
    basis === 'trace-intake'
      ? `The onboarding lead's intake singled this area out ("${matchedHint ?? ''}").`
      : `The map stage judged this the most representative front-door action of this codebase.`,
  );
  const intakeLine = renderIntakeFocusLine(intake);
  if (intakeLine !== undefined) focusParts.push(intakeLine);

  const plannedModule = plannedModuleSchema.parse({
    id: traceModuleId(candidate.id),
    title: `End to end: ${candidate.action}`,
    focus: focusParts.join(' '),
    keyFiles: candidate.keyFiles,
    assumes: [],
    teaches: [
      `how "${candidate.action}" flows end to end through this codebase`,
      'the files and layers along that path, and why each exists',
    ],
  });
  return {
    basis,
    traceAction: candidate.action,
    ...(matchedHint !== undefined ? { matchedHint } : {}),
    plannedModule,
  };
}

// ---------------------------------------------------------------------------
// Node-based fallback (the pre-#18 centrality heuristic)
// ---------------------------------------------------------------------------

interface NodeCandidate {
  node: SystemMapNode;
  degree: number;
  /** Deduped repo-relative files from the node's and incident edges' anchors. */
  keyFiles: string[];
  /** Lowercased haystack for intake-hint matching. */
  searchText: string;
}

function selectCentralityFlagship(
  mapSpec: LabSpec,
  intake?: LeadIntake,
): FlagshipSelection {
  const systemMap = findSystemMap(mapSpec);
  if (systemMap === undefined) {
    throw new FlagshipSelectionError('the map spec contains no system-map widget.');
  }

  const candidates = systemMap.nodes
    .map((node) => toNodeCandidate(node, systemMap.edges))
    .filter((candidate) => candidate.keyFiles.length > 0);
  if (candidates.length === 0) {
    throw new FlagshipSelectionError(
      'no system-map node carries an anchor (directly or via an incident edge), ' +
        'so there are no key files to author from.',
    );
  }

  const fromIntake = matchIntakeHints(candidates, intake);
  if (fromIntake !== undefined) {
    return toNodeSelection(fromIntake.matched, 'intake', intake, fromIntake.hint);
  }

  let best = candidates[0] as NodeCandidate;
  for (const candidate of candidates) {
    if (candidate.degree > best.degree) best = candidate; // ties keep map order
  }
  return toNodeSelection(best, 'centrality', intake);
}

function findSystemMap(mapSpec: LabSpec): SystemMapWidget | undefined {
  for (const module of mapSpec.base.modules) {
    for (const widget of module.widgets) {
      if (widget.type === 'system-map') return widget;
    }
  }
  return undefined;
}

function toNodeCandidate(node: SystemMapNode, edges: readonly SystemMapEdge[]): NodeCandidate {
  const incident = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  const keyFiles = [
    ...new Set(
      [...(node.anchors ?? []), ...incident.flatMap((edge) => edge.anchors ?? [])].map(
        (anchor) => anchor.file,
      ),
    ),
  ];
  const searchText = [node.id, node.label, node.description ?? '', ...keyFiles]
    .join(' ')
    .toLowerCase();
  return { node, degree: incident.length, keyFiles, searchText };
}

/** The map stage owns `repo-overview`; a colliding node id gets suffixed. */
function flagshipModuleId(nodeId: string): string {
  return nodeId === 'repo-overview' ? 'repo-overview-flagship' : nodeId;
}

function toNodeSelection(
  candidate: NodeCandidate,
  basis: 'intake' | 'centrality',
  intake: LeadIntake | undefined,
  matchedHint?: string,
): FlagshipSelection {
  const { node, degree, keyFiles } = candidate;

  const focusParts: string[] = [
    `Teach "${node.label}" as this repository's flagship subsystem — the single ` +
      `deepest first look a new engineer gets.`,
  ];
  if (node.description !== undefined) {
    focusParts.push(node.description);
  }
  focusParts.push(
    basis === 'intake'
      ? `The onboarding lead's intake singled this area out ("${matchedHint ?? ''}").`
      : `It was chosen by subsystem centrality: ${degree} edge${degree === 1 ? '' : 's'} ` +
          `of the system map touch it.`,
  );
  const intakeLine = renderIntakeFocusLine(intake);
  if (intakeLine !== undefined) focusParts.push(intakeLine);

  const plannedModule = plannedModuleSchema.parse({
    id: flagshipModuleId(node.id),
    title: node.label,
    focus: focusParts.join(' '),
    keyFiles,
    assumes: [],
    teaches: [`how the "${node.label}" subsystem works and its role in the system`],
  });
  return {
    basis,
    nodeId: node.id,
    degree,
    ...(matchedHint !== undefined ? { matchedHint } : {}),
    plannedModule,
  };
}

// ---------------------------------------------------------------------------
// Shared intake-hint matching
// ---------------------------------------------------------------------------

/**
 * A hint matches an item when any of its words (4+ characters, so "the"/"a"
 * never match) appears in the item's search text. Hints are scanned in
 * intake priority order; items in map order.
 */
function matchIntakeHints<T extends { searchText: string }>(
  items: readonly T[],
  intake: LeadIntake | undefined,
): { matched: T; hint: string } | undefined {
  if (!hasIntakeAnswers(intake)) return undefined;
  const hints = [...(intake.weekOneMastery ?? []), ...(intake.activeDevelopment ?? [])];
  for (const hint of hints) {
    const words = hint
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4);
    if (words.length === 0) continue;
    for (const matched of items) {
      if (words.some((word) => matched.searchText.includes(word))) {
        return { matched, hint };
      }
    }
  }
  return undefined;
}

/** The intake summary appended to every flagship brief, when present. */
function renderIntakeFocusLine(intake: LeadIntake | undefined): string | undefined {
  if (!hasIntakeAnswers(intake)) return undefined;
  const inline: string[] = [];
  if ((intake.weekOneMastery?.length ?? 0) > 0) {
    inline.push(`week-one hires must master: ${intake.weekOneMastery!.join('; ')}`);
  }
  if ((intake.activeDevelopment?.length ?? 0) > 0) {
    inline.push(`under active development: ${intake.activeDevelopment!.join('; ')}`);
  }
  if ((intake.gotchas?.length ?? 0) > 0) {
    inline.push(`known gotchas to call out: ${intake.gotchas!.join('; ')}`);
  }
  return `Lead intake — ${inline.join('. ')}.`;
}
