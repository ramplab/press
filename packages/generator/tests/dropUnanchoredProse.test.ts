import { describe, expect, it } from 'vitest';
import { dropUnanchoredProse } from '../src/dropUnanchoredProse.js';

/**
 * A pressing of supabase died four minutes in because one edge said "Renders
 * page content" and cited nothing. The map was otherwise whole. PLAN.md §3
 * already says unverified claims are dropped from the base spec; this is that
 * rule applied one step earlier, to claims that were never grounded at all.
 */

describe('system-map: prose with its anchors alongside it', () => {
  it('drops an unanchored edge label and keeps the arrow', () => {
    const { value, drops } = dropUnanchoredProse(
      {
        id: 'system-map',
        type: 'system-map',
        nodes: [
          { id: 'router', label: 'Router' },
          { id: 'page', label: 'Page' },
        ],
        edges: [{ from: 'router', to: 'page', label: 'Renders page content' }],
      },
      'systemMap',
    );

    expect(value).toMatchObject({ edges: [{ from: 'router', to: 'page' }] });
    expect((value as { edges: Record<string, unknown>[] }).edges[0]).not.toHaveProperty('label');
    expect(drops).toEqual([
      { path: 'systemMap.edges[0].label', text: 'Renders page content' },
    ]);
  });

  it('drops an unanchored node description and keeps the node', () => {
    const { value, drops } = dropUnanchoredProse(
      {
        id: 'system-map',
        type: 'system-map',
        nodes: [{ id: 'realtime', label: 'Realtime Server', description: 'Pushes changes.' }],
        edges: [],
      },
      'systemMap',
    );

    // The node survives with the label that names it in the diagram.
    expect(value).toMatchObject({ nodes: [{ id: 'realtime', label: 'Realtime Server' }] });
    expect((value as { nodes: Record<string, unknown>[] }).nodes[0]).not.toHaveProperty(
      'description',
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]?.path).toBe('systemMap.nodes[0].description');
  });

  it('leaves anchored prose exactly as it came', () => {
    const widget = {
      id: 'system-map',
      type: 'system-map',
      nodes: [
        {
          id: 'greeter',
          label: 'Greeter',
          description: 'Builds the greeting.',
          anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
        },
      ],
      edges: [],
    };

    const { value, drops } = dropUnanchoredProse(widget, 'systemMap');

    expect(value).toEqual(widget);
    expect(drops).toEqual([]);
  });

  it('treats an empty anchors array as no anchors, which is what it is', () => {
    const { drops } = dropUnanchoredProse(
      {
        type: 'system-map',
        nodes: [],
        edges: [{ from: 'a', to: 'b', label: 'calls', anchors: [] }],
      },
      'systemMap',
    );

    expect(drops).toHaveLength(1);
  });

  it('says nothing about empty prose, because nothing was lost', () => {
    const { value, drops } = dropUnanchoredProse(
      { type: 'system-map', nodes: [], edges: [{ from: 'a', to: 'b', label: '  ' }] },
      'systemMap',
    );

    expect((value as { edges: Record<string, unknown>[] }).edges[0]).not.toHaveProperty('label');
    expect(drops).toEqual([]);
  });

  it('never touches a node label, which names the node rather than claiming anything', () => {
    const { value, drops } = dropUnanchoredProse(
      { type: 'system-map', nodes: [{ id: 'a', label: 'Auth' }], edges: [] },
      'systemMap',
    );

    expect(value).toMatchObject({ nodes: [{ id: 'a', label: 'Auth' }] });
    expect(drops).toEqual([]);
  });
});

describe('the { body, anchors } widgets', () => {
  it('drops an unanchored state description and transition commentary', () => {
    const { value, drops } = dropUnanchoredProse(
      {
        id: 'lifecycle',
        type: 'state-machine',
        states: [{ id: 'active', label: 'Active', description: { body: 'Fresh session.' } }],
        transitions: [
          { from: 'active', to: 'expired', trigger: 'ttl elapsed', commentary: { body: 'Lazy.' } },
        ],
      },
      'widgets[2]',
    );

    expect(value).toMatchObject({
      states: [{ id: 'active', label: 'Active' }],
      transitions: [{ from: 'active', to: 'expired', trigger: 'ttl elapsed' }],
    });
    expect(drops.map((d) => d.path)).toEqual([
      'widgets[2].states[0].description',
      'widgets[2].transitions[0].commentary',
    ]);
  });

  it('drops an unanchored pipeline stage description and keeps the stage', () => {
    const { value, drops } = dropUnanchoredProse(
      {
        type: 'pipeline',
        stages: [{ id: 'parse', label: 'Parse', description: { body: 'Reads the config.' } }],
      },
      'widgets[0]',
    );

    expect(value).toMatchObject({ stages: [{ id: 'parse', label: 'Parse' }] });
    expect(drops).toHaveLength(1);
  });

  it('drops an unanchored annotation at any depth of a data model', () => {
    const { value, drops } = dropUnanchoredProse(
      {
        type: 'data-model',
        nodes: [
          {
            name: 'people',
            type: 'Person[]',
            children: [
              { name: 'source', type: 'string', annotation: { body: 'Where it came from.' } },
            ],
          },
        ],
      },
      'widgets[1]',
    );

    expect(value).toMatchObject({
      nodes: [{ name: 'people', children: [{ name: 'source', type: 'string' }] }],
    });
    expect(drops.map((d) => d.path)).toEqual([
      'widgets[1].nodes[0].children[0].annotation',
    ]);
  });

  it("drops a decision table's default-outcome explanation, which is the optional one", () => {
    const { value, drops } = dropUnanchoredProse(
      {
        type: 'decision-table',
        inputs: [],
        rules: [{ when: [], outcome: 'Approved', explanation: { body: 'Because.' } }],
        defaultOutcome: { outcome: 'Declined', explanation: { body: 'No rule matched.' } },
      },
      'widgets[0]',
    );

    // The rule's explanation is required by the schema and stays put; only the
    // default outcome's, which is optional, goes.
    expect(value).toMatchObject({
      rules: [{ outcome: 'Approved', explanation: { body: 'Because.' } }],
      defaultOutcome: { outcome: 'Declined' },
    });
    expect(drops.map((d) => d.path)).toEqual(['widgets[0].defaultOutcome.explanation']);
  });
});

describe('claims the schema requires', () => {
  it('leaves a quiz explanation alone, so it fails validation and earns a retry', () => {
    // Deleting a required claim would only move the failure, and would hollow
    // out the widget on the way.
    const widget = {
      type: 'quiz',
      questions: [
        {
          id: 'q',
          prompt: 'What?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          correctOptionId: 'a',
          explanation: { body: 'Because A.' },
        },
      ],
    };

    const { value, drops } = dropUnanchoredProse(widget, 'widgets[3]');

    expect(value).toEqual(widget);
    expect(drops).toEqual([]);
  });

  it('leaves walkthrough commentary, figure captions and callout bodies alone', () => {
    const widgets = [
      {
        type: 'code-walkthrough',
        code: ['a'],
        steps: [{ lines: { start: 1, end: 1 }, commentary: { body: 'Does a thing.' } }],
      },
      { type: 'code-figure', code: ['a'], caption: { body: 'The point.' } },
      { type: 'callout', kind: 'why', body: 'An insight.' },
    ];

    for (const widget of widgets) {
      const { value, drops } = dropUnanchoredProse(widget, 'widgets[0]');
      expect(value).toEqual(widget);
      expect(drops).toEqual([]);
    }
  });
});

describe('unvalidated input', () => {
  it('passes malformed payloads through for validation to reject', () => {
    expect(dropUnanchoredProse(null, 'w').value).toBeNull();
    expect(dropUnanchoredProse({ type: 'system-map', nodes: 'nope' }, 'w').value).toEqual({
      type: 'system-map',
      nodes: 'nope',
    });
    expect(dropUnanchoredProse({ type: 'unknown-widget' }, 'w').drops).toEqual([]);
  });

  it('leaves the input alone', () => {
    const widget = {
      type: 'system-map',
      nodes: [],
      edges: [{ from: 'a', to: 'b', label: 'calls' }],
    };
    dropUnanchoredProse(widget, 'systemMap');
    expect(widget.edges[0]).toHaveProperty('label', 'calls');
  });
});
