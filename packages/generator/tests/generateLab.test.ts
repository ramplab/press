import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { safeParseLabSpec } from '@ramplab/spec';
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_STAGE_MODEL,
  GENERATION_STAGES,
  MAP_STAGE_MODEL,
  MapStageError,
  generateLab,
  resolveStageModels,
  type ModelRunner,
  type StageRequest,
  type StageResponse,
} from '../src/index.js';

/**
 * generateLab is exercised end-to-end against the polyglot fixture repo with
 * a fake ModelRunner — the injectable agent boundary — so CI runs the full
 * map-stage pipeline (prompting, retry, spec validation, anchor resolution)
 * without any live API call.
 */

const REPO = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

/** Scripted stand-in for the Agent SDK runner. Records every request. */
class FakeRunner implements ModelRunner {
  readonly requests: StageRequest[] = [];
  private readonly responses: StageResponse[];

  constructor(responses: (string | StageResponse)[]) {
    this.responses = responses.map((r) => (typeof r === 'string' ? { output: r } : r));
  }

  runStage(request: StageRequest): Promise<StageResponse> {
    this.requests.push(request);
    const response = this.responses[Math.min(this.requests.length, this.responses.length) - 1];
    if (response === undefined) {
      throw new Error('FakeRunner: no scripted response left');
    }
    return Promise.resolve(response);
  }
}

/**
 * A payload whose anchors all verify against the polyglot fixture repo
 * (paths/symbols/lines mirror resolveAnchors.test.ts).
 */
function validPayload(): Record<string, unknown> {
  return {
    title: 'Polyglot Onboarding Lab',
    moduleTitle: 'Repo tour',
    moduleSummary: 'Nine tiny services, one per language.',
    systemMap: {
      id: 'system-map',
      type: 'system-map',
      title: 'How the pieces fit',
      nodes: [
        {
          id: 'greeter',
          label: 'Greeter',
          description: 'TypeScript greeting service.',
          anchors: [{ file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 } }],
        },
        {
          id: 'server',
          label: 'Go server',
          description: 'HTTP entry point.',
          anchors: [{ file: 'pkg/server/server.go', symbol: 'ListenAddr' }],
        },
        { id: 'orders', label: 'Orders' },
      ],
      edges: [
        {
          from: 'server',
          to: 'greeter',
          label: 'greeting requests',
          anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
        },
        { from: 'server', to: 'orders' },
      ],
    },
    callouts: [
      {
        id: 'why-polyglot',
        type: 'callout',
        kind: 'why',
        title: 'Why nine languages?',
        body: 'Each service demonstrates anchor resolution in a different language.',
        anchors: [{ file: 'lib/order.rb', symbol: 'total_cents', lines: { start: 8, end: 10 } }],
      },
      {
        id: 'watch-sessions',
        type: 'callout',
        kind: 'warning',
        body: 'Session expiry is checked lazily.',
        anchors: [{ file: 'app/Session.kt', symbol: 'isExpired' }],
      },
    ],
  };
}

describe('per-stage model config', () => {
  it('defaults the map stage to Haiku and every other stage to Sonnet', () => {
    const models = resolveStageModels();
    expect(GENERATION_STAGES).toEqual(['map', 'plan', 'author', 'assemble', 'verify']);
    expect(models.map).toBe(MAP_STAGE_MODEL);
    for (const stage of GENERATION_STAGES) {
      if (stage !== 'map') expect(models[stage]).toBe('claude-sonnet-5');
    }
    expect(DEFAULT_STAGE_MODEL).toBe('claude-sonnet-5');
  });

  it('honors per-stage overrides without disturbing other stages', () => {
    const models = resolveStageModels({ map: 'claude-haiku-4-5', verify: 'claude-opus-4-8' });
    expect(models.map).toBe('claude-haiku-4-5');
    expect(models.verify).toBe('claude-opus-4-8');
    expect(models.plan).toBe('claude-sonnet-5');
    expect(models.author).toBe('claude-sonnet-5');
    expect(models.assemble).toBe('claude-sonnet-5');
  });
});

describe('the turn cap', () => {
  it('is 100, because 50 does not author a chapter against a large repo', () => {
    // The eval harness raised its own default for exactly this reason and the
    // product path never got the lesson, so a live press ran at 50 (#177).
    // Exhausting it is not a slow chapter: the SDK returns error_max_turns,
    // the runner throws, and no stage catches it — the press dies.
    expect(DEFAULT_MAX_TURNS).toBe(100);
  });
});

describe('generateLab: happy path', () => {
  it('produces a valid, anchor-resolved spec from one model call', async () => {
    const runner = new FakeRunner([
      { output: JSON.stringify(validPayload()), costUsd: 0.12 },
    ]);

    const result = await generateLab(REPO, { runner });

    // One call, to the map stage, against the repo, with the map default model.
    expect(runner.requests).toHaveLength(1);
    const request = runner.requests[0]!;
    expect(request.stage).toBe('map');
    expect(request.repoDir).toBe(REPO);
    expect(request.model).toBe(MAP_STAGE_MODEL);
    expect(request.attempt).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.costUsd).toBe(0.12);

    // The spec validates against @ramplab/spec after a JSON round-trip.
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);

    // One module holding the system map plus the callouts.
    expect(result.spec.base.modules).toHaveLength(1);
    const module = result.spec.base.modules[0]!;
    expect(module.id).toBe('repo-overview');
    expect(module.widgets.map((w) => w.type)).toEqual(['system-map', 'callout', 'callout']);

    // Every anchor resolved and carries a fingerprint into the fixture repo.
    expect(result.resolution.summary.unresolvedUnits).toBe(0);
    expect(result.resolution.summary.resolvedAnchors).toBe(
      result.resolution.summary.totalAnchors,
    );
    for (const anchor of result.resolution.anchors) {
      expect(anchor.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    // The lab id is slugged from the fixture directory name.
    expect(result.spec.id).toBe('polyglot');
  });

  it('accepts JSON wrapped in prose and a markdown fence', async () => {
    const output = `Here is the map:\n\n\`\`\`json\n${JSON.stringify(validPayload())}\n\`\`\`\nDone.`;
    const runner = new FakeRunner([output]);

    const result = await generateLab(REPO, { runner });

    expect(result.attempts).toBe(1);
    expect(result.spec.title).toBe('Polyglot Onboarding Lab');
  });
});

describe('generateLab: schema-invalid output and retry', () => {
  it('retries once with validation feedback and succeeds', async () => {
    const invalid = validPayload();
    // Machine-generated callouts must carry anchors — this violates the schema.
    invalid['callouts'] = [
      { id: 'unanchored', type: 'callout', kind: 'why', body: 'No anchors here.' },
    ];
    const runner = new FakeRunner([
      JSON.stringify(invalid),
      JSON.stringify(validPayload()),
    ]);

    const result = await generateLab(REPO, { runner });

    expect(result.attempts).toBe(2);
    expect(runner.requests).toHaveLength(2);
    const retry = runner.requests[1]!;
    expect(retry.attempt).toBe(2);
    // The retry prompt carries the validation failure back to the model.
    expect(retry.prompt).toContain('previous attempt was rejected');
    expect(retry.prompt).toContain('anchor');
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('fails with a clear error once retries are exhausted', async () => {
    const runner = new FakeRunner(['not json at all', 'still { not: valid json']);

    const error = await generateLab(REPO, { runner }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MapStageError);
    const mapError = error as MapStageError;
    expect(mapError.attempts).toBe(2);
    expect(mapError.message).toContain('did not produce a valid lab spec');
    expect(mapError.message).toContain('2 attempts');
    expect(runner.requests).toHaveLength(2);
  });

  it('honors maxRetries: 0 (no second attempt)', async () => {
    const runner = new FakeRunner(['not json']);

    await expect(generateLab(REPO, { runner, maxRetries: 0 })).rejects.toThrow(MapStageError);
    expect(runner.requests).toHaveLength(1);
  });

  it('presses on when the model labels an edge it did not anchor', async () => {
    // The pressing of supabase that prompted this: a whole valid map, lost
    // after four minutes to one edge that said "Renders page content" and
    // cited nothing. Ungrounded prose is dropped, not fatal.
    const payload = validPayload();
    const systemMap = payload['systemMap'] as { edges: Record<string, unknown>[] };
    systemMap.edges.push({ from: 'greeter', to: 'orders', label: 'Renders page content' });
    const runner = new FakeRunner([JSON.stringify(payload)]);

    const result = await generateLab(REPO, { runner });

    // One call: no retry was needed, because nothing was rejected.
    expect(runner.requests).toHaveLength(1);
    expect(result.attempts).toBe(1);

    // The arrow is still in the diagram; the phrase that cited nothing is not.
    const map = result.spec.base.modules[0]?.widgets[0];
    expect(map?.type).toBe('system-map');
    const edge = map?.type === 'system-map' ? map.edges.at(-1) : undefined;
    expect(edge).toEqual({ from: 'greeter', to: 'orders' });

    // And the run says what it dropped rather than swallowing it.
    expect(result.proseDrops).toEqual([
      { source: 'map', path: 'systemMap.edges[2].label', text: 'Renders page content' },
    ]);
  });

  it('still rejects a callout with no anchors, where the claim IS the widget', () => {
    // Nothing droppable there: a callout is its body, so an unanchored one is
    // a real failure and must still earn its retry.
    const invalid = validPayload();
    invalid['callouts'] = [
      { id: 'unanchored', type: 'callout', kind: 'why', body: 'No anchors here.' },
    ];
    const runner = new FakeRunner([JSON.stringify(invalid), JSON.stringify(validPayload())]);

    return expect(generateLab(REPO, { runner }).then((r) => r.attempts)).resolves.toBe(2);
  });

  it('reports the failure in the coordinates the model wrote in', async () => {
    // The model writes { systemMap, callouts }; this stage validates a lab
    // spec assembled around it. A retry that says base.modules[0].widgets[2]
    // is asking the model to fix a path that appears nowhere in its output.
    const invalid = validPayload();
    invalid['callouts'] = [
      (invalid['callouts'] as unknown[])[0],
      { id: 'unanchored', type: 'callout', kind: 'why', body: 'No anchors here.' },
    ];
    const runner = new FakeRunner([JSON.stringify(invalid), JSON.stringify(validPayload())]);

    await generateLab(REPO, { runner });

    const retry = runner.requests[1]!.prompt;
    expect(retry).toContain('callouts[1]');
    expect(retry).not.toContain('base.modules');
  });

  it('sums cost across attempts', async () => {
    const runner = new FakeRunner([
      { output: 'not json', costUsd: 0.05 },
      { output: JSON.stringify(validPayload()), costUsd: 0.07 },
    ]);

    const result = await generateLab(REPO, { runner });

    expect(result.costUsd).toBeCloseTo(0.12);
  });
});

describe('generateLab: anchor-resolution policy', () => {
  function payloadWithBadAnchor(): Record<string, unknown> {
    const payload = validPayload();
    (payload['callouts'] as unknown[]).push({
      id: 'hallucinated',
      type: 'callout',
      kind: 'connects-to',
      body: 'This claim points at a file that does not exist.',
      anchors: [{ file: 'src/imaginary.ts', symbol: 'nope' }],
    });
    return payload;
  }

  it('drops units with unresolvable anchors under the default policy', async () => {
    const runner = new FakeRunner([JSON.stringify(payloadWithBadAnchor())]);

    const result = await generateLab(REPO, { runner });

    const widgetIds = result.spec.base.modules[0]!.widgets.map((w) => w.id);
    expect(widgetIds).not.toContain('hallucinated');
    const unit = result.resolution.units.find((u) => u.widgetId === 'hallucinated');
    expect(unit?.outcome).toBe('dropped');
    expect(unit?.anchors[0]?.status).toBe('file-missing');
    // The surviving spec still validates.
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);
  });

  it('keeps and reports units under the flag policy', async () => {
    const runner = new FakeRunner([JSON.stringify(payloadWithBadAnchor())]);

    const result = await generateLab(REPO, { runner, resolutionPolicy: 'flag' });

    const widgetIds = result.spec.base.modules[0]!.widgets.map((w) => w.id);
    expect(widgetIds).toContain('hallucinated');
    const unit = result.resolution.units.find((u) => u.widgetId === 'hallucinated');
    expect(unit?.outcome).toBe('flagged');
  });
});

describe('generateLab: config plumbing', () => {
  it('passes the map-stage model override to the runner and reports the full map', async () => {
    const runner = new FakeRunner([JSON.stringify(validPayload())]);

    const result = await generateLab(REPO, {
      runner,
      models: { map: 'claude-opus-4-8' },
    });

    expect(runner.requests[0]!.model).toBe('claude-opus-4-8');
    expect(result.models.map).toBe('claude-opus-4-8');
    expect(result.models.plan).toBe('claude-sonnet-5');
  });

  it('honors an explicit labId', async () => {
    const runner = new FakeRunner([JSON.stringify(validPayload())]);

    const result = await generateLab(REPO, { runner, labId: 'my-lab' });

    expect(result.spec.id).toBe('my-lab');
  });

  it('rejects a repoDir that is not an existing directory', async () => {
    const runner = new FakeRunner([JSON.stringify(validPayload())]);

    await expect(generateLab(`${REPO}/does-not-exist`, { runner })).rejects.toThrow(
      /not an existing directory/,
    );
    expect(runner.requests).toHaveLength(0);
  });
});
