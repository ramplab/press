import { describe, expect, it } from 'vitest';
import type { GenerationProgressEvent } from '@ramplab/generator';
import { COLOR_STYLE, PALETTE, PLAIN_STYLE, paint, shouldColor, styleFor } from '../src/colors.js';
import { foldPressEvent, initialPressState, renderPress } from '../src/pressProgress.js';

/**
 * The library's colours in a terminal, and the rule that they disappear
 * wherever they would be noise or damage: a pipe, a dumb terminal, NO_COLOR.
 */

const ESC = '\u001b';
const ACCENT = `${ESC}[38;2;211;144;111m`;

describe('shouldColor', () => {
  it('paints a real terminal', () => {
    expect(shouldColor({}, true)).toBe(true);
  });

  it('never paints a pipe, which is what CI and `| less` are', () => {
    // The public repo's first impression is this output in somebody's log.
    expect(shouldColor({}, false)).toBe(false);
  });

  it('honours NO_COLOR for any value at all', () => {
    expect(shouldColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(shouldColor({ NO_COLOR: 'yes' }, true)).toBe(false);
    // Empty means unset, per no-color.org.
    expect(shouldColor({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('lets FORCE_COLOR win over a pipe, which is how CI asks for colour', () => {
    expect(shouldColor({ FORCE_COLOR: '1' }, false)).toBe(true);
    // '0' is the documented way to say no.
    expect(shouldColor({ FORCE_COLOR: '0' }, false)).toBe(false);
  });

  it('refuses a terminal that says it is dumb', () => {
    expect(shouldColor({ TERM: 'dumb' }, true)).toBe(false);
  });
});

describe('the palette is the library’s, not a guess at it', () => {
  it('uses the renderer’s dark-theme tokens verbatim', () => {
    // packages/renderer/src/theme.css, [data-theme='dark'].
    expect(PALETTE.accent).toEqual({ r: 0xd3, g: 0x90, b: 0x6f }); // --accent
    expect(PALETTE.ok).toEqual({ r: 0x83, g: 0xbb, b: 0x92 }); // --ok
    expect(PALETTE.ink2).toEqual({ r: 0xa8, g: 0x9f, b: 0x8b }); // --ink2
  });

  it('emits truecolor, so the hue is the actual hue', () => {
    expect(paint('x', PALETTE.accent)).toBe(`${ACCENT}x${ESC}[39m`);
  });
});

describe('a frame in both dresses', () => {
  const events: GenerationProgressEvent[] = [
    { type: 'stage-started', pass: 'pass2', stage: 'author' },
    {
      type: 'plan-ready',
      pass: 'pass2',
      modules: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    },
    { type: 'module-authored', pass: 'pass2', moduleId: 'a', attempts: 1 },
  ];
  const state = events.reduce(
    (acc, event) => foldPressEvent(acc, event, 0),
    initialPressState('acme/widgets', 0),
  );

  it('says exactly the same thing with the colour stripped out', () => {
    const coloured = renderPress(state, 5000, { style: COLOR_STYLE }).join('\n');
    const plain = renderPress(state, 5000, { style: PLAIN_STYLE }).join('\n');
    expect(coloured.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')).toBe(plain);
  });

  it('carries no escape codes at all when it is not painting', () => {
    expect(renderPress(state, 5000, { style: PLAIN_STYLE }).join('\n')).not.toContain(ESC);
  });

  it('paints the wordmark, the active stage and the filled bar', () => {
    const coloured = renderPress(state, 5000, { style: COLOR_STYLE }).join('\n');
    expect(coloured).toContain(`Ramp${ACCENT}Lab`);
    expect(coloured).toContain(`${ACCENT}authoring…`);
    expect(coloured).toContain(`${ACCENT}▰`);
  });
});

describe('styleFor', () => {
  it('is the plain one wherever colour would be noise', () => {
    expect(styleFor({}, false)).toBe(PLAIN_STYLE);
    expect(styleFor({ NO_COLOR: '1' }, true)).toBe(PLAIN_STYLE);
    expect(styleFor({}, true)).toBe(COLOR_STYLE);
  });
});
