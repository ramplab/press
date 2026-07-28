import type { LabSpec } from '@ramplab/spec';
import type { GenerationStageName } from './pipeline.js';

/**
 * Progress streaming for the two-pass runtime (PLAN.md §4).
 *
 * The `onProgress` callback is **the streaming seam**: pass 1's "renders as
 * it streams in" experience is a caller subscribing to these events — no
 * network or server transport lives in this package. A server slice later
 * forwards the same events over SSE/WebSocket; the CLI prints them; tests
 * assert on them.
 *
 * Event vocabulary (deliberately small):
 * - `stage-started` / `stage-completed` — pipeline stage boundaries.
 * - `plan-ready` — the chapters this pressing has committed to, emitted once
 *   the plan stage settles. It exists so a display can say "4 of 6" during
 *   authoring: the numerator was always derivable from `module-authored`, and
 *   the denominator lived and died inside the generator (#164). Authoring is
 *   the long stretch, so this is the difference between a bar that measures
 *   something and one that is guessing.
 * - `module-authored` — one authored module landed (fan-out progress).
 * - `spec-updated` — carries a **complete, schema-valid, anchor-resolved
 *   lab spec** reflecting everything generated so far, so a renderer can
 *   display each snapshot as-is without merging deltas.
 *
 * Callbacks are invoked synchronously and are not awaited; a throwing
 * callback would abort the run, so callers should keep handlers cheap.
 */

/** Which pass of the two-pass runtime emitted an event. */
export type GenerationPass = 'pass1' | 'pass2';

export type GenerationProgressEvent =
  | { type: 'stage-started'; pass: GenerationPass; stage: GenerationStageName }
  | { type: 'stage-completed'; pass: GenerationPass; stage: GenerationStageName }
  | {
      type: 'plan-ready';
      pass: GenerationPass;
      /** The chapters the plan committed to, in reading order. */
      modules: { id: string; title: string }[];
    }
  | {
      type: 'module-authored';
      pass: GenerationPass;
      moduleId: string;
      /** Attempts spent on this module (1 = no retry needed). */
      attempts: number;
    }
  | {
      type: 'spec-updated';
      pass: GenerationPass;
      /** A valid, anchor-resolved snapshot — renderable as-is. */
      spec: LabSpec;
    };

export type ProgressCallback = (event: GenerationProgressEvent) => void;
