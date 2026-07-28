import { describe, expect, it } from 'vitest';
import { normalizeModelJson } from '../src/normalizeModelJson.js';

/**
 * A pressing of supabase died on `"symbol": ""` after four and a half
 * minutes. The model had anchored everything asked of it and spelled "no
 * symbol here" as an empty string instead of by leaving the key out.
 */

describe('normalizeModelJson', () => {
  it('reads an empty optional field as the absence it means', () => {
    const anchor = { file: 'src/a.ts', symbol: '' };
    expect(normalizeModelJson(anchor)).toEqual({ file: 'src/a.ts' });
  });

  it('reaches everywhere in a payload, not just the top', () => {
    const spec = {
      base: {
        modules: [
          {
            widgets: [
              { nodes: [{ id: 'n', label: 'N', anchors: [{ file: 'a.ts', symbol: '' }] }] },
            ],
          },
        ],
      },
    };
    const out = normalizeModelJson(spec) as typeof spec;
    expect(out.base.modules[0]?.widgets[0]?.nodes[0]?.anchors[0]).toEqual({ file: 'a.ts' });
  });

  it('treats whitespace as empty, since it says nothing either', () => {
    expect(normalizeModelJson({ file: 'a.ts', symbol: '   ' })).toEqual({ file: 'a.ts' });
  });

  it('leaves a field alone when it actually has something to say', () => {
    const anchor = { file: 'a.ts', symbol: 'handleRequest' };
    expect(normalizeModelJson(anchor)).toEqual(anchor);
  });

  it('does not touch a required field, where empty is a real failure', () => {
    // `label` and `file` must be non-empty. Dropping them would turn a
    // caught failure into a confusing one about a missing key.
    expect(normalizeModelJson({ id: 'n', label: '', file: '' })).toEqual({
      id: 'n',
      label: '',
      file: '',
    });
  });

  it('leaves the input alone', () => {
    const anchor = { file: 'a.ts', symbol: '' };
    normalizeModelJson(anchor);
    expect(anchor.symbol).toBe('');
  });

  it("reads an annotation's empty readBy as the absence it means", () => {
    // Author-stage only: the map stage never emits a data model.
    expect(normalizeModelJson({ body: 'The source field.', readBy: '' })).toEqual({
      body: 'The source field.',
    });
  });

  it('reads an empty pipeline flow as nothing flowing that way', () => {
    expect(normalizeModelJson({ in: 'raw config bytes', out: '' })).toEqual({
      in: 'raw config bytes',
    });
  });

  it('leaves "label" alone, because empty does not always mean absent there', () => {
    // Optional on a system-map edge; REQUIRED on a node, state, stage and quiz
    // option. Stripping it blanket-wise would delete what names a node.
    expect(normalizeModelJson({ id: 'realtime', label: '' })).toEqual({
      id: 'realtime',
      label: '',
    });
  });

  it('leaves "example" alone, where an empty string is a real value', () => {
    expect(normalizeModelJson({ name: 'suffix', type: 'string', example: '' })).toEqual({
      name: 'suffix',
      type: 'string',
      example: '',
    });
  });

  it('keeps blank lines in a code excerpt, which are part of the code', () => {
    // Excerpt lines are array entries, not keyed fields — a stripped blank
    // line would silently shift every step's line range under it.
    const widget = { type: 'code-figure', code: ['func main() {', '', '}'] };
    expect(normalizeModelJson(widget)).toEqual(widget);
  });

  it('keeps arrays and scalars as they are', () => {
    expect(normalizeModelJson([1, 'two', null])).toEqual([1, 'two', null]);
    expect(normalizeModelJson(null)).toBeNull();
  });
});
