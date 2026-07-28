import { useEffect, useState } from 'react';
import type { Anchor, OverlayPipelineWidget, PipelineStage } from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './PipelineRunner.module.css';

export interface PipelineRunnerProps {
  widget: OverlayPipelineWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Book-furniture figure number, e.g. "Figure III" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
}

/** How long each stage stays active during play (the reference lab's 640ms). */
const PLAY_STEP_MS = 640;

/** Playhead position: -1 = idle, 0..n-1 = that stage active, n = complete. */
const IDLE = -1;

/**
 * Pipeline-runner widget, ported from the reference lab's validation
 * pipeline (`.pipeline`/`.pstage`): a joined row of stages the learner plays
 * or steps through. As data progresses, each stage lights up in turn — done
 * stages keep their flow line — and the info panel below shows the active
 * stage's description with its anchor chips. Play and per-stage stepping
 * drive the same discrete playhead, so everything still works with
 * animations off (prefers-reduced-motion only disables the CSS motion).
 */
export function PipelineRunner({ widget, origin = 'base', figureLabel, onAnchorClick }: PipelineRunnerProps) {
  const stageCount = widget.stages.length;
  const [position, setPosition] = useState(IDLE);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return undefined;
    if (position >= stageCount) {
      setPlaying(false);
      return undefined;
    }
    const timer = setTimeout(() => setPosition((current) => current + 1), PLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, position, stageCount]);

  const complete = position >= stageCount;
  const active = position >= 0 && !complete ? widget.stages[position] : undefined;

  const onPlayPause = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // Play restarts a finished run and picks an idle one up from the top.
    if (position === IDLE || complete) setPosition(0);
    setPlaying(true);
  };

  const onStep = () => {
    setPlaying(false);
    setPosition((current) => Math.min(current + 1, stageCount));
  };

  const onReset = () => {
    setPlaying(false);
    setPosition(IDLE);
  };

  const jumpTo = (index: number) => {
    setPlaying(false);
    setPosition(index);
  };

  return (
    <section
      className={styles.frame}
      data-widget="pipeline"
      data-origin={origin}
      aria-label={widget.title ?? 'Pipeline'}
    >
      <header className={styles.head}>
        <span className={styles.badge}>
          {figureLabel !== undefined ? `${figureLabel} · ` : ''}pipeline
        </span>
        <span className={styles.title}>{widget.title ?? 'Pipeline'}</span>
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
      </header>
      <div className={styles.body}>
        <div className={styles.controls}>
          <button type="button" className={styles.btn} onClick={onPlayPause}>
            {playing ? '❚❚ pause' : '▶ play'}
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={onStep}
            disabled={complete}
          >
            step →
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={onReset}
            disabled={position === IDLE}
          >
            ↺ reset
          </button>
          <span className={styles.progress}>
            {position === IDLE
              ? `${stageCount} stages`
              : complete
                ? `done · ${stageCount} / ${stageCount}`
                : `stage ${position + 1} / ${stageCount}`}
          </span>
        </div>
        <div className={styles.pipeline}>
          {widget.stages.map((stage, index) => {
            const state = index === position ? 'active' : index < position ? 'done' : 'idle';
            return (
              <button
                key={stage.id}
                type="button"
                className={styles.stage}
                data-state={state}
                aria-current={state === 'active' ? 'step' : undefined}
                onClick={() => jumpTo(index)}
              >
                <span className={styles.stageId}>{stage.id}</span>
                <span className={styles.stageLabel}>{stage.label}</span>
                <span className={styles.stageFlow}>
                  {state !== 'idle' ? flowLine(stage) : ''}
                </span>
              </button>
            );
          })}
        </div>
        <div className={styles.info}>
          {position === IDLE ? (
            <span className={styles.placeholder}>
              Press play, or step through the pipeline stage by stage.
            </span>
          ) : complete ? (
            <p className={styles.complete}>
              Pipeline complete: all {stageCount} stages run.
            </p>
          ) : (
            active !== undefined && (
              <>
                <p className={styles.stageLine}>
                  <b>{active.label}</b>
                  {active.description !== undefined && (
                    <>: <InlineProse text={active.description.body} /></>
                  )}
                </p>
                {active.flow !== undefined && (
                  <p className={styles.flowDetail}>
                    {active.flow.in !== undefined && (
                      <span>
                        <span className={styles.flowKey}>in</span>{' '}
                        <InlineProse text={active.flow.in} />
                      </span>
                    )}
                    {active.flow.out !== undefined && (
                      <span>
                        <span className={styles.flowKey}>out</span>{' '}
                        <InlineProse text={active.flow.out} />
                      </span>
                    )}
                  </p>
                )}
                {active.description !== undefined &&
                  active.description.anchors !== undefined &&
                  active.description.anchors.length > 0 && (
                    <span className={styles.anchors}>
                      {active.description.anchors.map((anchor, index) => (
                        <AnchorChip
                          key={index}
                          anchor={anchor}
                          className={styles.anchor}
                          onAnchorClick={onAnchorClick}
                        />
                      ))}
                    </span>
                  )}
              </>
            )
          )}
        </div>
      </div>
    </section>
  );
}

/** The in-stage flow caption: "in → out", or whichever side is present. */
function flowLine(stage: PipelineStage): string {
  if (stage.flow === undefined) return '';
  return [stage.flow.in, stage.flow.out].filter((part) => part !== undefined).join(' → ');
}
