/**
 * Pure journey logic (issue #21, moved into the renderer for #22 — the
 * Edition contents page and Appendix A render these directly): which
 * capability each module unlocks, the state of the capabilities ledger, and
 * where "resume" should send the learner. Storage lives in `ProgressStore`;
 * everything here is a pure function of spec + progress.
 */
import type { ResolvedModule } from '@ramplab/spec';
import { furthestVisitedModuleId, moduleProgressState, type LabProgress } from './progress.js';

/** The closing "what you can do now" callout of a module. */
export interface ModuleCapability {
  calloutId: string;
  title?: string;
  body: string;
}

/**
 * A module's capability callout, identified structurally: the last callout
 * before the module's checkpoint quiz (the shape the #18 generator prompts
 * produce — every quiz module closes with a "What you can do now" callout).
 * There is deliberately no spec field for this; if a module doesn't match the
 * shape (no quiz, or no callout before it) it simply has no ledger entry.
 */
export function moduleCapability(module: ResolvedModule): ModuleCapability | undefined {
  const widgets = module.widgets.map((resolved) => resolved.widget);
  const quizIndex = widgets.findIndex((widget) => widget.type === 'quiz');
  if (quizIndex === -1) return undefined;
  for (let index = quizIndex - 1; index >= 0; index -= 1) {
    const widget = widgets[index];
    if (widget !== undefined && widget.type === 'callout') {
      return {
        calloutId: widget.id,
        ...(widget.title !== undefined ? { title: widget.title } : {}),
        body: widget.body,
      };
    }
  }
  return undefined;
}

export interface LedgerEntry {
  moduleId: string;
  moduleTitle: string;
  capability: ModuleCapability;
  /** True once the module is completed (its quiz passed). */
  unlocked: boolean;
}

export interface CapabilitiesLedger {
  /** One entry per module with an extractable capability, in spec order. */
  entries: LedgerEntry[];
  unlockedCount: number;
}

/** The Appendix A ("what you can now do") state. */
export function capabilitiesLedger(
  modules: readonly ResolvedModule[],
  progress: LabProgress,
): CapabilitiesLedger {
  const entries: LedgerEntry[] = [];
  for (const module of modules) {
    const capability = moduleCapability(module);
    if (capability === undefined) continue;
    entries.push({
      moduleId: module.id,
      moduleTitle: module.title,
      capability,
      unlocked: moduleProgressState(module.id, progress) === 'completed',
    });
  }
  return { entries, unlockedCount: entries.filter((entry) => entry.unlocked).length };
}

/**
 * Where the resume ribbon should send the learner: their furthest-visited
 * module. Undefined when there is nothing to resume — nothing visited yet, or
 * the journey never left the first module.
 */
export function resumeTargetId(
  modules: readonly ResolvedModule[],
  progress: LabProgress,
): string | undefined {
  const furthest = furthestVisitedModuleId(modules, progress);
  if (furthest === undefined || furthest === modules[0]?.id) return undefined;
  return furthest;
}
