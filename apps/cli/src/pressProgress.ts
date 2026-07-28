import { GENERATION_STAGES, type GenerationProgressEvent, type GenerationStageName } from '@ramplab/generator';
import { PLAIN_STYLE, type PressStyle } from './colors.js';

/**
 * What a pressing looks like while it is happening (#164).
 *
 * `ramplab generate` used to print a line per event and then go quiet for
 * minutes, on a run the site advertises as about half an hour. Nothing on
 * screen changed between a stage starting and finishing, so a working press
 * and a hung one were indistinguishable, which is the one job the output has.
 *
 * The fix is not a livelier verb. Whether something is frozen comes down to
 * two independently moving numbers, so every frame carries elapsed time, and
 * the long stage carries chapters landed.
 *
 * **A bar is only drawn where there is something to measure.** Authoring is
 * the only stage with a countable total, and it only has one because the plan
 * now says so out loud. Map, verify and assemble get the verb and the clock
 * and no bar, rather than a bar that is guessing. A progress bar that is not
 * measuring anything is the fastest way to make a progress display worthless,
 * and it would be a strange thing to ship in a product whose whole claim is
 * that it does not assert what it cannot check.
 *
 * State and frame are pure, so the display is tested by folding events and
 * comparing strings, with no terminal anywhere near it. Time is passed in.
 */

export type StageStatus = 'pending' | 'active' | 'done';

export interface StageState {
  name: GenerationStageName;
  status: StageStatus;
  startedMs?: number;
  endedMs?: number;
}

export interface PressState {
  /** What is being pressed, for the heading. */
  subject: string;
  stages: StageState[];
  /** The chapters the plan committed to. Absent until the plan settles. */
  planned?: { id: string; title: string }[];
  /** Chapters that have landed, in the order they landed. */
  authored: { id: string; attempts: number }[];
  startedMs: number;
}

export function initialPressState(subject: string, nowMs: number): PressState {
  return {
    subject,
    stages: GENERATION_STAGES.map((name) => ({ name, status: 'pending' as StageStatus })),
    authored: [],
    startedMs: nowMs,
  };
}

/** Fold one progress event into the display's state. Pure. */
export function foldPressEvent(
  state: PressState,
  event: GenerationProgressEvent,
  nowMs: number,
): PressState {
  switch (event.type) {
    case 'stage-started':
      return {
        ...state,
        stages: state.stages.map((stage) =>
          stage.name === event.stage
            ? { ...stage, status: 'active', startedMs: nowMs }
            : stage,
        ),
      };
    case 'stage-completed':
      return {
        ...state,
        stages: state.stages.map((stage) =>
          stage.name === event.stage ? { ...stage, status: 'done', endedMs: nowMs } : stage,
        ),
      };
    case 'plan-ready':
      return { ...state, planned: event.modules };
    case 'module-authored':
      return {
        ...state,
        authored: [...state.authored, { id: event.moduleId, attempts: event.attempts }],
      };
    case 'spec-updated':
      // The snapshot drives the reader's saved-on-interrupt copy, not the
      // display: chapters landed already come from module-authored, and
      // counting a spec's modules would double-count the overview.
      return state;
  }
}

/** `4m 12s`, `41s`. Whole seconds: a jittering tenth reads as noise. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Present continuous while it runs, past tense once it has (Evil Martians). */
const VERBS: Record<GenerationStageName, { running: string; done: string }> = {
  map: { running: 'mapping the repository', done: 'mapped' },
  plan: { running: 'planning the chapters', done: 'planned' },
  author: { running: 'authoring', done: 'authored' },
  verify: { running: 'verifying every claim', done: 'verified' },
  assemble: { running: 'assembling the edition', done: 'assembled' },
};

/** Frames for the active stage. Same cadence as the rest of the terminal. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export interface RenderOptions {
  /** Columns available. Narrower terminals drop the bar before the numbers. */
  width?: number;
  /** Spinner frame index; the caller ticks it. */
  frame?: number;
  /** Interrupt hint. Omitted once the press is finishing. */
  interruptHint?: boolean;
  /**
   * How to paint it. Defaults to no escape codes at all, which is also what a
   * pipe, a dumb terminal and NO_COLOR get: the shape has to carry the meaning
   * without colour, so the tests read it that way too.
   */
  style?: PressStyle;
}

/**
 * A segmented bar, filled against hollow, as in the reference. Never drawn
 * without a real total to divide by.
 */
export function renderBar(
  done: number,
  total: number,
  cells = 20,
  style: PressStyle = PLAIN_STYLE,
): string {
  if (total <= 0) return '';
  const filled = Math.max(0, Math.min(cells, Math.round((done / total) * cells)));
  return `${style.barFilled('▰'.repeat(filled))}${style.barEmpty('▱'.repeat(cells - filled))}`;
}

/**
 * The whole frame, as lines. All five stages are present from the first
 * second, so the shape of the work is legible before anything finishes.
 */
export function renderPress(state: PressState, nowMs: number, options: RenderOptions = {}): string[] {
  const width = options.width ?? 80;
  const frame = options.frame ?? 0;
  const style = options.style ?? PLAIN_STYLE;
  // Ramp in the words' colour, Lab in the accent: the wordmark, as it is set
  // everywhere else.
  const lines: string[] = [`  Ramp${style.brand('Lab')} · pressing ${state.subject}`, ''];

  for (const stage of state.stages) {
    const verbs = VERBS[stage.name];
    if (stage.status === 'done') {
      const took = stage.startedMs !== undefined && stage.endedMs !== undefined
        ? formatElapsed(stage.endedMs - stage.startedMs)
        : '';
      const detail = stageDetail(stage, state);
      lines.push(
        `  ${style.done('✓')} ${verbs.done.padEnd(10)} ${style.dim(took.padStart(7))}${detail === '' ? '' : style.dim(detail)}`,
      );
      continue;
    }
    if (stage.status === 'pending') {
      // Plain names while they wait: a conjugated verb on work that has not
      // started reads as though it had.
      lines.push(`    ${style.pending(stage.name)}`);
      continue;
    }
    // Active: the glyph, the verb, and the clock that proves it is alive.
    const spin = SPINNER[frame % SPINNER.length] ?? SPINNER[0];
    const since = stage.startedMs ?? state.startedMs;
    lines.push(
      `  ${style.active(spin)} ${style.active(`${verbs.running}…`)} ${style.dim(`(${formatElapsed(nowMs - since)})`)}`,
    );

    // Only authoring can be measured, and only once the plan has said how
    // many chapters it committed to.
    const total = state.planned?.length ?? 0;
    if (stage.name === 'author' && total > 0) {
      // Capped at the total on purpose. The zoom-out chapter is written inside
      // this stage but was never part of the plan, so an uncapped count reads
      // "8 of 7" for the minutes it takes. The bar sitting full with the clock
      // still moving is the honest picture: the plan is written, and something
      // beyond it is still going.
      const done = Math.min(state.authored.length, total);
      const cells = width < 60 ? 10 : 20;
      // Not "esc": the reference is an interactive TUI, this is a one-shot
      // command, and ctrl-c is both the convention and the signal we can
      // actually catch. It says what interrupting does, because a press that
      // has run twenty minutes and spent real money should not make anyone
      // guess whether stopping throws it away.
      const hint = options.interruptHint === false ? '' : '   ctrl-c saves what has landed';
      lines.push(
        `    ${renderBar(done, total, cells, style)}  ${done} of ${total}${style.dim(hint)}`,
      );
    }
  }
  return lines;
}

/** The trailing note on a completed stage, where a real number exists. */
function stageDetail(stage: StageState, state: PressState): string {
  if (stage.name === 'plan' && state.planned !== undefined) {
    const count = state.planned.length;
    return `  · ${count} chapter${count === 1 ? '' : 's'} planned`;
  }
  if (stage.name === 'author' && state.authored.length > 0) {
    const retried = state.authored.filter((module) => module.attempts > 1).length;
    const base = `  · ${state.authored.length} chapter${state.authored.length === 1 ? '' : 's'} written`;
    return retried === 0 ? base : `${base}, ${retried} retried`;
  }
  return '';
}
