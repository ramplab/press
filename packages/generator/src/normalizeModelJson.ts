/**
 * Canonicalising what a model meant before validating what it wrote (#107).
 *
 * A pressing of supabase failed on this:
 *
 *     ✖ Too small: expected string to have >=1 characters
 *       → at base.modules[0].widgets[0].nodes[6].anchors[0].symbol
 *
 * `symbol` is optional on an anchor: naming one sharpens the reference, and
 * leaving it out anchors the whole file. The model had anchored everything it
 * was asked to, and spelled "no symbol here" as `""` rather than by omitting
 * the key. That is not a wrong claim, it is the right claim written the wrong
 * way, and it cost a six minute run.
 *
 * So an empty string in a field that is optional is read as the absence it
 * plainly is. This weakens nothing: a file-level anchor is still an anchor,
 * still resolved against the repository, still fingerprinted. A field that is
 * REQUIRED to be non-empty is left exactly as it came, because there the
 * emptiness is a real failure and the gate should still catch it.
 *
 * Applied by every stage that assembles a model payload into something the
 * spec schema validates — the map stage and the author stage. The plan and
 * verify stages have no optional string fields to canonicalise, so they do not
 * call this; adding it there would be a no-op dressed up as caution.
 */

/**
 * Optional string fields where empty unambiguously means "not given".
 *
 * A key earns a place here only if it is optional EVERYWHERE it appears in the
 * spec. `label` is the counter-example and the reason this is an allowlist
 * rather than a rule: it is optional on a system-map edge and on a
 * decision-table option, but required on a node, a state, a stage and a quiz
 * option. Stripping it blanket-wise would delete the thing that names a node.
 * (Unanchored edge labels are handled instead by `dropUnanchoredProse`, which
 * knows which widget it is looking at.)
 *
 * `example` is deliberately absent for the opposite reason: an empty string is
 * a valid example value, so there is no failure to prevent.
 */
const OPTIONAL_WHEN_EMPTY = new Set([
  'symbol',
  'summary',
  'description',
  'title',
  'profile',
  // Author-stage fields, reachable only from widgets the map stage never
  // emits: a data-model annotation's "Read by: …" line, and what a pipeline
  // stage takes in and hands on. Each appears exactly once in the schema, and
  // is optional there.
  'readBy',
  'in',
  'out',
]);

/**
 * Strip empty strings from optional fields, everywhere in a model payload.
 * Structure is otherwise untouched, and the input is not mutated.
 */
export function normalizeModelJson<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (OPTIONAL_WHEN_EMPTY.has(key) && typeof child === 'string' && child.trim() === '') {
      continue; // the field is absent, which is what it was trying to say
    }
    out[key] = strip(child);
  }
  return out;
}
