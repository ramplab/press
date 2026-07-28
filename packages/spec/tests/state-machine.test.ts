import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '../src/index.js';
import stateMachineLab from './fixtures/state-machine-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(stateMachineLab)) as Record<string, unknown>;
}

/** Shortcut to the base state-machine widget inside a mutable fixture. */
function machine(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[0];
}

describe('stateMachineWidgetSchema', () => {
  it('parses the valid state-machine fixture lab', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    expect(widget?.type).toBe('state-machine');
    if (widget?.type !== 'state-machine') throw new Error('expected a state machine');
    expect(widget.states.map((state) => state.id)).toEqual([
      'pending',
      'validating',
      'accepted',
      'rejected',
    ]);
    expect(widget.transitions).toHaveLength(4);
    expect(widget.transitions[0]?.commentary?.anchors).toHaveLength(1);
  });

  it('accepts states without descriptions and transitions without commentary', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    if (widget?.type !== 'state-machine') throw new Error('expected a state machine');
    expect(widget.states[1]?.description).toBeUndefined();
    expect(widget.transitions[1]?.commentary).toBeUndefined();
  });

  it('rejects machine-generated state descriptions with no anchors', () => {
    const input = fixture();
    machine(input).states[0].description.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].states[0].description.anchors');
  });

  it('rejects machine-generated edge commentary with anchors missing entirely', () => {
    const input = fixture();
    delete machine(input).transitions[0].commentary.anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].transitions[0].commentary.anchors');
  });

  it('rejects transitions referencing unknown states, naming the bad end', () => {
    const input = fixture();
    machine(input).transitions[1].to = 'vanished';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/transition\.to references unknown state "vanished"/);
    expect(result.error).toContain('base.modules[0].widgets[0].transitions[1].to');
  });

  it('rejects duplicate state ids', () => {
    const input = fixture();
    machine(input).states[1].id = 'pending';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate state id "pending"/);
    expect(result.error).toContain('base.modules[0].widgets[0].states[1].id');
  });

  it('rejects a state machine with no states', () => {
    const input = fixture();
    machine(input).states = [];
    machine(input).transitions = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one state/i);
  });

  it('rejects empty transition triggers', () => {
    const input = fixture();
    machine(input).transitions[2].trigger = '';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/transition\.trigger must be non-empty/);
  });

  it('accepts unanchored descriptions and commentary in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    expect(widget?.type).toBe('state-machine');
    if (widget?.type !== 'state-machine') throw new Error('expected a state machine');
    expect(widget.states[0]?.description?.anchors).toBeUndefined();
    expect(widget.transitions[0]?.commentary?.anchors).toBeUndefined();
  });
});
