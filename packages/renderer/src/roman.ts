/**
 * Roman numerals for book furniture (chapter numbers, figure labels,
 * appendix references). Operated UI (step bubbles, quiz keys) stays arabic —
 * the Edition register rule from research.md §4.4.
 */
const NUMERALS: readonly [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(value: number): string {
  if (!Number.isFinite(value) || value < 1) return String(value);
  let remaining = Math.floor(value);
  let out = '';
  for (const [step, glyph] of NUMERALS) {
    while (remaining >= step) {
      out += glyph;
      remaining -= step;
    }
  }
  return out;
}
