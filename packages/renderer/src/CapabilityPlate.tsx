import type { OverlayCalloutWidget } from '@ramplab/spec';
import { AnchorChip } from './AnchorChip.js';
import { InlineProse } from './InlineProse.js';
import styles from './CapabilityPlate.module.css';

export interface CapabilityPlateProps {
  widget: OverlayCalloutWidget;
  origin?: 'base' | 'overlay';
}

/**
 * The end-of-chapter capability plate: the module's closing "what you can now
 * do" callout, set between double rules like a produced plate (research.md
 * §4.4). Same spec content as a callout — the Lab picks which callout gets
 * the plate treatment (the last one before the chapter's checkpoint).
 */
export function CapabilityPlate({ widget, origin = 'base' }: CapabilityPlateProps) {
  return (
    <aside
      className={styles.plate}
      data-widget="callout"
      data-kind={widget.kind}
      data-origin={origin}
      data-plate="true"
    >
      <span className={styles.kicker}>{widget.title ?? 'What you can now do'}</span>
      <p className={styles.body}>
        <InlineProse text={widget.body} />
      </p>
      {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
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
