// The shared inline-prose renderer (issue #23): backtick spans in prose become
// Edition inline <code>. Unit tests cover the parser's contract directly, and
// one component test asserts a real <code> lands in the DOM.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OverlayCalloutWidget } from '@ramplab/spec';
import { Callout } from '../src/Callout.js';
import { InlineProse, parseInlineProse } from '../src/InlineProse.js';

describe('parseInlineProse', () => {
  it('passes prose with no backticks straight through as one text token', () => {
    expect(parseInlineProse('App.Start boots the server')).toEqual([
      { text: 'App.Start boots the server' },
    ]);
  });

  it('splits a paired span into text and code tokens', () => {
    expect(parseInlineProse('call `ServeHTTP` here')).toEqual([
      { text: 'call ' },
      { code: 'ServeHTTP' },
      { text: ' here' },
    ]);
  });

  it('parses multiple spans in one string', () => {
    expect(parseInlineProse('`App.Start` calls `caddyhttp.Server`')).toEqual([
      { code: 'App.Start' },
      { text: ' calls ' },
      { code: 'caddyhttp.Server' },
    ]);
  });

  it('renders an unpaired backtick literally', () => {
    expect(parseInlineProse('a stray ` backtick')).toEqual([
      { text: 'a stray ` backtick' },
    ]);
  });

  it('keeps a trailing unpaired backtick after a valid span literal', () => {
    expect(parseInlineProse('`changeConfig` then a stray ` mark')).toEqual([
      { code: 'changeConfig' },
      { text: ' then a stray ` mark' },
    ]);
  });

  it('drops an empty span without emitting an odd token', () => {
    expect(parseInlineProse('before `` after')).toEqual([
      { text: 'before ' },
      { text: ' after' },
    ]);
    expect(parseInlineProse('``')).toEqual([]);
  });

  it('handles a code span that spans the whole string', () => {
    expect(parseInlineProse('`ServeHTTP`')).toEqual([{ code: 'ServeHTTP' }]);
  });

  it('never throws on a lone backtick', () => {
    expect(() => parseInlineProse('`')).not.toThrow();
    expect(parseInlineProse('`')).toEqual([{ text: '`' }]);
  });
});

describe('<InlineProse>', () => {
  it('renders a backtick span as a styled <code> element', () => {
    const { container } = render(<InlineProse text="the `ServeHTTP` method" />);
    const code = container.querySelector('code[data-inline-code="true"]');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('ServeHTTP');
    // The surrounding prose stays plain text (no code wrapper).
    expect(container).toHaveTextContent('the ServeHTTP method');
  });

  it('emits plain text with no <code> when there are no backticks', () => {
    const { container } = render(<InlineProse text="plain prose only" />);
    expect(container.querySelector('code')).toBeNull();
    expect(screen.getByText('plain prose only')).toBeInTheDocument();
  });
});

describe('inline code in a widget', () => {
  it('renders a callout body identifier as inline <code>', () => {
    const widget: OverlayCalloutWidget = {
      id: 'why-serve',
      type: 'callout',
      kind: 'why',
      body: 'The listener hands the request to `ServeHTTP` on the root server.',
    };
    const { container } = render(<Callout widget={widget} />);
    const code = container.querySelector('code[data-inline-code="true"]');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('ServeHTTP');
    // The provenance anchor chips (also <code>) stay a separate concern.
    expect(container.querySelector('[data-inline-code="true"]')).toBe(code);
  });
});
