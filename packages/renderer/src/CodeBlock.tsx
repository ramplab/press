import { useMemo } from 'react';
import { highlightLines } from './highlight.js';
import styles from './CodeBlock.module.css';

export interface CodeBlockProps {
  /** The excerpt, one entry per line. */
  code: readonly string[];
  /** Source path — drives language detection (extension) only. */
  file?: string | undefined;
  /** Real-file number of the first line (the gutter matches the repo). */
  gutterStart?: number;
  /** Excerpt-relative 1-based range to mark with the wash + bar. */
  highlight?: { start: number; end: number } | undefined;
  /**
   * Walkthrough mode: lines outside `highlight` dim (the Apple-tutorials
   * focus device). Figures render every line at full strength.
   */
  dimUnlit?: boolean;
}

/**
 * The Edition code panel: mono only, syntax colors as `--code-*` custom
 * properties (both printings from one set of spans), the current range marked
 * with the accent wash and bar. Comments carry the quiet italic.
 */
export function CodeBlock({ code, file, gutterStart = 1, highlight, dimUnlit = false }: CodeBlockProps) {
  const tokenLines = useMemo(() => highlightLines(code, file), [code, file]);
  return (
    <pre className={styles.code}>
      {tokenLines.map((tokens, index) => {
        const lineNumber = index + 1;
        const lit =
          highlight !== undefined && lineNumber >= highlight.start && lineNumber <= highlight.end;
        return (
          <span
            key={index}
            className={styles.line}
            data-hl={lit ? 'true' : undefined}
            data-dim={dimUnlit && !lit ? 'true' : undefined}
          >
            <span className={styles.lineNumber} aria-hidden="true">
              {gutterStart + index}
            </span>
            <span className={styles.lineText}>
              {tokens.length === 1 && tokens[0]?.text === ''
                ? ' '
                : tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      style={{
                        ...(token.color !== undefined ? { color: token.color } : {}),
                        ...(token.italic === true ? { fontStyle: 'italic' } : {}),
                      }}
                    >
                      {token.text}
                    </span>
                  ))}
            </span>
          </span>
        );
      })}
    </pre>
  );
}
