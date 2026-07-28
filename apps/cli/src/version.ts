import { readFileSync } from 'node:fs';

/**
 * What version of the press this is.
 *
 * Read from the package's own manifest rather than written down a second time
 * in the source, because a version that has to be updated in two places is a
 * version that will eventually disagree with itself, and the one place it
 * would disagree is the answer to "which version are you on" in a bug report.
 *
 * `../package.json` resolves to the package root from both `src/version.ts`
 * and the built `dist/version.js`, and npm always packs the manifest, so this
 * works the same in the repository, in a global install and in a test.
 */
export function cliVersion(): string {
  try {
    const manifest = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(manifest) as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : 'unknown';
  } catch {
    // A CLI that cannot find its own manifest still has work to do; refusing
    // to start over a version string would be the wrong trade.
    return 'unknown';
  }
}
