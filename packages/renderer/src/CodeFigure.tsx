import { useEffect, useState } from 'react';
import type { Anchor, OverlayCodeFigureWidget } from '@ramplab/spec';
import { CodeBlock } from './CodeBlock.js';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './CodeFigure.module.css';

export interface CodeFigureProps {
  widget: OverlayCodeFigureWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Book-furniture figure number, e.g. "Figure II" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
}

/**
 * A code excerpt as a produced, captioned plate (Edition): every line at full
 * strength, the spec's highlight range marked with the wash + bar, a
 * small-caps FIGURE label and an italic serif caption. The copy control and
 * source attribution are quiet sans machinery.
 */
export function CodeFigure({ widget, origin = 'base', figureLabel, onAnchorClick }: CodeFigureProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);

  const onCopy = () => {
    void navigator.clipboard?.writeText(widget.code.join('\n')).catch(() => undefined);
    setCopied(true);
  };

  return (
    <figure className={styles.figure} data-widget="code-figure" data-origin={origin}>
      <div className={styles.codeCard}>
        <CodeBlock
          code={widget.code}
          file={widget.source?.file}
          gutterStart={widget.source?.lines?.start ?? 1}
          highlight={widget.highlight}
        />
      </div>
      <div className={styles.plateFoot}>
        {widget.source !== undefined && (
          <span className={styles.source}>
            <code className={styles.path}>{widget.source.file}</code>
            {widget.source.lines !== undefined && (
              <span className={styles.sourceLines}>
                {' '}
                · lines {widget.source.lines.start}–{widget.source.lines.end}
              </span>
            )}
          </span>
        )}
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
        <button type="button" className={styles.copy} onClick={onCopy}>
          {copied ? 'copied ✓' : 'copy'}
        </button>
      </div>
      <figcaption className={styles.caption}>
        {figureLabel !== undefined && (
          <span className={styles.figureNumber}>{figureLabel} · </span>
        )}
        <InlineProse text={widget.caption.body} />
        {widget.caption.anchors !== undefined && widget.caption.anchors.length > 0 && (
          <span className={styles.anchors}>
            {widget.caption.anchors.map((anchor, index) => (
              <AnchorChip
                key={index}
                anchor={anchor}
                className={styles.anchor}
                onAnchorClick={onAnchorClick}
              />
            ))}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
