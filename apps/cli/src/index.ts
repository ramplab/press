#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runExport } from './commands/export.js';
import { runGenerate } from './commands/generate.js';
import { runPreview } from './commands/preview.js';
import { runPublish } from './commands/publish.js';
import { cliVersion } from './version.js';
import { runValidate } from './commands/validate.js';

/**
 * RampLab Mode B-lite CLI entry point (issue #29).
 *
 * Deliberately tiny: parse a subcommand + its flags with Node's built-in
 * `parseArgs` (no arg-parsing dependency), dispatch, and translate the
 * command's return value into a process exit code. All real work lives in
 * `commands/*`, which are pure and injectable so they run in tests with no
 * API spend.
 */

const USAGE = `ramplab: press interactive onboarding editions from a codebase

Usage:
  ramplab generate <repo|url> [--out <file>]    Generate a lab spec (defaults to <repo>.json)
                   [--clone-timeout <minutes>]  How long a URL clone may take (default 15)
  ramplab validate <spec.json>                  Validate a lab spec (free, offline)
  ramplab preview  <spec.json> [--port <n>]     Build and serve a lab locally
  ramplab export   <spec.json> --static <dir>   Write a self-contained static bundle
  ramplab publish  <spec.json>                  Offer a pressed edition to the library
  ramplab --version                             Print the version and exit

Pressing runs on your Claude Code login. Run \`claude\` once to sign in.
Set ANTHROPIC_API_KEY to meter it against an API key instead, at roughly
$5 to $30 in tokens per edition. A key takes precedence wherever it is set.

Docs: https://library.ramplab.dev/cli/
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'generate': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          out: { type: 'string', short: 'o' },
          'clone-timeout': { type: 'string' },
        },
      });
      const repo = positionals[0];
      if (repo === undefined) {
        process.stderr.write(`generate: missing <repo-path|git-url>\n\n${USAGE}`);
        return 1;
      }
      const cloneTimeout =
        values['clone-timeout'] === undefined
          ? undefined
          : Number.parseInt(values['clone-timeout'], 10);
      if (cloneTimeout !== undefined && (!Number.isInteger(cloneTimeout) || cloneTimeout <= 0)) {
        process.stderr.write(`generate: invalid --clone-timeout '${values['clone-timeout']}'\n`);
        return 1;
      }
      return runGenerate({
        repo,
        ...(values.out !== undefined ? { out: values.out } : {}),
        ...(cloneTimeout !== undefined ? { cloneTimeoutMinutes: cloneTimeout } : {}),
      });
    }

    case 'validate': {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      const file = positionals[0];
      if (file === undefined) {
        process.stderr.write(`validate: missing <spec.json>\n\n${USAGE}`);
        return 1;
      }
      return runValidate(file);
    }

    case 'preview': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { port: { type: 'string', short: 'p' } },
      });
      const file = positionals[0];
      if (file === undefined) {
        process.stderr.write(`preview: missing <spec.json>\n\n${USAGE}`);
        return 1;
      }
      const port = values.port !== undefined ? Number.parseInt(values.port, 10) : 4173;
      if (!Number.isInteger(port) || port <= 0) {
        process.stderr.write(`preview: invalid --port '${values.port}'\n`);
        return 1;
      }
      return runPreview({ specFile: file, port });
    }

    case 'export': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { static: { type: 'string' } },
      });
      const file = positionals[0];
      if (file === undefined) {
        process.stderr.write(`export: missing <spec.json>\n\n${USAGE}`);
        return 1;
      }
      if (values.static === undefined) {
        process.stderr.write(`export: missing --static <dir>\n\n${USAGE}`);
        return 1;
      }
      return runExport({ specFile: file, outDir: values.static });
    }

    case 'publish': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { worker: { type: 'string' }, site: { type: 'string' } },
      });
      const file = positionals[0];
      if (file === undefined) {
        process.stderr.write(`publish: missing <spec.json>\n\n${USAGE}`);
        return 1;
      }
      return runPublish({
        specFile: file,
        ...(values.worker !== undefined ? { workerUrl: values.worker } : {}),
        ...(values.site !== undefined ? { siteUrl: values.site } : {}),
      });
    }

    // Bare, so it is trivially parseable, and the first thing anyone reaches
    // for after updating or when filing a bug.
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${cliVersion()}\n`);
      return 0;

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;

    default:
      process.stderr.write(`Unknown command '${command}'.\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((cause) => {
    process.stderr.write(`${(cause as Error).stack ?? String(cause)}\n`);
    process.exit(1);
  });
