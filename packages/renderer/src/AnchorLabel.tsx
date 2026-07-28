import type { Anchor } from '@ramplab/spec';
import styles from './AnchorLabel.module.css';

/**
 * Canonical text form of a code anchor: `file · symbol :start–end`.
 * Shared by every widget that surfaces anchor provenance.
 */
export function AnchorLabel({ anchor }: { anchor: Anchor }) {
  return (
    <>
      {anchor.file}
      {anchor.symbol !== undefined && <> · {anchor.symbol}</>}
      {anchor.lines !== undefined && (
        <span className={styles.lines}>
          {' '}
          :{anchor.lines.start}–{anchor.lines.end}
        </span>
      )}
    </>
  );
}
