import { describe, expect, it, vi } from 'vitest';
import {
  cloneRepo,
  CloneTimeoutError,
  parseGitProgress,
  validateRepoUrl,
  type ExecFn,
} from '../src/cloneRepo.js';

describe('validateRepoUrl', () => {
  it('accepts a plain github repo and derives a stable key', () => {
    const r = validateRepoUrl('https://github.com/sindresorhus/ky');
    expect(r).toEqual({ ok: true, url: 'https://github.com/sindresorhus/ky.git', repoKey: 'sindresorhus/ky' });
  });

  it('strips a trailing .git and trims whitespace', () => {
    const r = validateRepoUrl('  https://github.com/gorilla/mux.git  ');
    expect(r.ok && r.repoKey).toBe('gorilla/mux');
  });

  it.each([
    ['http://github.com/a/b', 'http not allowed'],
    ['https://gitlab.com/a/b', 'non-github host'],
    ['https://user:pass@github.com/a/b', 'credentials in url'],
    ['https://github.com/a', 'missing repo segment'],
    ['https://github.com/a/b/c', 'too many segments'],
    ['https://github.com/a/..', 'path traversal'],
    ['not a url', 'garbage'],
  ])('rejects %s (%s)', (url) => {
    expect(validateRepoUrl(url).ok).toBe(false);
  });
});

describe('cloneRepo', () => {
  it('runs a shallow single-branch clone and returns a cleanup', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stderr: '' }));
    const result = await cloneRepo('https://github.com/sindresorhus/ky', {
      exec,
      timeoutMs: 5000,
    });
    expect(exec).toHaveBeenCalledOnce();
    const [cmd, args, opts] = exec.mock.calls[0]!;
    expect(cmd).toBe('git');
    expect(args).toContain('--depth');
    expect(args).toContain('1');
    expect(args).toContain('--single-branch');
    expect(args).toContain('https://github.com/sindresorhus/ky.git');
    expect(opts.timeoutMs).toBe(5000);
    expect(typeof result.cleanup).toBe('function');
    await result.cleanup();
  });

  it('cleans up and throws when git fails', async () => {
    const exec: ExecFn = async () => ({ code: 128, stderr: 'fatal: repository not found' });
    await expect(cloneRepo('https://github.com/nope/nope', { exec })).rejects.toThrow(
      /git clone failed.*repository not found/,
    );
  });

  it('rejects an invalid URL before cloning', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stderr: '' }));
    await expect(cloneRepo('https://evil.com/a/b', { exec })).rejects.toThrow(/Invalid repo URL/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('cloneRepo with an installation token (private repos, P2)', () => {
  it('sends the token as a github-scoped Basic extraheader, never in the URL', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stderr: '' }));
    await (
      await cloneRepo('https://github.com/acme/api', { exec, accessToken: 'ghs_secret' })
    ).cleanup();
    const [, args] = exec.mock.calls[0]!;
    const headerArg = args.find((a) => a.startsWith('http.https://github.com/.extraheader='));
    expect(headerArg).toBe(
      `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(
        'x-access-token:ghs_secret',
      ).toString('base64')}`,
    );
    expect(args[args.indexOf(headerArg!) - 1]).toBe('-c');
    // The clone URL stays credential-free and the raw token never appears in
    // argv (it rides base64'd inside the one header arg).
    expect(args).toContain('https://github.com/acme/api.git');
    expect(args.filter((a) => a.includes('ghs_secret'))).toEqual([]);
  });

  it('adds no auth args without a token', async () => {
    const exec = vi.fn<ExecFn>(async () => ({ code: 0, stderr: '' }));
    await (await cloneRepo('https://github.com/acme/api', { exec })).cleanup();
    const [, args] = exec.mock.calls[0]!;
    expect(args.some((a) => a.includes('extraheader'))).toBe(false);
    expect(args[0]).toBe('clone');
  });
});

describe('cloneRepo at a commit', () => {
  /** Every git invocation, flattened for readability. */
  function record(): { exec: ExecFn; runs: string[] } {
    const runs: string[] = [];
    return {
      runs,
      exec: async (cmd, args) => {
        runs.push(`${cmd} ${args.join(' ')}`);
        return { code: 0, stderr: '' };
      },
    };
  }

  it('fetches that exact commit rather than whatever HEAD has become', async () => {
    const sha = 'b'.repeat(40);
    const { exec, runs } = record();
    const result = await cloneRepo('https://github.com/acme/widgets', { exec, commit: sha });
    // Cloning the default branch and hoping is the bug this avoids: anchors
    // are only checkable against the tree they were written against.
    expect(runs.some((run) => run.includes(`fetch --depth 1 origin ${sha}`))).toBe(true);
    expect(runs.some((run) => run.includes('checkout --detach FETCH_HEAD'))).toBe(true);
    expect(runs.every((run) => run.startsWith('git '))).toBe(true);
    await result.cleanup();
  });

  it('cleans up and throws when the commit is not there to fetch', async () => {
    const exec: ExecFn = async (_cmd, args) =>
      args.includes('fetch')
        ? { code: 128, stderr: "fatal: couldn't find remote ref" }
        : { code: 0, stderr: '' };
    await expect(
      cloneRepo('https://github.com/acme/widgets', { exec, commit: 'c'.repeat(40) }),
    ).rejects.toThrow(/couldn't find remote ref/);
  });

  it('refuses a commit that is not a full sha', async () => {
    const { exec, runs } = record();
    await expect(
      cloneRepo('https://github.com/acme/widgets', { exec, commit: 'abc1234' }),
    ).rejects.toThrow(/full 40-character/);
    expect(runs).toHaveLength(0);
  });
});

describe('a clone that runs out of the time we gave it', () => {
  it('says we stopped it, rather than reporting git dying', async () => {
    // The failure this fixes: a two minute limit killed a clone of a large
    // monorepo, and the message was git's last words about a broken transfer,
    // which reads as the network's fault for a limit we chose.
    const exec: ExecFn = async () => ({
      code: 1,
      stderr: "Cloning into '/tmp/x'...\nfatal: early EOF",
      timedOut: true,
    });
    await expect(
      cloneRepo('https://github.com/supabase/supabase', { exec, timeoutMs: 120_000 }),
    ).rejects.toThrow(/gave up after 2 minutes/);
  });

  it('is a distinct error, so a caller can suggest the fix', async () => {
    const exec: ExecFn = async () => ({ code: 1, stderr: 'fatal: early EOF', timedOut: true });
    await expect(
      cloneRepo('https://github.com/acme/widgets', { exec, timeoutMs: 60_000 }),
    ).rejects.toBeInstanceOf(CloneTimeoutError);
  });

  it('still blames git when git is actually to blame', async () => {
    const exec: ExecFn = async () => ({
      code: 128,
      stderr: 'fatal: repository not found',
      timedOut: false,
    });
    await expect(cloneRepo('https://github.com/acme/nope', { exec })).rejects.toThrow(
      /repository not found/,
    );
  });
});

describe('progress', () => {
  it('asks git for progress, which it withholds from a pipe by default', async () => {
    const runs: string[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      runs.push(args.join(' '));
      return { code: 0, stderr: '' };
    };
    const result = await cloneRepo('https://github.com/acme/widgets', { exec });
    expect(runs.some((run) => run.includes('--progress'))).toBe(true);
    await result.cleanup();
  });

  it('hands each chunk of git progress to the caller as it arrives', async () => {
    const seen: string[] = [];
    const exec: ExecFn = async (_cmd, _args, opts) => {
      opts.onStderr?.('Receiving objects:  12% (120/1000)\r');
      opts.onStderr?.('Receiving objects:  48% (480/1000)\r');
      return { code: 0, stderr: '' };
    };
    const result = await cloneRepo('https://github.com/acme/widgets', {
      exec,
      onProgress: (chunk) => seen.push(chunk),
    });
    expect(seen).toHaveLength(2);
    await result.cleanup();
  });
});

describe('parseGitProgress', () => {
  it('reads the percentage git is reporting', () => {
    expect(parseGitProgress('Receiving objects:  45% (450/1000), 12 MiB | 3 MiB/s')).toEqual({
      phase: 'receiving',
      percent: 45,
    });
    expect(parseGitProgress('Resolving deltas:  80% (800/1000)')).toEqual({
      phase: 'resolving',
      percent: 80,
    });
  });

  it('takes the last state in a chunk, since git rewrites one line', () => {
    const chunk = 'Receiving objects:  10% (1/10)\rReceiving objects:  90% (9/10)\r';
    expect(parseGitProgress(chunk)?.percent).toBe(90);
  });

  it('yields nothing for a line that is not progress, rather than a guess', () => {
    expect(parseGitProgress("Cloning into '/tmp/x'...")).toBeUndefined();
    expect(parseGitProgress('fatal: early EOF')).toBeUndefined();
  });
});
