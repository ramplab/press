import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@ramplab/spec';
import { bundleLabJs, buildStaticHtml, readRendererCss } from '../src/export/build.js';

/**
 * Integration test: run the REAL esbuild bundle of the renderer (+ React +
 * shiki) — no stubs. Proves the self-contained bundle actually builds and
 * embeds everything. Slower than the unit tests (a real bundle), hence the
 * raised timeout. Requires the workspace packages to be built (turbo does
 * this via ^build before test).
 */

const spec = {
  schemaVersion: '1',
  id: 'demo',
  title: 'Integration Lab',
  base: { modules: [{ id: 'a' }] },
  overlay: { modules: [] },
} as unknown as LabSpec;

describe('esbuild bundle (integration)', () => {
  it('bundles the renderer into a non-trivial IIFE with no process reference', async () => {
    const js = await bundleLabJs();
    expect(js.length).toBeGreaterThan(10_000); // React + renderer + shiki grammars
    // NODE_ENV was defined, so no bare process.env.NODE_ENV survives.
    expect(js).not.toContain('process.env.NODE_ENV');
  }, 60_000);

  it('reads the shipped renderer stylesheet', async () => {
    const css = await readRendererCss();
    expect(css.length).toBeGreaterThan(0);
  });

  it('assembles a self-contained document embedding the real bundle + spec', async () => {
    const html = await buildStaticHtml(spec);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('"Integration Lab"');
    expect(html.length).toBeGreaterThan(10_000);
  }, 60_000);
});
