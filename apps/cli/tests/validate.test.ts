import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runValidate } from '../src/commands/validate.js';

/** The canonical golden lab spec — a known-valid full spec. */
const GOLDEN = fileURLToPath(
  new URL('../../../packages/spec/tests/fixtures/golden.json', import.meta.url),
);

async function withTmpFile(contents: string, fn: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ramplab-validate-'));
  try {
    const path = join(dir, 'spec.json');
    await writeFile(path, contents, 'utf8');
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runValidate', () => {
  it('accepts a valid lab spec and reports the module count', async () => {
    const lines: string[] = [];
    const code = await runValidate(GOLDEN, {
      stdout: (l) => lines.push(l),
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/valid lab spec \(9 modules\)/);
  });

  it('rejects a file that is not valid JSON', async () => {
    await withTmpFile('{ not json', async (path) => {
      const errs: string[] = [];
      const code = await runValidate(path, { stdout: () => {}, stderr: (l) => errs.push(l) });
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('not valid JSON');
    });
  });

  it('rejects valid JSON that is not a lab spec', async () => {
    await withTmpFile('{"hello":"world"}', async (path) => {
      const errs: string[] = [];
      const code = await runValidate(path, { stdout: () => {}, stderr: (l) => errs.push(l) });
      expect(code).toBe(1);
      expect(errs.join('\n')).toContain('not a valid lab spec');
    });
  });

  it('reports a missing file rather than throwing', async () => {
    const errs: string[] = [];
    const code = await runValidate('/no/such/spec.json', {
      stdout: () => {},
      stderr: (l) => errs.push(l),
    });
    expect(code).toBe(1);
    expect(errs.join('\n')).toContain('Cannot read');
  });
});
