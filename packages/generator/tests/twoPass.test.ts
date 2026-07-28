import { describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec } from '@ramplab/spec';
import {
  FlagshipSelectionError,
  generateLab,
  generateLabPass1,
  selectFlagshipModule,
  type GenerationProgressEvent,
} from '../src/index.js';
import {
  AUTHOR_SCRIPTS,
  REPO,
  ScriptedRunner,
  firstContributionModulePayload,
  greetingsModulePayload,
  mapPayload,
  ordersModulePayload,
  planPayload,
} from './harness.js';

/**
 * The two-pass runtime (PLAN.md §4) exercised against the polyglot fixture
 * repo with the scripted ModelRunner — no live API calls. Pass 1 = map +
 * flagship module, lightly verified, streamed via onProgress. Pass 2 = the
 * existing full pipeline, reusing pass 1's map output and steered by the
 * lead intake.
 */

/** mapPayload()'s nodes: greeter (anchored), orders (anchored), sessions
 * (bare). One edge greeter→orders, so greeter/orders tie at degree 1 and
 * map order breaks the tie in greeter's favor. */

/** A map variant where "orders" clearly has the highest degree (2). */
function ordersCentralMapPayload(): Record<string, unknown> {
  const payload = mapPayload();
  (payload['systemMap'] as { edges: unknown[] }).edges = [
    { from: 'greeter', to: 'orders' },
    { from: 'orders', to: 'sessions' },
  ];
  return payload;
}

/** Wrap a system-map widget into a minimal valid LabSpec for unit tests. */
function specWithSystemMap(systemMap: unknown): ReturnType<typeof parseLabSpec> {
  return parseLabSpec({
    schemaVersion: 1,
    id: 'unit',
    title: 'Unit fixture',
    base: { modules: [{ id: 'repo-overview', title: 'Tour', widgets: [systemMap] }] },
    overlay: [],
  });
}

function eventLabel(event: GenerationProgressEvent): string {
  switch (event.type) {
    case 'stage-started':
    case 'stage-completed':
      return `${event.type}:${event.stage}`;
    case 'plan-ready':
      return `plan-ready:${event.modules.length}`;
    case 'module-authored':
      return `module-authored:${event.moduleId}`;
    case 'spec-updated':
      return `spec-updated:${event.spec.base.modules.length}`;
  }
}

describe('pass 1: map + flagship module, lightly verified', () => {
  it('authors exactly one module and assembles overview + flagship into a valid, resolved spec', async () => {
    const runner = new ScriptedRunner({
      map: [{ output: JSON.stringify(mapPayload()), costUsd: 0.1 }],
      // Flagship module ids are system-map node ids.
      author: { greeter: [{ output: JSON.stringify(greetingsModulePayload()), costUsd: 0.3 }] },
    });

    const result = await generateLabPass1(REPO, { runner });

    // Light verification: map + one author call — NO plan, NO verifier agent.
    expect(runner.requests.map((r) => r.stage)).toEqual(['map', 'author']);
    expect(result.spec.base.modules.map((m) => m.id)).toEqual(['greeter', 'repo-overview']);
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(result.spec))).success).toBe(true);

    // Anchor resolution ran over the assembled preview.
    expect(result.resolution.summary.unresolvedUnits).toBe(0);
    expect(result.resolution.summary.resolvedAnchors).toBe(
      result.resolution.summary.totalAnchors,
    );

    // Tie at degree 1 (greeter/orders) keeps map order: greeter wins.
    expect(result.flagship).toMatchObject({
      nodeId: 'greeter',
      basis: 'centrality',
      degree: 1,
    });
    expect(result.flagship.plannedModule.keyFiles).toEqual(['src/greeter.ts']);
    expect(result.authorAttempts).toEqual({ greeter: 1 });
    expect(result.costUsd).toBeCloseTo(0.4);

    // The raw map output is returned so pass 2 can reuse it.
    expect(result.mapResult.spec.base.modules.map((m) => m.id)).toEqual(['repo-overview']);
    expect(result.mapResult.attempts).toBe(1);
  });

  it('picks the highest-degree anchored node as flagship', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(ordersCentralMapPayload())],
      author: { orders: [JSON.stringify(ordersModulePayload())] },
    });

    const result = await generateLabPass1(REPO, { runner });

    expect(result.flagship).toMatchObject({
      nodeId: 'orders',
      basis: 'centrality',
      degree: 2,
    });
    expect(result.spec.base.modules.map((m) => m.id)).toEqual(['orders', 'repo-overview']);
  });

  it('never picks an unanchored node, however central', () => {
    // "hub" has the highest degree but no anchors anywhere near it —
    // nothing to author from, so the anchored "greeter" wins instead.
    const spec = specWithSystemMap({
      id: 'system-map',
      type: 'system-map',
      nodes: [
        { id: 'hub', label: 'Hub' },
        {
          id: 'greeter',
          label: 'Greeter',
          description: 'TypeScript greeting service.',
          anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }],
        },
      ],
      edges: [
        { from: 'hub', to: 'greeter' },
        { from: 'greeter', to: 'hub' },
      ],
    });

    const selection = selectFlagshipModule(spec);
    expect(selection.nodeId).toBe('greeter');
    // Edge anchors count toward a node's key files too; here there are none.
    expect(selection.plannedModule.keyFiles).toEqual(['src/greeter.ts']);
  });

  it('fails with a clear error when no node is anchored', () => {
    const spec = specWithSystemMap({
      id: 'system-map',
      type: 'system-map',
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });

    expect(() => selectFlagshipModule(spec)).toThrow(FlagshipSelectionError);
    expect(() => selectFlagshipModule(spec)).toThrow(/no system-map node carries an anchor/);
  });

  it('lets an intake hint override the centrality pick and threads intake into the flagship prompt', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      author: { orders: [JSON.stringify(ordersModulePayload())] },
    });

    const result = await generateLabPass1(REPO, {
      runner,
      intake: {
        weekOneMastery: ['order totals and money handling'],
        gotchas: ['totals are integer cents, never floats'],
      },
    });

    // Centrality alone would pick greeter (see the happy-path test); the
    // intake's "order totals..." matches the orders node and overrides it.
    expect(result.flagship).toMatchObject({
      nodeId: 'orders',
      basis: 'intake',
      matchedHint: 'order totals and money handling',
    });
    expect(result.spec.base.modules.map((m) => m.id)).toEqual(['orders', 'repo-overview']);

    // The flagship author's brief carries the intake answers.
    const authorPrompt = runner.authorRequests()[0]!.prompt;
    expect(authorPrompt).toContain('week-one hires must master: order totals and money handling');
    expect(authorPrompt).toContain('known gotchas to call out: totals are integer cents');
    expect(authorPrompt).toContain('onboarding lead');
  });

  it('falls back to centrality when no intake hint matches a node', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      author: { greeter: [JSON.stringify(greetingsModulePayload())] },
    });

    const result = await generateLabPass1(REPO, {
      runner,
      intake: { weekOneMastery: ['kubernetes deployment topology'] },
    });

    expect(result.flagship).toMatchObject({ nodeId: 'greeter', basis: 'centrality' });
  });

  it('streams the documented onProgress event sequence with renderable spec snapshots', async () => {
    const events: GenerationProgressEvent[] = [];
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      author: { greeter: [JSON.stringify(greetingsModulePayload())] },
    });

    await generateLabPass1(REPO, { runner, onProgress: (event) => events.push(event) });

    expect(events.map(eventLabel)).toEqual([
      'stage-started:map',
      'stage-completed:map',
      'spec-updated:1', // the overview renders before authoring starts
      'stage-started:author',
      'module-authored:greeter',
      'stage-completed:author',
      'stage-started:assemble',
      'stage-completed:assemble',
      'spec-updated:2', // overview + flagship
    ]);
    for (const event of events) {
      expect(event.pass).toBe('pass1');
      if (event.type === 'spec-updated') {
        // Every snapshot is schema-valid after a JSON round-trip: renderable as-is.
        expect(safeParseLabSpec(JSON.parse(JSON.stringify(event.spec))).success).toBe(true);
      }
    }
  });

  it('measures pass-1 timing with the injected clock', async () => {
    let now = 0;
    const clock = (): number => (now += 500);
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      author: { greeter: [JSON.stringify(greetingsModulePayload())] },
    });

    const result = await generateLabPass1(REPO, { runner, clock });

    // Eight clock reads: entry, around each of map/author/assemble, exit.
    expect(result.timing.startedAtMs).toBe(500);
    expect(result.timing.durationMs).toBe(3500); // 4000 - 500
    expect(now).toBe(4000);
    // The per-stage split (#31) — each stage spans one 500ms tick. The
    // scripted runner reports no spend, so costUsd is (correctly) absent.
    expect(result.timing.stages).toEqual([
      { stage: 'map', durationMs: 500 },
      { stage: 'author', durationMs: 500 },
      { stage: 'assemble', durationMs: 500 },
    ]);
    const summed = result.timing.stages.reduce((ms, s) => ms + s.durationMs, 0);
    expect(summed).toBeLessThanOrEqual(result.timing.durationMs);
  });
});

describe('pass 2: full pipeline with map reuse, intake, and progress', () => {
  it('reuses pass 1 map output — no second map call, its cost not re-counted', async () => {
    const pass1Runner = new ScriptedRunner({
      map: [{ output: JSON.stringify(mapPayload()), costUsd: 0.1 }],
      author: { greeter: [{ output: JSON.stringify(greetingsModulePayload()), costUsd: 0.05 }] },
    });
    const pass1 = await generateLabPass1(REPO, { runner: pass1Runner });

    const pass2Runner = new ScriptedRunner({
      map: [], // any map call would throw: no scripted response
      plan: [
        {
          output: JSON.stringify(planPayload(['greetings', 'first-contribution'])),
          costUsd: 0.2,
        },
      ],
      author: {
        greetings: [{ output: JSON.stringify(greetingsModulePayload()), costUsd: 0.3 }],
        'first-contribution': [
          { output: JSON.stringify(firstContributionModulePayload()), costUsd: 0.1 },
        ],
      },
    });

    const result = await generateLab(REPO, {
      runner: pass2Runner,
      full: true,
      mapResult: pass1.mapResult,
    });

    // Runner bookkeeping: the map stage never ran in pass 2. The third author
    // call is the overview chapter's re-write (2026-07-26).
    expect(pass2Runner.requests.map((r) => r.stage)).toEqual([
      'plan',
      'author',
      'author',
      'author',
      'verify',
      'verify',
      'verify',
    ]);
    expect(result.spec.base.modules.map((m) => m.id)).toEqual([
      'greetings',
      'repo-overview',
      'first-contribution',
    ]);
    expect(result.attempts).toBe(pass1.mapResult.attempts);
    // plan (0.2) + authors (0.3 + 0.1); the reused map's 0.1 was pass 1's spend.
    expect(result.costUsd).toBeCloseTo(0.6);
    // The flagship module is re-authored from pass 2's own plan, not spliced
    // in from pass 1 — the plan stage owns the canonical curriculum.
    expect(pass2Runner.authorRequests()).toHaveLength(2 + 1); // + the overview re-write
  });

  it('threads the intake into the plan prompt', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, {
      runner,
      full: true,
      intake: {
        weekOneMastery: ['the greeting path end to end'],
        activeDevelopment: ['orders is being rewritten'],
        gotchas: ['session expiry is lazy'],
      },
    });

    const planPrompt = runner.requests.find((r) => r.stage === 'plan')!.prompt;
    expect(planPrompt).toContain('What must a week-one hire master?');
    expect(planPrompt).toContain('- the greeting path end to end');
    expect(planPrompt).toContain('What is under active development?');
    expect(planPrompt).toContain('- orders is being rewritten');
    expect(planPrompt).toContain('What trips people up?');
    expect(planPrompt).toContain('- session expiry is lazy');
  });

  it('omits the intake section when no intake is given', async () => {
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, { runner, full: true });

    const planPrompt = runner.requests.find((r) => r.stage === 'plan')!.prompt;
    expect(planPrompt).not.toContain('What must a week-one hire master?');
    expect(planPrompt).not.toContain('2-minute intake');
  });

  it('intake answers demonstrably change the curriculum plan', async () => {
    // The scripted planner behaves like a model that respects the intake:
    // it plans the orders module only when the intake mentions billing.
    const scriptedPlanner = (prompt: string): string =>
      prompt.includes('billing')
        ? JSON.stringify(planPayload(['orders', 'first-contribution']))
        : JSON.stringify(planPayload(['greetings', 'first-contribution']));

    const withoutIntake = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [scriptedPlanner],
      author: AUTHOR_SCRIPTS,
    });
    const withIntake = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [scriptedPlanner],
      author: AUTHOR_SCRIPTS,
    });

    const baseline = await generateLab(REPO, { runner: withoutIntake, full: true });
    const steered = await generateLab(REPO, {
      runner: withIntake,
      full: true,
      intake: { weekOneMastery: ['billing and order totals'] },
    });

    expect(baseline.plan?.modules.map((m) => m.id)).toEqual([
      'greetings',
      'first-contribution',
    ]);
    expect(steered.plan?.modules.map((m) => m.id)).toEqual([
      'orders',
      'first-contribution',
    ]);
    expect(steered.spec.base.modules.map((m) => m.id)).toEqual([
      'orders',
      'repo-overview',
      'first-contribution',
    ]);
  });

  it('streams pass2 progress events across all five stages', async () => {
    const events: GenerationProgressEvent[] = [];
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'orders', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, {
      runner,
      full: true,
      concurrency: 1, // deterministic module-authored order
      onProgress: (event) => events.push(event),
    });

    expect(events.map(eventLabel)).toEqual([
      'stage-started:map',
      'stage-completed:map',
      'spec-updated:1', // overview renders before planning starts
      'stage-started:plan',
      'stage-completed:plan',
      // The denominator, before the stage that needs it (#164).
      'plan-ready:3',
      'stage-started:author',
      'module-authored:greetings',
      'spec-updated:2', // live preview: overview + each module as it lands
      'module-authored:orders',
      'spec-updated:3',
      'module-authored:first-contribution',
      'spec-updated:4',
      'stage-completed:author',
      'stage-started:assemble',
      'stage-completed:assemble',
      'spec-updated:4', // overview + all three authored modules
      'stage-started:verify',
      'stage-completed:verify',
      'spec-updated:4', // the verified final spec
    ]);
    for (const event of events) {
      expect(event.pass).toBe('pass2');
      if (event.type === 'spec-updated') {
        expect(safeParseLabSpec(JSON.parse(JSON.stringify(event.spec))).success).toBe(true);
      }
    }
  });

  it('keeps authoring open until the zoom-out chapter is written', async () => {
    // A live press of supabase went silent here: `✓ authored` on top, verify
    // and assemble still pending, no spinner and no clock, while the overview
    // chapter was being written for several minutes. Reported complete before
    // its last piece of work, the stage leaves the display with nothing
    // active, and a working press becomes indistinguishable from a dead one.
    //
    // The other sequence test never caught it because AUTHOR_SCRIPTS has no
    // repo-overview entry, so the re-author throws and is swallowed. Here it
    // succeeds, which is the case a real press always takes.
    const events: GenerationProgressEvent[] = [];
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: {
        ...AUTHOR_SCRIPTS,
        'repo-overview': [JSON.stringify(firstContributionModulePayload())],
      },
    });

    await generateLab(REPO, {
      runner,
      full: true,
      concurrency: 1,
      onProgress: (event) => events.push(event),
    });

    const labels = events.map(eventLabel);
    const overview = labels.indexOf('module-authored:repo-overview');
    const authorClosed = labels.indexOf('stage-completed:author');

    expect(overview).toBeGreaterThan(-1);
    expect(authorClosed).toBeGreaterThan(overview);
    // And nothing else opens before it closes, so there is never a moment
    // with no stage running.
    expect(labels.indexOf('stage-started:assemble')).toBeGreaterThan(authorClosed);
  });

  it('skips map events when reusing a supplied map result', async () => {
    const pass1Runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      author: { greeter: [JSON.stringify(greetingsModulePayload())] },
    });
    const pass1 = await generateLabPass1(REPO, { runner: pass1Runner });

    const events: GenerationProgressEvent[] = [];
    const runner = new ScriptedRunner({
      map: [],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });

    await generateLab(REPO, {
      runner,
      full: true,
      mapResult: pass1.mapResult,
      onProgress: (event) => events.push(event),
    });

    expect(events.map(eventLabel).slice(0, 2)).toEqual([
      'spec-updated:1',
      'stage-started:plan',
    ]);
    expect(events.map(eventLabel)).not.toContain('stage-started:map');
  });

  it('the tracer emits no progress events', async () => {
    const events: GenerationProgressEvent[] = [];
    const runner = new ScriptedRunner({ map: [JSON.stringify(mapPayload())] });

    await generateLab(REPO, { runner, onProgress: (event) => events.push(event) });

    expect(events).toEqual([]);
  });
});

describe('plan-ready', () => {
  it('announces the chapters a pressing has committed to, before authoring starts', async () => {
    // The numerator was always derivable from module-authored; the total lived
    // and died inside the generator, so nothing watching could say "4 of 6"
    // during the longest stage of the run (#164).
    const runner = new ScriptedRunner({
      map: [JSON.stringify(mapPayload())],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });
    const events: GenerationProgressEvent[] = [];
    await generateLab(REPO, { runner, full: true, onProgress: (event) => events.push(event) });

    const planReady = events.find((event) => event.type === 'plan-ready');
    expect(planReady).toBeDefined();
    if (planReady?.type !== 'plan-ready') throw new Error('unreachable');
    expect(planReady.modules.length).toBeGreaterThan(0);
    expect(planReady.modules[0]).toHaveProperty('title');

    // Before authoring, so a display has the denominator for the whole stage.
    const order = events.map((event) => event.type);
    expect(order.indexOf('plan-ready')).toBeLessThan(
      order.indexOf('module-authored'),
    );

    // And it is the real plan: every chapter that lands was announced.
    const authored = events.flatMap((event) =>
      event.type === 'module-authored' ? [event.moduleId] : [],
    );
    const announced = planReady.modules.map((module) => module.id);
    for (const id of authored) expect(announced).toContain(id);
  });
});

describe('the map stage and an empty optional field', () => {
  it('accepts a map whose anchors say "no symbol" with an empty string', async () => {
    // The live failure: every node anchored, two anchors carrying
    // `"symbol": ""`, and a six minute run thrown away over it (#107).
    const payload = JSON.parse(JSON.stringify(mapPayload())) as {
      systemMap: { nodes: { anchors?: { file: string; symbol?: string }[] }[] };
    };
    const first = payload.systemMap.nodes[0];
    if (first?.anchors?.[0] !== undefined) first.anchors[0].symbol = '';

    const runner = new ScriptedRunner({
      map: [JSON.stringify(payload)],
      plan: [JSON.stringify(planPayload(['greetings', 'first-contribution']))],
      author: AUTHOR_SCRIPTS,
    });
    const result = await generateLab(REPO, { runner, full: true });
    expect(result.spec.base.modules.length).toBeGreaterThan(0);
  });
});
