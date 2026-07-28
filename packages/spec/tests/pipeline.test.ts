import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '../src/index.js';
import pipelineLab from './fixtures/pipeline-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(pipelineLab)) as Record<string, unknown>;
}

/** Shortcut to the base pipeline widget inside a mutable fixture. */
function pipeline(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[0];
}

describe('pipelineWidgetSchema', () => {
  it('parses the valid pipeline fixture lab in stage order', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    expect(widget?.type).toBe('pipeline');
    if (widget?.type !== 'pipeline') throw new Error('expected a pipeline');
    expect(widget.stages.map((stage) => stage.id)).toEqual([
      'map',
      'author',
      'verify',
      'assemble',
    ]);
    expect(widget.stages[0]?.description?.anchors).toHaveLength(1);
    expect(widget.stages[0]?.flow).toEqual({ in: 'repo directory', out: 'subsystem map' });
  });

  it('accepts stages without descriptions and without flow details', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    if (widget?.type !== 'pipeline') throw new Error('expected a pipeline');
    expect(widget.stages[1]?.description).toBeUndefined();
    expect(widget.stages[3]?.description).toBeUndefined();
    expect(widget.stages[3]?.flow).toBeUndefined();
  });

  it('rejects machine-generated stage descriptions with no anchors', () => {
    const input = fixture();
    pipeline(input).stages[0].description.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].stages[0].description.anchors');
  });

  it('rejects machine-generated stage descriptions with anchors missing entirely', () => {
    const input = fixture();
    delete pipeline(input).stages[2].description.anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].stages[2].description.anchors');
  });

  it('rejects duplicate stage ids', () => {
    const input = fixture();
    pipeline(input).stages[1].id = 'map';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate stage id "map"/);
    expect(result.error).toContain('base.modules[0].widgets[0].stages[1].id');
  });

  it('rejects a pipeline with no stages', () => {
    const input = fixture();
    pipeline(input).stages = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one stage/i);
  });

  it('rejects empty stage labels', () => {
    const input = fixture();
    pipeline(input).stages[1].label = '';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/stage\.label must be non-empty/);
  });

  it('rejects a flow that names neither what comes in nor what goes out', () => {
    const input = fixture();
    pipeline(input).stages[1].flow = {};

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/flow must name what comes in, what goes out, or both/);
    expect(result.error).toContain('base.modules[0].widgets[0].stages[1].flow');
  });

  it('accepts unanchored stage descriptions in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    expect(widget?.type).toBe('pipeline');
    if (widget?.type !== 'pipeline') throw new Error('expected a pipeline');
    expect(widget.stages[0]?.description?.anchors).toBeUndefined();
    expect(widget.stages[1]?.flow).toEqual({ out: 'a release' });
  });
});
