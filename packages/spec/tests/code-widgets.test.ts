import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '../src/index.js';
import codeLab from './fixtures/code-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(codeLab)) as Record<string, unknown>;
}

/** Shortcut to the base code-walkthrough widget inside a mutable fixture. */
function walkthrough(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[0];
}

/** Shortcut to the base code-figure widget inside a mutable fixture. */
function figure(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[1];
}

describe('codeWalkthroughWidgetSchema', () => {
  it('parses the valid code-widgets fixture lab', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    expect(widget?.type).toBe('code-walkthrough');
    if (widget?.type !== 'code-walkthrough') throw new Error('expected a code walkthrough');
    expect(widget.code).toHaveLength(6);
    expect(widget.steps).toHaveLength(3);
    expect(widget.steps[0]?.commentary.anchors).toHaveLength(1);
    expect(widget.source?.file).toBe('packages/spec/src/parse.ts');
  });

  it('rejects machine-generated step commentary with no anchors', () => {
    const input = fixture();
    walkthrough(input).steps[1].commentary.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].steps[1].commentary.anchors');
  });

  it('rejects step commentary with anchors missing entirely', () => {
    const input = fixture();
    delete walkthrough(input).steps[0].commentary.anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].steps[0].commentary.anchors');
  });

  it('rejects a step whose line range points past the end of the excerpt', () => {
    const input = fixture();
    walkthrough(input).steps[2].lines = { start: 5, end: 9 };

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/line range 5–9 exceeds the excerpt \(6 lines\)/);
    expect(result.error).toContain('base.modules[0].widgets[0].steps[2].lines');
  });

  it('rejects an inverted step line range', () => {
    const input = fixture();
    walkthrough(input).steps[0].lines = { start: 4, end: 2 };

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/lines\.end must be >= lines\.start/);
  });

  it('rejects a walkthrough with no steps', () => {
    const input = fixture();
    walkthrough(input).steps = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one step/i);
  });

  it('rejects a walkthrough with an empty excerpt', () => {
    const input = fixture();
    walkthrough(input).code = [];
    walkthrough(input).steps = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one line/i);
  });

  it('accepts unanchored step commentary in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    expect(widget?.type).toBe('code-walkthrough');
    if (widget?.type !== 'code-walkthrough') throw new Error('expected a code walkthrough');
    expect(widget.steps[0]?.commentary.anchors).toBeUndefined();
  });

  it('still bounds overlay step ranges by the excerpt', () => {
    const input = fixture();
    (input as any).overlay[0].widget.steps[0].lines = { start: 1, end: 3 };

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/exceeds the excerpt \(1 line\)/);
    expect(result.error).toContain('overlay[0].widget.steps[0].lines');
  });
});

describe('codeFigureWidgetSchema', () => {
  it('parses the base code figure with its highlight and anchored caption', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[1];
    expect(widget?.type).toBe('code-figure');
    if (widget?.type !== 'code-figure') throw new Error('expected a code figure');
    expect(widget.code).toHaveLength(4);
    expect(widget.highlight).toEqual({ start: 2, end: 3 });
    expect(widget.caption.anchors).toHaveLength(1);
  });

  it('rejects a machine-generated caption with no anchors', () => {
    const input = fixture();
    figure(input).caption.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[1].caption.anchors');
  });

  it('rejects a highlight range that points past the end of the excerpt', () => {
    const input = fixture();
    figure(input).highlight = { start: 3, end: 12 };

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/line range 3–12 exceeds the excerpt \(4 lines\)/);
    expect(result.error).toContain('base.modules[0].widgets[1].highlight');
  });

  it('accepts an unanchored caption in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[1]?.widget;
    expect(widget?.type).toBe('code-figure');
    if (widget?.type !== 'code-figure') throw new Error('expected a code figure');
    expect(widget.caption.anchors).toBeUndefined();
  });
});
