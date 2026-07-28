import { describe, expect, it } from 'vitest';
import type { GenerationProgressEvent } from '@ramplab/generator';
import {
  foldPressEvent,
  formatElapsed,
  initialPressState,
  renderBar,
  renderPress,
  type PressState,
} from '../src/pressProgress.js';

/**
 * The press display (#164). All of it folds events into state and state into
 * strings, so this is the whole thing under test with no terminal involved.
 */

const START = 1_000_000;

function press(events: [GenerationProgressEvent, number][]): PressState {
  return events.reduce(
    (state, [event, at]) => foldPressEvent(state, event, at),
    initialPressState('caddyserver/caddy', START),
  );
}

const started = (stage: string): GenerationProgressEvent =>
  ({ type: 'stage-started', pass: 'pass2', stage }) as GenerationProgressEvent;
const completed = (stage: string): GenerationProgressEvent =>
  ({ type: 'stage-completed', pass: 'pass2', stage }) as GenerationProgressEvent;
const planReady = (n: number): GenerationProgressEvent => ({
  type: 'plan-ready',
  pass: 'pass2',
  modules: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, title: `Chapter ${i}` })),
});
const authored = (id: string, attempts = 1): GenerationProgressEvent => ({
  type: 'module-authored',
  pass: 'pass2',
  moduleId: id,
  attempts,
});

describe('the zoom-out chapter, which the plan never counted', () => {
  it('never counts past the total it is measuring against', () => {
    // The overview is written inside the author stage but was never in the
    // plan, so an uncapped count reads "3 of 2" for the minutes it takes.
    const state = press([
      [planReady(2), START],
      [started('author'), START],
      [authored('m0'), START + 1_000],
      [authored('m1'), START + 2_000],
      [authored('repo-overview'), START + 3_000],
    ]);

    const frame = renderPress(state, START + 4_000).join('\n');

    expect(frame).toContain('2 of 2');
    expect(frame).not.toContain('3 of 2');
  });
});

describe('the shape of the work is visible before anything finishes', () => {
  it('shows all five stages from the first frame', () => {
    const frame = renderPress(initialPressState('caddyserver/caddy', START), START).join('\n');
    for (const stage of ['map', 'plan', 'author', 'verify', 'assemble']) {
      expect(frame).toContain(stage);
    }
    expect(frame).toContain('caddyserver/caddy');
  });
});

describe('liveness', () => {
  it('ticks a clock on the active stage, so a frozen press is distinguishable', () => {
    const state = press([[started('map'), START]]);
    const early = renderPress(state, START + 3_000).join('\n');
    const later = renderPress(state, START + 64_000).join('\n');
    // Nothing else changed; the number did. That is the whole signal.
    expect(early).toContain('(3s)');
    expect(later).toContain('(1m 04s)');
  });

  it('turns the spinner independently of any event arriving', () => {
    const state = press([[started('map'), START]]);
    const a = renderPress(state, START + 1000, { frame: 0 });
    const b = renderPress(state, START + 1000, { frame: 1 });
    expect(a.join('\n')).not.toBe(b.join('\n'));
  });
});

describe('a bar only where there is something to measure', () => {
  it('measures authoring once the plan has committed to a number', () => {
    const state = press([
      [started('map'), START],
      [completed('map'), START + 18_000],
      [started('plan'), START + 18_000],
      [completed('plan'), START + 59_000],
      [planReady(6), START + 59_000],
      [started('author'), START + 59_000],
      [authored('a'), START + 100_000],
      [authored('b'), START + 140_000],
      [authored('c'), START + 180_000],
      [authored('d'), START + 220_000],
    ]);
    const frame = renderPress(state, START + 311_000).join('\n');
    expect(frame).toContain('4 of 6');
    expect(frame).toContain('▰');
    expect(frame).toContain('▱');
    expect(frame).toContain('ctrl-c saves what has landed');
    // Completed stages collapse to one line each, with their own elapsed.
    expect(frame).toContain('✓ mapped');
    expect(frame).toContain('18s');
    expect(frame).toContain('6 chapters planned');
  });

  it('draws no bar for a stage with no total, rather than one that guesses', () => {
    // map, verify and assemble have nothing countable. A bar there would be
    // decoration pretending to be measurement.
    const state = press([
      [started('map'), START],
    ]);
    const frame = renderPress(state, START + 5_000).join('\n');
    expect(frame).toContain('mapping the repository…');
    expect(frame).not.toContain('▰');
    expect(frame).not.toContain('%');
  });

  it('draws no bar while authoring if the plan never announced a total', () => {
    // An older generator that does not emit plan-ready must degrade to the
    // clock, never to a bar over a made-up denominator.
    const state = press([
      [started('author'), START],
      [authored('a'), START + 1000],
    ]);
    const frame = renderPress(state, START + 2000).join('\n');
    expect(frame).toContain('authoring…');
    expect(frame).not.toContain('▰');
  });
});

describe('renderBar', () => {
  it('fills in proportion, and never past the ends', () => {
    expect(renderBar(0, 6, 10)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(renderBar(3, 6, 10)).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(renderBar(6, 6, 10)).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(renderBar(9, 6, 10)).toBe('▰▰▰▰▰▰▰▰▰▰');
  });

  it('is nothing at all without a total to divide by', () => {
    expect(renderBar(2, 0)).toBe('');
  });
});

describe('formatElapsed', () => {
  it('reads the way a person would say it', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(41_000)).toBe('41s');
    expect(formatElapsed(252_000)).toBe('4m 12s');
    expect(formatElapsed(3_600_000)).toBe('60m 00s');
  });
});

describe('past tense on completion', () => {
  it('switches the verb and keeps what the stage produced', () => {
    const state = press([
      [started('author'), START],
      [planReady(3), START],
      [authored('a'), START + 10],
      [authored('b', 2), START + 20],
      [authored('c'), START + 30],
      [completed('author'), START + 40],
    ]);
    const frame = renderPress(state, START + 50).join('\n');
    expect(frame).toContain('✓ authored');
    expect(frame).toContain('3 chapters written');
    // A retry is worth surfacing: it is the difference between a clean run
    // and one that fought.
    expect(frame).toContain('1 retried');
    expect(frame).not.toContain('ctrl-c');
  });
});
