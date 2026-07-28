import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Anchor, OverlayCodeWalkthroughWidget } from '@ramplab/spec';
import { CodeBlock } from './CodeBlock.js';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './CodeWalkthrough.module.css';

/**
 * Keys that move the page, so pressing one is the reader reading. ArrowLeft
 * and ArrowRight are absent on purpose: they drive this widget's stepper, and
 * treating them as scrolling makes the sync fight the reader's own choice.
 */
const SCROLL_KEYS = new Set([
  ' ',
  'Spacebar',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
]);

export interface CodeWalkthroughProps {
  widget: OverlayCodeWalkthroughWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
}

/**
 * The Edition walkthrough — the pinned-panel pattern (Apple-tutorials
 * lineage, direction-d.html): every step's serif prose is on the page,
 * inactive steps dimmed; the code panel stays pinned beside them and its
 * highlight follows the active step. Reading pace drives the sync (an
 * IntersectionObserver watches the step crossing the reading line); clicking
 * a step, its bubble, the prev/next controls or ←/→ (once the panel has
 * focus) also steps. Only the code card ever scrolls programmatically — the
 * page moves only on the reader's own navigation.
 *
 * Step line ranges are excerpt-relative; the gutter is numbered from the
 * `source` anchor's start line so the display matches the real file.
 */
export function CodeWalkthrough({ widget, origin = 'base', onAnchorClick }: CodeWalkthroughProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const stepCount = widget.steps.length;
  const step = widget.steps[Math.min(stepIndex, stepCount - 1)];
  const isLast = stepIndex === stepCount - 1;
  const gutterStart = widget.source?.lines?.start ?? 1;

  const stepsRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stepIndexRef = useRef(stepIndex);
  stepIndexRef.current = stepIndex;
  // Scroll-sync only follows the reader's *own* scrolling. A control action
  // (button / bubble / arrow key) is authoritative and switches this off until
  // the reader scrolls again — otherwise the observer, reacting to any page
  // scroll (including the browser auto-scrolling a control into view), would
  // clobber the chosen step. See the observer effect below.
  const syncFromScroll = useRef(false);

  const goTo = (index: number) => {
    setStepIndex(Math.max(0, Math.min(stepCount - 1, index)));
  };

  /**
   * Reader-initiated jump (a control button, a bubble, an arrow key): activate
   * the step, let the pinned code card follow, and take authority away from the
   * scroll-sync until the reader next scrolls. It must NOT scroll the page — the
   * page moves only on the reader's own navigation (the invariant above); only
   * the code card scrolls programmatically, via the effect below.
   */
  const jumpTo = (index: number) => {
    syncFromScroll.current = false;
    goTo(index);
  };

  /**
   * Clicking a step's prose activates it — but selecting text inside that
   * prose also fires a click, which used to yank the code panel to a
   * different step mid-sentence. Copying a line out of a walkthrough is an
   * ordinary thing to do while reading, so a click that ends a selection is
   * not a request to navigate.
   */
  const jumpToUnlessSelecting = (index: number) => {
    const selection = globalThis.getSelection?.();
    if (selection !== null && selection !== undefined && !selection.isCollapsed) return;
    jumpTo(index);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      jumpTo(stepIndex + 1);
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      jumpTo(stepIndex - 1);
    }
  };

  // A genuine reader scroll re-arms scroll-sync. Programmatic scrolls — the
  // browser bringing a control into view, the code card's own scroll —
  // deliberately do not, so they can never move the active step.
  //
  // Keys that scroll the page count as reading, the same as a trackpad. ←/→
  // are pointedly NOT among them: they are this widget's own stepper, and
  // arming on them let the scroll that followed a jump immediately recompute
  // the nearest step and overwrite the step the reader had just chosen.
  useEffect(() => {
    const arm = () => {
      syncFromScroll.current = true;
    };
    // `KeyboardEvent` is React's in this module; this listener wants the DOM one.
    const armOnScrollKey = (event: globalThis.KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) arm();
    };
    window.addEventListener('wheel', arm, { passive: true });
    window.addEventListener('touchmove', arm, { passive: true });
    window.addEventListener('keydown', armOnScrollKey, { passive: true });
    return () => {
      window.removeEventListener('wheel', arm);
      window.removeEventListener('touchmove', arm);
      window.removeEventListener('keydown', armOnScrollKey);
    };
  }, []);

  // Scroll-sync: the step nearest the reading line becomes active.
  //
  // This used to watch discrete IntersectionObserver events against a band
  // 10% of the viewport tall, and take only entries that were intersecting.
  // Two ways that silently desynced: one scroll long enough to carry a step
  // clean across the band between callbacks set nothing, and when no step was
  // inside the band at all — routine on mobile, where the code card occupies
  // that region — nothing updated either. The panel then showed the wrong
  // lines for the paragraph being read, with no sign it had drifted.
  //
  // Measuring distance to the reading line instead has no such gap: whatever
  // the scroll increment, some step is always nearest.
  useEffect(() => {
    const root = stepsRef.current;
    if (root === null) return undefined;
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    const pick = () => {
      frame = 0;
      if (!syncFromScroll.current) return;
      // Skip the work entirely while this walkthrough is off-screen; its
      // active step should also stay where the reader left it.
      const rootRect = root.getBoundingClientRect();
      const viewport = window.innerHeight;
      if (rootRect.bottom < 0 || rootRect.top > viewport) return;
      const readingLine = viewport * 0.4;
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const el of root.querySelectorAll<HTMLElement>('[data-step-index]')) {
        const rect = el.getBoundingClientRect();
        // Zero while the step straddles the line, else the gap to it.
        const distance =
          rect.top > readingLine
            ? rect.top - readingLine
            : rect.bottom < readingLine
              ? readingLine - rect.bottom
              : 0;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = Number(el.dataset['stepIndex']);
        }
      }
      if (bestIndex >= 0) setStepIndex(bestIndex);
    };
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(pick);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [stepCount]);

  // The pinned code card follows the active step — the card scrolls, never
  // the page.
  useEffect(() => {
    const card = cardRef.current;
    if (card === null || typeof card.scrollTo !== 'function') return;
    // Horizontal offset does not carry between steps: scrolling right once to
    // read a long line otherwise left every later step starting mid-line.
    card.scrollLeft = 0;
    const lit = card.querySelector('[data-hl="true"]');
    if (lit === null || card.scrollHeight <= card.clientHeight) return;
    const delta = lit.getBoundingClientRect().top - card.getBoundingClientRect().top;
    const target = card.scrollTop + delta - card.clientHeight / 2 + 24;
    card.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }, [stepIndex]);

  if (step === undefined) return null;

  return (
    <section
      className={styles.frame}
      data-widget="code-walkthrough"
      data-origin={origin}
      aria-label={widget.title ?? 'Code walkthrough'}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <header className={styles.head}>
        <span className={styles.kicker}>
          walkthrough
          {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
        </span>
        {widget.title !== undefined && <h3 className={styles.title}>{widget.title}</h3>}
        {widget.source !== undefined && (
          <div className={styles.source}>
            <code className={styles.path}>{widget.source.file}</code>
            {widget.source.lines !== undefined && (
              <span className={styles.sourceLines}>
                {' '}
                · lines {widget.source.lines.start}–{widget.source.lines.end}
              </span>
            )}
          </div>
        )}
      </header>
      <div className={styles.columns}>
        <div className={styles.steps} ref={stepsRef}>
          {widget.steps.map((s, index) => {
            const active = index === stepIndex;
            const first = gutterStart + s.lines.start - 1;
            const last = gutterStart + s.lines.end - 1;
            return (
              <div
                key={index}
                className={styles.step}
                data-step-index={index}
                data-active={active ? 'true' : undefined}
                onClick={() => jumpToUnlessSelecting(index)}
              >
                <div className={styles.stepMark}>
                  <button
                    type="button"
                    className={styles.bubble}
                    aria-label={`Go to step ${index + 1}`}
                    aria-current={active ? 'step' : undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      jumpTo(index);
                    }}
                  >
                    {index + 1}
                  </button>
                  <span className={styles.lineRef}>
                    {s.lines.start === s.lines.end ? `line ${first}` : `lines ${first}–${last}`}
                  </span>
                </div>
                <div className={styles.body}>
                  <p>
                    <InlineProse text={s.commentary.body} />
                  </p>
                  {s.commentary.anchors !== undefined && s.commentary.anchors.length > 0 && (
                    <span className={styles.anchors}>
                      {s.commentary.anchors.map((anchor, anchorIndex) => (
                        <AnchorChip
                          key={anchorIndex}
                          anchor={anchor}
                          className={styles.anchor}
                          onAnchorClick={onAnchorClick}
                        />
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className={styles.codePanel}>
          <div className={styles.codeCard} ref={cardRef}>
            <CodeBlock
              code={widget.code}
              file={widget.source?.file}
              gutterStart={gutterStart}
              highlight={step.lines}
              dimUnlit
            />
          </div>
          <div className={styles.controls}>
            <button
              type="button"
              className={styles.controlButton}
              disabled={stepIndex === 0}
              onClick={() => jumpTo(stepIndex - 1)}
            >
              ← prev
            </button>
            <button
              type="button"
              className={styles.controlButton}
              onClick={() => jumpTo(isLast ? 0 : stepIndex + 1)}
            >
              {isLast ? 'restart ↺' : 'next →'}
            </button>
            <span className={styles.counter}>
              step {stepIndex + 1} of {stepCount}
            </span>
          </div>
          {/* Shown only while the frame has focus — the arrow keys are its
              reason for being focusable, and nothing else announced them. */}
          <p className={styles.keyHint}>← → to step through</p>
        </div>
      </div>
    </section>
  );
}
