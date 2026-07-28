/** An `owner/name` pair extracted from a spec's `repo` provenance string. */
export interface GithubRepoRef {
  owner: string;
  name: string;
}

/**
 * Extracts `owner`/`name` from a spec's `repo` provenance. Accepts the forms
 * provenance actually arrives in — `github.com/owner/repo` (what the worker
 * stamps), full https URLs, ssh remotes, and bare `owner/repo` (the platform
 * is GitHub-only; a GitHub owner never contains a dot, so hosts can't be
 * mistaken for owners) — and returns `undefined` for anything else: a
 * consumer with no known home must not pretend to have one (no anchor
 * permalink, no starter shelf).
 */
export function parseGithubRepo(repo: string | undefined): GithubRepoRef | undefined {
  if (repo === undefined) return undefined;
  const match =
    /^(?:https?:\/\/)?(?:www\.)?(?:git@)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      repo.trim(),
    ) ?? /^([A-Za-z0-9-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repo.trim());
  const [, owner, name] = match ?? [];
  if (owner === undefined || name === undefined) return undefined;
  return { owner, name };
}
