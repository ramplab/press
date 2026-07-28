import { describe, expect, it } from 'vitest';
import {
  LabSpecParseError,
  parseLabSpec,
  resolveModules,
  safeParseLabSpec,
} from '../src/index.js';
import validLab from './fixtures/valid-lab.json';

/** Deep-clone the valid fixture so tests can mutate freely. */
function fixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validLab)) as Record<string, unknown>;
}

describe('parseLabSpec', () => {
  it('parses the valid fixture lab', () => {
    const spec = parseLabSpec(fixture());
    expect(spec.schemaVersion).toBe(1);
    expect(spec.title).toBe('Fixture Lab');
    expect(spec.base.modules).toHaveLength(1);
    expect(spec.base.modules[0]?.widgets[0]?.type).toBe('callout');
    expect(spec.overlay).toHaveLength(1);
  });

  it('defaults overlay to an empty array when absent', () => {
    const input = fixture();
    delete input['overlay'];
    const spec = parseLabSpec(input);
    expect(spec.overlay).toEqual([]);
  });

  it('rejects machine-generated callouts with no anchors', () => {
    const input = fixture();
    const widget = (input as any).base.modules[0].widgets[0];
    widget.anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[0].anchors');
  });

  it('rejects machine-generated callouts with anchors missing entirely', () => {
    const input = fixture();
    delete (input as any).base.modules[0].widgets[0].anchors;

    expect(() => parseLabSpec(input)).toThrow(LabSpecParseError);
    expect(() => parseLabSpec(input)).toThrow(/anchors/i);
  });

  it('accepts unanchored content in the human overlay', () => {
    const spec = parseLabSpec(fixture());
    const widget = spec.overlay[0]?.widget;
    if (widget?.type !== 'callout') throw new Error('expected a callout overlay widget');
    expect(widget.anchors).toBeUndefined();
  });

  it('rejects unknown widget types with a useful error', () => {
    const input = fixture();
    (input as any).base.modules[0].widgets.push({
      id: 'mystery',
      type: 'hologram',
      body: 'not a real widget',
    });

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/type/i);
    expect(result.error).toContain('base.modules[0].widgets[2]');
  });

  it('rejects an unsupported schema version, naming the supported one', () => {
    const input = fixture();
    input['schemaVersion'] = 2;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('schemaVersion 2');
    expect(result.error).toContain('supports schema version 1');
  });

  it('rejects a spec with schemaVersion missing', () => {
    const input = fixture();
    delete input['schemaVersion'];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/missing "schemaVersion"/);
  });

  it('rejects non-object input with a readable message', () => {
    const result = safeParseLabSpec('not a lab');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('must be a JSON object');
  });

  it('rejects invalid anchor line ranges', () => {
    const input = fixture();
    (input as any).base.modules[0].widgets[1].anchors[0].lines = { start: 45, end: 30 };

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/lines\.end must be >= lines\.start/);
  });

  it('rejects unstable (non-kebab-case) IDs', () => {
    const input = fixture();
    (input as any).base.modules[0].id = 'Module One!';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/kebab-case/);
  });
});

describe('system-map widgets', () => {
  /** A valid system-map widget appended to the fixture's first module. */
  function withSystemMap(widget: Record<string, unknown> = {}): {
    input: Record<string, unknown>;
    map: any;
  } {
    const input = fixture();
    const map = {
      id: 'arch-map',
      type: 'system-map',
      title: 'RampLab, end to end',
      nodes: [
        {
          id: 'spec',
          label: 'Lab spec',
          description: 'Versioned Zod schemas; the contract everything meets.',
          anchors: [{ file: 'packages/spec/src/schema.ts', symbol: 'labSpecSchema' }],
        },
        { id: 'renderer', label: 'Renderer' },
      ],
      edges: [
        {
          from: 'spec',
          to: 'renderer',
          label: 'parsed spec JSON',
          anchors: [{ file: 'packages/spec/src/parse.ts', symbol: 'parseLabSpec' }],
        },
      ],
      ...widget,
    };
    (input as any).base.modules[0].widgets.push(map);
    return { input, map };
  }

  it('parses a valid system map, including bare structural nodes', () => {
    const { input } = withSystemMap();
    const spec = parseLabSpec(input);
    const map = spec.base.modules[0]?.widgets.at(-1);
    expect(map?.type).toBe('system-map');
    if (map?.type !== 'system-map') throw new Error('expected a system map');
    expect(map.nodes.map((node) => node.id)).toEqual(['spec', 'renderer']);
    // The bare node carries no teachable content, so no anchors are required.
    expect(map.nodes[1]?.description).toBeUndefined();
  });

  it('rejects node descriptions without anchors', () => {
    const { input, map } = withSystemMap();
    delete map.nodes[0].anchors;

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('nodes[0].anchors');
  });

  it('rejects labeled edges without anchors', () => {
    const { input, map } = withSystemMap();
    map.edges[0].anchors = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('edges[0].anchors');
  });

  it('accepts unlabeled, unanchored edges as pure structure', () => {
    const { input, map } = withSystemMap();
    map.edges = [{ from: 'renderer', to: 'spec' }];
    expect(() => parseLabSpec(input)).not.toThrow();
  });

  it('rejects edges pointing at unknown nodes, naming the id', () => {
    const { input, map } = withSystemMap();
    map.edges[0].to = 'ghost';

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('edge to references unknown node "ghost"');
    expect(result.error).toContain('edges[0].to');
  });

  it('rejects duplicate node ids', () => {
    const { input, map } = withSystemMap();
    map.nodes.push({ id: 'spec', label: 'Lab spec again' });

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toContain('duplicate node id "spec"');
    expect(result.error).toContain('nodes[2].id');
  });

  it('rejects a system map with no nodes', () => {
    const { input, map } = withSystemMap();
    map.nodes = [];
    map.edges = [];

    const result = safeParseLabSpec(input);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one node/);
  });
});

describe('data-model widget', () => {
  /** A valid data-model widget with an annotated nested tree. */
  function dataModelWidget(): Record<string, unknown> {
    return {
      id: 'application-data',
      type: 'data-model',
      title: 'ApplicationData explorer',
      source: { file: 'lib/types/application-data.ts' },
      nodes: [
        {
          name: 'fields',
          type: 'Record<fieldId, value>',
          annotation: {
            body: 'Flat map of every questionnaire answer.',
            readBy: 'Read by: RuleEngine.buildContext().',
            anchors: [{ file: 'lib/types/application-data.ts', symbol: 'ApplicationData' }],
          },
          children: [
            { name: 'company_name', type: 'string', example: 'Nimbus Retail Ltd' },
            { name: 'is_profitable', type: 'boolean', example: true },
          ],
        },
        { name: 'meta', type: 'ApplicationMeta' },
      ],
    };
  }

  /** The valid fixture with a data-model widget appended to module one. */
  function fixtureWith(widget: Record<string, unknown>): Record<string, unknown> {
    const input = fixture();
    (input as any).base.modules[0].widgets.push(widget);
    return input;
  }

  it('parses a data-model widget with nested annotated nodes', () => {
    const spec = parseLabSpec(fixtureWith(dataModelWidget()));
    const widget = spec.base.modules[0]?.widgets[2];
    if (widget?.type !== 'data-model') throw new Error('expected a data-model widget');
    expect(widget.nodes).toHaveLength(2);
    expect(widget.nodes[0]?.children?.[1]?.example).toBe(true);
    expect(widget.nodes[0]?.annotation?.anchors).toHaveLength(1);
  });

  it('rejects machine-generated node annotations with no anchors', () => {
    const widget = dataModelWidget();
    (widget as any).nodes[0].annotation.anchors = [];

    const result = safeParseLabSpec(fixtureWith(widget));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one code anchor/i);
    expect(result.error).toContain('base.modules[0].widgets[2].nodes[0].annotation.anchors');
  });

  it('rejects annotations on deeply nested nodes when anchors are missing', () => {
    const widget = dataModelWidget();
    (widget as any).nodes[0].children[0].annotation = { body: 'Registry-enriched field.' };

    const result = safeParseLabSpec(fixtureWith(widget));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/anchors/i);
    expect(result.error).toContain('widgets[2].nodes[0].children[0].annotation.anchors');
  });

  it('rejects a data model with no nodes', () => {
    const widget = dataModelWidget();
    (widget as any).nodes = [];

    const result = safeParseLabSpec(fixtureWith(widget));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/at least one node/i);
  });

  it('rejects nodes with empty names', () => {
    const widget = dataModelWidget();
    (widget as any).nodes[0].children[0].name = '';

    const result = safeParseLabSpec(fixtureWith(widget));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/node\.name must be non-empty/);
  });

  it('rejects duplicate sibling node names anywhere in the tree', () => {
    const widget = dataModelWidget();
    (widget as any).nodes[0].children[1].name = 'company_name';

    const result = safeParseLabSpec(fixtureWith(widget));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/duplicate sibling node name "company_name"/);
    expect(result.error).toContain('widgets[2].nodes[0].children[1].name');
  });

  it('accepts unanchored node annotations in the human overlay', () => {
    const input = fixture();
    (input as any).overlay.push({
      id: 'lead-data-note',
      target: { moduleId: 'module-one' },
      widget: {
        id: 'overlay-data-model',
        type: 'data-model',
        nodes: [
          {
            name: 'legacy_flag',
            type: 'boolean',
            annotation: { body: 'Nobody remembers why. Ask in #onboarding.' },
          },
        ],
      },
    });

    const spec = parseLabSpec(input);
    const widget = spec.overlay[1]?.widget;
    if (widget?.type !== 'data-model') throw new Error('expected a data-model overlay widget');
    expect(widget.nodes[0]?.annotation?.anchors).toBeUndefined();
  });
});

describe('resolveModules', () => {
  it('splices overlay widgets after their target widget', () => {
    const spec = parseLabSpec(fixture());
    const [module] = resolveModules(spec);
    expect(module).toBeDefined();
    expect(module?.widgets.map((w) => w.widget.id)).toEqual([
      'why-first',
      'tribal-note',
      'warn-first',
    ]);
    expect(module?.widgets.map((w) => w.origin)).toEqual(['base', 'overlay', 'base']);
  });

  it('appends overlay widgets when the target widget is gone', () => {
    const input = fixture();
    (input as any).overlay[0].target.afterWidgetId = 'deleted-widget';
    const [module] = resolveModules(parseLabSpec(input));
    expect(module?.widgets.at(-1)?.widget.id).toBe('tribal-note');
  });

  it('ignores overlay entries pointing at unknown modules', () => {
    const input = fixture();
    (input as any).overlay[0].target.moduleId = 'deleted-module';
    const [module] = resolveModules(parseLabSpec(input));
    expect(module?.widgets).toHaveLength(2);
  });
});

describe('what the model actually sent', () => {
  it('names the value at a failing path, which zod does not', () => {
    // A pressing failed after six minutes with seven "Invalid discriminator
    // value" lines and no way to tell what the model had emitted (#107).
    const spec = {
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      base: {
        modules: [
          {
            id: 'm',
            title: 'M',
            widgets: [{ id: 'w', type: 'insight', body: 'hello' }],
          },
        ],
      },
      overlay: [],
    };
    const result = safeParseLabSpec(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('Received:');
    expect(result.error).toContain('"insight"');
  });

  it('says nothing about a path where the value is simply absent', () => {
    // "must carry at least one code anchor" is already the whole story; an
    // empty "Received:" section under it would be noise.
    const spec = {
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      base: { modules: [] },
      overlay: [],
    };
    const result = safeParseLabSpec(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).not.toContain('Received:');
  });
});

describe('naming the thing an error is about', () => {
  it('says which map node was described without being anchored', () => {
    // Three live map-stage failures reported indexes: nodes[0], nodes[7],
    // nodes[10]. Which concepts those were is the fact a prompt fix needs
    // (#107), and the node carries a required label.
    const spec = {
      schemaVersion: 1,
      id: 'x',
      title: 'X',
      base: {
        modules: [
          {
            id: 'm',
            title: 'M',
            widgets: [
              {
                id: 'map',
                type: 'system-map',
                title: 'The system',
                nodes: [
                  { id: 'realtime', label: 'Realtime Server', description: 'Pushes changes.' },
                ],
                edges: [],
              },
            ],
          },
        ],
      },
      overlay: [],
    };
    const result = safeParseLabSpec(spec);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('must carry at least one code anchor');
    expect(result.error).toContain('"Realtime Server"');
  });
});
