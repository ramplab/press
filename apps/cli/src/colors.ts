/**
 * The library's colours, in a terminal (#164).
 *
 * Taken from `packages/renderer/src/theme.css`, dark theme, because a
 * terminal is a dark surface and these are the same tokens the reader and the
 * site use. An edition pressed on the command line and the same edition read
 * in the library should look like they came from the same place.
 *
 *   accent  #d3906f  terracotta, the active thing
 *   ok      #83bb92  sage, a stage that is finished
 *   ink     #e9e2d1  warm off-white, the words
 *   ink2    #a89f8b  muted, numbers and asides
 *   ink3    #8c8576  furthest back, work not started
 *
 * Truecolor rather than the 16-colour palette, because these exact hues are
 * the point; a terminal that cannot manage it gets no colour at all, which is
 * a better outcome than approximating a brand into whatever `yellow` means on
 * somebody's theme.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The dark-theme tokens, verbatim. */
export const PALETTE = {
  accent: { r: 0xd3, g: 0x90, b: 0x6f },
  ok: { r: 0x83, g: 0xbb, b: 0x92 },
  ink: { r: 0xe9, g: 0xe2, b: 0xd1 },
  ink2: { r: 0xa8, g: 0x9f, b: 0x8b },
  ink3: { r: 0x8c, g: 0x85, b: 0x76 },
} as const satisfies Record<string, Rgb>;

export function paint(text: string, colour: Rgb): string {
  return `\u001b[38;2;${colour.r};${colour.g};${colour.b}m${text}\u001b[39m`;
}

/**
 * Whether to colour at all.
 *
 * `NO_COLOR` is honoured for any non-empty value, per no-color.org, and
 * `FORCE_COLOR` overrides everything including a pipe, which is what a CI
 * that wants colour in its logs sets. Otherwise: only a real terminal.
 */
export function shouldColor(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') {
    return true;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return isTty;
}

/** How each part of a press frame is painted. */
export interface PressStyle {
  /** The `Lab` half of the wordmark. */
  brand(text: string): string;
  /** A finished stage. */
  done(text: string): string;
  /** The stage that is running. */
  active(text: string): string;
  /** Numbers and asides. */
  dim(text: string): string;
  /** Work that has not started. */
  pending(text: string): string;
  /** Filled and hollow bar cells. */
  barFilled(text: string): string;
  barEmpty(text: string): string;
}

/** No escape codes at all: the shape has to carry the meaning on its own. */
export const PLAIN_STYLE: PressStyle = {
  brand: (text) => text,
  done: (text) => text,
  active: (text) => text,
  dim: (text) => text,
  pending: (text) => text,
  barFilled: (text) => text,
  barEmpty: (text) => text,
};

export const COLOR_STYLE: PressStyle = {
  brand: (text) => paint(text, PALETTE.accent),
  done: (text) => paint(text, PALETTE.ok),
  active: (text) => paint(text, PALETTE.accent),
  dim: (text) => paint(text, PALETTE.ink2),
  pending: (text) => paint(text, PALETTE.ink3),
  barFilled: (text) => paint(text, PALETTE.accent),
  barEmpty: (text) => paint(text, PALETTE.ink3),
};

export function styleFor(env: Record<string, string | undefined>, isTty: boolean): PressStyle {
  return shouldColor(env, isTty) ? COLOR_STYLE : PLAIN_STYLE;
}
