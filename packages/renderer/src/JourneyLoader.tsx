import styles from './JourneyLoader.module.css';

/**
 * The Codebase → Journey loader (founder motion spec, "Codebase Journey
 * Loader" — 2026-07-10): a small program inks in line by line while the five
 * pipeline stages (I parse · II lex · III spec · IV guard · V emit) light in
 * sequence and the module counter cycles. The whole animation is CSS
 * keyframes — no hooks, no timers — so the component is RSC-safe and
 * `prefers-reduced-motion` collapses it to the fully-inked static state.
 *
 * Colors ride the Edition tokens (`--ink`/`--ink3`), so it prints correctly
 * in both themes.
 */

export interface JourneyLoaderProps {
  /** The status line, bottom left. @default 'Reading source…' */
  message?: string;
  /** Tighter spacing + smaller type for inline surfaces. */
  compact?: boolean;
  className?: string;
}

/**
 * The snippet, tokenized into the Edition code-panel roles (§4.5): keywords
 * in the edition's ink, function names in Prussian blue, everything else the
 * panel ink — set in the mono voice so it reads as code, not prose.
 */
type Token = { text: string; role?: 'kw' | 'fn' };
const CODE_LINES: Token[][] = [
  [
    { text: 'export', role: 'kw' },
    { text: ' ' },
    { text: 'function', role: 'kw' },
    { text: ' ' },
    { text: 'parseSource', role: 'fn' },
    { text: '(src) {' },
  ],
  [
    { text: '  ' },
    { text: 'const', role: 'kw' },
    { text: ' tokens = ' },
    { text: 'tokenize', role: 'fn' },
    { text: '(src);' },
  ],
  [
    { text: '  ' },
    { text: 'const', role: 'kw' },
    { text: ' spec = ' },
    { text: 'buildSpec', role: 'fn' },
    { text: '(tokens);' },
  ],
  [
    { text: '  ' },
    { text: 'const', role: 'kw' },
    { text: ' result = ' },
    { text: 'validate', role: 'fn' },
    { text: '(spec);' },
  ],
  [
    { text: '  ' },
    { text: 'return', role: 'kw' },
    { text: ' ' },
    { text: 'emitLab', role: 'fn' },
    { text: '(result);' },
  ],
  [{ text: '}' }],
];

const STAGES = ['parse', 'lex', 'spec', 'guard', 'emit'] as const;
const NUMERALS = ['I', 'II', 'III', 'IV', 'V'] as const;

export function JourneyLoader({ message = 'Reading source…', compact, className }: JourneyLoaderProps) {
  return (
    <div
      className={`${styles.loader} ${compact ? styles.compact : ''} ${className ?? ''}`}
      role="status"
      aria-label={message}
    >
      <div className={styles.head} aria-hidden="true">
        <span>RampLab</span>
        <span>Codebase → Journey</span>
      </div>

      <pre className={styles.code} aria-hidden="true">
        {CODE_LINES.map((line, i) => (
          <span key={i} className={styles.line} style={{ '--i': i } as React.CSSProperties}>
            {line.map((part, j) => (
              <span
                key={j}
                className={
                  part.role === 'kw' ? styles.kw : part.role === 'fn' ? styles.fn : undefined
                }
              >
                {part.text}
              </span>
            ))}
            {'\n'}
          </span>
        ))}
      </pre>

      <div className={styles.stages} aria-hidden="true">
        {STAGES.map((stage, i) => (
          <span key={stage} className={styles.stage} style={{ '--i': i } as React.CSSProperties}>
            <span className={styles.numeral}>{NUMERALS[i]}</span>
            <span className={styles.stageLabel}>{stage}</span>
          </span>
        ))}
      </div>

      <div className={styles.foot}>
        <span className={styles.message}>{message}</span>
        <span className={styles.counter} aria-hidden="true">
          {STAGES.map((_, i) => (
            <span key={i} className={styles.count} style={{ '--i': i } as React.CSSProperties}>
              {i + 1}&nbsp;/&nbsp;5 modules
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
