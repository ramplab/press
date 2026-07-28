import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@ramplab/spec';
import { assembleHtml } from '../src/export/html.js';
import { runExport } from '../src/commands/export.js';

const spec = {
  schemaVersion: '1',
  id: 'demo',
  title: 'Payments </script> Lab',
  base: { modules: [{ id: 'a' }] },
  overlay: { modules: [] },
} as unknown as LabSpec;

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ramplab-export-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('assembleHtml', () => {
  it('inlines css + js + spec into one self-contained document', () => {
    const html = assembleHtml({ js: 'window.__RAN__=1;', css: '.x{color:red}', spec });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('.x{color:red}');
    expect(html).toContain('window.__RAN__=1;');
    expect(html).toContain('window.__RAMPLAB_SPEC__=');
  });

  it('neutralizes </script> in the embedded spec so it cannot break out', () => {
    const html = assembleHtml({ js: '', css: '', spec });
    // The literal closing tag must not appear inside the data script.
    expect(html).not.toContain('</script> Lab');
    expect(html).toContain('\\u003c/script> Lab');
    // Title is HTML-escaped in <title>.
    expect(html).toContain('<title>Payments &lt;/script&gt; Lab</title>');
  });
});

describe('runExport', () => {
  it('writes index.html using injected bundler stubs (no esbuild)', async () => {
    await withTmpDir(async (dir) => {
      const lines: string[] = [];
      const code = await runExport(
        { specFile: 'ignored.json', outDir: dir },
        {
          load: async () => ({ spec }),
          bundleJs: async () => 'window.__STUB__=1;',
          readCss: async () => '.lab{}',
          stdout: (l) => lines.push(l),
          stderr: (l) => lines.push(l),
        },
      );
      expect(code).toBe(0);
      const html = await readFile(join(dir, 'index.html'), 'utf8');
      expect(html).toContain('window.__STUB__=1;');
      expect(html).toContain('.lab{}');
      expect(lines.join('\n')).toContain('self-contained lab');
    });
  });

  it('fails with a message when the spec is invalid', async () => {
    await withTmpDir(async (dir) => {
      const errs: string[] = [];
      const code = await runExport(
        { specFile: 'bad.json', outDir: dir },
        { load: async () => ({ error: 'bad.json is not a valid lab spec' }), stderr: (l) => errs.push(l), stdout: () => {} },
      );
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('not a valid lab spec');
    });
  });
});
