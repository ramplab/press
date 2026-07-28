#!/usr/bin/env node
/**
 * Does a live run actually reach a credential? — the cheapest possible check.
 *
 * The generator's live entries no longer demand `ANTHROPIC_API_KEY`: with the
 * key unset the Agent SDK spawns the Claude Code CLI, which falls through to
 * `CLAUDE_CODE_OAUTH_TOKEN` and then your stored Claude Code login, spending
 * session allowance instead of API credit. That fallback is worth confirming
 * before committing a 30-minute pressing to it, and confirming it costs one
 * two-token round trip.
 *
 * Run (from the repo root):
 *   node packages/generator/scripts/auth-probe.mjs            # no key: the Claude Code login
 *   ANTHROPIC_API_KEY=sk-ant-... node packages/generator/scripts/auth-probe.mjs
 *   node packages/generator/scripts/auth-probe.mjs claude-opus-5   # probe a specific model
 *
 * A shell that has sourced this repo's `.env` already has the key set — this
 * script does NOT unset it for you, because which credential you are probing
 * is the whole question. Use `env -u ANTHROPIC_API_KEY node ...` to be sure.
 *
 * Exit 0 = a credential answered. Exit 1 = it did not; the CLI's stderr tail
 * is printed, which is where the reason lives.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const arg = process.argv[2];
if (arg === '--help' || arg === '-h') {
  console.log(
    'Usage: node packages/generator/scripts/auth-probe.mjs [model]\n\n' +
      '  Sends one two-token round trip through the Agent SDK and reports which\n' +
      '  credential answered. Prefix with `env -u ANTHROPIC_API_KEY` to probe the\n' +
      '  Claude Code login rather than the API key.\n\n' +
      '  model   defaults to claude-sonnet-5',
  );
  process.exit(0);
}
// A stray flag must not silently become the model name and burn a round trip.
if (arg !== undefined && arg.startsWith('-')) {
  console.error(`Unknown option "${arg}". The only argument is a model id; see --help.`);
  process.exit(2);
}
const model = arg ?? 'claude-sonnet-5';

// Report the mode through the same helper the live entries print, so the probe
// and a real run can never disagree about which credential is in play.
let describeAuth;
try {
  ({ describeAuth } = await import(join(repoRoot, 'packages/generator/dist/index.js')));
} catch {
  console.error('(generator dist not built — run `pnpm turbo run build` for the auth banner)');
}
if (describeAuth !== undefined) console.log(`Auth: ${describeAuth().label}`);
console.log(`Model: ${model}\nProbing...\n`);

const { query } = await import('@anthropic-ai/claude-agent-sdk');

let stderrTail = '';
const session = query({
  prompt: 'Reply with exactly: PONG',
  options: {
    model,
    // Somewhere real and harmless to sit; the probe reads nothing.
    cwd: join(repoRoot, 'packages/spec'),
    allowedTools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
    permissionMode: 'bypassPermissions',
    settingSources: [], // same zero-infra assumption as the real runner
    maxTurns: 2,
    stderr: (data) => {
      stderrTail = `${stderrTail}${data}`.slice(-2000);
    },
  },
});

const fail = (message) => {
  console.error(`\nFAILED: ${message}`);
  if (stderrTail.length > 0) console.error(`\nCLI stderr (tail):\n${stderrTail.trim()}`);
  process.exit(1);
};

let result;
try {
  for await (const message of session) {
    if (message.type === 'result') result = message;
  }
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}

if (result === undefined) fail('the session ended without a result message.');
if (result.is_error === true || result.subtype !== 'success') {
  fail(`the session reported ${result.subtype ?? 'an error'}.`);
}

console.log(`Reply: ${JSON.stringify(result.result)}`);
console.log(
  result.total_cost_usd === undefined
    ? 'Cost: not reported by the runner.'
    : `Cost: $${result.total_cost_usd.toFixed(4)} ` +
        '(on the Claude Code credential this is a token-priced estimate, not a charge)',
);
console.log('\nOK — a credential answered. A live run will reach the models.');
