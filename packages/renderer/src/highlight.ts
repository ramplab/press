/**
 * Syntax highlighting for the Edition code panels (research.md §4.5).
 *
 * Shiki (sync core + JavaScript regex engine) with a custom theme whose
 * every color is a `var(--code-*)` custom property, so ONE tokenization
 * serves both printings: light/dark resolve entirely in CSS, static
 * prerenders (Next SSG) emit the exact spans the client hydrates, and no
 * highlighting work happens in the browser beyond painting.
 *
 * The palette colors the *language*, never the subject: identifiers,
 * variables and struct fields stay `--code-ink`; comments are the quiet
 * italic voice. Unknown languages fall back to plain ink.
 */
import { createHighlighterCoreSync, type HighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import type { ThemeRegistrationAny } from '@shikijs/types';
import go from '@shikijs/langs/go';
import java from '@shikijs/langs/java';
import python from '@shikijs/langs/python';
import ruby from '@shikijs/langs/ruby';
import tsx from '@shikijs/langs/tsx';
import typescript from '@shikijs/langs/typescript';

/** One paintable slice of a line. */
export interface CodeToken {
  text: string;
  /** Resolved CSS color (a `var(--code-*)` reference) — absent = plain ink. */
  color?: string;
  italic?: boolean;
}

const THEME_NAME = 'ramplab-edition';

/**
 * The Edition theme: TextMate scopes → the §4.5 custom properties. Scope
 * order matters — later, more specific entries win within Shiki's matcher.
 */
const editionTheme: ThemeRegistrationAny = {
  name: THEME_NAME,
  settings: [
    { settings: { foreground: 'var(--code-ink)', background: 'var(--code-bg)' } },
    {
      scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'constant.language.import-export-all'],
      settings: { foreground: 'var(--code-keyword)' },
    },
    {
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
      settings: { foreground: 'var(--code-fn)' },
    },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'entity.name.namespace',
        'entity.other.inherited-class',
        'support.type',
        'support.class',
      ],
      settings: { foreground: 'var(--code-type)' },
    },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: 'var(--code-string)' } },
    {
      scope: ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'],
      settings: { foreground: 'var(--code-num)' },
    },
    {
      scope: ['comment', 'punctuation.definition.comment', 'string.comment'],
      settings: { foreground: 'var(--code-comment)', fontStyle: 'italic' },
    },
    {
      scope: ['punctuation', 'keyword.operator', 'meta.brace'],
      settings: { foreground: 'var(--code-punct)' },
    },
    /* The subject stays ink: names this codebase chose are the author's. */
    {
      scope: ['variable', 'variable.other', 'variable.parameter', 'entity.name.variable', 'meta.definition.variable'],
      settings: { foreground: 'var(--code-ink)' },
    },
  ],
};

/**
 * Lab languages (PLAN §12 targets): Go, TS/TSX, Python, Ruby, Java. Anything
 * else renders plain — graceful, never wrong.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  go: 'go',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  tsx: 'tsx',
  jsx: 'tsx',
  py: 'python',
  rb: 'ruby',
  java: 'java',
};

let highlighter: HighlighterCore | undefined;

function getHighlighter(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    langs: [go, typescript, tsx, python, ruby, java],
    themes: [editionTheme],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighter;
}

/** Language id for a source path, or undefined (→ plain) when unknown. */
export function languageForFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const dot = file.lastIndexOf('.');
  if (dot === -1) return undefined;
  return LANG_BY_EXTENSION[file.slice(dot + 1).toLowerCase()];
}

const PLAIN_INK = 'var(--code-ink)';

/**
 * Tokenize a whole excerpt (block-level, so multi-line strings/comments
 * survive) into per-line token runs. Falls back to plain ink lines when the
 * language is unknown or the grammar rejects the excerpt.
 */
export function highlightLines(code: readonly string[], file?: string): CodeToken[][] {
  const lang = languageForFile(file);
  const plain = (): CodeToken[][] => code.map((line) => [{ text: line }]);
  if (lang === undefined) return plain();
  try {
    const themed = getHighlighter().codeToTokensBase(code.join('\n'), {
      lang,
      theme: THEME_NAME,
    });
    const lines = themed.map((line) =>
      line.map((token) => {
        const italic = ((token.fontStyle ?? 0) & 1) === 1;
        const color = token.color === undefined || token.color === PLAIN_INK ? undefined : token.color;
        return {
          text: token.content,
          ...(color !== undefined ? { color } : {}),
          ...(italic ? { italic: true } : {}),
        };
      }),
    );
    // Shiki drops trailing empty lines; keep the excerpt's line count exact.
    while (lines.length < code.length) lines.push([{ text: '' }]);
    return lines.slice(0, code.length);
  } catch {
    return plain();
  }
}
