// Anchor permalinks from repo provenance (parsing itself is covered at the
// spec seam — packages/spec/tests/provenance.test.ts).
import { describe, expect, it } from 'vitest';
import { anchorHrefBuilder } from '../src/sourceLink.js';

describe('anchorHrefBuilder', () => {
  it('builds HEAD permalinks with encoded paths and line ranges', () => {
    const href = anchorHrefBuilder('owner/repo');
    expect(href?.({ file: 'src/a b/c.ts', symbol: 'x', lines: { start: 3, end: 9 } })).toBe(
      'https://github.com/owner/repo/blob/HEAD/src/a%20b/c.ts#L3-L9',
    );
  });

  it('returns undefined for unknown provenance', () => {
    expect(anchorHrefBuilder('not a repo')).toBeUndefined();
  });
});
