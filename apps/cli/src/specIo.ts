import { readFile } from 'node:fs/promises';
import { safeParseLabSpec, type LabSpec } from '@ramplab/spec';

/** Outcome of loading a lab spec from disk: exactly one field is set. */
export type LoadedSpec = { spec: LabSpec; error?: undefined } | { spec?: undefined; error: string };

/**
 * Read, JSON-parse, and validate a lab spec file against `@ramplab/spec`.
 * Returns a friendly error string rather than throwing, so command handlers
 * can print it and return a non-zero exit code. Shared by validate, preview,
 * and export.
 */
export async function loadSpec(file: string): Promise<LoadedSpec> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (cause) {
    return { error: `Cannot read ${file}: ${(cause as Error).message}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return { error: `${file} is not valid JSON: ${(cause as Error).message}` };
  }

  const result = safeParseLabSpec(json);
  if (!result.success) {
    return { error: `${file} is not a valid lab spec:\n${result.error}` };
  }
  return { spec: result.data };
}
