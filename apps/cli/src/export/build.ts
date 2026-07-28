import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { LabSpec } from '@ramplab/spec';
import { assembleHtml, BROWSER_ENTRY } from './html.js';

/**
 * Turn a lab spec into one self-contained, interactive HTML document.
 *
 * The renderer highlights code with shiki's *sync* core and statically
 * imported grammars (no dynamic imports, no WASM), so the whole widget
 * library — plus React and shiki — bundles into a single IIFE with esbuild.
 * The result needs no server and no network: openable from disk, hostable
 * anywhere. This is the engine under both `export --static` and `preview`.
 */

const require = createRequire(import.meta.url);

/** Bundle the browser entry (+ renderer, React, shiki) into one IIFE string. */
export async function bundleLabJs(): Promise<string> {
  const result = await build({
    stdin: {
      contents: BROWSER_ENTRY,
      // Resolve bare imports (@ramplab/renderer, react, …) from the CLI
      // package root, walking up into node_modules.
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // React's ESM branches on process.env.NODE_ENV; define it so esbuild
    // prunes the dev-only paths and no `process` reference reaches the browser.
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    write: false,
  });
  const [file] = result.outputFiles;
  if (file === undefined) throw new Error('esbuild produced no output');
  return file.text;
}

/** Read the renderer's shipped stylesheet (resolved via its package export). */
export async function readRendererCss(): Promise<string> {
  return readFile(require.resolve('@ramplab/renderer/style.css'), 'utf8');
}

export interface BuildStaticHtmlDeps {
  /** Override the JS bundler (tests inject a stub to avoid running esbuild). */
  bundleJs?: () => Promise<string>;
  /** Override CSS loading. */
  readCss?: () => Promise<string>;
}

/** Build the self-contained HTML for a spec. */
export async function buildStaticHtml(
  spec: LabSpec,
  deps: BuildStaticHtmlDeps = {},
): Promise<string> {
  const [js, css] = await Promise.all([
    (deps.bundleJs ?? bundleLabJs)(),
    (deps.readCss ?? readRendererCss)(),
  ]);
  return assembleHtml({ js, css, spec });
}
