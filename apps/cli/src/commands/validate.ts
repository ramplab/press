import { readFile } from 'node:fs/promises';
import { safeParseLabSpec } from '@ramplab/spec';

/**
 * `ramplab validate <spec.json>` — check a lab spec against `@ramplab/spec`.
 *
 * Free, offline, no API. Useful after `generate`, after hand-editing a spec,
 * or to confirm a spec from another source is loadable before publishing.
 */

export interface ValidateDeps {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Run the validate command. Returns a process exit code. */
export async function runValidate(file: string, deps: ValidateDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    err(`Cannot read ${file}: ${(cause as Error).message}`);
    return 1;
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    err(`${file} is not valid JSON: ${(cause as Error).message}`);
    return 1;
  }

  const result = safeParseLabSpec(json);
  if (!result.success) {
    err(`${file} is not a valid lab spec:`);
    err(result.error);
    return 1;
  }

  const modules = result.data.base.modules.length;
  out(`✓ ${file} is a valid lab spec (${modules} module${modules === 1 ? '' : 's'}).`);
  return 0;
}
