import { Fragment, useId, useState } from 'react';
import type {
  Anchor,
  DecisionTableExplanation,
  DecisionTableInput,
  DecisionTableInputValue,
  DecisionTableRule,
  OverlayDecisionTableWidget,
} from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './DecisionTable.module.css';

export interface DecisionTableProps {
  widget: OverlayDecisionTableWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Book-furniture figure number, e.g. "Figure III" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
}

type InputValues = Readonly<Record<string, DecisionTableInputValue>>;

type RuleStatus = 'hit' | 'miss' | 'skip';

/**
 * Decision-table / rule playground, ported from the reference lab's `.dt`
 * table and `.bigflag` verdict: the learner edits the inputs on the left,
 * every change re-evaluates the table client-side, and the first matching
 * rule wins. Rows above the hit read `false`; rows below go grey because the
 * table short-circuits. The verdict panel shows the winning outcome and its
 * anchored explanation.
 */
export function DecisionTable({ widget, origin = 'base', figureLabel, onAnchorClick }: DecisionTableProps) {
  const [values, setValues] = useState<InputValues>(() => defaultValues(widget));

  const matchedIndex = widget.rules.findIndex((rule) => ruleMatches(rule, values));
  const matchedRule = matchedIndex === -1 ? undefined : widget.rules[matchedIndex];

  const setValue = (inputId: string, value: DecisionTableInputValue) =>
    setValues((previous) => ({ ...previous, [inputId]: value }));

  return (
    <section className={styles.frame} data-widget="decision-table" data-origin={origin}>
      <header className={styles.head}>
        <span className={styles.badge}>
          {figureLabel !== undefined ? `${figureLabel} · ` : ''}rule playground
        </span>
        <span className={styles.title}>{widget.title ?? 'Decision table'}</span>
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
      </header>
      <div className={styles.body}>
        <div className={styles.grid}>
          <div>
            {widget.inputs.map((input) => (
              <InputControl
                key={input.id}
                input={input}
                value={values[input.id] ?? input.default}
                onChange={(value) => setValue(input.id, value)}
              />
            ))}
          </div>
          <div>
            <Verdict
              widget={widget}
              matchedIndex={matchedIndex}
              matchedRule={matchedRule}
              onAnchorClick={onAnchorClick}
            />
            <p className={styles.tableLabel}>
              The decision table <small>· first match wins</small>
            </p>
            <div className={styles.table}>
              {widget.rules.map((rule, index) => (
                <RuleRow
                  key={index}
                  widget={widget}
                  rule={rule}
                  index={index}
                  status={statusFor(index, matchedIndex)}
                />
              ))}
              {widget.defaultOutcome !== undefined && (
                <div
                  className={styles.rule}
                  data-rule="default"
                  data-rule-status={matchedIndex === -1 ? 'hit' : 'skip'}
                >
                  <span className={styles.ruleNumber}>∅</span>
                  <span className={styles.ruleText}>
                    No rule matched → <b>default: {widget.defaultOutcome.outcome}</b>
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Verdict({
  widget,
  matchedIndex,
  matchedRule,
  onAnchorClick,
}: {
  widget: OverlayDecisionTableWidget;
  matchedIndex: number;
  matchedRule: DecisionTableRule | undefined;
  onAnchorClick: ((anchor: Anchor) => void) | undefined;
}) {
  let matched: 'rule' | 'default' | 'none';
  let outcome: string;
  let sub: string;
  let explanation: DecisionTableExplanation | undefined;

  if (matchedRule !== undefined) {
    matched = 'rule';
    outcome = matchedRule.outcome;
    sub = `rule ${matchedIndex + 1} matched first, so the table short-circuits there`;
    explanation = matchedRule.explanation;
  } else if (widget.defaultOutcome !== undefined) {
    matched = 'default';
    outcome = widget.defaultOutcome.outcome;
    sub = 'no rule matched, so the default outcome applies';
    explanation = widget.defaultOutcome.explanation;
  } else {
    matched = 'none';
    outcome = 'no outcome';
    sub = 'no rule matched and this table declares no default outcome';
    explanation = undefined;
  }

  return (
    <div className={styles.flag} data-matched={matched}>
      <span className={styles.flagIcon} aria-hidden="true">
        {'⚖️'}
      </span>
      <div>
        <div className={styles.flagOutcome}>
          <InlineProse text={outcome} />
        </div>
        <div className={styles.flagSub}>{sub}</div>
        {explanation !== undefined && (
          <>
            <p className={styles.explanation}>
              <InlineProse text={explanation.body} />
            </p>
            <AnchorChips anchors={explanation.anchors} onAnchorClick={onAnchorClick} />
          </>
        )}
      </div>
    </div>
  );
}

function RuleRow({
  widget,
  rule,
  index,
  status,
}: {
  widget: OverlayDecisionTableWidget;
  rule: DecisionTableRule;
  index: number;
  status: RuleStatus;
}) {
  return (
    <div className={styles.rule} data-rule={index + 1} data-rule-status={status}>
      <span className={styles.ruleNumber}>{index + 1}</span>
      <span className={styles.ruleText}>
        {rule.when.map((condition, conditionIndex) => {
          const input = widget.inputs.find((candidate) => candidate.id === condition.input);
          return (
            <Fragment key={conditionIndex}>
              {conditionIndex > 0 && ' AND '}
              {input?.label ?? condition.input} = <b>{valueLabel(input, condition.equals)}</b>
            </Fragment>
          );
        })}
        {' → '}
        <span className={styles.ruleOutcome}>{rule.outcome}</span>
      </span>
      <span className={styles.ruleValue}>
        {status === 'hit' ? 'TRUE → wins' : status === 'miss' ? 'false' : 'not evaluated'}
      </span>
    </div>
  );
}

function InputControl({
  input,
  value,
  onChange,
}: {
  input: DecisionTableInput;
  value: DecisionTableInputValue;
  onChange: (value: DecisionTableInputValue) => void;
}) {
  const controlId = useId();

  if (input.type === 'boolean') {
    return (
      <div className={styles.control}>
        <span className={styles.controlLabel} id={controlId}>
          {input.label}
        </span>
        <div className={styles.chips} role="group" aria-labelledby={controlId}>
          <button type="button" aria-pressed={value === true} onClick={() => onChange(true)}>
            Yes
          </button>
          <button type="button" aria-pressed={value === false} onClick={() => onChange(false)}>
            No
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.control}>
      <label className={styles.controlLabel} htmlFor={controlId}>
        {input.label}
      </label>
      <select
        id={controlId}
        value={typeof value === 'string' ? value : input.default}
        onChange={(event) => onChange(event.target.value)}
      >
        {input.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
    </div>
  );
}

function AnchorChips({
  anchors,
  onAnchorClick,
}: {
  anchors?: readonly Anchor[];
  onAnchorClick?: ((anchor: Anchor) => void) | undefined;
}) {
  if (anchors === undefined || anchors.length === 0) return null;
  return (
    <span className={styles.anchors}>
      {anchors.map((anchor, index) => (
        <AnchorChip
          key={index}
          anchor={anchor}
          className={styles.anchor}
          onAnchorClick={onAnchorClick}
        />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Evaluation: first-matching-rule-wins, exactly the spec's declared semantics.
 * ------------------------------------------------------------------------- */

function defaultValues(widget: OverlayDecisionTableWidget): InputValues {
  return Object.fromEntries(widget.inputs.map((input) => [input.id, input.default]));
}

/** A rule matches when every one of its conditions holds (AND). */
function ruleMatches(rule: DecisionTableRule, values: InputValues): boolean {
  return rule.when.every((condition) => values[condition.input] === condition.equals);
}

/**
 * Row verdicts mirror the reference lab: rows before the hit were evaluated
 * and missed; rows after it were never evaluated at all.
 */
function statusFor(index: number, matchedIndex: number): RuleStatus {
  if (index === matchedIndex) return 'hit';
  if (matchedIndex === -1 || index < matchedIndex) return 'miss';
  return 'skip';
}

function valueLabel(
  input: DecisionTableInput | undefined,
  value: DecisionTableInputValue,
): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (input?.type === 'select') {
    const option = input.options.find((candidate) => candidate.value === value);
    if (option?.label !== undefined) return option.label;
  }
  return value;
}
