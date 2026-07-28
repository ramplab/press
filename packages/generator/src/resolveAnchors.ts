import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { Anchor, LabSpec } from '@ramplab/spec';

/**
 * Anchor resolution — mechanical grounding enforcement (PLAN.md §3).
 *
 * `resolveAnchors(spec, repoDir)` checks every anchor in the spec's base
 * content against the actual repository directory:
 *
 * - the anchored file exists (repo-relative; paths that escape `repoDir`
 *   never resolve),
 * - the line range, if given, is valid against the file's real line count,
 * - the symbol, if given, matches textually inside the anchored region.
 *
 * v1 is deliberately textual and language-agnostic — no parsers, no
 * tree-sitter. A "symbol match" is a token-boundary substring match, which
 * works uniformly across TS, Ruby, Go, Python, Java, C#, Dart, Kotlin,
 * Swift, ... (tree-sitter-backed resolution is a v2 option).
 *
 * The function is deterministic and pure over `(spec, directory)`: no
 * globals, no clock, no mutation of the input spec. Given the same spec and
 * the same directory contents it always returns the same result.
 */

/** Why an individual anchor did or did not resolve. */
export type AnchorStatus =
  | 'resolved'
  | 'file-missing'
  | 'lines-out-of-range'
  | 'symbol-not-found';

/**
 * What to do with teachable units whose anchors fail to resolve:
 * - `drop` (default): remove the unit from the returned base spec — the
 *   grounding constraint is enforced structurally.
 * - `flag`: keep the spec intact and only report — for review flows where
 *   a human decides.
 */
export type ResolutionPolicy = 'drop' | 'flag';

/** Per-teachable-unit outcome, reflecting the active policy. */
export type UnitOutcome = 'resolved' | 'dropped' | 'flagged';

/** The resolution verdict for one anchor of one base widget. */
export interface AnchorResolution {
  moduleId: string;
  widgetId: string;
  /**
   * Ordinal of the anchor within its widget, in deterministic walk order.
   * For widgets with a single top-level `anchors` array (callouts) this is
   * the array index; nested carriers (system-map nodes/edges, data-model
   * annotations) are walked depth-first in spec order.
   */
  anchorIndex: number;
  /** JSON path of the anchor within its widget (e.g. `["nodes", 0, "anchors", 1]`). */
  anchorPath: (string | number)[];
  /** The anchor as checked (fingerprint populated when resolved). */
  anchor: Anchor;
  status: AnchorStatus;
  /** Human-readable explanation of the status. */
  detail: string;
  /**
   * `sha256:<hex>` content hash of the anchored region (the line range if
   * given, otherwise the whole file), only present when resolved. Line
   * endings are normalized to `\n` before hashing so fingerprints are
   * stable across checkout conventions.
   */
  fingerprint?: string;
}

/**
 * The verdict for one teachable unit (a base widget). A unit is resolved
 * only if *every* one of its anchors resolved — each claim's grounding must
 * check out.
 */
export interface UnitResolution {
  moduleId: string;
  widgetId: string;
  outcome: UnitOutcome;
  anchors: AnchorResolution[];
}

export interface ResolutionSummary {
  totalAnchors: number;
  resolvedAnchors: number;
  totalUnits: number;
  resolvedUnits: number;
  /** Units dropped or flagged, depending on policy. */
  unresolvedUnits: number;
}

/** Structured report of a full resolution pass over a spec's base content. */
export interface ResolutionReport {
  policy: ResolutionPolicy;
  /** Every anchor checked, in spec order. */
  anchors: AnchorResolution[];
  /** Every teachable unit (base widget), in spec order. */
  units: UnitResolution[];
  summary: ResolutionSummary;
}

export interface ResolveAnchorsOptions {
  /** @default 'drop' */
  policy?: ResolutionPolicy;
}

export interface ResolveAnchorsResult {
  /**
   * The spec after resolution. Resolved anchors carry fingerprints. Under
   * the `drop` policy, unresolved units are removed from their modules;
   * under `flag` the structure is untouched. The human overlay is never
   * modified — only the machine-owned base is subject to grounding
   * enforcement.
   */
  spec: LabSpec;
  report: ResolutionReport;
}

/**
 * Resolve every base-content anchor in `spec` against the repository at
 * `repoDir`, enforcing the grounding constraint per the chosen policy.
 */
export function resolveAnchors(
  spec: LabSpec,
  repoDir: string,
  options: ResolveAnchorsOptions = {},
): ResolveAnchorsResult {
  const policy: ResolutionPolicy = options.policy ?? 'drop';
  const repoRoot = resolve(repoDir);
  const fileCache = new Map<string, LoadedFile>();

  const units: UnitResolution[] = [];
  const allAnchors: AnchorResolution[] = [];

  for (const module of spec.base.modules) {
    for (const widget of module.widgets) {
      const anchors = collectAnchorRefs(widget).map((ref, anchorIndex) =>
        resolveAnchor(ref.anchor, {
          repoRoot,
          fileCache,
          moduleId: module.id,
          widgetId: widget.id,
          anchorIndex,
          anchorPath: ref.path,
        }),
      );
      const unitResolved = anchors.every((a) => a.status === 'resolved');
      units.push({
        moduleId: module.id,
        widgetId: widget.id,
        outcome: unitResolved ? 'resolved' : policy === 'drop' ? 'dropped' : 'flagged',
        anchors,
      });
      allAnchors.push(...anchors);
    }
  }

  const report: ResolutionReport = {
    policy,
    anchors: allAnchors,
    units,
    summary: {
      totalAnchors: allAnchors.length,
      resolvedAnchors: allAnchors.filter((a) => a.status === 'resolved').length,
      totalUnits: units.length,
      resolvedUnits: units.filter((u) => u.outcome === 'resolved').length,
      unresolvedUnits: units.filter((u) => u.outcome !== 'resolved').length,
    },
  };

  return { spec: buildOutputSpec(spec, report), report };
}

// ---------------------------------------------------------------------------
// Per-anchor resolution
// ---------------------------------------------------------------------------

interface AnchorContext {
  repoRoot: string;
  fileCache: Map<string, LoadedFile>;
  moduleId: string;
  widgetId: string;
  anchorIndex: number;
  anchorPath: (string | number)[];
}

function resolveAnchor(anchor: Anchor, ctx: AnchorContext): AnchorResolution {
  const base = {
    moduleId: ctx.moduleId,
    widgetId: ctx.widgetId,
    anchorIndex: ctx.anchorIndex,
    anchorPath: ctx.anchorPath,
  };
  const fail = (status: Exclude<AnchorStatus, 'resolved'>, detail: string): AnchorResolution => ({
    ...base,
    anchor: cloneAnchor(anchor),
    status,
    detail,
  });

  const loaded = readAnchorRegion(anchor, ctx.repoRoot, ctx.fileCache);
  if (loaded.kind !== 'ok') {
    return fail(loaded.kind, loaded.detail);
  }
  const region = loaded.text;

  if (anchor.symbol !== undefined && !symbolPattern(anchor.symbol).test(region)) {
    const where = anchor.lines
      ? `lines ${anchor.lines.start}-${anchor.lines.end} of "${anchor.file}"`
      : `"${anchor.file}"`;
    return fail('symbol-not-found', `Symbol "${anchor.symbol}" not found in ${where}.`);
  }

  const fingerprint = `sha256:${createHash('sha256').update(region, 'utf8').digest('hex')}`;
  const resolvedAnchor = cloneAnchor(anchor);
  resolvedAnchor.fingerprint = fingerprint;
  return {
    ...base,
    anchor: resolvedAnchor,
    status: 'resolved',
    detail: anchor.lines
      ? `Resolved lines ${anchor.lines.start}-${anchor.lines.end} of "${anchor.file}".`
      : `Resolved "${anchor.file}".`,
    fingerprint,
  };
}

/**
 * Textual, language-agnostic symbol matching: the symbol must appear in the
 * region as a whole token — not embedded inside a longer identifier (so
 * "greet" never matches "greeting"). Symbols containing punctuation (Ruby's
 * `empty?`, operators, etc.) are matched literally.
 */
function symbolPattern(symbol: string): RegExp {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

// ---------------------------------------------------------------------------
// Anchor-region reading (shared with the verify stage)
// ---------------------------------------------------------------------------

/**
 * The content an anchor points at, or why it could not be read. The failure
 * kinds mirror the mechanical {@link AnchorStatus} values (symbol matching is
 * a separate concern layered on top by `resolveAnchor`).
 */
export type AnchorRegion =
  | { kind: 'ok'; text: string }
  | { kind: 'file-missing'; detail: string }
  | { kind: 'lines-out-of-range'; detail: string };

/** Share one cache across many {@link readAnchorRegion} calls over one repo. */
export function createAnchorFileCache(): AnchorFileCache {
  return new Map();
}

export type AnchorFileCache = Map<string, LoadedFile>;

/**
 * Read the actual repository content an anchor points at: the line range if
 * given, otherwise the whole file. Line endings are normalized to `\n`. This
 * is the single anchor-region reader — anchor resolution fingerprints what it
 * returns, and the verify stage shows it to the adversarial verifier — so
 * both stages are guaranteed to be looking at the same bytes.
 */
export function readAnchorRegion(
  anchor: Pick<Anchor, 'file' | 'lines'>,
  repoDir: string,
  cache: AnchorFileCache = createAnchorFileCache(),
): AnchorRegion {
  const repoRoot = resolve(repoDir);
  const file = loadFile(anchor.file, repoRoot, cache);
  if (file.kind === 'missing') {
    return { kind: 'file-missing', detail: file.detail };
  }

  let regionLines = file.lines;
  if (anchor.lines) {
    const { start, end } = anchor.lines;
    if (end > file.lineCount || start > file.lineCount) {
      return {
        kind: 'lines-out-of-range',
        detail: `Line range ${start}-${end} exceeds "${anchor.file}" (${file.lineCount} line${file.lineCount === 1 ? '' : 's'}).`,
      };
    }
    regionLines = file.lines.slice(start - 1, end);
  }
  return { kind: 'ok', text: regionLines.join('\n') };
}

// ---------------------------------------------------------------------------
// File loading (repo-relative, traversal-safe, cached per resolution pass)
// ---------------------------------------------------------------------------

export type LoadedFile =
  | { kind: 'ok'; lines: string[]; lineCount: number }
  | { kind: 'missing'; detail: string };

function loadFile(
  relPath: string,
  repoRoot: string,
  cache: Map<string, LoadedFile>,
): LoadedFile {
  const cached = cache.get(relPath);
  if (cached) return cached;

  const loaded = loadFileUncached(relPath, repoRoot);
  cache.set(relPath, loaded);
  return loaded;
}

function loadFileUncached(relPath: string, repoRoot: string): LoadedFile {
  if (isAbsolute(relPath)) {
    return { kind: 'missing', detail: `Anchor file "${relPath}" must be repo-relative, not absolute.` };
  }
  const absPath = resolve(repoRoot, relPath);
  if (absPath !== repoRoot && !absPath.startsWith(repoRoot + sep)) {
    return { kind: 'missing', detail: `Anchor file "${relPath}" escapes the repository root.` };
  }

  let raw: string;
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) {
      return { kind: 'missing', detail: `Anchor path "${relPath}" is not a regular file.` };
    }
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return { kind: 'missing', detail: `Anchor file "${relPath}" does not exist in the repository.` };
  }

  // Normalize line endings so line counts and fingerprints are identical
  // across CRLF/LF checkouts of the same content.
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // A trailing newline does not start an extra line ("a\n" is one line).
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  return { kind: 'ok', lines, lineCount };
}

// ---------------------------------------------------------------------------
// Output spec construction
// ---------------------------------------------------------------------------

/**
 * Build the returned spec without mutating the input: fingerprints stamped
 * onto resolved anchors, and (under `drop`) unresolved units filtered out of
 * their modules. Module and overlay structure is otherwise preserved.
 */
function buildOutputSpec(spec: LabSpec, report: ResolutionReport): LabSpec {
  const out = structuredClone(spec);

  const outcomeByUnit = new Map<string, UnitOutcome>();
  for (const unit of report.units) {
    outcomeByUnit.set(unitKey(unit.moduleId, unit.widgetId), unit.outcome);
  }
  const fingerprintByAnchor = new Map<string, string>();
  for (const res of report.anchors) {
    if (res.fingerprint !== undefined) {
      fingerprintByAnchor.set(
        anchorKey(res.moduleId, res.widgetId, res.anchorIndex),
        res.fingerprint,
      );
    }
  }

  for (const module of out.base.modules) {
    if (report.policy === 'drop') {
      module.widgets = module.widgets.filter(
        (widget) => outcomeByUnit.get(unitKey(module.id, widget.id)) !== 'dropped',
      );
    }
    for (const widget of module.widgets) {
      // Same deterministic walk as during resolution, so ordinals line up.
      collectAnchorRefs(widget).forEach((ref, index) => {
        const fingerprint = fingerprintByAnchor.get(anchorKey(module.id, widget.id, index));
        if (fingerprint !== undefined) {
          ref.anchor.fingerprint = fingerprint;
        }
      });
    }
  }

  return out;
}

function unitKey(moduleId: string, widgetId: string): string {
  return `${moduleId} ${widgetId}`;
}

function anchorKey(moduleId: string, widgetId: string, anchorIndex: number): string {
  return `${unitKey(moduleId, widgetId)} ${anchorIndex}`;
}

function cloneAnchor(anchor: Anchor): Anchor {
  return structuredClone(anchor);
}

// ---------------------------------------------------------------------------
// Anchor collection (widget-shape agnostic)
// ---------------------------------------------------------------------------

interface AnchorRef {
  /** Live reference into the walked object — assignments stick. */
  anchor: Anchor;
  /** JSON path of the anchor within the walked widget. */
  path: (string | number)[];
}

function isAnchorLike(value: unknown): value is Anchor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { file?: unknown }).file === 'string'
  );
}

/**
 * Collect every anchor a widget carries, wherever it lives: top-level
 * `anchors` arrays (callouts), nested carriers (system-map nodes/edges,
 * data-model annotations at any depth), and single-anchor `source` fields.
 * Structural rather than per-widget-type, so new widget shapes are covered
 * automatically as long as they keep the schema's `anchors`/`source` naming.
 * Depth-first in spec order — deterministic for a given spec.
 */
function collectAnchorRefs(
  value: unknown,
  path: (string | number)[] = [],
  out: AnchorRef[] = [],
): AnchorRef[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectAnchorRefs(item, [...path, index], out));
    return out;
  }
  if (value === null || typeof value !== 'object') {
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'anchors' && Array.isArray(child)) {
      child.forEach((anchor, index) => {
        if (isAnchorLike(anchor)) out.push({ anchor, path: [...path, key, index] });
      });
    } else if (key === 'source' && isAnchorLike(child)) {
      out.push({ anchor: child, path: [...path, key] });
    } else {
      collectAnchorRefs(child, [...path, key], out);
    }
  }
  return out;
}
