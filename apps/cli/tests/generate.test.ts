import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  GenerateLabConfig,
  GenerateLabResult,
  GenerationProgressEvent,
  ModelRunner,
} from '@ramplab/generator';
import type { LabSpec } from '@ramplab/spec';
import {
  defaultOutName,
  dropsPathFor,
  freeOutPath,
  runGenerate,
} from '../src/commands/generate.js';

/**
 * The generate command is exercised with an injected fake `generate` and a
 * fake runner, so the whole CLI path — progress printing, spec writing,
 * summary, exit codes, and the ANTHROPIC_API_KEY preflight — runs with **no
 * API spend**. The generation pipeline itself is covered by the generator's
 * own fake-runner tests; here we test the wrapper's behavior.
 */

const fakeSpec = {
  schemaVersion: '1',
  id: 'demo',
  title: 'Demo',
  base: { modules: [{ id: 'a' }, { id: 'b' }] },
  overlay: { modules: [] },
} as unknown as LabSpec;

const scriptedEvents: GenerationProgressEvent[] = [
  { type: 'stage-started', pass: 'pass2', stage: 'map' },
  { type: 'stage-completed', pass: 'pass2', stage: 'map' },
  { type: 'module-authored', pass: 'pass2', moduleId: 'a', attempts: 1 },
];

function fakeGenerate(
  events: GenerationProgressEvent[] = scriptedEvents,
  costUsd: number | undefined = 1.23,
  proseDrops: GenerateLabResult['proseDrops'] = [],
): (repo: string, config: GenerateLabConfig) => Promise<GenerateLabResult> {
  return async (_repoDir, config) => {
    for (const event of events) config.onProgress?.(event);
    return {
      spec: fakeSpec,
      resolution: {} as GenerateLabResult['resolution'],
      models: {} as GenerateLabResult['models'],
      costUsd,
      attempts: 1,
      proseDrops,
    };
  };
}

async function withTmpOut<T>(fn: (out: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ramplab-cli-'));
  try {
    return await fn(join(dir, 'spec.json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runGenerate', () => {
  it('writes the spec, streams progress, and reports a summary (no spend)', async () => {
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(code).toBe(0);
      const written = JSON.parse(await readFile(out, 'utf8'));
      expect(written.base.modules).toHaveLength(2);

      const output = lines.join('\n');
      expect(output).toContain('▸ map…');
      expect(output).toContain('authored a');
      expect(output).toContain('2 modules');
      expect(output).toContain('$1.23');
    });
  });

  // No API key required since 2026-07-26: the Agent SDK resolves the Claude
  // Code login when no key is set, so a Pro or Max subscription presses
  // without anyone minting one. Developers have Claude Code; far fewer have
  // API billing, and that gate was the whole barrier.
  it('presses on the Claude Code login when no key is set, and says so', async () => {
    await withTmpOut(async (out) => {
      const outs: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        { generate: fakeGenerate(), env: {}, stdout: (l) => outs.push(l), stderr: () => {} },
      );

      expect(code).toBe(0);
      const said = outs.join('\n');
      expect(said).toContain('Claude Code login');
      // The reader must know which pocket this comes out of.
      expect(said).toContain('not API credit');
      expect(said).not.toContain('$5–30');
    });
  });

  it('names the key, and its cost, when one is set', async () => {
    await withTmpOut(async (out) => {
      const outs: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(),
          env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
          stdout: (l) => outs.push(l),
          stderr: () => {},
        },
      );
      expect(code).toBe(0);
      expect(outs.join('\n')).toContain('ANTHROPIC_API_KEY');
      expect(outs.join('\n')).toContain('$5–30');
    });
  });

  it('keeps the chapters that landed when the press falls over', async () => {
    // A press can die on a stage error, a turn cap or a dropped connection
    // (#177). None of those make the chapters already written any worse, and
    // this used to discard them while holding a valid edition in memory.
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: async (_repoDir, config) => {
            config.onProgress?.({ type: 'spec-updated', pass: 'pass2', spec: fakeSpec });
            throw new Error('Agent SDK session for stage "author" failed (error_max_turns).');
          },
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(code).toBe(1);
      const output = lines.join('\n');
      // Why it stopped, and that what is on disk is not the whole book.
      expect(output).toContain('error_max_turns');
      expect(output).toContain('PARTIAL edition');
      const saved = JSON.parse(await readFile(out, 'utf8')) as { title: string };
      expect(saved.title).toBe('Demo');
    });
  });

  it('exits 130 and says interrupted when the reader stops it', async () => {
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      let fire: (() => void) | undefined;
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: async (_repoDir, config) => {
            config.onProgress?.({ type: 'spec-updated', pass: 'pass2', spec: fakeSpec });
            fire?.();
            throw new Error('aborted');
          },
          runner: {} as ModelRunner,
          onInterrupt: (handler) => {
            fire = handler;
            return () => {};
          },
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(code).toBe(130);
      const output = lines.join('\n');
      expect(output).toContain('Interrupted.');
      // An interrupt is a choice, not a fault; no failure message.
      expect(output).not.toContain('Generation failed');
    });
  });

  it('returns a non-zero code and message when generation throws', async () => {
    await withTmpOut(async (out) => {
      const errs: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: async () => {
            throw new Error('map stage exploded');
          },
          runner: {} as ModelRunner,
          stdout: () => {},
          stderr: (l) => errs.push(l),
        },
      );

      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('map stage exploded');
    });
  });

  it('reports "n/a" when the run does not report a cost', async () => {
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: async () => ({
            spec: fakeSpec,
            resolution: {} as GenerateLabResult['resolution'],
            models: {} as GenerateLabResult['models'],
            costUsd: undefined,
            attempts: 1,
            proseDrops: [],
          }),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );
      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('model cost n/a');
    });
  });

  it('says how long the press took, not only what it produced', async () => {
    // A press is advertised at about half an hour and bills real money; the
    // summary used to report neither the clock nor anything but a count.
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const ticks = [0, 1_872_000]; // start, then 31m 12s later
      let call = 0;
      await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(),
          runner: {} as ModelRunner,
          now: () => ticks[Math.min(call++, ticks.length - 1)]!,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(lines.join('\n')).toContain('31m 12s');
    });
  });

  it('tells the reader what is missing, in terms they can use', async () => {
    // The first version of this printed `map · systemMap.edges[2].label` and a
    // sentence about "the shape it sat on" — written for whoever tunes the map
    // prompt, not for someone who just pressed their own repo for an hour.
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const code = await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(scriptedEvents, 1.23, [
            { source: 'map', path: 'systemMap.edges[0].label', text: 'Route to database' },
            { source: 'map', path: 'systemMap.edges[1].label', text: 'Route to auth' },
          ]),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(code).toBe(0);
      const output = lines.join('\n');
      expect(output).toContain('2 diagram labels were left out');
      expect(output).toContain('otherwise complete');
      // None of the machine vocabulary reaches them.
      expect(output).not.toContain('systemMap.edges');
      expect(output).not.toContain('the shape it sat on');
      expect(output).not.toContain('Route to database');
    });
  });

  it('keeps the per-drop detail in a sidecar, for whoever fixes the prompt', async () => {
    // Five consecutive edge labels failing is how anyone learns the map prompt
    // is the thing to fix; that signal must survive leaving the terminal.
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const drops = [
        { source: 'map', path: 'systemMap.edges[0].label', text: 'Route to database' },
        { source: 'user-views-table', path: 'widgets[3].stages[5].description', text: 'Postgres.' },
      ];
      await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(scriptedEvents, 1.23, drops),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      const sidecar = dropsPathFor(out);
      expect(lines.join('\n')).toContain(sidecar);
      const written = JSON.parse(await readFile(sidecar, 'utf8')) as {
        count: number;
        drops: typeof drops;
      };
      expect(written.count).toBe(2);
      expect(written.drops).toEqual(drops);
      await rm(sidecar, { force: true });
    });
  });

  it('names the edition after the repository, so two presses never collide', () => {
    // The default was `spec.json` for every press, which is not a name so much
    // as a collision: the second repo anyone pressed silently destroyed the
    // first edition, an hour and around $25, with nothing on screen to say so.
    expect(defaultOutName('https://github.com/supabase/supabase')).toBe('supabase.json');
    expect(defaultOutName('https://github.com/caddyserver/caddy')).toBe('caddy.json');
    expect(defaultOutName('/home/me/my_project')).toBe('my-project.json');
  });

  it('steps past a taken name rather than writing over it', () => {
    const taken = new Set(['supabase.json', 'supabase-2.json']);
    expect(freeOutPath('supabase.json', (p) => taken.has(p))).toBe('supabase-3.json');
    expect(freeOutPath('free.json', () => false)).toBe('free.json');
  });

  it('says where it is writing before it spends anything', async () => {
    const lines: string[] = [];
    await runGenerate(
      { repo: 'https://github.com/supabase/supabase' },
      {
        generate: fakeGenerate(),
        runner: {} as ModelRunner,
        clone: fakeClone('/tmp/nowhere').clone,
        fileExists: (p) => p === 'supabase.json',
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
      },
    );

    const output = lines.join('\n');
    // Announced up front, and the collision is stepped past, not overwritten.
    expect(output).toContain('supabase.json exists; writing to supabase-2.json');
    expect(output).toContain('✓ Wrote supabase-2.json');
    await rm('supabase-2.json', { force: true });
  });

  it('names the next thing to do, as commands that exist', async () => {
    // After an hour and real money the closing line used to recommend
    // `validate`, and point at a viewer without saying where it was.
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      const output = lines.join('\n');
      expect(output).toContain(`ramplab preview ${out}`);
      expect(output).toContain(`ramplab publish ${out}`);
      expect(output).toContain(`ramplab export ${out} --static`);
      expect(output).not.toContain('ramplab validate');
    });
  });

  it('says nothing about drops when every claim was anchored', async () => {
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      await runGenerate(
        { repo: '/repo', out },
        {
          generate: fakeGenerate(),
          runner: {} as ModelRunner,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );

      expect(lines.join('\n')).not.toContain('unanchored');
    });
  });
});

/** A clone that yields a fixed directory and records whether it was removed. */
function fakeClone(dir: string) {
  const seen: string[] = [];
  let cleaned = false;
  return {
    seen,
    cleaned: () => cleaned,
    clone: async (repoUrl: string) => {
      seen.push(repoUrl);
      return {
        dir,
        cleanup: async (): Promise<void> => {
          cleaned = true;
        },
      };
    },
  };
}

describe('runGenerate from a git URL', () => {
  it('clones the URL and presses the checkout, not the argument', async () => {
    await withTmpOut(async (out) => {
      const lines: string[] = [];
      const fake = fakeClone('/tmp/checkout-1');
      const pressed: string[] = [];
      const code = await runGenerate(
        { repo: 'https://github.com/octocat/Hello-World', out },
        {
          clone: fake.clone,
          generate: (repoDir, config) => {
            pressed.push(repoDir);
            return fakeGenerate()(repoDir, config);
          },
          runner: {} as ModelRunner,
          readCommit: () => 'a'.repeat(40),
          isDirty: () => false,
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );
      expect(code).toBe(0);
      expect(fake.seen).toEqual(['https://github.com/octocat/Hello-World.git']);
      expect(pressed).toEqual(['/tmp/checkout-1']);
      expect(lines.join('\n')).toContain('Cloning octocat/Hello-World');
      // A fresh clone is never dirty, so the commit always travels with it.
      expect(JSON.parse(await readFile(out, 'utf8')).commit).toBe('a'.repeat(40));
    });
  });

  it('removes the checkout even when the press fails', async () => {
    await withTmpOut(async (out) => {
      const fake = fakeClone('/tmp/checkout-2');
      const code = await runGenerate(
        { repo: 'https://github.com/octocat/Hello-World', out },
        {
          clone: fake.clone,
          generate: () => Promise.reject(new Error('pipeline exploded')),
          runner: {} as ModelRunner,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(code).toBe(1);
      expect(fake.cleaned()).toBe(true);
    });
  });

  it('says what is wrong with the URL, not that a directory is missing', async () => {
    await withTmpOut(async (out) => {
      const errs: string[] = [];
      const fake = fakeClone('/tmp/never');
      const code = await runGenerate(
        { repo: 'https://gitlab.com/acme/widgets', out },
        {
          clone: fake.clone,
          runner: {} as ModelRunner,
          stdout: () => {},
          stderr: (l) => errs.push(l),
        },
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toMatch(/only github\.com/i);
      // And it never went near the network to find that out.
      expect(fake.seen).toEqual([]);
    });
  });

  it('presses a local directory without cloning anything', async () => {
    await withTmpOut(async (out) => {
      const fake = fakeClone('/tmp/never');
      const pressed: string[] = [];
      await runGenerate(
        { repo: '/some/local/repo', out },
        {
          clone: fake.clone,
          generate: (repoDir, config) => {
            pressed.push(repoDir);
            return fakeGenerate()(repoDir, config);
          },
          runner: {} as ModelRunner,
          readCommit: () => undefined,
          isDirty: () => false,
          stdout: () => {},
          stderr: () => {},
        },
      );
      expect(fake.seen).toEqual([]);
      expect(pressed).toEqual(['/some/local/repo']);
    });
  });
});

describe('naming the repository an edition describes', () => {
  /** Press and hand back the spec that was written. */
  async function pressed(
    options: { repo: string },
    deps: Parameters<typeof runGenerate>[1],
  ): Promise<Record<string, unknown>> {
    return withTmpOut(async (out) => {
      const code = await runGenerate({ ...options, out }, {
        generate: fakeGenerate(),
        runner: {} as ModelRunner,
        stdout: () => {},
        stderr: () => {},
        ...deps,
      });
      expect(code).toBe(0);
      return JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
    });
  }

  it('names the remote a local checkout came from', async () => {
    // Without this every locally pressed edition reads as naming no
    // repository, and nothing can ever check it against one.
    const spec = await pressed(
      { repo: '/some/checkout' },
      { readRemote: () => 'https://github.com/caddyserver/caddy', readCommit: () => 'b'.repeat(40), isDirty: () => false },
    );
    expect(spec.repo).toBe('https://github.com/caddyserver/caddy');
    expect(spec.commit).toBe('b'.repeat(40));
  });

  it('names the URL it cloned, without asking the checkout', async () => {
    const spec = await pressed(
      { repo: 'https://github.com/octocat/Hello-World' },
      {
        clone: async () => ({ dir: '/tmp/checkout', cleanup: async (): Promise<void> => {} }),
        readRemote: () => 'https://github.com/somebody/else',
        readCommit: () => 'c'.repeat(40),
        isDirty: () => false,
      },
    );
    expect(spec.repo).toBe('https://github.com/octocat/Hello-World');
  });

  it('names nothing when the directory is not a public GitHub checkout, and says so', async () => {
    const lines: string[] = [];
    const spec = await pressed(
      { repo: '/some/tarball' },
      { readRemote: () => undefined, readCommit: () => undefined, isDirty: () => false, stdout: (l) => lines.push(l) },
    );
    expect(spec.repo).toBeUndefined();
    // Said at the press, where the reason is visible, not discovered later on
    // a claim page with the shelf greyed out.
    expect(lines.join('\n')).toContain('not a checkout of a public GitHub repository');
    expect(lines.join('\n')).toContain('privately or by link, but not to the shelf');
  });
});
