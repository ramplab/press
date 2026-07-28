import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStallWatchdog, DEFAULT_STALL_TIMEOUT_MS } from '../src/agentSdkRunner.js';

/**
 * The clock the pipeline did not have. A Caddy eval sat in pass-1 authoring
 * for 5h24m on 2026-07-26 because a silent SDK session is indistinguishable
 * from a slow one to `for await`, and `maxTurns` is a turn cap, not a clock.
 */
describe('createStallWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once the idle window elapses', () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog(1000, onStall);
    watchdog.arm();
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(watchdog.stalled).toBe(true);
  });

  it('never fires while messages keep arriving — a slow stage is not a stalled one', () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog(1000, onStall);
    watchdog.arm();
    // An hour of steady activity, each sign of life inside the window.
    for (let i = 0; i < 3600; i++) {
      vi.advanceTimersByTime(900);
      watchdog.arm();
    }
    expect(onStall).not.toHaveBeenCalled();
    expect(watchdog.stalled).toBe(false);
  });

  it('stops firing once disarmed', () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog(1000, onStall);
    watchdog.arm();
    watchdog.disarm();
    vi.advanceTimersByTime(10_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('fires at most once, even if re-armed after stalling', () => {
    const onStall = vi.fn();
    const watchdog = createStallWatchdog(1000, onStall);
    watchdog.arm();
    vi.advanceTimersByTime(1000);
    watchdog.arm();
    vi.advanceTimersByTime(10_000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it('defaults to a window longer than any healthy turn', () => {
    // Express's entire 7-chapter pressing ran 21 minutes across every stage;
    // a single stage silent for 15 is pathological, not slow.
    expect(DEFAULT_STALL_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});
