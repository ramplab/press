import type { CalloutKind, OverlayCalloutWidget } from '@ramplab/spec';
import { AnchorChip } from './AnchorChip.js';
import { InlineProse } from './InlineProse.js';
import styles from './Callout.module.css';

/** Sans kicker per kind — typographic apparatus, no icons (Edition). */
const KIND_LABELS: Record<CalloutKind, string> = {
  why: 'Why',
  warning: 'Take care',
  'connects-to': 'Connects',
};

export interface CalloutProps {
  widget: OverlayCalloutWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
}

/**
 * Editorial note in the reading flow (Edition): a sidenote-style aside with a
 * hairline rule and a sans kicker naming its kind; the body is the author's
 * serif voice. Anchors stay mono — provenance apparatus.
 */
export function Callout({ widget, origin = 'base' }: CalloutProps) {
  return (
    <aside
      className={styles.callout}
      data-widget="callout"
      data-kind={widget.kind}
      data-origin={origin}
    >
      <span className={styles.kicker}>
        {KIND_LABELS[widget.kind]}
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
      </span>
      <p className={styles.body}>
        {widget.title !== undefined && <b className={styles.title}>{widget.title}: </b>}
        <InlineProse text={widget.body} />
      </p>
      {widget.anchors !== undefined && widget.anchors.length > 0 && (
        <span className={styles.anchors}>
          {widget.anchors.map((anchor, index) => (
            <AnchorChip key={index} anchor={anchor} className={styles.anchor} />
          ))}
        </span>
      )}
    </aside>
  );
}
