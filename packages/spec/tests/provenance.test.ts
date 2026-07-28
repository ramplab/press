// Repo provenance parsing: every form the worker/CLI actually stamps must
// resolve to owner/name; anything else must resolve to nothing (an anchor
// permalink or a live shelf with no known home must not pretend to have one).
import { describe, expect, it } from 'vitest';
import { parseGithubRepo } from '../src/index.js';

describe('parseGithubRepo', () => {
  it.each([
    ['github.com/caddyserver/caddy', 'caddyserver', 'caddy'],
    ['https://github.com/owner/repo.git', 'owner', 'repo'],
    ['https://www.github.com/owner/repo/', 'owner', 'repo'],
    ['git@github.com:owner/repo.git', 'owner', 'repo'],
    ['owner/repo', 'owner', 'repo'],
    ['  owner/repo.git  ', 'owner', 'repo'],
  ])('parses %s', (input, owner, name) => {
    expect(parseGithubRepo(input)).toEqual({ owner, name });
  });

  it.each([[undefined], ['https://gitlab.com/o/r'], ['not a repo'], ['owner.only']])(
    'rejects %s',
    (input) => {
      expect(parseGithubRepo(input)).toBeUndefined();
    },
  );
});
