/**
 * Live-run entry for the generator — the documented real-model path.
 *
 * Usage (from the repo root):
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @ramplab/generator run live -- <repoDir> [outFile] [--pass1 | --full]
 *
 * The key is optional. With `ANTHROPIC_API_KEY` unset the Agent SDK falls
 * through to the Claude Code login, which spends session allowance instead of
 * API credit — the way to populate the library without a metered bill. Either
 * way the run prints which credential it took before it starts. Note that a
 * shell which sources this repo's `.env` has the key set: unset it deliberately.
 *
 * Runs against the given plain local directory with the real Claude Agent
 * SDK, prints progress and a resolution summary to stderr, and writes the
 * resulting lab-spec JSON to `outFile` (default `lab-spec.json` in the
 * current directory) — ready to load into the playground.
 *
 * Modes (the two-pass runtime, PLAN.md §4):
 * - default: the map-stage tracer (repo map + intro module).
 * - `--pass1`: pass 1 — map + ONE flagship module: the most representative
 *   front-door trace action the map proposed (intake can override; subsystem
 *   centrality is the fallback), lightly verified (anchor resolution only).
 *   Streams progress events, prints which trace action was selected and why
 *   (basis), and prints the measured pass-1 timing.
 * - `--full`: pass 2 — the full pipeline (map → curriculum plan → parallel
 *   authoring → assemble → adversarial verification), printing progress
 *   events as they arrive.
 *
 * Optional env:
 * - RAMPLAB_MAP_MODEL / RAMPLAB_PLAN_MODEL / RAMPLAB_AUTHOR_MODEL /
 *   RAMPLAB_VERIFY_MODEL override the per-stage models.
 * - RAMPLAB_MAX_MODULES caps the curriculum budget (full mode; default 6).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAgentSdkRunner, describeAuth } from './agentSdkRunner.js';
import type { FlagshipSelection } from './flagship.js';
import { generateLab, type GenerateLabConfig } from './generateLab.js';
import { generateLabPass1 } from './pass1.js';
import type { StageModelConfig } from './pipeline.js';
import type { GenerationProgressEvent } from './progress.js';

/**
 * One line naming the selected flagship and its basis — trace action first
 * (the issue-#18 design), node fallback spelled out — so iteration reviews
 * know exactly what pass 1 chose and why.
 */
function describeFlagship(flagship: FlagshipSelection): string {
  const why = {
    trace: 'most representative front-door action proposed by the map',
    'trace-intake': `intake hint "${flagship.matchedHint ?? ''}" matched this action`,
    intake:
      `no usable trace candidates — node fallback; ` +
      `intake hint "${flagship.matchedHint ?? ''}" matched this node`,
    centrality:
      `no usable trace candidates — node fallback by subsystem centrality ` +
      `(degree ${flagship.degree ?? 0})`,
  }[flagship.basis];
  return flagship.traceAction !== undefined
    ? `Flagship trace: "${flagship.traceAction}" → module "${flagship.plannedModule.id}" ` +
        `(basis: ${flagship.basis} — ${why}).`
    : `Flagship: module "${flagship.plannedModule.id}" (node ${flagship.nodeId ?? '?'}, ` +
        `basis: ${flagship.basis} — ${why}).`;
}

function printProgress(event: GenerationProgressEvent): void {
  switch (event.type) {
    case 'stage-started':
      console.error(`[${event.pass}] ${event.stage}: started`);
      break;
    case 'stage-completed':
      console.error(`[${event.pass}] ${event.stage}: completed`);
      break;
    case 'module-authored':
      console.error(
        `[${event.pass}] authored module "${event.moduleId}" ` +
          `(${event.attempts} attempt${event.attempts === 1 ? '' : 's'})`,
      );
      break;
    case 'spec-updated':
      console.error(
        `[${event.pass}] spec updated — ${event.spec.base.modules.length} module(s) renderable`,
      );
      break;
  }
}

/** Read `--flag N` out of argv as a positive integer. */
function numericFlag(
  args: readonly string[],
  flag: string,
): { ok: true; value: number | undefined } | { ok: false; error: string } {
  const at = args.indexOf(flag);
  if (at === -1) return { ok: true, value: undefined };
  const raw = args[at + 1];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${flag} needs a positive integer, got "${raw ?? ''}".` };
  }
  return { ok: true, value };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const pass1 = args.includes('--pass1');

  // The same two guards the eval harness raises by default (its tier-1
  // findings): the SDK's 50-turn default gets exhausted by one authoring
  // session on a real repo, and author-stage schema drift occasionally needs
  // a second retry. This entry could not reach either until now, so a
  // single-repo pressing was the one path still running on the low cap.
  const turns = numericFlag(args, '--max-turns');
  const retries = numericFlag(args, '--max-retries');
  for (const parsed of [turns, retries]) {
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }
  }
  const maxTurns = turns.ok ? turns.value : undefined;
  const maxRetries = retries.ok ? retries.value : undefined;

  const positional = args.filter(
    (arg, index) =>
      !arg.startsWith('--') &&
      // Drop the value that followed a numeric flag, not every matching token.
      !(index > 0 && (args[index - 1] === '--max-turns' || args[index - 1] === '--max-retries')),
  );
  const [repoDirArg, outArg] = positional;
  if (repoDirArg === undefined || (full && pass1)) {
    console.error(
      'Usage: pnpm --filter @ramplab/generator run live -- <repoDir> [outFile] ' +
        '[--pass1 | --full] [--max-turns N] [--max-retries N]',
    );
    process.exitCode = 2;
    return;
  }
  // Either credential runs the pipeline; the run just has to say which.
  console.error(`Auth: ${describeAuth().label}`);

  const repoDir = resolve(repoDirArg);
  const outFile = resolve(outArg ?? 'lab-spec.json');

  const models: StageModelConfig = {};
  if (process.env['RAMPLAB_MAP_MODEL'] !== undefined) {
    models.map = process.env['RAMPLAB_MAP_MODEL'];
  }
  if (process.env['RAMPLAB_PLAN_MODEL'] !== undefined) {
    models.plan = process.env['RAMPLAB_PLAN_MODEL'];
  }
  if (process.env['RAMPLAB_AUTHOR_MODEL'] !== undefined) {
    models.author = process.env['RAMPLAB_AUTHOR_MODEL'];
  }
  if (process.env['RAMPLAB_VERIFY_MODEL'] !== undefined) {
    models.verify = process.env['RAMPLAB_VERIFY_MODEL'];
  }

  const maxModulesEnv = process.env['RAMPLAB_MAX_MODULES'];
  const maxModules = maxModulesEnv !== undefined ? Number(maxModulesEnv) : undefined;
  if (maxModules !== undefined && (!Number.isInteger(maxModules) || maxModules < 1)) {
    console.error(`RAMPLAB_MAX_MODULES must be a positive integer, got "${maxModulesEnv}".`);
    process.exitCode = 2;
    return;
  }

  // A raised cap is still a hard guard, just a roomier one.
  const runner = maxTurns !== undefined ? createAgentSdkRunner({ maxTurns }) : undefined;
  if (maxTurns !== undefined || maxRetries !== undefined) {
    console.error(
      `Guards: max-turns=${maxTurns ?? 'default'}, max-retries=${maxRetries ?? 'default'}`,
    );
  }

  if (pass1) {
    console.error(`Generating pass-1 preview lab for ${repoDir} ...`);
    const result = await generateLabPass1(repoDir, {
      ...(Object.keys(models).length > 0 ? { models } : {}),
      ...(runner !== undefined ? { runner } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      onProgress: printProgress,
    });

    writeFileSync(outFile, `${JSON.stringify(result.spec, null, 2)}\n`, 'utf8');

    const seconds = (result.timing.durationMs / 1000).toFixed(1);
    console.error(`Pass 1 done in ${seconds}s (map attempts: ${result.attempts}).`);
    console.error(`Models: map=${result.models.map}, author=${result.models.author}`);
    console.error(describeFlagship(result.flagship));
    const { summary } = result.resolution;
    console.error(
      `Anchors: ${summary.resolvedAnchors}/${summary.totalAnchors} resolved; ` +
        `units: ${summary.resolvedUnits}/${summary.totalUnits} kept, ` +
        `${summary.unresolvedUnits} dropped.`,
    );
    console.error(
      result.costUsd !== undefined
        ? `Cost: $${result.costUsd.toFixed(4)}`
        : 'Cost: not reported by the runner.',
    );
    console.error(`Spec written to ${outFile} — load it in apps/playground to view.`);
    return;
  }

  const config: GenerateLabConfig = {
    full,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(maxModules !== undefined ? { budget: { maxModules } } : {}),
    ...(runner !== undefined ? { runner } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
    ...(full ? { onProgress: printProgress } : {}),
  };

  console.error(
    `Generating ${full ? 'full-pipeline' : 'map-stage'} lab for ${repoDir} ...`,
  );
  const started = Date.now();
  const result = await generateLab(repoDir, config);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  writeFileSync(outFile, `${JSON.stringify(result.spec, null, 2)}\n`, 'utf8');

  const { summary } = result.resolution;
  console.error(`Done in ${seconds}s (map attempts: ${result.attempts}).`);
  console.error(
    full
      ? `Models: map=${result.models.map}, plan=${result.models.plan}, ` +
          `author=${result.models.author}, verify=${result.models.verify}`
      : `Model (map stage): ${result.models.map}`,
  );
  if (result.plan !== undefined) {
    console.error(
      `Plan: ${result.plan.modules.length} module(s) — ` +
        result.plan.modules.map((m) => m.id).join(', '),
    );
  }
  console.error(
    `Anchors: ${summary.resolvedAnchors}/${summary.totalAnchors} resolved; ` +
      `units: ${summary.resolvedUnits}/${summary.totalUnits} kept, ` +
      `${summary.unresolvedUnits} dropped.`,
  );
  if (result.verification !== undefined) {
    const v = result.verification;
    console.error(
      `Verification: ${v.summary.verified}/${v.summary.totalClaims} claims verified ` +
        `(pass rate ${(v.summary.passRate * 100).toFixed(1)}%); dropped ` +
        `${v.drops.widgets.length} widget(s), ${v.drops.questions.length} quiz question(s), ` +
        `${v.drops.modules.length} emptied module(s).`,
    );
  }
  console.error(
    result.costUsd !== undefined
      ? `Cost: $${result.costUsd.toFixed(4)}`
      : 'Cost: not reported by the runner.',
  );
  console.error(`Spec written to ${outFile} — load it in apps/playground to view.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
