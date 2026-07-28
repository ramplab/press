import { useState } from 'react';
import type { Anchor, OverlayQuizWidget, QuizQuestion } from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import type { CheckpointResult } from './progress.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './Quiz.module.css';

const KEY_LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export interface QuizProps {
  widget: OverlayQuizWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Persisted checkpoint results by question id (from the progress store). */
  results?: Record<string, CheckpointResult> | undefined;
  /** Called when the learner checks an answer. */
  onResult?: (questionId: string, result: CheckpointResult) => void;
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
  /**
   * The serif line the completion moment shows — the Lab passes the
   * chapter-bound copy ("Chapter II is bound into your edition.").
   */
  completionNote?: string | undefined;
}

/**
 * The end-of-chapter checkpoint (Edition): the whole operated surface —
 * prompts, key-cap options, verdicts, anchored explanations — is sans
 * machinery; the section title and the restrained "bound" completion moment
 * are the book speaking (serif display). Behavior is unchanged from the
 * reference model: pick, check, anchored explanation on right AND wrong,
 * retry on a miss; passed questions arrive pre-locked via `results` so
 * progress survives reload.
 */
export function Quiz({
  widget,
  origin = 'base',
  results,
  onResult,
  onAnchorClick,
  completionNote,
}: QuizProps) {
  const passedCount = widget.questions.filter(
    (question) => results?.[question.id]?.correct === true,
  ).length;
  const allPassed = passedCount === widget.questions.length;

  return (
    <section className={styles.frame} data-widget="quiz" data-origin={origin}>
      <header className={styles.head}>
        <span className={styles.kicker}>
          checkpoint
          {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
        </span>
        <h3 className={styles.title}>{widget.title ?? 'Checkpoint'}</h3>
        <p className={styles.sub}>
          Answered in place: nothing is graded, everything is explained.
          <span className={styles.tally}>
            {' '}
            {passedCount} / {widget.questions.length} passed
          </span>
        </p>
      </header>
      {widget.questions.map((question, index) => (
        <Question
          key={question.id}
          question={question}
          number={index + 1}
          passed={results?.[question.id]?.correct === true}
          onResult={onResult}
          onAnchorClick={onAnchorClick}
        />
      ))}
      {allPassed && (
        <footer className={styles.complete} data-quiz-complete="true">
          <div className={styles.stars} aria-hidden="true">
            ✦ ✦ ✦
          </div>
          {completionNote !== undefined && <div className={styles.bound}>{completionNote}</div>}
          <div className={styles.completeSub}>
            Checkpoint passed: all {widget.questions.length} question
            {widget.questions.length === 1 ? '' : 's'} answered correctly.
          </div>
        </footer>
      )}
    </section>
  );
}

function Question({
  question,
  number,
  passed,
  onResult,
  onAnchorClick,
}: {
  question: QuizQuestion;
  number: number;
  /** Persisted pass from the progress store — renders pre-locked. */
  passed: boolean;
  onResult?: ((questionId: string, result: CheckpointResult) => void) | undefined;
  onAnchorClick?: ((anchor: Anchor) => void) | undefined;
}) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<'correct' | 'incorrect' | undefined>(undefined);

  const outcome = passed ? 'correct' : checked;
  const locked = outcome !== undefined;

  const check = () => {
    if (selectedId === undefined || locked) return;
    const correct = selectedId === question.correctOptionId;
    setChecked(correct ? 'correct' : 'incorrect');
    onResult?.(question.id, { selectedOptionId: selectedId, correct });
  };

  const tryAgain = () => {
    setSelectedId(undefined);
    setChecked(undefined);
  };

  /** Feedback shown on each option once the answer is checked. */
  const optionState = (optionId: string): 'correct' | 'wrong' | undefined => {
    if (!locked) return undefined;
    if (optionId === question.correctOptionId) return 'correct';
    if (outcome === 'incorrect' && optionId === selectedId) return 'wrong';
    return undefined;
  };

  return (
    <div
      className={styles.question}
      data-question-id={question.id}
      data-outcome={outcome}
      role="group"
      aria-label={`Question ${number}`}
    >
      <p className={styles.prompt}>
        <span className={styles.promptNumber} aria-hidden="true">
          {number}.
        </span>
        {question.prompt}
        <span className={styles.status} aria-hidden="true">
          {outcome === 'correct' ? ' ✓' : outcome === 'incorrect' ? ' ✕' : ''}
        </span>
      </p>
      <div className={styles.options}>
        {question.options.map((option, optionIndex) => (
          <button
            key={option.id}
            type="button"
            className={styles.option}
            disabled={locked}
            aria-pressed={option.id === selectedId}
            data-state={optionState(option.id)}
            onClick={() => setSelectedId(option.id)}
          >
            <span className={styles.keyCap} aria-hidden="true">
              {KEY_LETTERS[optionIndex] ?? optionIndex + 1}
            </span>
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <div className={styles.actions}>
        {!locked && (
          <button
            type="button"
            className={styles.checkButton}
            disabled={selectedId === undefined}
            onClick={check}
          >
            Check answer
          </button>
        )}
        {outcome === 'incorrect' && (
          <button type="button" className={styles.retryButton} onClick={tryAgain}>
            Try again
          </button>
        )}
        {outcome === 'correct' && <span className={styles.verdict}>Correct.</span>}
        {outcome === 'incorrect' && <span className={styles.verdictWrong}>Not quite.</span>}
      </div>
      {locked && (
        <div className={styles.explanation}>
          <b>Why:</b> <InlineProse text={question.explanation.body} />
          {question.explanation.anchors !== undefined &&
            question.explanation.anchors.length > 0 && (
              <span className={styles.anchors}>
                {question.explanation.anchors.map((anchor, index) => (
                  <AnchorChip
                    key={index}
                    anchor={anchor}
                    className={styles.anchor}
                    onAnchorClick={onAnchorClick}
                  />
                ))}
              </span>
            )}
        </div>
      )}
    </div>
  );
}
