import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Ephemeral clone sandbox for untrusted public repos (Slice 2, #30).
 *
 * v1 only **reads** repo files (the generator never executes the repo), so
 * the threat model is resource abuse and bad URLs — not RCE. This is a
 * shallow clone into a temp dir with a hard timeout and depth cap; stronger
 * per-job microVM isolation is deferred to the v2 live-logic widget
 * (`docs/infra-cost-options.md` §5). `git` itself is injected (`exec`) so the
 * flow tests without touching the network.
 */

export interface CloneResult {
  /** The local checkout directory (hand to the generator). */
  dir: string;
  /** Remove the checkout. Always call it (a `finally`). */
  cleanup: () => Promise<void>;
}

export type ExecResult = {
  code: number;
  stderr: string;
  /**
   * We killed it, rather than it failing on its own. Without this a timeout
   * is indistinguishable from a git failure, and the caller reports whatever
   * git happened to have written before it died — which reads as a network
   * fault for a limit we imposed.
   */
  timedOut?: boolean;
};
export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: {
    timeoutMs: number;
    /** Stderr as it arrives. Git writes its progress here. */
    onStderr?: ((chunk: string) => void) | undefined;
  },
) => Promise<ExecResult>;

export interface CloneOptions {
  /**
   * Abort the clone after this long.
   *
   * @default 120_000, which is the budget for cloning an untrusted URL on
   * shared infrastructure: the worker cannot let one repository tie up the
   * machine everyone else is served from. A local press has neither of those
   * constraints and should pass something far larger; two minutes does not
   * finish a shallow clone of a big monorepo, and the CLI's own default says
   * so.
   */
  timeoutMs?: number;
  /**
   * Called with git's progress as it arrives. Git writes progress to stderr,
   * and this used to be collected into a string that was read only if the
   * clone failed, so a caller watched a large repository in total silence and
   * then, sometimes, got told it had failed.
   */
  onProgress?: (chunk: string) => void;
  /** Inject the git runner (tests). @default real `git` via spawn. */
  exec?: ExecFn;
  /** Temp root for the checkout. @default os.tmpdir(). */
  tmpRoot?: string;
  /**
   * Installation access token for a private clone (see
   * `docs/private-repos-design.md`). Passed to git as an `Authorization`
   * extraheader — never in the URL, so it can't leak into error messages or
   * the dedup key; `validateRepoUrl` keeps rejecting credentials-in-URL.
   */
  accessToken?: string;
  /**
   * Check out this exact commit instead of the default branch's tip.
   *
   * Verifying a claimed edition means resolving its anchors against the tree
   * they were written against; clone `HEAD` instead and the repository has
   * moved on, honest anchors drift, and a sound edition is rejected for a
   * reason that is not its fault. Must be a full sha — an abbreviation cannot
   * be fetched by name.
   */
  commit?: string;
}

/** Raised when the clone ran out of the time we gave it, not out of luck. */
export class CloneTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloneTimeoutError';
  }
}

export type UrlCheck =
  | { ok: true; url: string; repoKey: string }
  | { ok: false; error: string };

/**
 * Accept only `https://github.com/<owner>/<repo>`. Rejects other hosts, SSH,
 * credentials-in-URL, and path traversal. Returns the normalized clone URL
 * and a stable `repoKey` (`owner/repo`) for dedup.
 */
export function validateRepoUrl(input: string): UrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, error: `Not a URL: ${input}` };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https:// GitHub URLs are allowed.' };
  }
  if (parsed.hostname !== 'github.com') {
    return { ok: false, error: 'Only github.com repositories are supported.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain credentials.' };
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return { ok: false, error: 'Expected https://github.com/<owner>/<repo>.' };
  }
  const [owner, repoRaw] = segments as [string, string];
  const repo = repoRaw.replace(/\.git$/, '');
  const nameRe = /^[A-Za-z0-9._-]+$/;
  if (!nameRe.test(owner) || !nameRe.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, error: 'Invalid owner or repository name.' };
  }
  return { ok: true, url: `https://github.com/${owner}/${repo}.git`, repoKey: `${owner}/${repo}` };
}

/** Default git runner: spawn, capture stderr, enforce a kill-on-timeout. */
const realExec: ExecFn = (cmd, args, opts) =>
  new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onStderr?.(text);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stderr, timedOut });
    });
  });

/**
 * Git's progress, as a percentage of whatever it is currently doing.
 *
 * Receiving is the long part of a clone and the part worth showing; resolving
 * deltas follows it and is usually quick. Anything else is not a progress
 * line and yields nothing rather than a guess.
 */
export function parseGitProgress(
  chunk: string,
): { phase: 'receiving' | 'resolving'; percent: number } | undefined {
  // Git rewrites one line with carriage returns, so the last match in a
  // chunk is the current state.
  const matches = [...chunk.matchAll(/(Receiving objects|Resolving deltas):\s+(\d+)%/g)];
  const last = matches[matches.length - 1];
  if (last === undefined) return undefined;
  return {
    phase: last[1] === 'Receiving objects' ? 'receiving' : 'resolving',
    percent: Number(last[2]),
  };
}

/**
 * Validate the URL, shallow-clone into a fresh temp dir, and return the dir
 * plus a cleanup. On any failure the temp dir is removed before throwing, so
 * a failed clone never leaks disk.
 *
 * With `commit`, the fetch asks for that object by name rather than cloning a
 * branch: one commit, one tree, no history.
 */
export async function cloneRepo(repoUrl: string, options: CloneOptions = {}): Promise<CloneResult> {
  const check = validateRepoUrl(repoUrl);
  if (!check.ok) throw new Error(`Invalid repo URL: ${check.error}`);
  if (options.commit !== undefined && !/^[0-9a-f]{40}$/.test(options.commit)) {
    throw new Error('A commit to clone must be a full 40-character sha.');
  }

  const exec = options.exec ?? realExec;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'ramplab-clone-'));
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true });

  // GitHub installation tokens authenticate as `x-access-token:<token>` over
  // Basic auth. The extraheader config is scoped to github.com only.
  const authArgs =
    options.accessToken === undefined
      ? []
      : [
          '-c',
          `http.https://github.com/.extraheader=Authorization: Basic ${Buffer.from(
            `x-access-token:${options.accessToken}`,
          ).toString('base64')}`,
        ];

  const run = async (args: readonly string[], what: string): Promise<void> => {
    const result = await exec('git', args, {
      timeoutMs,
      ...(options.onProgress !== undefined ? { onStderr: options.onProgress } : {}),
    });
    if (result.code === 0) return;
    await cleanup();
    if (result.timedOut === true) {
      // Say who stopped it. Reporting git's last words here is how a limit we
      // chose comes to look like the remote hanging up.
      const minutes = Math.round(timeoutMs / 60_000);
      throw new CloneTimeoutError(
        `git ${what} gave up after ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
          'This repository needs longer than the time allowed for it.',
      );
    }
    throw new Error(`git ${what} failed (exit ${result.code}): ${result.stderr.trim()}`);
  };

  if (options.commit === undefined) {
    await run(
      // `--progress` because git only volunteers it to a terminal, and this
      // stderr is a pipe. Without it a large clone is silent by construction.
      [
        ...authArgs,
        'clone',
        '--progress',
        '--depth',
        '1',
        '--single-branch',
        '--no-tags',
        check.url,
        dir,
      ],
      'clone',
    );
    return { dir, cleanup };
  }

  // Fetching one object by sha, rather than cloning and then looking for it:
  // GitHub serves any commit it has by name, so this is a single round trip
  // for exactly the tree the edition was pressed against, however far the
  // default branch has moved since.
  await run(['init', '--quiet', dir], 'init');
  await run(['-C', dir, 'remote', 'add', 'origin', check.url], 'remote add');
  await run([...authArgs, '-C', dir, 'fetch', '--depth', '1', 'origin', options.commit], 'fetch');
  await run(['-C', dir, 'checkout', '--detach', 'FETCH_HEAD'], 'checkout');
  return { dir, cleanup };
}
