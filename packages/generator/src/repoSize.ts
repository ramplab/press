import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Right-sizing the curriculum to the repository (founder, 2026-07-14): every
 * edition was exactly the module cap because a budget reads as a quota to the
 * planner, so a thousand-line game and a hundred-thousand-line monorepo got
 * identical spines. The plan budget now scales with what the clone actually
 * holds. Mechanical and cheap: one directory walk, no model involved.
 */

export interface RepoSizeStats {
  /** Source-ish files counted (binaries and vendored trees skipped). */
  files: number;
  /** Their summed size in bytes. */
  bytes: number;
}

/** Directories that say nothing about how much there is to TEACH. */
const SKIPPED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  'coverage',
]);

/** Extensions that are clearly not teachable source. */
const SKIPPED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.ogg', '.wav', '.webm',
  '.zip', '.gz', '.tar', '.jar', '.wasm',
  '.lock', '.min.js', '.map', '.pdf',
]);

export function measureRepo(dir: string): RepoSizeStats {
  const stats: RepoSizeStats = { files: 0, bytes: 0 };
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory: not teachable either
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name.toLowerCase();
      const ext = name.slice(name.lastIndexOf('.'));
      if (SKIPPED_EXTENSIONS.has(ext) || name.endsWith('.min.js')) continue;
      try {
        stats.files += 1;
        stats.bytes += statSync(join(current, entry.name)).size;
      } catch {
        stats.files -= 0; // stat raced a deletion: skip silently
      }
    }
  };
  walk(dir);
  return stats;
}

/**
 * Planned (authored) modules for a repo of this size. The assembled edition
 * adds the overview module on top, so the reader sees one more chapter than
 * this number: tiers 4/5/6/7 read as editions of 5/6/7/8 chapters. A tier is
 * taken when EITHER measure clears it; both file count and volume signal
 * teachable surface.
 */
export function plannedModulesFor(stats: RepoSizeStats): number {
  const tier = (files: number, bytes: number): boolean =>
    stats.files >= files || stats.bytes >= bytes;
  if (tier(900, 8_000_000)) return 7;
  if (tier(200, 1_500_000)) return 6;
  if (tier(40, 300_000)) return 5;
  return 4;
}
