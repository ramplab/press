import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '../src/index.js';
import decisionTableLab from './fixtures/decision-table-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(decisionTableLab)) as Record<string, unknown>;
}

/** Shortcut to the base decision-table widget inside a mutable fixture. */
function table(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[0];
}

describe('decisionTableWidgetSchema', () => {
  it('parses the valid decision-table fixture lab', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    expect(widget?.type).toBe('decision-table');
    if (widget?.type !== 'decision-table') throw new Error('expected a decision table');
    expect(widget.inputs.map((input) => input.id)).toEqual(['shape', 'version-known', 'anchored']);
    expect(widget.rules).toHaveLength(3);
    expect(widget.rules[0]?.explanation.anchors).toHaveLength(1);
    expect(widget.defaultOutcome?.outcome).toBe('parsed — LabSpec returned');
  });

  it('rejects machine-generated rule explanations with no anchors', () => {
    const input = fixture();
    table(input).rules[0].explanation.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].rules[0].explanation.anchors');
  });

  it('rejects machine-generated explanations with anchors missing entirely', () => {
    const input = fixture();
    delete table(input).defaultOutcome.explanation.anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].defaultOutcome.explanation.anchors');
  });

  it('rejects conditions referencing undeclared inputs, naming the input', () => {
    const input = fixture();
    table(input).rules[1].when[0].input = 'ghost';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/condition references undeclared input "ghost"/);
    expect(result.error).toContain('base.modules[0].widgets[0].rules[1].when[0].input');
  });

  it('rejects select conditions comparing against a value that is not an option', () => {
    const input = fixture();
    table(input).rules[0].when[0].equals = 'banana';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/"banana" is not an option of select input "shape"/);
    expect(result.error).toContain('base.modules[0].widgets[0].rules[0].when[0].equals');
  });

  it('rejects boolean conditions comparing against a string', () => {
    const input = fixture();
    table(input).rules[1].when[0].equals = 'nope';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(
      /condition on boolean input "version-known" must compare against a boolean/,
    );
  });

  it('rejects select defaults that name no declared option', () => {
    const input = fixture();
    table(input).inputs[0].default = 'banana';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/default "banana" is not an option of select input "shape"/);
    expect(result.error).toContain('base.modules[0].widgets[0].inputs[0].default');
  });

  it('rejects duplicate input ids', () => {
    const input = fixture();
    table(input).inputs[2].id = 'version-known';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate input id "version-known"/);
    expect(result.error).toContain('base.modules[0].widgets[0].inputs[2].id');
  });

  it('rejects duplicate option values within a select input', () => {
    const input = fixture();
    table(input).inputs[0].options[1].value = 'object';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate option value "object" on input "shape"/);
    expect(result.error).toContain('base.modules[0].widgets[0].inputs[0].options[1].value');
  });

  it('rejects a decision table with no rules', () => {
    const input = fixture();
    table(input).rules = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one rule/i);
  });

  it('rejects rules with no conditions', () => {
    const input = fixture();
    table(input).rules[2].when = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one condition/i);
  });

  it('accepts unanchored explanations and a bare default outcome in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    expect(widget?.type).toBe('decision-table');
    if (widget?.type !== 'decision-table') throw new Error('expected a decision table');
    expect(widget.rules[0]?.explanation?.anchors).toBeUndefined();
    expect(widget.defaultOutcome?.explanation).toBeUndefined();
  });
});
