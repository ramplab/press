import { Fragment, type ReactElement } from 'react';
import styles from './InlineProse.module.css';

/**
 * A parsed run of prose: either a plain text segment or an inline-code span.
 * The author's serif voice is the text; a `code` token is a backtick span the
 * author marked as code (an identifier, type, function, file path, package).
 */
export type InlineToken = { text: string } | { code: string };

/**
 * Parse a prose string into text/inline-code tokens, splitting on backtick
 * pairs (``like `this` ``). The mono-only-in-code register holds: inline code
 * IS code, so it earns the mono face — nothing else here is styled (no bold,
 * italic or links; the author's prose is plain serif otherwise).
 *
 * Edge cases, all handled without throwing:
 * - an unpaired backtick (no closing partner) renders literally;
 * - an empty span (`` `` ``) contributes nothing;
 * - a stray backtick anywhere never crashes — worst case it prints as itself.
 */
export function parseInlineProse(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text.length > 0) {
      tokens.push({ text });
      text = '';
    }
  };

  while (i < input.length) {
    if (input[i] === '`') {
      const close = input.indexOf('`', i + 1);
      if (close === -1) {
        // Unpaired backtick: no partner, so it is literal punctuation.
        text += '`';
        i += 1;
        continue;
      }
      flushText();
      const code = input.slice(i + 1, close);
      // An empty span (two adjacent backticks) contributes nothing.
      if (code.length > 0) tokens.push({ code });
      i = close + 1;
      continue;
    }
    text += input[i];
    i += 1;
  }

  flushText();
  return tokens;
}

export interface InlineProseProps {
  /** The prose string; backtick spans become inline `<code>`. */
  text: string;
}

/**
 * Render a prose string with its backtick spans as Edition inline code. Drop
 * this in anywhere prose was previously interpolated raw (`{widget.body}` and
 * friends) so inline identifiers read as code in both themes. With no
 * backticks it emits exactly the original text — a transparent passthrough.
 */
export function InlineProse({ text }: InlineProseProps): ReactElement {
  const tokens = parseInlineProse(text);
  return (
    <>
      {tokens.map((token, index) => (
        <Fragment key={index}>
          {'code' in token ? (
            <code className={styles.inlineCode} data-inline-code="true">
              {token.code}
            </code>
          ) : (
            token.text
          )}
        </Fragment>
      ))}
    </>
  );
}
