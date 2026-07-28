import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRepoDirty, readRepoCommit, readRepoRemote } from '../src/repoCommit.js';

/**
 * The commit a spec was pressed from. Anchors are only checkable against the
 * tree they were written against, so without this a verifier clones HEAD, the
 * repository has moved on, and honest anchors fail for a reason that is not
 * their fault.
 */

let dir: string;
const git = (...args: string[]): void => {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ramplab-commit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRepoCommit', () => {
  it('reads the checkout’s HEAD', () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-qm', 'first');

    const sha = readRepoCommit(dir);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('is silent on a directory that is not a checkout', () => {
    // Pressing a tarball or a vendored copy is perfectly valid; it just
    // cannot be verified from a commit later, and nothing should fail here.
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    expect(readRepoCommit(dir)).toBeUndefined();
    expect(isRepoDirty(dir)).toBe(false);
  });
});

describe('isRepoDirty', () => {
  it('is false on a clean tree and true once something changes', () => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'a.txt'), 'hello\n');
    git('add', '.');
    git('commit', '-qm', 'first');
    expect(isRepoDirty(dir)).toBe(false);

    // A spec pressed from a dirty tree describes code that exists on exactly
    // one machine, so its anchors can never be re-verified from the commit.
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    expect(isRepoDirty(dir)).toBe(true);
  });
});

describe('readRepoRemote', () => {
  const withOrigin = (url: string): void => {
    git('init', '-q');
    git('remote', 'add', 'origin', url);
  };

  it('names the GitHub repository a checkout came from', () => {
    withOrigin('https://github.com/caddyserver/caddy.git');
    expect(readRepoRemote(dir)).toBe('https://github.com/caddyserver/caddy');
  });

  it('normalizes an ssh remote to the same canonical form', () => {
    // The same repository, however the developer happens to clone it: the
    // spec should not say two different things about one project.
    withOrigin('git@github.com:caddyserver/caddy.git');
    expect(readRepoRemote(dir)).toBe('https://github.com/caddyserver/caddy');
  });

  it('says nothing about a host we could not verify against', () => {
    // Claiming a GitLab remote would promise a check we cannot perform, and
    // an edition that names nothing is honest about what it is.
    withOrigin('https://gitlab.com/acme/widgets.git');
    expect(readRepoRemote(dir)).toBeUndefined();
  });

  it('is silent with no remote, and on a directory that is not a checkout', () => {
    git('init', '-q');
    expect(readRepoRemote(dir)).toBeUndefined();
    expect(readRepoRemote(join(dir, 'nope'))).toBeUndefined();
  });
});
