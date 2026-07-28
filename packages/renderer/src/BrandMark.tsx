/**
 * The RampLab mark — a bound edition: the spine bar printed in the accent,
 * cover and heading line in the current ink, body lines in the lighter rule
 * (identity sheet "The Bound Edition", Issue 01 · Sheet A). Colors ride the
 * Edition tokens and `currentColor`, so the mark reprints correctly in both
 * themes and can be tinted by its parent's `color`.
 */
export interface BrandMarkProps {
  /** Rendered width/height in px (the mark is square). */
  size?: number;
  className?: string;
}

export function BrandMark({ size = 24, className }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="34" y="23" width="12" height="74" fill="var(--accent, #88422e)" />
      <rect
        x="33"
        y="22"
        width="54"
        height="76"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="5.5"
      />
      <path d="M45 22 V98" stroke="currentColor" strokeWidth="4" />
      <line x1="56" y1="42" x2="78" y2="42" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
      <line x1="56" y1="55" x2="78" y2="55" stroke="var(--rule2, #cbc1a9)" strokeWidth="4.5" strokeLinecap="round" />
      <line x1="56" y1="68" x2="72" y2="68" stroke="var(--rule2, #cbc1a9)" strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}
