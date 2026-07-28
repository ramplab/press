import type { LabSpec } from '@ramplab/spec';

/**
 * The browser entry for a self-contained lab: read the spec embedded on
 * `window`, mount it with the renderer. Bundled by esbuild (see `build.ts`)
 * together with the renderer, React, and shiki into one script. It is a
 * plain string — never typechecked as part of the CLI's `tsc` (it targets
 * the DOM, which the CLI's Node tsconfig doesn't include) — so esbuild owns
 * its compilation.
 */
export const BROWSER_ENTRY = `
import { renderLab } from '@ramplab/renderer';
const spec = window.__RAMPLAB_SPEC__;
const root = document.getElementById('root');
if (spec && root) renderLab(spec, root);
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Embed a spec as a JS literal inside a `<script>`. `JSON.stringify` alone is
 * unsafe in HTML because a `</script>` inside a string would close the tag;
 * escaping `<` to a unicode escape keeps the JSON valid while inert to the
 * HTML parser.
 */
function embedSpec(spec: LabSpec): string {
  return JSON.stringify(spec).replace(/</g, '\\u003c');
}

/**
 * Assemble a single self-contained HTML document: inlined renderer CSS, the
 * spec on `window`, and the bundled script. No external requests — openable
 * from `file://`, hostable anywhere. Pure and synchronous so it is trivially
 * testable without running a bundler.
 */
export function assembleHtml(parts: { js: string; css: string; spec: LabSpec }): string {
  const title = parts.spec.title || 'RampLab';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${parts.css}</style>
</head>
<body>
<div id="root"></div>
<script>window.__RAMPLAB_SPEC__=${embedSpec(parts.spec)}</script>
<script>${parts.js}</script>
</body>
</html>
`;
}
