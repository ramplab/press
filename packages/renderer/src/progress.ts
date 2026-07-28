import type { OverlayQuizWidget, ResolvedModule } from '@ramplab/spec';

/**
 * Local learner progress — the reference-lab model (PLAN.md §6): no accounts,
 * progress lives in this browser's localStorage, keyed by lab id plus the
 * spec's stable module/widget/question IDs so it survives regeneration.
 *
 * This module is a deliberate seam: `Lab` talks only to the `ProgressStore`
 * interface, so the hosted viewer can swap in an account-backed store later
 * without touching any widget code.
 */

/** The outcome of checking one checkpoint question. */
export interface CheckpointResult {
  selectedOptionId: string;
  correct: boolean;
}

export interface LabProgress {
  /** Module ids the learner has opened at least once. */
  viewedModules: Record<string, boolean>;
  /** Module ids the learner has completed (every checkpoint question passed). */
  completedModules: Record<string, boolean>;
  /** Latest checkpoint result per quiz widget id, per question id. */
  checkpoints: Record<string, Record<string, CheckpointResult>>;
}

/**
 * The learner's journey state for one module. `completed` implies viewed even
 * if the persisted record predates viewed-tracking, so legacy progress never
 * renders a completed-but-unseen module.
 */
export type ModuleProgressState = 'unseen' | 'viewed' | 'completed';

export function moduleProgressState(moduleId: string, progress: LabProgress): ModuleProgressState {
  if (progress.completedModules[moduleId] === true) return 'completed';
  if (progress.viewedModules[moduleId] === true) return 'viewed';
  return 'unseen';
}

/**
 * How `Lab` reads and records learner progress. Every mutator returns the
 * updated snapshot so callers can feed React state without a second read.
 */
export interface ProgressStore {
  read(): LabProgress;
  recordCheckpoint(widgetId: string, questionId: string, result: CheckpointResult): LabProgress;
  /** Mark a module as opened; a no-op (no write) if it is already viewed. */
  setModuleViewed(moduleId: string): LabProgress;
  setModuleCompleted(moduleId: string, completed: boolean): LabProgress;
  /** Wipe this lab's progress (other labs' keys are untouched). */
  reset(): LabProgress;
}

/**
 * Bump when the persisted shape changes incompatibly (and migrate from the
 * old key). Additive fields stay within v1: `sanitize` fills what a legacy
 * record lacks — e.g. `viewedModules`, added after v1 records already
 * existed, defaults to empty and is backfilled from `completedModules` by
 * `moduleProgressState`.
 */
const STORAGE_PREFIX = 'ramplab-progress-v1';

export function progressStorageKey(labId: string): string {
  return `${STORAGE_PREFIX}:${labId}`;
}

export function emptyProgress(): LabProgress {
  return { viewedModules: {}, completedModules: {}, checkpoints: {} };
}

/**
 * Reading `globalThis.localStorage` can itself throw (e.g. sandboxed iframes,
 * some privacy modes), so even obtaining the default backend is guarded.
 */
function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Accept only values shaped like persisted progress; anything else resets. */
function sanitize(raw: unknown): LabProgress {
  if (typeof raw !== 'object' || raw === null) return emptyProgress();
  const value = raw as Partial<Record<keyof LabProgress, unknown>>;
  const progress = emptyProgress();

  if (typeof value.viewedModules === 'object' && value.viewedModules !== null) {
    for (const [moduleId, viewed] of Object.entries(value.viewedModules)) {
      if (viewed === true) progress.viewedModules[moduleId] = true;
    }
  }
  if (typeof value.completedModules === 'object' && value.completedModules !== null) {
    for (const [moduleId, completed] of Object.entries(value.completedModules)) {
      if (completed === true) progress.completedModules[moduleId] = true;
    }
  }
  if (typeof value.checkpoints === 'object' && value.checkpoints !== null) {
    for (const [widgetId, results] of Object.entries(value.checkpoints)) {
      if (typeof results !== 'object' || results === null) continue;
      for (const [questionId, result] of Object.entries(results)) {
        const candidate = result as Partial<CheckpointResult> | null;
        if (
          typeof candidate === 'object' &&
          candidate !== null &&
          typeof candidate.selectedOptionId === 'string' &&
          typeof candidate.correct === 'boolean'
        ) {
          (progress.checkpoints[widgetId] ??= {})[questionId] = {
            selectedOptionId: candidate.selectedOptionId,
            correct: candidate.correct,
          };
        }
      }
    }
  }
  return progress;
}

/**
 * localStorage-backed progress store. Storage failures are never fatal:
 * unavailable/throwing/corrupt storage degrades to in-memory progress for the
 * session, so the lab keeps working in private windows and sandboxed embeds.
 */
export function createLocalProgressStore(
  labId: string,
  storage: Storage | undefined = defaultStorage(),
): ProgressStore {
  const key = progressStorageKey(labId);

  let current: LabProgress = (() => {
    if (storage === undefined) return emptyProgress();
    try {
      const raw = storage.getItem(key);
      return raw === null ? emptyProgress() : sanitize(JSON.parse(raw));
    } catch {
      return emptyProgress();
    }
  })();

  const persist = (): void => {
    if (storage === undefined) return;
    try {
      storage.setItem(key, JSON.stringify(current));
    } catch {
      // Quota exceeded or storage revoked mid-session: keep going in memory.
    }
  };

  /** Callers get defensive copies — the store's snapshot is never aliased. */
  const snapshot = (): LabProgress => structuredClone(current);

  return {
    read: snapshot,
    recordCheckpoint(widgetId, questionId, result) {
      const next = snapshot();
      (next.checkpoints[widgetId] ??= {})[questionId] = { ...result };
      current = next;
      persist();
      return snapshot();
    },
    setModuleViewed(moduleId) {
      if (current.viewedModules[moduleId] === true) return snapshot();
      const next = snapshot();
      next.viewedModules[moduleId] = true;
      current = next;
      persist();
      return snapshot();
    },
    setModuleCompleted(moduleId, completed) {
      const next = snapshot();
      if (completed) {
        next.completedModules[moduleId] = true;
      } else {
        delete next.completedModules[moduleId];
      }
      current = next;
      persist();
      return snapshot();
    },
    reset() {
      current = emptyProgress();
      if (storage !== undefined) {
        try {
          storage.removeItem(key);
        } catch {
          // Best effort — in-memory state is already clear.
        }
      }
      return snapshot();
    },
  };
}

/** All checkpoint quizzes in a resolved module (base and overlay alike). */
export function quizWidgetsOf(module: ResolvedModule): OverlayQuizWidget[] {
  return module.widgets.flatMap((resolved) =>
    resolved.widget.type === 'quiz' ? [resolved.widget] : [],
  );
}

/**
 * A module counts as complete once it has checkpoints and the learner has
 * answered every one of its questions correctly. Modules without checkpoints
 * have nothing to pass, so they are never marked complete.
 */
export function isModuleComplete(module: ResolvedModule, progress: LabProgress): boolean {
  const quizzes = quizWidgetsOf(module);
  if (quizzes.length === 0) return false;
  return quizzes.every((quiz) =>
    quiz.questions.every(
      (question) => progress.checkpoints[quiz.id]?.[question.id]?.correct === true,
    ),
  );
}

/**
 * The furthest module (by spec order) the learner has opened or completed —
 * the resume target when they come back to a lab. Undefined until anything
 * has been visited.
 */
export function furthestVisitedModuleId(
  modules: readonly ResolvedModule[],
  progress: LabProgress,
): string | undefined {
  for (let index = modules.length - 1; index >= 0; index -= 1) {
    const module = modules[index] as ResolvedModule;
    if (moduleProgressState(module.id, progress) !== 'unseen') return module.id;
  }
  return undefined;
}

export interface CheckpointStats {
  passed: number;
  total: number;
}

/** Lab-wide checkpoint tally for the sidebar "n / t passed" panel. */
export function countCheckpoints(
  modules: readonly ResolvedModule[],
  progress: LabProgress,
): CheckpointStats {
  let passed = 0;
  let total = 0;
  for (const module of modules) {
    for (const quiz of quizWidgetsOf(module)) {
      for (const question of quiz.questions) {
        total += 1;
        if (progress.checkpoints[quiz.id]?.[question.id]?.correct === true) passed += 1;
      }
    }
  }
  return { passed, total };
}
