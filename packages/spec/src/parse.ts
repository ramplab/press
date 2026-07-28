import { z } from 'zod';
import { SCHEMA_VERSION, labSpecSchema, type LabSpec } from './schema.js';

export type LabSpecIssue = z.ZodError['issues'][number];

export class LabSpecParseError extends Error {
  readonly issues: readonly LabSpecIssue[];

  constructor(message: string, issues: readonly LabSpecIssue[] = []) {
    super(message);
    this.name = 'LabSpecParseError';
    this.issues = issues;
  }
}

export type SafeParseLabSpecResult =
  | { success: true; data: LabSpec }
  | { success: false; error: string; issues: readonly LabSpecIssue[] };

/**
 * Validate an unknown value as a v1 lab spec. Never throws; returns either
 * the parsed spec or a human-readable error message plus raw issues.
 */
export function safeParseLabSpec(input: unknown): SafeParseLabSpecResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      success: false,
      error: `Lab spec must be a JSON object, got ${describe(input)}.`,
      issues: [],
    };
  }

  const version = (input as Record<string, unknown>)['schemaVersion'];
  if (version !== SCHEMA_VERSION) {
    return {
      success: false,
      error:
        version === undefined
          ? `Lab spec is missing "schemaVersion". This version of @ramplab/spec supports schema version ${SCHEMA_VERSION}.`
          : `Unsupported lab spec schemaVersion ${JSON.stringify(version)}. This version of @ramplab/spec supports schema version ${SCHEMA_VERSION}.`,
      issues: [],
    };
  }

  const parsed = labSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid lab spec:\n${z.prettifyError(parsed.error)}${receivedReport(input, parsed.error.issues)}`,
      issues: parsed.error.issues,
    };
  }
  return { success: true, data: parsed.data };
}

/**
 * Validate an unknown value as a v1 lab spec, throwing `LabSpecParseError`
 * (with a readable message and the underlying issues) on failure.
 */
export function parseLabSpec(input: unknown): LabSpec {
  const result = safeParseLabSpec(input);
  if (!result.success) {
    throw new LabSpecParseError(result.error, result.issues);
  }
  return result.data;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * What was actually there, at the paths that failed.
 *
 * Zod says "Invalid discriminator value. Expected 'callout' | …" and stops:
 * for a discriminated union it records the options it wanted and not the
 * value it got. That is the one fact worth having. A pressing of supabase
 * failed after six minutes with seven of these and the operator could not
 * tell what the model had emitted, which is exactly what a prompt fix needs
 * to know (#107).
 *
 * Only primitives are reported, and truncated. An object at a failing path is
 * usually the whole widget, and pasting that back into an error message
 * buries the answer rather than giving it.
 */
function receivedReport(input: unknown, issues: readonly { path: PropertyKey[] }[]): string {
  const seen = new Map<string, string>();
  for (const issue of issues) {
    if (issue.path.length === 0) continue;
    const value = valueAt(input, issue.path);
    if (value === undefined) {
      // An absent value has nothing to show, but the thing it is absent FROM
      // usually has a name, and that is the fact a prompt fix needs: which
      // concept the model described without pinning it to a file (#107).
      const named = nameOf(valueAt(input, issue.path.slice(0, -1)));
      if (named !== undefined) seen.set(pathLabel(issue.path.slice(0, -1)), named);
      continue;
    }
    if (typeof value === 'object') continue;
    const shown = JSON.stringify(value) ?? String(value);
    seen.set(pathLabel(issue.path), shown.length > 60 ? `${shown.slice(0, 57)}…` : shown);
  }
  if (seen.size === 0) return '';
  const lines = [...seen].slice(0, 10).map(([where, shown]) => `  ${where} = ${shown}`);
  const more = seen.size > 10 ? `\n  …and ${seen.size - 10} more` : '';
  return `\n\nReceived:\n${lines.join('\n')}${more}`;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value: unknown = input;
  for (const step of path) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<PropertyKey, unknown>)[step];
  }
  return value;
}

function pathLabel(path: readonly PropertyKey[]): string {
  return path
    .map((step) => (typeof step === 'number' ? `[${step}]` : `.${String(step)}`))
    .join('')
    .replace(/^\./, '');
}

/**
 * What a thing calls itself, for an error about something missing from it.
 * A system-map node carries a required `label`; widgets and modules carry
 * ids and titles. Any of them beats an array index.
 */
function nameOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['label', 'title', 'id']) {
    const found = record[key];
    if (typeof found === 'string' && found.length > 0) {
      const shown = JSON.stringify(found);
      return shown.length > 60 ? `${shown.slice(0, 57)}…` : shown;
    }
  }
  return undefined;
}
