import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { measureRepo, plannedModulesFor } from '../src/repoSize.js';

describe('plannedModulesFor', () => {
  it('tiers by whichever measure clears first', () => {
    expect(plannedModulesFor({ files: 10, bytes: 50_000 })).toBe(4);
    expect(plannedModulesFor({ files: 60, bytes: 100_000 })).toBe(5);
    expect(plannedModulesFor({ files: 10, bytes: 400_000 })).toBe(5); // bytes clear the tier
    expect(plannedModulesFor({ files: 300, bytes: 500_000 })).toBe(6);
    expect(plannedModulesFor({ files: 2_000, bytes: 500_000 })).toBe(7);
    expect(plannedModulesFor({ files: 100, bytes: 20_000_000 })).toBe(7);
  });
});

describe('measureRepo', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('counts source files and skips vendored trees and binaries', () => {
    dir = mkdtempSync(join(tmpdir(), 'reposize-'));
    writeFileSync(join(dir, 'a.ts'), 'x'.repeat(100));
    writeFileSync(join(dir, 'b.md'), 'y'.repeat(50));
    writeFileSync(join(dir, 'logo.png'), Buffer.alloc(5000));
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'z'.repeat(9000));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'c.ts'), 'w'.repeat(200));
    const stats = measureRepo(dir);
    expect(stats.files).toBe(3); // a.ts, b.md, src/c.ts
    expect(stats.bytes).toBe(350);
  });

  it('an unreadable or empty directory measures as the smallest repo', () => {
    dir = mkdtempSync(join(tmpdir(), 'reposize-'));
    expect(measureRepo(join(dir, 'missing'))).toEqual({ files: 0, bytes: 0 });
    expect(plannedModulesFor(measureRepo(dir))).toBe(4);
  });
});
