import type { GenerationProgressEvent } from '@ramplab/generator';
import { formatElapsed, type PressState } from './pressProgress.js';

/**
 * Turn a generation progress event into a single terminal line — or
 * `undefined` for events that shouldn't print.
 *
 * The `onProgress` callback is the generator's streaming seam (see the
 * generator's `progress.ts`): a server slice forwards these over SSE, and the
 * CLI prints them. `spec-updated` snapshots exist for renderers to display
 * as-is, not for the terminal, so we drop them here to keep output quiet.
 *
 * **What #164 fixed for terminals, and not for pipes.** A live press proves it
 * is alive with two independently moving numbers. The log had neither: `▸ map…`
 * and then eight minutes of silence, with no way to tell a working press from a
 * wedged one short of running `stat` on the file. So a completed stage now says
 * how long it took, and `plan-ready` prints instead of being dropped on the
 * floor — it exists precisely to carry the denominator out of the generator
 * (#164), and the log was the one display that never received it. That matters
 * most here rather than least: piped output is what CI keeps and what people
 * paste into issues.
 *
 * Stage names stay as the generator names them. This is a log; the conjugated
 * verbs belong to the frame that has room for them.
 *
 * The state is the same one the live display folds (`pressProgress.ts`), passed
 * in already folded, so both displays read one model rather than two.
 */
export function formatProgress(
  event: GenerationProgressEvent,
  state: PressState,
): string | undefined {
  switch (event.type) {
    case 'stage-started':
      return `▸ ${event.stage}…`;
    case 'stage-completed': {
      const stage = state.stages.find((entry) => entry.name === event.stage);
      const took =
        stage?.startedMs !== undefined && stage.endedMs !== undefined
          ? ` (${formatElapsed(stage.endedMs - stage.startedMs)})`
          : '';
      return `✓ ${event.stage}${took}`;
    }
    case 'plan-ready': {
      const count = event.modules.length;
      return (
        `  · ${count} chapter${count === 1 ? '' : 's'} planned: ` +
        `${event.modules.map((module) => module.id).join(', ')}`
      );
    }
    case 'module-authored': {
      const attempts = `${event.attempts} attempt${event.attempts === 1 ? '' : 's'}`;
      // The denominator, now that the log has one — but only while it counts
      // something. The overview chapter is re-authored after the fan-out
      // closes, so it lands beyond the plan it was never part of, and quoting
      // it as "7 of 6" is worse than quoting nothing.
      const total = state.planned?.length;
      const done = state.authored.length;
      const progress = total === undefined || done > total ? '' : ` [${done} of ${total}]`;
      return `  · authored ${event.moduleId} (${attempts})${progress}`;
    }
    case 'spec-updated':
      return undefined;
  }
}
