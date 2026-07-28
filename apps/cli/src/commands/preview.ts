import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { buildStaticHtml, type BuildStaticHtmlDeps } from '../export/build.js';
import { loadSpec } from '../specIo.js';

/**
 * `ramplab preview <spec.json>` — build the self-contained lab and serve it
 * locally so the caller can click through it before publishing. Long-running:
 * holds the port until interrupted (Ctrl-C).
 */

export interface PreviewOptions {
  specFile: string;
  port: number;
}

export interface PreviewDeps extends BuildStaticHtmlDeps {
  load?: (file: string) => ReturnType<typeof loadSpec>;
  /** Override browser-open (tests / headless). Default best-effort per OS. */
  openBrowser?: (url: string) => void;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** A one-page static server that always serves the same lab HTML. */
export function createPreviewServer(html: string): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}

/** Best-effort open the default browser; never fails the command. */
function defaultOpenBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .on('error', () => {})
      .unref();
  } catch {
    /* opening is a convenience; ignore failures */
  }
}

/**
 * Run the preview command. Resolves when the server closes (Ctrl-C); returns
 * a process exit code. The build + server are factored out (`buildStaticHtml`,
 * `createPreviewServer`) so they test without a long-running listen.
 */
export async function runPreview(options: PreviewOptions, deps: PreviewDeps = {}): Promise<number> {
  const load = deps.load ?? loadSpec;
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  const loaded = await load(options.specFile);
  if (loaded.error !== undefined) {
    err(loaded.error);
    return 1;
  }

  let html: string;
  try {
    html = await buildStaticHtml(loaded.spec, deps);
  } catch (cause) {
    err(`Could not build the lab bundle: ${(cause as Error).message}`);
    return 1;
  }

  const server = createPreviewServer(html);
  return new Promise<number>((resolve) => {
    server.on('error', (cause) => {
      err(`Preview server error: ${(cause as Error).message}`);
      resolve(1);
    });
    server.listen(options.port, () => {
      const url = `http://localhost:${options.port}/`;
      out(`Previewing "${loaded.spec.title}" at ${url}`);
      out('Press Ctrl-C to stop.');
      openBrowser(url);
    });
    const stop = (): void => {
      server.close(() => resolve(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
