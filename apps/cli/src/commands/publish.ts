import { readFile } from 'node:fs/promises';
import { safeParseLabSpec } from '@ramplab/spec';

/**
 * `ramplab publish <spec.json>` — put an edition you pressed yourself on the
 * library's shelf (founder, 2026-07-26).
 *
 * The CLI never holds a credential. It uploads the spec to an unauthenticated
 * holding pen, gets back a short code, and prints a link; the browser the user
 * is already signed into does the claiming. The alternative was a CLI token to
 * issue, store, validate, rotate and revoke, which is a lot of machinery and
 * one more long-lived secret in a dotfile.
 *
 * What that buys, beyond the missing secret: `pressedBy` on the published
 * edition comes from a real session rather than from anything this command
 * asserted, and the visibility decision happens where the person is, with the
 * reasons in front of them.
 */

/** The deployed worker (docs/worker-deploy.md). */
export const DEFAULT_WORKER_URL = 'https://api.ramplab.dev';
/** Where the claim page lives. */
export const DEFAULT_SITE_URL = 'https://library.ramplab.dev';

export interface PublishOptions {
  specFile: string;
  /** @default the deployed worker */
  workerUrl?: string;
  /** @default the deployed library */
  siteUrl?: string;
}

export interface PublishDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Injected so the whole command tests without a network. */
  fetch?: typeof globalThis.fetch;
}

interface Accepted {
  code?: unknown;
  expiresAt?: unknown;
  claimUrl?: unknown;
}

/** Run the publish command. Returns a process exit code. */
export async function runPublish(
  options: PublishOptions,
  deps: PublishDeps = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const doFetch = deps.fetch ?? globalThis.fetch;
  const workerUrl = (options.workerUrl ?? DEFAULT_WORKER_URL).replace(/\/+$/, '');
  const siteUrl = (options.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, '');

  let text: string;
  try {
    text = await readFile(options.specFile, 'utf8');
  } catch (cause) {
    err(`Cannot read ${options.specFile}: ${(cause as Error).message}`);
    return 1;
  }

  // Validated here as well as by the worker, because a spec that was never
  // going to be accepted should fail on the machine that can explain it,
  // before anything is uploaded.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    err(`${options.specFile} is not valid JSON: ${(cause as Error).message}`);
    return 1;
  }
  const parsed = safeParseLabSpec(json);
  if (!parsed.success) {
    err(`${options.specFile} is not a valid lab spec:`);
    err(parsed.error);
    return 1;
  }

  let response: Response;
  try {
    response = await doFetch(`${workerUrl}/publish/pending`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
  } catch (cause) {
    err(`Could not reach ${workerUrl}: ${(cause as Error).message}`);
    return 1;
  }

  const body = (await response.json().catch(() => ({}))) as Accepted & { error?: unknown };
  if (!response.ok) {
    const message =
      typeof body.error === 'string' ? body.error : `The library refused the upload (HTTP ${response.status}).`;
    err(message);
    return 1;
  }
  if (typeof body.code !== 'string') {
    err(`The library answered without a claim code (HTTP ${response.status}).`);
    return 1;
  }

  const claimUrl =
    typeof body.claimUrl === 'string' && body.claimUrl.length > 0
      ? body.claimUrl
      : `${siteUrl}/claim/?code=${encodeURIComponent(body.code)}`;

  const title = parsed.data.title;
  const modules = parsed.data.base.modules.length;
  out(`Uploaded "${title}" (${modules} chapter${modules === 1 ? '' : 's'}).`);
  out('');
  out('Open this to claim it, signed in as yourself:');
  out(`  ${claimUrl}`);
  out('');
  out(`Claim code ${body.code}. It is good for 15 minutes, and the edition is not`);
  out('on the shelf until you claim it. Nothing has been published yet.');
  if (parsed.data.commit === undefined) {
    // Better said now than discovered on the claim page: the public shelf is
    // the one thing this edition cannot be offered, and pressing again from a
    // clean checkout is the fix.
    out('');
    out('This edition carries no commit, so it can be claimed as private or unlisted');
    out('but not public. Press it again from a clean checkout to publish it publicly.');
  }
  return 0;
}
