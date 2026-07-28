import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@ramplab/spec';
import { createPreviewServer, runPreview } from '../src/commands/preview.js';

const spec = {
  schemaVersion: '1',
  id: 'demo',
  title: 'Preview Lab',
  base: { modules: [{ id: 'a' }] },
  overlay: { modules: [] },
} as unknown as LabSpec;

describe('createPreviewServer', () => {
  it('serves the same HTML with a 200 and html content-type', async () => {
    const server = createPreviewServer('<!doctype html><title>hi</title>');
    await new Promise<void>((r) => server.listen(0, r));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://localhost:${port}/anything`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<title>hi</title>');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('runPreview', () => {
  it('builds, serves, opens the browser, then stops on SIGINT', async () => {
    const lines: string[] = [];
    let openedUrl: string | undefined;
    const done = runPreview(
      { specFile: 'ignored.json', port: 0 },
      {
        load: async () => ({ spec }),
        bundleJs: async () => 'window.__STUB__=1;',
        readCss: async () => '.lab{}',
        openBrowser: (url) => {
          openedUrl = url;
        },
        stdout: (l) => lines.push(l),
        stderr: (l) => lines.push(l),
      },
    );
    // Let listen() fire, then interrupt to unblock the promise.
    await new Promise((r) => setTimeout(r, 50));
    process.emit('SIGINT');
    const code = await done;

    expect(code).toBe(0);
    expect(openedUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
    expect(lines.join('\n')).toContain('Preview Lab');
  });

  it('fails when the spec is invalid', async () => {
    const errs: string[] = [];
    const code = await runPreview(
      { specFile: 'bad.json', port: 0 },
      { load: async () => ({ error: 'bad spec' }), stderr: (l) => errs.push(l), stdout: () => {} },
    );
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('bad spec');
  });
});
