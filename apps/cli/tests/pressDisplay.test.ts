import { describe, expect, it } from 'vitest';
import type { GenerationProgressEvent } from '@ramplab/generator';
import {
  createCloneDisplay,
  createLiveDisplay,
  createLogDisplay,
  type OutputStream,
} from '../src/pressDisplay.js';
import { formatProgress } from '../src/reporter.js';

/**
 * The part that owns a cursor. Everything here drives an injected stream and
 * an injected clock, so no test waits on a timer or touches a terminal.
 */

const ESC = '\u001b';

function fakeStream(isTTY: boolean, columns = 80): OutputStream & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    isTTY,
    columns,
    write(chunk) {
      written.push(chunk);
    },
  };
}

/** A timer we tick by hand. */
function fakeTimer() {
  let tick: (() => void) | undefined;
  let cleared = false;
  return {
    fire: () => tick?.(),
    cleared: () => cleared,
    setInterval: (fn: () => void) => {
      tick = fn;
      return { unref: () => {} };
    },
    clearInterval: () => {
      cleared = true;
    },
  };
}

const started = (stage: string): GenerationProgressEvent =>
  ({ type: 'stage-started', pass: 'pass2', stage }) as GenerationProgressEvent;

describe('the live display', () => {
  it('repaints on the clock, not only when an event arrives', () => {
    // The whole point: a stage can take four minutes, and a display that only
    // redraws on events is exactly as silent as the log it replaced.
    const stream = fakeStream(true);
    const timer = fakeTimer();
    let clock = 0;
    const display = createLiveDisplay({
      stream,
      env: { NO_COLOR: '1' },
      subject: 'acme/widgets',
      now: () => clock,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    display.onEvent(started('map'));
    const before = stream.written.length;

    clock = 5000;
    timer.fire();

    expect(stream.written.length).toBeGreaterThan(before);
    expect(stream.written.join('')).toContain('(5s)');
    display.stop();
  });

  it('erases exactly what it drew, so it leaves no trail', () => {
    const stream = fakeStream(true);
    const timer = fakeTimer();
    const display = createLiveDisplay({
      stream,
      env: { NO_COLOR: '1' },
      subject: 'acme/widgets',
      now: () => 0,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    const firstFrame = stream.written[stream.written.length - 1] ?? '';
    const drawn = firstFrame.split('\n').length - 1;

    display.onEvent(started('map'));
    const second = stream.written[stream.written.length - 1] ?? '';
    // Cursor up by exactly the number of lines last painted, then clear down.
    expect(second.startsWith(`${ESC}[${drawn}A${ESC}[0J`)).toBe(true);
    display.stop();
  });

  it('hides the cursor while it owns the screen, and gives it back', () => {
    const stream = fakeStream(true);
    const timer = fakeTimer();
    const display = createLiveDisplay({
      stream,
      env: { NO_COLOR: '1' },
      subject: 'acme/widgets',
      now: () => 0,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
    expect(stream.written[0]).toBe(`${ESC}[?25l`);

    display.stop();
    expect(stream.written[stream.written.length - 1]).toBe(`${ESC}[?25h`);
    // And it stops repainting, so nothing scribbles over what comes next.
    expect(timer.cleared()).toBe(true);
    const after = stream.written.length;
    timer.fire();
    expect(stream.written.length).toBe(after);
  });
});

describe('the log display', () => {
  /** A log display over a clock the test moves by hand. */
  function logDisplay(lines: string[], clock: { ms: number }) {
    return createLogDisplay((line) => lines.push(line), formatProgress, {
      subject: 'acme/widgets',
      now: () => clock.ms,
    });
  }

  it('one line per event, and a finished stage says what it took', () => {
    // What a pipe, a CI job and TERM=dumb get, and what the published CLI's
    // first impression is made of. Before this it had no clock at all: `▸ map…`
    // and then eight minutes in which a working press and a wedged one looked
    // exactly alike.
    const lines: string[] = [];
    const clock = { ms: 0 };
    const display = logDisplay(lines, clock);

    display.onEvent(started('map'));
    clock.ms = 482_000;
    display.onEvent({ type: 'stage-completed', pass: 'pass2', stage: 'map' });
    display.onEvent({ type: 'module-authored', pass: 'pass2', moduleId: 'x', attempts: 1 });
    display.stop();

    expect(lines).toEqual([
      '▸ map…',
      '✓ map (8m 02s)',
      // No plan was announced, so there is no denominator to quote.
      '  · authored x (1 attempt)',
    ]);
    expect(lines.join('')).not.toContain(ESC);
  });

  it('prints what the plan committed to, which the log used to swallow', () => {
    // plan-ready exists to carry the denominator out of the generator (#164),
    // and the log was the one display that dropped it on the floor — in the
    // output CI keeps and people paste into issues.
    const lines: string[] = [];
    const clock = { ms: 0 };
    const display = logDisplay(lines, clock);

    display.onEvent({
      type: 'plan-ready',
      pass: 'pass2',
      modules: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    });
    display.onEvent({ type: 'module-authored', pass: 'pass2', moduleId: 'a', attempts: 2 });

    expect(lines).toEqual([
      '  · 2 chapters planned: a, b',
      '  · authored a (2 attempts) [1 of 2]',
    ]);
  });

  it('quotes no denominator for a chapter that was never in the plan', () => {
    // The overview is re-authored after the fan-out closes, so it lands beyond
    // the plan. "[3 of 2]" is worse than saying nothing.
    const lines: string[] = [];
    const clock = { ms: 0 };
    const display = logDisplay(lines, clock);
    const authored = (moduleId: string): GenerationProgressEvent => ({
      type: 'module-authored',
      pass: 'pass2',
      moduleId,
      attempts: 1,
    });

    display.onEvent({
      type: 'plan-ready',
      pass: 'pass2',
      modules: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    });
    display.onEvent(authored('a'));
    display.onEvent(authored('b'));
    display.onEvent(authored('repo-overview'));

    expect(lines.at(-1)).toBe('  · authored repo-overview (1 attempt)');
    expect(lines.at(-2)).toBe('  · authored b (1 attempt) [2 of 2]');
  });

  it('still drops spec-updated, which is for renderers rather than terminals', () => {
    const lines: string[] = [];
    const clock = { ms: 0 };
    logDisplay(lines, clock).onEvent({
      type: 'spec-updated',
      pass: 'pass2',
      spec: { base: { modules: [] } } as never,
    });

    expect(lines).toEqual([]);
  });
});

describe('the clone display', () => {
  const parse = (chunk: string) => {
    const m = /(Receiving objects|Resolving deltas):\s+(\d+)%/.exec(chunk);
    return m === null
      ? undefined
      : {
          phase: (m[1] === 'Receiving objects' ? 'receiving' : 'resolving') as
            | 'receiving'
            | 'resolving',
          percent: Number(m[2]),
        };
  };

  function make(stream: OutputStream, timer: ReturnType<typeof fakeTimer>, clock: () => number) {
    return createCloneDisplay({
      stream,
      env: { NO_COLOR: '1' },
      subject: 'supabase/supabase',
      parse,
      now: clock,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });
  }

  it('shows the clone is alive before any progress has arrived', () => {
    // The failure this fixes: two minutes of nothing on screen, on a
    // repository big enough to need them.
    const stream = fakeStream(true);
    const timer = fakeTimer();
    let clock = 0;
    const display = make(stream, timer, () => clock);
    clock = 30_000;
    timer.fire();

    const painted = stream.written.join('');
    expect(painted).toContain('cloning supabase/supabase…');
    expect(painted).toContain('(30s)');
    display.stop();
  });

  it('turns git’s own percentage into a bar', () => {
    const stream = fakeStream(true);
    const timer = fakeTimer();
    const display = make(stream, timer, () => 0);
    display.onProgress('Receiving objects:  45% (450/1000), 12 MiB | 3 MiB/s');

    const painted = stream.written.join('');
    expect(painted).toContain('receiving 45%');
    expect(painted).toContain('▰');
    display.stop();
  });

  it('ignores a line that is not progress rather than showing a guess', () => {
    const stream = fakeStream(true);
    const timer = fakeTimer();
    const display = make(stream, timer, () => 0);
    display.onProgress("Cloning into '/tmp/x'...");
    expect(stream.written.join('')).not.toContain('▰');
    display.stop();
  });

  it('erases itself when it is done, so the press starts on a clean screen', () => {
    const stream = fakeStream(true);
    const timer = fakeTimer();
    const display = make(stream, timer, () => 0);
    display.onProgress('Receiving objects:  10% (1/10)');
    display.stop();

    const tail = stream.written.slice(-2).join('');
    expect(tail).toContain(`${ESC}[0J`); // cleared
    expect(tail).toContain(`${ESC}[?25h`); // cursor given back
  });
});
