import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  cloneRepo,
  CloneTimeoutError,
  describeAuth,
  parseGitProgress,
  generateLab,
  isRepoDirty,
  readRepoCommit,
  readRepoRemote,
  validateRepoUrl,
  type CloneResult,
  type GenerateLabConfig,
  type GenerateLabResult,
  type GenerationProgressEvent,
  type ModelRunner,
  type ProseDrop,
} from '@ramplab/generator';
import { formatProgress } from '../reporter.js';
import { formatElapsed } from '../pressProgress.js';
import {
  createCloneDisplay,
  createLiveDisplay,
  createLogDisplay,
  type OutputStream,
  type PressDisplay,
} from '../pressDisplay.js';

/**
 * `ramplab generate <repo-path|git-url>` — the heart of Mode B-lite (#29).
 *
 * Runs the full two-pass pipeline over a repository on the caller's own
 * machine and writes the resulting lab spec to disk. The argument is a local
 * directory, or a GitHub URL to clone into a temp checkout first (#146).
 *
 * The URL form is not only convenience. A fresh clone is never dirty, so the
 * commit is always stamped and the repository is reachable by definition,
 * which is exactly what the public shelf asks for later. Pressing a directory
 * stays the more private path and the default reading of the argument.
 * Grounding is fully preserved: because generation runs where the repo lives,
 * mechanical anchor resolution and the adversarial verify stage both run —
 * exactly what a "paste this prompt into your agent" approach could not do.
 *
 * The generator has zero infra assumptions and takes an injectable
 * `ModelRunner`, so this wrapper is thin and testable: inject a fake runner
 * (and/or a fake `generate`) and the whole command runs with no API spend.
 */

/**
 * How long a local clone may take.
 *
 * The library's own limit is two minutes, which is the right budget for
 * cloning an untrusted URL on the machine everyone is served from. On your
 * own laptop neither constraint applies, and two minutes does not finish a
 * shallow clone of something the size of supabase: the clone was killed and
 * the error blamed git for it.
 */
export const LOCAL_CLONE_TIMEOUT_MS = 15 * 60_000;

export interface GenerateOptions {
  /** A local repository directory, or a GitHub URL to clone and press. */
  repo: string;
  /** Override the clone budget, in minutes. */
  cloneTimeoutMinutes?: number;
  /**
   * Where to write the lab spec. Defaults to the repository's own name, so
   * two different repos never collide, and a name already taken is stepped
   * past rather than overwritten.
   */
  out?: string;
}

export interface GenerateDeps {
  /** The generator entry point; defaults to the real `generateLab`. */
  generate?: (repoDir: string, config: GenerateLabConfig) => Promise<GenerateLabResult>;
  /**
   * Agent-invocation boundary passed through to the generator. Omitted on the
   * live path (the generator defaults to the real Agent SDK runner, which
   * resolves a credential for itself); tests inject a fake so no live call
   * happens. When present, the credential banner is skipped entirely.
   */
  runner?: ModelRunner;
  /** Environment source; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Clones a URL; defaults to the real shallow clone. Injected in tests. */
  clone?: (repoUrl: string) => Promise<CloneResult>;
  /** Reads the pressed commit; injected in tests so no git is required. */
  readCommit?: (repoDir: string) => string | undefined;
  /** Names the repository a checkout came from; injected in tests. */
  readRemote?: (repoDir: string) => string | undefined;
  /**
   * The stream a live press draws on. Defaults to stdout. A stream that is
   * not a TTY gets the one-line-per-event log instead, which is what pipes,
   * CI and `TERM=dumb` see.
   */
  stream?: OutputStream;
  /** Register the interrupt handler; injected so tests never touch signals. */
  onInterrupt?: (handler: () => void) => () => void;
  /** Reports an unclean working tree; injected in tests. */
  isDirty?: (repoDir: string) => boolean;
  /** Millisecond clock, injected in tests so the reported duration is stable. */
  now?: () => number;
  /** Existence check for output paths; injected in tests. */
  fileExists?: (path: string) => boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Run the generate command. Returns a process exit code. */
export async function runGenerate(
  options: GenerateOptions,
  deps: GenerateDeps = {},
): Promise<number> {
  const generate = deps.generate ?? generateLab;
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string): void => void process.stderr.write(`${line}\n`));

  // Which credential this press will spend (founder, 2026-07-26). An API key
  // is no longer required: the Agent SDK spawns the Claude Code CLI, which
  // resolves credentials the way Claude Code itself does, so a Pro or Max
  // subscription presses without anyone minting a key. That matters because
  // developers have Claude Code; far fewer have API billing set up. Either
  // way the press runs HERE, on this machine, against the real repo, and no
  // credential ever leaves it.
  if (deps.runner === undefined) {
    const auth = describeAuth(env);
    out(
      auth.mode === 'api-key'
        ? 'Pressing on your ANTHROPIC_API_KEY. Expect roughly $5–30 in tokens, billed to your key.'
        : 'Pressing on your Claude Code login. This spends session allowance, not API credit.',
    );
    if (auth.mode === 'claude-code') {
      out('(No ANTHROPIC_API_KEY set. Run `claude` once to sign in if this fails.)');
    }
  }

  // Where this lands, decided and announced before a clone or a token is
  // spent. Knowing the name up front is the difference between choosing it
  // and discovering it an hour later on top of something you wanted.
  const exists = deps.fileExists ?? existsSync;
  const desiredOut = options.out ?? defaultOutName(options.repo);
  const outPath = freeOutPath(desiredOut, exists);
  if (outPath !== desiredOut) {
    out(`${desiredOut} exists; writing to ${outPath}`);
  } else if (options.out === undefined) {
    out(`Writing to ${outPath}`);
  }
  const resolved = { ...options, out: outPath };

  // A URL is cloned into a temp checkout and pressed there; anything else is
  // read where it stands. `looksRemote` only decides which error you get: a
  // bad URL should say what is wrong with the URL, not that no such directory
  // exists.
  const looksRemote = /^(https?:\/\/|git@)/i.test(options.repo.trim());
  let checkout: CloneResult | undefined;
  let clonedFrom: string | undefined;
  let repoDir = options.repo;

  if (looksRemote) {
    const check = validateRepoUrl(options.repo);
    if (!check.ok) {
      err(`Cannot press ${options.repo}: ${check.error}`);
      err('Clone it yourself and press the directory instead.');
      return 1;
    }
    clonedFrom = `https://github.com/${check.repoKey}`;
    const timeoutMs =
      options.cloneTimeoutMinutes !== undefined
        ? options.cloneTimeoutMinutes * 60_000
        : LOCAL_CLONE_TIMEOUT_MS;
    const cloneStream = deps.stream ?? (process.stdout as unknown as OutputStream);
    const cloneLive = cloneStream.isTTY === true;
    // Git knows how it is getting on and says so on stderr. On a terminal
    // that becomes a live line; anywhere else it stays quiet, as before.
    const cloneDisplay = cloneLive
      ? createCloneDisplay({
          stream: cloneStream,
          env: deps.env ?? process.env,
          subject: check.repoKey,
          parse: parseGitProgress,
        })
      : undefined;
    if (cloneDisplay === undefined) out(`Cloning ${check.repoKey} …`);
    try {
      checkout = await (deps.clone ??
        ((url: string) =>
          cloneRepo(url, {
            timeoutMs,
            ...(cloneDisplay !== undefined
              ? { onProgress: (chunk: string) => cloneDisplay.onProgress(chunk) }
              : {}),
          })))(check.url);
      cloneDisplay?.stop();
    } catch (cause) {
      cloneDisplay?.stop();
      err(`Could not clone ${check.repoKey}: ${(cause as Error).message}`);
      if (cause instanceof CloneTimeoutError) {
        const minutes = Math.round(timeoutMs / 60_000);
        err(`Give it longer with --clone-timeout ${minutes * 2}, or clone it yourself`);
        err('and press the directory instead.');
      }
      return 1;
    }
    repoDir = checkout.dir;
  }

  try {
    return await press(repoDir, resolved, deps, { out, err, generate, cloned: clonedFrom });
  } finally {
    // The checkout is ours, so it goes when we are done with it either way.
    await checkout?.cleanup();
  }
}

/** The press itself, over a directory that is either theirs or our clone. */
async function press(
  repoDir: string,
  options: GenerateOptions & { out: string },
  deps: GenerateDeps,
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    generate: (repoDir: string, config: GenerateLabConfig) => Promise<GenerateLabResult>;
    /** The URL this checkout came from, when we made it. */
    cloned: string | undefined;
  },
): Promise<number> {
  const { out, err, generate, cloned } = io;
  const now = deps.now ?? Date.now;
  const startedMs = now();
  const stream = deps.stream ?? (process.stdout as unknown as OutputStream);
  const live = stream.isTTY === true && (deps.env ?? process.env).NO_COLOR === undefined;

  // A press is minutes of silence otherwise. On a terminal that is a live
  // frame; anywhere else it is the log it always was (#164).
  const display: PressDisplay = live
    ? createLiveDisplay({
        stream,
        env: deps.env ?? process.env,
        // owner/repo, as the clone line says it. The raw URL is noise in a
        // heading that already says what it is doing.
        subject: validateRepoUrl(options.repo).ok
          ? (validateRepoUrl(options.repo) as { repoKey: string }).repoKey
          : options.repo,
      })
    : createLogDisplay(out, formatProgress, {
        subject: options.repo,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
  if (!live) out(`Generating lab from ${options.repo} …`);

  // The most recent snapshot, kept so an interrupted press can still hand
  // back what it managed. Every one of these is complete and anchor-resolved.
  let latest: GenerateLabResult['spec'] | undefined;
  let interrupted = false;

  const release = deps.onInterrupt?.(() => {
    interrupted = true;
  });

  let result: GenerateLabResult;
  try {
    const config: GenerateLabConfig = {
      full: true,
      resolutionPolicy: 'drop',
      onProgress: (event: GenerationProgressEvent): void => {
        if (event.type === 'spec-updated') latest = event.spec;
        display.onEvent(event);
      },
      ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    };
    result = await generate(repoDir, config);
  } catch (cause) {
    display.stop();
    release?.();
    // Whatever landed is worth keeping, however the press ended (#177). Every
    // spec-updated snapshot is complete, schema-valid and anchor-resolved by
    // contract, so a failure at minute forty was throwing away a real edition
    // of the chapters already written — one that this could always have
    // saved, and did, but only for ctrl-c. A press can die on a stage error,
    // a turn cap or a dropped connection, and none of those make the finished
    // chapters worse.
    if (latest !== undefined) {
      if (!interrupted) err(`Generation failed: ${(cause as Error).message}`);
      return await savePartial(latest, options, {
        out,
        err,
        exists: deps.fileExists ?? existsSync,
        interrupted,
      });
    }
    err(`Generation failed: ${(cause as Error).message}`);
    return 1;
  }
  display.stop();
  release?.();

  // Provenance for anyone who re-verifies this later. Anchors are only
  // checkable against the tree they were written against, so the commit
  // travels with the spec; without it a verifier clones HEAD, the repo has
  // moved on, and honest anchors fail. Best-effort: pressing a directory that
  // is not a checkout stays perfectly valid, it just cannot be verified from
  // the commit alone, and the publish step says so rather than this one.
  const commit = deps.readCommit === undefined ? readRepoCommit(repoDir) : deps.readCommit(repoDir);
  const dirty = deps.isDirty === undefined ? isRepoDirty(repoDir) : deps.isDirty(repoDir);
  // The repository this describes, so anything can ever check it: the URL we
  // cloned, or the remote the checkout already names. Without it an edition
  // reads as naming no repository and is capped below the public shelf
  // whatever its contents, which is not what a public checkout deserves.
  const repo =
    cloned ?? (deps.readRemote === undefined ? readRepoRemote(repoDir) : deps.readRemote(repoDir));
  const spec = {
    ...result.spec,
    ...(result.spec.repo === undefined && repo !== undefined ? { repo } : {}),
    ...(commit !== undefined && !dirty ? { commit } : {}),
  };
  if (commit !== undefined && dirty) {
    out('Note: the working tree has uncommitted changes, so no commit is stamped.');
    out('This edition can still be read and shared privately, but not verified from its commit.');
  } else if (spec.repo === undefined) {
    // Said here, where the reason is visible, rather than discovered later on
    // a claim page with the shelf greyed out.
    out('Note: this is not a checkout of a public GitHub repository, so nothing can');
    out('check it later. You can still publish it privately or by link, but not to the shelf.');
  }

  // Re-checked, because an hour is long enough for the name to be taken by
  // something else since it was chosen.
  const outPath = freeOutPath(options.out, deps.fileExists ?? existsSync);
  try {
    await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  } catch (cause) {
    err(`Could not write ${outPath}: ${(cause as Error).message}`);
    return 1;
  }

  await reportProseDrops(result.proseDrops, outPath, { out, err });

  const modules = result.spec.base.modules.length;
  const cost = result.costUsd !== undefined ? `$${result.costUsd.toFixed(2)}` : 'n/a';
  out('');
  out(`✓ Wrote ${outPath}`);
  // What it took as well as what it cost. A press is advertised at about half
  // an hour and bills real money; "7 modules" alone says nothing about either.
  out(
    `  ${modules} module${modules === 1 ? '' : 's'} · ${formatElapsed(now() - startedMs)} · ` +
      `model cost ${cost}`,
  );
  // The three things anyone actually wants next, as commands they can run.
  // This used to point at the viewer without saying where it was, and then
  // offer `validate` — the one command that tells you nothing you want to
  // know at the end of an hour.
  out('');
  out(`  Read it      ramplab preview ${outPath}`);
  out(`  Publish it   ramplab publish ${outPath}`);
  out(`  Bundle it    ramplab export ${outPath} --static ./site`);
  return 0;
}

/**
 * Where an edition lands when nobody said.
 *
 * The default used to be `spec.json` for every press, which is not a name so
 * much as a collision waiting to happen: the second repo anyone pressed
 * silently destroyed the first edition, an hour of wall clock and around $25
 * of tokens, with nothing on screen to say so. The repository already has a
 * name and it is the one thing that distinguishes one edition from another.
 */
export function defaultOutName(repo: string): string {
  const check = validateRepoUrl(repo);
  const raw = check.ok
    ? (check.repoKey.split('/').pop() ?? check.repoKey)
    : basename(resolve(repo));
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug.length > 0 ? slug : 'lab'}.json`;
}

/**
 * The first name near `desired` that is not already taken. Stepping past an
 * existing file is the only safe move at the end of a press: the edition has
 * been paid for by the time anyone knows the name is contested, so refusing
 * to write would throw away the very thing the hour bought.
 */
export function freeOutPath(desired: string, exists: (path: string) => boolean): string {
  if (!exists(desired)) return desired;
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : '';
  for (let n = 2; n <= 999; n++) {
    const candidate = `${stem}-${n}${ext}`;
    if (!exists(candidate)) return candidate;
  }
  return `${stem}-${999}${ext}`;
}

/** `spec.json` → `spec.drops.json`, alongside the edition it describes. */
export function dropsPathFor(specPath: string): string {
  return specPath.endsWith('.json')
    ? `${specPath.slice(0, -'.json'.length)}.drops.json`
    : `${specPath}.drops.json`;
}

/**
 * Prose the models wrote without citing anything, told to the person who just
 * spent an hour pressing their own repository.
 *
 * The first version of this reported `map · systemMap.edges[2].label` and a
 * sentence about "the shape it sat on". That is written for whoever tunes the
 * map prompt — which is a real reader, and not this one. Someone pressing
 * supabase cannot act on a payload coordinate, does not share the vocabulary,
 * and has exactly one lever anyway, which is to press again. So they get one
 * sentence in their own terms: what is missing, and that the edition is
 * otherwise whole.
 *
 * The detail is not thrown away, because it is how anyone notices that
 * supabase lost five consecutive edge labels and that the map prompt is the
 * thing to fix. It goes in a sidecar next to the spec, named only when it
 * exists.
 *
 * Failing to write the sidecar is a warning, never a failure. The edition is
 * already on disk and is the thing worth an hour; losing the run over its
 * footnote would be absurd.
 */
async function reportProseDrops(
  drops: ProseDrop[],
  specPath: string,
  io: { out: (line: string) => void; err: (line: string) => void },
): Promise<void> {
  if (drops.length === 0) return;

  const dropsPath = dropsPathFor(specPath);
  let wrote = true;
  try {
    await writeFile(
      dropsPath,
      `${JSON.stringify({ spec: specPath, count: drops.length, drops }, null, 2)}\n`,
      'utf8',
    );
  } catch (cause) {
    wrote = false;
    io.err(`(could not write ${dropsPath}: ${(cause as Error).message})`);
  }

  const what = drops.length === 1 ? 'diagram label was' : 'diagram labels were';
  io.out('');
  io.out(`Note: ${drops.length} ${what} left out because the models could not point`);
  io.out('them at specific code. Your chapters and diagrams are otherwise complete.');
  // Its own line: an absolute --out path makes an appended parenthetical wrap
  // into nonsense, and this one is only useful to whoever goes looking.
  if (wrote) io.out(`Details: ${dropsPath}`);
}

/**
 * What a press that did not finish leaves behind.
 *
 * Every `spec-updated` snapshot is complete, schema-valid and anchor-resolved,
 * so the chapters that landed are a real edition rather than a fragment. After
 * twenty minutes and real money, handing that back beats handing back nothing.
 *
 * It is not only for ctrl-c. A press can die on a stage error, a turn cap or a
 * dropped connection (#177), and none of those make the chapters already
 * written any worse — but the failure path used to discard them while holding
 * a perfectly good edition in memory.
 *
 * The one thing this must not do is let it pass for a finished pressing. A
 * truncated edition verifies perfectly well at the claim page, because the
 * anchors it does carry are honest, so if the output is vague about it
 * somebody publishes half a book without knowing. Hence the wording, and hence
 * the exit codes: 130 is what a shell reads as interrupted, and a press that
 * fell over is still a failure.
 */
async function savePartial(
  spec: GenerateLabResult['spec'],
  options: GenerateOptions & { out: string },
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    exists: (path: string) => boolean;
    interrupted: boolean;
  },
): Promise<number> {
  const code = io.interrupted ? 130 : 1;
  const how = io.interrupted ? 'Interrupted' : 'Stopped early';
  const chapters = spec.base.modules.length;
  const outPath = freeOutPath(options.out, io.exists);
  try {
    await writeFile(outPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  } catch (cause) {
    io.err(`${how}, and could not write ${outPath}: ${(cause as Error).message}`);
    return code;
  }
  io.out('');
  io.out(`${how}. Wrote the ${chapters} chapter${chapters === 1 ? '' : 's'} that had landed`);
  io.out(`to ${outPath}. This is a PARTIAL edition: it is readable and every`);
  io.out('claim in it is checked, but it is not the whole book that was planned.');
  io.out('Press again to get the rest.');
  return code;
}
