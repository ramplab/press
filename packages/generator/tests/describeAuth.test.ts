import { describe, expect, it } from 'vitest';
import { describeAuth } from '../src/agentSdkRunner.js';

/**
 * Which credential a live run spends is a money question, so it is pinned:
 * the API key wins when present (the CLI's own precedence), everything else
 * falls through to the Claude Code login, and only the key path may claim the
 * run is billed to the API account.
 */
describe('describeAuth', () => {
  it('takes the API key when one is set', () => {
    const auth = describeAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(auth.mode).toBe('api-key');
    expect(auth.billedToApiAccount).toBe(true);
  });

  it('falls through to the Claude Code credential when no key is set', () => {
    const auth = describeAuth({});
    expect(auth.mode).toBe('claude-code');
    expect(auth.billedToApiAccount).toBe(false);
  });

  it('treats an empty key as no key — an exported blank must not look billed', () => {
    const auth = describeAuth({ ANTHROPIC_API_KEY: '' });
    expect(auth.mode).toBe('claude-code');
    expect(auth.billedToApiAccount).toBe(false);
  });

  it('labels both modes well enough to read in a run banner', () => {
    expect(describeAuth({ ANTHROPIC_API_KEY: 'sk-ant-test' }).label).toContain(
      'ANTHROPIC_API_KEY',
    );
    expect(describeAuth({}).label).toContain('Claude Code credential');
  });
});
