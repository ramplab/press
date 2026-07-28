import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPublish } from '../src/commands/publish.js';

/**
 * `ramplab publish` — hand a locally pressed edition to the library without
 * ever holding a credential. Every test runs against an injected `fetch`, so
 * the command is exercised end to end with nothing on the network.
 */

const GOLDEN = fileURLToPath(
  new URL('../../../packages/spec/tests/fixtures/golden.json', import.meta.url),
);

/** A fake worker that records what it was sent. */
function worker(response: { status: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? 'null')) as unknown,
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch: fetchFn, calls };
}

async function withTmpFile(contents: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ramplab-publish-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, contents, 'utf8');
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ACCEPTED = {
  status: 201,
  body: { code: 'k3mq7x2p', expiresAt: '2026-07-26T10:15:00.000Z' },
};

describe('runPublish', () => {
  it('uploads the edition and prints the link that claims it', async () => {
    const out: string[] = [];
    const fake = worker(ACCEPTED);
    const code = await runPublish(
      { specFile: GOLDEN, workerUrl: 'https://api.example.com', siteUrl: 'https://lib.example.com' },
      { fetch: fake.fetch, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
    );
    expect(code).toBe(0);
    expect(fake.calls[0]?.url).toBe('https://api.example.com/publish/pending');
    expect((fake.calls[0]?.body as { title: string }).title).toBeDefined();
    const printed = out.join('\n');
    expect(printed).toContain('https://lib.example.com/claim/?code=k3mq7x2p');
    // The window matters: the reader has to switch to a browser and sign in.
    expect(printed).toMatch(/15 minutes/);
  });

  it('prefers the claim link the worker gives it', async () => {
    const out: string[] = [];
    const fake = worker({
      status: 201,
      body: { ...ACCEPTED.body, claimUrl: 'https://elsewhere.example/claim/?code=k3mq7x2p' },
    });
    await runPublish(
      { specFile: GOLDEN, workerUrl: 'https://api.example.com', siteUrl: 'https://lib.example.com' },
      { fetch: fake.fetch, stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
    );
    expect(out.join('\n')).toContain('https://elsewhere.example/claim/?code=k3mq7x2p');
  });

  it('checks the spec before sending anything', async () => {
    const errs: string[] = [];
    const fake = worker(ACCEPTED);
    await withTmpFile('{"hello":"world"}', async (path) => {
      const code = await runPublish(
        { specFile: path },
        { fetch: fake.fetch, stdout: () => {}, stderr: (l) => errs.push(l) },
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('not a valid lab spec');
      expect(fake.calls).toHaveLength(0);
    });
  });

  it('reports a file it cannot read', async () => {
    const errs: string[] = [];
    const code = await runPublish(
      { specFile: '/no/such/spec.json' },
      { fetch: worker(ACCEPTED).fetch, stdout: () => {}, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('Cannot read');
  });

  it('passes the worker’s own words through when it refuses', async () => {
    const errs: string[] = [];
    const fake = worker({ status: 429, body: { error: 'Too many uploads. Try again in a little while.' } });
    const code = await runPublish(
      { specFile: GOLDEN },
      { fetch: fake.fetch, stdout: () => {}, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('Too many uploads');
  });

  it('says which library it could not reach', async () => {
    const errs: string[] = [];
    const failing = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof globalThis.fetch;
    const code = await runPublish(
      { specFile: GOLDEN, workerUrl: 'https://api.example.com' },
      { fetch: failing, stdout: () => {}, stderr: (l) => errs.push(l) },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('https://api.example.com');
  });
});
