import { describe, expect, it } from 'vitest';
import { inPayloadCoordinates } from '../src/index.js';

/**
 * The map stage validates a lab spec it assembles around the model's payload,
 * so zod reports `base.modules[0].widgets[3]` — a path that appears nowhere in
 * the output contract the model was given, or in the JSON it wrote. The retry
 * used to hand that back verbatim and ask for a fix.
 */

describe('inPayloadCoordinates', () => {
  it('names the system map, which is always widget 0', () => {
    expect(
      inPayloadCoordinates('✖ must carry an anchor\n  → at base.modules[0].widgets[0].edges[0].anchors'),
    ).toBe('✖ must carry an anchor\n  → at systemMap.edges[0].anchors');
  });

  it('shifts the callouts back by the system map that precedes them', () => {
    // widgets[1] is callouts[0] — the off-by-one a model had to guess at.
    expect(inPayloadCoordinates('at base.modules[0].widgets[1].anchors')).toBe(
      'at callouts[0].anchors',
    );
    expect(inPayloadCoordinates('at base.modules[0].widgets[3].body')).toBe(
      'at callouts[2].body',
    );
  });

  it('names the module fields by the keys the model was asked for', () => {
    expect(inPayloadCoordinates('at base.modules[0].title')).toBe('at moduleTitle');
    expect(inPayloadCoordinates('at base.modules[0].summary')).toBe('at moduleSummary');
  });

  it('rewrites every path in a multi-issue failure, including the Received report', () => {
    const failure = [
      'Invalid lab spec:',
      '✖ machine-generated content must carry at least one code anchor',
      '  → at base.modules[0].widgets[0].edges[0].anchors',
      '✖ Invalid input',
      '  → at base.modules[0].widgets[2].kind',
      '',
      'Received:',
      '  base.modules[0].widgets[0].edges[0] = "Renders page content"',
    ].join('\n');

    const rewritten = inPayloadCoordinates(failure);

    expect(rewritten).not.toContain('base.modules');
    expect(rewritten).toContain('at systemMap.edges[0].anchors');
    expect(rewritten).toContain('at callouts[1].kind');
    expect(rewritten).toContain('systemMap.edges[0] = "Renders page content"');
  });

  it('leaves a failure with no spec paths in it alone', () => {
    const failure = 'The output did not contain a parseable JSON object.';
    expect(inPayloadCoordinates(failure)).toBe(failure);
  });
});
