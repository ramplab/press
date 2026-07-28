import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '../src/index.js';
import quizLab from './fixtures/quiz-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(quizLab)) as Record<string, unknown>;
}

/** Shortcut to the base quiz widget inside a mutable fixture. */
function quiz(input: Record<string, unknown>): any {
  return (input as any).base.modules[0].widgets[0];
}

describe('quizWidgetSchema', () => {
  it('parses the valid quiz fixture lab', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.base.modules[0]?.widgets[0];
    expect(widget?.type).toBe('quiz');
    if (widget?.type !== 'quiz') throw new Error('expected a quiz');
    expect(widget.questions.map((question) => question.id)).toEqual([
      'unknown-version',
      'unanchored-callout',
    ]);
    expect(widget.questions[0]?.options).toHaveLength(3);
    expect(widget.questions[0]?.correctOptionId).toBe('rejects-early');
    expect(widget.questions[0]?.explanation.anchors).toHaveLength(1);
  });

  it('rejects machine-generated explanations with no anchors', () => {
    const input = fixture();
    quiz(input).questions[0].explanation.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain(
      'base.modules[0].widgets[0].questions[0].explanation.anchors',
    );
  });

  it('rejects machine-generated explanations with anchors missing entirely', () => {
    const input = fixture();
    delete quiz(input).questions[1].explanation.anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchor/i);
    expect(result.error).toContain(
      'base.modules[0].widgets[0].questions[1].explanation.anchors',
    );
  });

  it('rejects questions whose explanation is missing — the answer is a machine claim', () => {
    const input = fixture();
    delete quiz(input).questions[0].explanation;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('base.modules[0].widgets[0].questions[0].explanation');
  });

  it('rejects a correct answer referencing an unknown option, naming the id', () => {
    const input = fixture();
    quiz(input).questions[0].correctOptionId = 'vanished';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/correctOptionId references unknown option "vanished"/);
    expect(result.error).toContain('base.modules[0].widgets[0].questions[0].correctOptionId');
  });

  it('rejects questions with fewer than two options', () => {
    const input = fixture();
    quiz(input).questions[1].options = [{ id: 'schema-rejects', label: 'Schema validation fails' }];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least two options/i);
    expect(result.error).toContain('base.modules[0].widgets[0].questions[1].options');
  });

  it('rejects duplicate option ids within a question', () => {
    const input = fixture();
    quiz(input).questions[0].options[1].id = 'rejects-early';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate option id "rejects-early"/);
    expect(result.error).toContain('base.modules[0].widgets[0].questions[0].options[1].id');
  });

  it('rejects duplicate question ids within a quiz', () => {
    const input = fixture();
    quiz(input).questions[1].id = 'unknown-version';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate question id "unknown-version"/);
    expect(result.error).toContain('base.modules[0].widgets[0].questions[1].id');
  });

  it('rejects a quiz with no questions', () => {
    const input = fixture();
    quiz(input).questions = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one question/i);
  });

  it('accepts unanchored explanations in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    expect(widget?.type).toBe('quiz');
    if (widget?.type !== 'quiz') throw new Error('expected a quiz');
    expect(widget.questions[0]?.explanation.body).toContain('tribal knowledge');
    expect(widget.questions[0]?.explanation.anchors).toBeUndefined();
  });
});
