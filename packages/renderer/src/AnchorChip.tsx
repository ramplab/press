import { createContext, useContext, type MouseEvent } from 'react';
import type { Anchor } from '@ramplab/spec';
import { AnchorLabel } from './AnchorLabel.js';
import styles from './AnchorChip.module.css';

/**
 * How the current surface turns an anchor into a source permalink. The Lab
 * provides one from `spec.repo` (see `anchorHrefBuilder`); a standalone
 * widget host may provide its own (e.g. a local-editor URL scheme). Without
 * a provider the chip has nowhere to send the reader.
 */
export const AnchorSourceContext = createContext<
  ((anchor: Anchor) => string | undefined) | undefined
>(undefined);

export interface AnchorChipProps {
  anchor: Anchor;
  /** The host widget's chip class, so every widget keeps its own look. */
  className?: string | undefined;
  onAnchorClick?: ((anchor: Anchor) => void) | undefined;
}

/**
 * One anchor chip that only affords what it can deliver: a real link when
 * the source permalink is known, the host's click handler when one is
 * wired, and otherwise an inert label. (Chips used to render as buttons
 * unconditionally — pointer cursor, no destination.)
 */
export function AnchorChip({ anchor, className, onAnchorClick }: AnchorChipProps) {
  const hrefFor = useContext(AnchorSourceContext);
  const href = hrefFor?.(anchor);
  const cls = (extra: string | undefined) =>
    [className, extra].filter((part): part is string => part !== undefined).join(' ');
  if (href !== undefined) {
    return (
      <a
        className={cls(styles.link)}
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(event: MouseEvent) => event.stopPropagation()}
      >
        <AnchorLabel anchor={anchor} />
      </a>
    );
  }
  if (onAnchorClick !== undefined) {
    return (
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          onAnchorClick(anchor);
        }}
      >
        <AnchorLabel anchor={anchor} />
      </button>
    );
  }
  return (
    <span className={cls(styles.inert)}>
      <AnchorLabel anchor={anchor} />
    </span>
  );
}
