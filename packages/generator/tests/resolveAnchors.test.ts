import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseLabSpec, safeParseLabSpec, type Anchor, type LabSpec } from '@ramplab/spec';
import { resolveAnchors } from '../src/index.js';

const REPO = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

/**
 * The polyglot fixture repo: nine languages, each with a known symbol, a
 * line range containing it, and a known total line count.
 */
const LANGUAGES = [
  { lang: 'ts', file: 'src/greeter.ts', symbol: 'greet', lines: { start: 5, end: 7 }, lineCount: 11 },
  { lang: 'ruby', file: 'lib/order.rb', symbol: 'total_cents', lines: { start: 8, end: 10 }, lineCount: 15 },
  { lang: 'go', file: 'pkg/server/server.go', symbol: 'ListenAddr', lines: { start: 11, end: 13 }, lineCount: 13 },
  { lang: 'python', file: 'app/models.py', symbol: 'display_name', lines: { start: 8, end: 9 }, lineCount: 13 },
  { lang: 'java', file: 'src/Main.java', symbol: 'greeting', lines: { start: 8, end: 10 }, lineCount: 11 },
  { lang: 'csharp', file: 'Services/Invoice.cs', symbol: 'TotalWithTax', lines: { start: 7, end: 10 }, lineCount: 11 },
  { lang: 'dart', file: 'lib/badge.dart', symbol: 'makeBadge', lines: { start: 9, end: 9 }, lineCount: 9 },
  { lang: 'kotlin', file: 'app/Session.kt', symbol: 'isExpired', lines: { start: 4, end: 4 }, lineCount: 7 },
  { lang: 'swift', file: 'Sources/Router.swift', symbol: 'register', lines: { start: 10, end: 12 }, lineCount: 13 },
] as const;

interface WidgetInput {
  id: string;
  anchors: Anchor[];
}

/** Build a minimal valid lab spec whose single module holds the given widgets. */
function makeSpec(widgets: WidgetInput[], overlay: unknown[] = []): LabSpec {
  return parseLabSpec({
    schemaVersion: 1,
    id: 'fixture-lab',
    title: 'Fixture Lab',
    base: {
      modules: [
        {
          id: 'module-one',
          title: 'Module One',
          widgets: widgets.map((w) => ({
            id: w.id,
            type: 'callout',
            kind: 'why',
            body: `Body for ${w.id}.`,
            anchors: w.anchors,
          })),
        },
      ],
    },
    overlay,
  });
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Expected fingerprint of a region of a fixture file, computed independently. */
function expectedFingerprint(file: string, lines?: { start: number; end: number }): string {
  const normalized = readFileSync(join(REPO, file), 'utf8').replace(/\r\n?/g, '\n');
  if (!lines) return sha256(normalized);
  return sha256(normalized.split('\n').slice(lines.start - 1, lines.end).join('\n'));
}

describe('resolveAnchors: resolution across languages', () => {
  const spec = makeSpec(
    LANGUAGES.map((l) => ({
      id: `unit-${l.lang}`,
      anchors: [{ file: l.file, symbol: l.symbol, lines: l.lines }],
    })),
  );
  const { spec: resolved, report } = resolveAnchors(spec, REPO);

  it.each(LANGUAGES)('resolves a file+symbol+lines anchor in $lang ($file)', ({ lang }) => {
    const unit = report.units.find((u) => u.widgetId === `unit-${lang}`);
    expect(unit?.outcome).toBe('resolved');
    expect(unit?.anchors[0]?.status).toBe('resolved');
    expect(unit?.anchors[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('resolves every unit and anchor, and the summary adds up', () => {
    expect(report.summary).toEqual({
      totalAnchors: LANGUAGES.length,
      resolvedAnchors: LANGUAGES.length,
      totalUnits: LANGUAGES.length,
      resolvedUnits: LANGUAGES.length,
      unresolvedUnits: 0,
    });
  });

  it('keeps all units in the returned spec and stamps fingerprints', () => {
    const widgets = resolved.base.modules[0]?.widgets ?? [];
    expect(widgets).toHaveLength(LANGUAGES.length);
    for (const widget of widgets) {
      if (widget.type !== 'callout') throw new Error('expected callout widget');
      expect(widget.anchors[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('emits fingerprints of exactly the anchored region', () => {
    for (const l of LANGUAGES) {
      const unit = report.units.find((u) => u.widgetId === `unit-${l.lang}`);
      expect(unit?.anchors[0]?.fingerprint).toBe(expectedFingerprint(l.file, l.lines));
    }
  });

  it('returns a spec that still validates against @ramplab/spec', () => {
    expect(safeParseLabSpec(JSON.parse(JSON.stringify(resolved))).success).toBe(true);
  });

  it('reports anchors and units in spec order', () => {
    expect(report.units.map((u) => u.widgetId)).toEqual(LANGUAGES.map((l) => `unit-${l.lang}`));
    expect(report.anchors.map((a) => a.widgetId)).toEqual(LANGUAGES.map((l) => `unit-${l.lang}`));
  });
});

describe('resolveAnchors: anchor granularities', () => {
  it('resolves a file-only anchor (whole-file fingerprint)', () => {
    const spec = makeSpec([{ id: 'file-only', anchors: [{ file: 'src/greeter.ts' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
    expect(report.anchors[0]?.fingerprint).toBe(expectedFingerprint('src/greeter.ts'));
  });

  it('resolves a symbol-only anchor by searching the whole file', () => {
    const spec = makeSpec([{ id: 'sym-only', anchors: [{ file: 'lib/order.rb', symbol: 'total_cents' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
  });

  it('resolves a lines-only anchor with a region fingerprint', () => {
    const lines = { start: 1, end: 3 };
    const spec = makeSpec([{ id: 'lines-only', anchors: [{ file: 'app/models.py', lines }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
    expect(report.anchors[0]?.fingerprint).toBe(expectedFingerprint('app/models.py', lines));
  });

  it('gives different fingerprints to whole file vs a region of it', () => {
    const spec = makeSpec([
      { id: 'whole', anchors: [{ file: 'src/greeter.ts' }] },
      { id: 'region', anchors: [{ file: 'src/greeter.ts', lines: { start: 5, end: 7 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.fingerprint).not.toBe(report.anchors[1]?.fingerprint);
  });
});

describe('resolveAnchors: failure statuses', () => {
  it('reports file-missing for a nonexistent file', () => {
    const spec = makeSpec([{ id: 'gone', anchors: [{ file: 'src/nope.ts' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('file-missing');
    expect(report.anchors[0]?.detail).toContain('src/nope.ts');
    expect(report.anchors[0]?.fingerprint).toBeUndefined();
  });

  it('reports file-missing for a directory path', () => {
    const spec = makeSpec([{ id: 'dir', anchors: [{ file: 'lib' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('file-missing');
    expect(report.anchors[0]?.detail).toMatch(/not a regular file/);
  });

  it('reports file-missing for a path escaping the repo root', () => {
    const spec = makeSpec([{ id: 'escape', anchors: [{ file: '../../vitest.config.ts' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('file-missing');
    expect(report.anchors[0]?.detail).toMatch(/escapes the repository root/);
  });

  it('reports file-missing for an absolute path, even one inside the repo', () => {
    const spec = makeSpec([{ id: 'abs', anchors: [{ file: join(REPO, 'src/greeter.ts') }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('file-missing');
    expect(report.anchors[0]?.detail).toMatch(/must be repo-relative/);
  });

  it.each(LANGUAGES)('reports lines-out-of-range past the end of the $lang file', ({ file, lineCount }) => {
    const spec = makeSpec([
      { id: 'past-end', anchors: [{ file, lines: { start: lineCount, end: lineCount + 1 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('lines-out-of-range');
    expect(report.anchors[0]?.detail).toContain(`${lineCount} lines`);
  });

  it('accepts a range ending exactly on the last line', () => {
    const spec = makeSpec([
      { id: 'last-line', anchors: [{ file: 'app/Session.kt', lines: { start: 7, end: 7 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
  });

  it('treats any line range against an empty file as out of range', () => {
    const spec = makeSpec([
      { id: 'empty', anchors: [{ file: 'notes/empty.txt', lines: { start: 1, end: 1 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('lines-out-of-range');
    expect(report.anchors[0]?.detail).toContain('0 lines');
  });

  it('reports symbol-not-found when the symbol is nowhere in the file', () => {
    const spec = makeSpec([{ id: 'no-sym', anchors: [{ file: 'src/greeter.ts', symbol: 'launchMissiles' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('symbol-not-found');
    expect(report.anchors[0]?.detail).toContain('launchMissiles');
  });

  it('reports symbol-not-found when the symbol exists only outside the line range', () => {
    // `total_cents` lives on lines 8-10 of order.rb; search lines 1-3.
    const spec = makeSpec([
      { id: 'sym-elsewhere', anchors: [{ file: 'lib/order.rb', symbol: 'total_cents', lines: { start: 1, end: 3 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('symbol-not-found');
    expect(report.anchors[0]?.detail).toContain('lines 1-3');
  });

  it('checks the line range before the symbol', () => {
    const spec = makeSpec([
      { id: 'both-bad', anchors: [{ file: 'src/greeter.ts', symbol: 'launchMissiles', lines: { start: 90, end: 99 } }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('lines-out-of-range');
  });
});

describe('resolveAnchors: textual symbol matching', () => {
  it('does not match a symbol embedded in a longer identifier', () => {
    // "gree" and "Greet" both occur only inside longer identifiers.
    const spec = makeSpec([
      { id: 'prefix', anchors: [{ file: 'src/greeter.ts', symbol: 'gree' }] },
      { id: 'inner', anchors: [{ file: 'src/greeter.ts', symbol: 'Greet' }] },
    ]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors.map((a) => a.status)).toEqual(['symbol-not-found', 'symbol-not-found']);
  });

  it('is case-sensitive', () => {
    const spec = makeSpec([{ id: 'case', anchors: [{ file: 'src/greeter.ts', symbol: 'GREET' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('symbol-not-found');
  });

  it('matches symbols containing regex metacharacters (Ruby empty?)', () => {
    const spec = makeSpec([{ id: 'ruby-pred', anchors: [{ file: 'lib/order.rb', symbol: 'empty?' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
  });

  it('matches qualified symbols spanning punctuation (Swift Route(path:)', () => {
    const spec = makeSpec([{ id: 'swift-call', anchors: [{ file: 'Sources/Router.swift', symbol: 'Route(path: path)' }] }]);
    const { report } = resolveAnchors(spec, REPO);
    expect(report.anchors[0]?.status).toBe('resolved');
  });
});

describe('resolveAnchors: drop vs flag policy', () => {
  const mixedSpec = () =>
    makeSpec([
      { id: 'good-unit', anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }] },
      { id: 'bad-unit', anchors: [{ file: 'src/deleted.ts' }] },
      { id: 'also-good', anchors: [{ file: 'app/models.py', symbol: 'find_user' }] },
    ]);

  it('drop (the default) removes unresolved units from the returned spec', () => {
    const { spec: resolved, report } = resolveAnchors(mixedSpec(), REPO);
    expect(report.policy).toBe('drop');
    expect(resolved.base.modules[0]?.widgets.map((w) => w.id)).toEqual(['good-unit', 'also-good']);
    expect(report.units.map((u) => u.outcome)).toEqual(['resolved', 'dropped', 'resolved']);
    expect(report.summary.unresolvedUnits).toBe(1);
  });

  it('flag keeps unresolved units in the returned spec, marked in the report', () => {
    const { spec: resolved, report } = resolveAnchors(mixedSpec(), REPO, { policy: 'flag' });
    expect(report.policy).toBe('flag');
    expect(resolved.base.modules[0]?.widgets.map((w) => w.id)).toEqual([
      'good-unit',
      'bad-unit',
      'also-good',
    ]);
    expect(report.units.map((u) => u.outcome)).toEqual(['resolved', 'flagged', 'resolved']);
    expect(report.summary.unresolvedUnits).toBe(1);
  });

  it('drops a unit when any one of its anchors fails (all anchors must ground)', () => {
    const spec = makeSpec([
      {
        id: 'half-grounded',
        anchors: [
          { file: 'src/greeter.ts', symbol: 'greet' },
          { file: 'src/greeter.ts', symbol: 'launchMissiles' },
        ],
      },
    ]);
    const { spec: resolved, report } = resolveAnchors(spec, REPO);
    expect(report.units[0]?.outcome).toBe('dropped');
    expect(report.units[0]?.anchors.map((a) => a.status)).toEqual(['resolved', 'symbol-not-found']);
    expect(resolved.base.modules[0]?.widgets).toHaveLength(0);
    expect(report.summary).toEqual({
      totalAnchors: 2,
      resolvedAnchors: 1,
      totalUnits: 1,
      resolvedUnits: 0,
      unresolvedUnits: 1,
    });
  });

  it('under flag, resolved anchors inside a flagged unit still get fingerprints', () => {
    const spec = makeSpec([
      {
        id: 'half-grounded',
        anchors: [
          { file: 'src/greeter.ts', symbol: 'greet' },
          { file: 'src/missing.ts' },
        ],
      },
    ]);
    const { spec: resolved } = resolveAnchors(spec, REPO, { policy: 'flag' });
    const widget = resolved.base.modules[0]?.widgets[0];
    const anchors = widget?.type === 'callout' ? widget.anchors : undefined;
    expect(anchors?.[0]?.fingerprint).toBe(expectedFingerprint('src/greeter.ts'));
    expect(anchors?.[1]?.fingerprint).toBeUndefined();
  });
});

describe('resolveAnchors: purity and determinism', () => {
  it('does not mutate the input spec', () => {
    const spec = makeSpec([
      { id: 'good-unit', anchors: [{ file: 'src/greeter.ts', symbol: 'greet' }] },
      { id: 'bad-unit', anchors: [{ file: 'src/deleted.ts' }] },
    ]);
    const before = JSON.parse(JSON.stringify(spec));
    resolveAnchors(spec, REPO);
    expect(spec).toEqual(before);
  });

  it('is deterministic: identical inputs give identical results', () => {
    const build = () =>
      makeSpec(
        LANGUAGES.map((l) => ({
          id: `unit-${l.lang}`,
          anchors: [{ file: l.file, symbol: l.symbol, lines: l.lines }],
        })),
      );
    const first = resolveAnchors(build(), REPO);
    const second = resolveAnchors(build(), REPO);
    expect(second).toEqual(first);
  });

  it('preserves the human overlay untouched', () => {
    const overlay = [
      {
        id: 'lead-note',
        target: { moduleId: 'module-one' },
        widget: { id: 'tribal', type: 'callout', kind: 'why', body: 'Unanchored tribal knowledge.' },
      },
    ];
    const spec = makeSpec([{ id: 'bad-unit', anchors: [{ file: 'src/deleted.ts' }] }], overlay);
    const { spec: resolved } = resolveAnchors(spec, REPO);
    expect(resolved.overlay).toEqual(spec.overlay);
    expect(resolved.base.modules[0]?.widgets).toHaveLength(0);
  });
});

describe('resolveAnchors: fingerprint normalization', () => {
  const tempRepos: string[] = [];
  afterAll(() => {
    for (const dir of tempRepos) rmSync(dir, { recursive: true, force: true });
  });

  it('fingerprints CRLF and LF checkouts of the same content identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ramplab-anchors-'));
    tempRepos.push(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'lf.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(dir, 'src', 'crlf.txt'), 'alpha\r\nbeta\r\ngamma\r\n');

    const spec = makeSpec([
      { id: 'lf', anchors: [{ file: 'src/lf.txt', lines: { start: 1, end: 3 } }] },
      { id: 'crlf', anchors: [{ file: 'src/crlf.txt', lines: { start: 1, end: 3 } }] },
    ]);
    const { report } = resolveAnchors(spec, dir);
    expect(report.anchors[0]?.status).toBe('resolved');
    expect(report.anchors[1]?.status).toBe('resolved');
    expect(report.anchors[0]?.fingerprint).toBe(report.anchors[1]?.fingerprint);
    expect(report.anchors[0]?.fingerprint).toBe(sha256('alpha\nbeta\ngamma'));
  });
});

describe('anchor fingerprint schema (@ramplab/spec)', () => {
  it('accepts a well-formed optional fingerprint', () => {
    const spec = makeSpec([
      {
        id: 'pre-stamped',
        anchors: [{ file: 'src/greeter.ts', fingerprint: sha256('anything') }],
      },
    ]);
    const stamped = spec.base.modules[0]?.widgets[0];
    if (stamped?.type !== 'callout') throw new Error('expected callout widget');
    expect(stamped.anchors[0]?.fingerprint).toMatch(/^sha256:/);
  });

  it('rejects malformed fingerprints', () => {
    const result = safeParseLabSpec({
      schemaVersion: 1,
      id: 'bad-fingerprint-lab',
      title: 'Bad Fingerprint',
      base: {
        modules: [
          {
            id: 'module-one',
            title: 'Module One',
            widgets: [
              {
                id: 'w',
                type: 'callout',
                kind: 'why',
                body: 'x',
                anchors: [{ file: 'a.ts', fingerprint: 'md5:nope' }],
              },
            ],
          },
        ],
      },
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error).toMatch(/sha256/);
  });
});
