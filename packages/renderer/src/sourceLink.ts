import { parseGithubRepo, type Anchor } from '@ramplab/spec';

/**
 * Turns a spec's `repo` provenance into per-anchor source permalinks.
 * Provenance parsing lives at the spec seam (`parseGithubRepo`); an anchor
 * with no known home must not pretend to be a link.
 */
export function anchorHrefBuilder(
  repo: string | undefined,
): ((anchor: Anchor) => string) | undefined {
  const ref = parseGithubRepo(repo);
  if (ref === undefined) return undefined;
  // HEAD resolves to the default branch; anchor line numbers can drift as the
  // repo moves — the fingerprint-based staleness story covers regeneration.
  const base = `https://github.com/${ref.owner}/${ref.name}/blob/HEAD/`;
  return (anchor) => {
    const path = anchor.file.split('/').map(encodeURIComponent).join('/');
    const lines =
      anchor.lines !== undefined ? `#L${anchor.lines.start}-L${anchor.lines.end}` : '';
    return `${base}${path}${lines}`;
  };
}
