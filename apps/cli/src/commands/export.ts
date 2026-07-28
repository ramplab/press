import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LabSpec } from '@ramplab/spec';
import { buildStaticHtml, type BuildStaticHtmlDeps } from '../export/build.js';
import { loadSpec } from '../specIo.js';

/**
 * `ramplab export <spec.json> --static <dir>` — write a self-contained,
 * interactive lab (one `index.html`, no external requests) the caller can
 * host anywhere or open from disk. The reference-lab distribution model.
 */

export interface ExportOptions {
  specFile: string;
  outDir: string;
}

export interface ExportDeps extends BuildStaticHtmlDeps {
  /** Override spec loading (tests). */
  load?: (file: string) => ReturnType<typeof loadSpec>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Run the export command. Returns a process exit code. */
export async function runExport(options: ExportOptions, deps: ExportDeps = {}): Promise<number> {
  const load = deps.load ?? loadSpec;
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const loaded = await load(options.specFile);
  if (loaded.error !== undefined) {
    err(loaded.error);
    return 1;
  }
  const spec: LabSpec = loaded.spec;

  let html: string;
  try {
    html = await buildStaticHtml(spec, deps);
  } catch (cause) {
    err(`Could not build the lab bundle: ${(cause as Error).message}`);
    return 1;
  }

  const indexPath = join(options.outDir, 'index.html');
  try {
    await mkdir(options.outDir, { recursive: true });
    await writeFile(indexPath, html, 'utf8');
  } catch (cause) {
    err(`Could not write ${indexPath}: ${(cause as Error).message}`);
    return 1;
  }

  out(`✓ Wrote self-contained lab to ${indexPath}`);
  out('  Open it in a browser, or host the directory anywhere — no server needed.');
  return 0;
}
