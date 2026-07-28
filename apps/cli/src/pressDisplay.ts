import type { GenerationProgressEvent } from '@ramplab/generator';
import { styleFor } from './colors.js';
import {
  foldPressEvent,
  formatElapsed,
  initialPressState,
  renderBar,
  renderPress,
  SPINNER,
  type PressState,
} from './pressProgress.js';

/**
 * Putting a press on a terminal, and taking it off again (#164).
 *
 * The frame itself is pure (`pressProgress.ts`); this is the part that owns a
 * cursor. It repaints on a timer as well as on events, because the whole
 * point is that the clock moves while nothing is arriving: a press can spend
 * four minutes inside one stage, and a display that only redraws on events is
 * exactly as silent as the log it replaced.
 *
 * Anything that is not a terminal gets the old one-line-per-event log
 * untouched. That is not politeness, it is the contract: piped output is what
 * CI keeps, what people paste into issues, and what somebody sees the first
 * time they try the published CLI in a script.
 */

/** Where a press writes itself. `columns` and `isTTY` as node's streams have. */
export interface OutputStream {
  write(chunk: string): void;
  columns?: number | undefined;
  isTTY?: boolean | undefined;
}

export interface PressDisplay {
  /** Fold one event in and repaint. */
  onEvent(event: GenerationProgressEvent): void;
  /** Stop repainting and leave the last frame on screen. */
  stop(): void;
}

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

/** Frames per second while a stage is running. Fast enough to read as alive. */
const REPAINT_MS = 120;

export interface LiveDisplayOptions {
  stream: OutputStream;
  env: Record<string, string | undefined>;
  subject: string;
  /** Injected so a test can drive time without waiting for it. */
  now?: () => number;
  /** Injected so a test never starts a real timer. */
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

/**
 * A live, in-place display. Erases exactly the lines it drew last time, so it
 * never leaves a trail and never scrolls a long press off the screen.
 */
export function createLiveDisplay(options: LiveDisplayOptions): PressDisplay {
  const { stream, env, subject } = options;
  const now = options.now ?? ((): number => Date.now());
  const start = now();
  const style = styleFor(env, stream.isTTY === true);
  const setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as never));

  let state: PressState = initialPressState(subject, start);
  let painted = 0;
  let frame = 0;
  let stopped = false;

  const paintFrame = (): void => {
    if (stopped) return;
    const lines = renderPress(state, now(), {
      frame: frame++,
      style,
      ...(stream.columns !== undefined ? { width: stream.columns } : {}),
    });
    // Erase precisely what was drawn, then redraw. Cheaper and steadier than
    // clearing the screen, which flickers and destroys scrollback.
    const rewind = painted === 0 ? '' : `\u001b[${painted}A\u001b[0J`;
    stream.write(`${rewind}${lines.join('\n')}\n`);
    painted = lines.length;
  };

  stream.write(HIDE_CURSOR);
  paintFrame();
  const timer = setTimer(paintFrame, REPAINT_MS);
  timer.unref?.(); // never hold the process open on our account

  return {
    onEvent(event) {
      state = foldPressEvent(state, event, now());
      paintFrame();
    },
    stop() {
      if (stopped) return;
      // One last frame first, so the finished state is what stays on screen
      // rather than whatever the timer last managed.
      paintFrame();
      stopped = true;
      clearTimer(timer);
      stream.write(SHOW_CURSOR);
    },
  };
}

export interface CloneDisplay {
  /** A chunk of git's stderr. */
  onProgress(chunk: string): void;
  stop(): void;
}

/**
 * The clone, while it happens.
 *
 * Cloning a large monorepo is minutes of nothing, before the press has even
 * started and before the press display exists. Git knows exactly how it is
 * getting on and writes it to stderr; we used to collect that into a string
 * and read it only if the clone failed.
 *
 * This one earns a bar under the same rule as the rest: the percentage is
 * git's own count of objects received, not a guess at how long a clone
 * usually takes.
 */
export function createCloneDisplay(options: {
  stream: OutputStream;
  env: Record<string, string | undefined>;
  subject: string;
  parse: (chunk: string) => { phase: 'receiving' | 'resolving'; percent: number } | undefined;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}): CloneDisplay {
  const { stream, env, subject, parse } = options;
  const now = options.now ?? ((): number => Date.now());
  const start = now();
  const style = styleFor(env, stream.isTTY === true);
  const setTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as never));

  let latest: { phase: 'receiving' | 'resolving'; percent: number } | undefined;
  let painted = 0;
  let frame = 0;
  let stopped = false;

  const paint = (): void => {
    if (stopped) return;
    const spin = SPINNER[frame++ % SPINNER.length] ?? SPINNER[0];
    const elapsed = formatElapsed(now() - start);
    const lines = [`  ${style.active(spin)} ${style.active(`cloning ${subject}…`)} ${style.dim(`(${elapsed})`)}`];
    if (latest !== undefined) {
      const verb = latest.phase === 'receiving' ? 'receiving' : 'resolving';
      lines.push(
        `    ${renderBar(latest.percent, 100, 20, style)}  ${style.dim(`${verb} ${latest.percent}%`)}`,
      );
    }
    const rewind = painted === 0 ? '' : `\u001b[${painted}A\u001b[0J`;
    stream.write(`${rewind}${lines.join('\n')}\n`);
    painted = lines.length;
  };

  stream.write(HIDE_CURSOR);
  paint();
  const timer = setTimer(paint, REPAINT_MS);
  timer.unref?.();

  return {
    onProgress(chunk) {
      const parsed = parse(chunk);
      if (parsed !== undefined) latest = parsed;
      paint();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      // Erase it entirely: a finished clone is not what anyone wants left on
      // screen above the press that follows.
      if (painted > 0) stream.write(`\u001b[${painted}A\u001b[0J`);
      stream.write(SHOW_CURSOR);
    },
  };
}

export interface LogDisplayOptions {
  subject: string;
  /** Injected so a test can drive time without waiting for it. */
  now?: () => number;
}

/**
 * One line per event, nothing rewritten. What a pipe, a CI job and `TERM=dumb`
 * get.
 *
 * It folds the same state the live display does, because a log line that says
 * how long a stage took needs to know when the stage began. Nothing is
 * repainted and no cursor is owned: the state exists only so each line can
 * carry what it knows (see `reporter.ts`).
 */
export function createLogDisplay(
  write: (line: string) => void,
  format: (event: GenerationProgressEvent, state: PressState) => string | undefined,
  options: LogDisplayOptions,
): PressDisplay {
  const now = options.now ?? ((): number => Date.now());
  let state: PressState = initialPressState(options.subject, now());

  return {
    onEvent(event) {
      state = foldPressEvent(state, event, now());
      const line = format(event, state);
      if (line !== undefined) write(line);
    },
    stop() {
      /* nothing was taken over, so nothing needs giving back */
    },
  };
}
