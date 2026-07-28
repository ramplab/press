import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliVersion } from '../src/version.js';

/**
 * "Which version are you on" is the first question of every bug report, and
 * until 1.0.1 the tool could not answer it.
 */

describe('cliVersion', () => {
  it('is the version the package actually publishes under', () => {
    // Read independently rather than through the same code path, so this
    // disagrees if the two ever drift.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    expect(cliVersion()).toBe(manifest.version);
  });

  it('looks like a version', () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
