import { execFileSync } from 'node:child_process';
import { parseGithubRepo } from '@ramplab/spec';

/**
 * The commit a repository directory is sitting at (founder, 2026-07-26).
 *
 * Stamped onto a pressed spec as `commit`, because anchors are only checkable
 * against the tree they were written against. Anyone re-verifying a spec later
 * needs to fetch that exact tree; without it they clone `HEAD`, the repository
 * has moved on, and honest anchors fail.
 *
 * Deliberately best-effort and silent: a directory that is not a git checkout
 * is a perfectly valid thing to press (a tarball, a vendored copy), and it
 * would be wrong to fail a pressing over provenance nobody asked for. The
 * consequence is stated where it lands — an edition with no commit cannot be
 * verified later, so it cannot take the public shelf.
 */
export function readRepoCommit(repoDir: string): string | undefined {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined; // not a checkout, no git, shallow oddity: not our problem
  }
}

/**
 * True when the working tree has uncommitted changes. A spec pressed from a
 * dirty tree describes code that exists on exactly one machine, so its anchors
 * can never be re-verified from the commit alone — worth knowing before an
 * edition is offered to the public shelf.
 */
export function isRepoDirty(repoDir: string): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return status.trim().length > 0;
  } catch {
    return false; // not a checkout: nothing to be dirty about
  }
}

/**
 * The repository a checkout came from, canonicalized (founder, 2026-07-26).
 *
 * A pressed spec has to name its repository or nothing can ever check it: the
 * claim route needs somewhere to clone from, and without this every edition
 * pressed on someone's own machine reads as "does not name a repository" and
 * is capped below the public shelf forever. The hosted press has always
 * stamped it from the URL it was given; a local press reads it from the
 * remote.
 *
 * Only GitHub, because that is what the library can actually fetch and
 * re-resolve anchors against. Naming a remote we cannot clone would promise a
 * check we are unable to perform, so a repository elsewhere is left unnamed
 * and the edition stays private or unlisted, which is the honest outcome.
 * `https` and `ssh` remotes of the same project canonicalize to one string, so
 * a spec does not say two different things depending on how someone cloned.
 */
export function readRepoRemote(repoDir: string): string | undefined {
  let url: string;
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return undefined; // no remote, no git, not a checkout: not our problem
  }
  const ref = parseGithubRepo(url);
  return ref === undefined ? undefined : `https://github.com/${ref.owner}/${ref.name}`;
}
