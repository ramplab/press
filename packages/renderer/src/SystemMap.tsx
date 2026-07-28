import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Anchor, SystemMapWidget } from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import { NODE_H, V_GAP, layoutMap, type PlacedNode } from './systemMapLayout.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './SystemMap.module.css';

/*
 * The system map, rebuilt for #22 (root fix for the label-overlap bug).
 *
 * Layout comes from the shared engine (`systemMapLayout.ts`) — the single
 * source of truth the Atlas Codex hero (#26) also lays its cover map out
 * with. Nodes are HTML boxes, not SVG text: labels wrap to two lines and
 * ellipsize inside a box sized from the available row width, so labels can
 * never overlap by construction. Edge labels never float free — they live in
 * the annotation card (research.md §2.3).
 *
 * Node detail is an annotation card AT the node (§4.6): it opens into the
 * emptier side (left-half nodes open right, vice versa), flips when
 * clipped, falls back below/above, and docks as a bottom plate ≤700px.
 * Dismiss: ×, Esc, click-away; selecting another node moves the card. The
 * card takes focus on open and returns it to the node on Esc/dismiss.
 */

const CARD_GAP = 12;
const FALLBACK_WIDTH = 960;

/**
 * Edge path between placed nodes: down the page for forward edges, along the
 * row for siblings, a side loop for backward edges, a small arc for selves.
 */
function edgePath(a: PlacedNode, b: PlacedNode, width: number): string {
  const ax = a.x + a.w / 2;
  const bx = b.x + b.w / 2;
  if (a.node.id === b.node.id) {
    const x = a.x + a.w;
    const y = a.y + NODE_H / 2;
    return `M${x},${y - 10} C${x + 34},${y - 22} ${x + 34},${y + 22} ${x},${y + 10}`;
  }
  if (b.y > a.y) {
    const y1 = a.y + NODE_H;
    const y2 = b.y - 5;
    return `M${ax},${y1} C${ax},${y1 + V_GAP * 0.45} ${bx},${y2 - V_GAP * 0.45} ${bx},${y2}`;
  }
  if (b.y === a.y) {
    const aIsLeft = a.x <= b.x;
    const x1 = aIsLeft ? a.x + a.w : a.x;
    const x2 = aIsLeft ? b.x - 5 : b.x + b.w + 5;
    const y = a.y + NODE_H / 2;
    const dir = aIsLeft ? 1 : -1;
    return `M${x1},${y} C${x1 + 20 * dir},${y - 18} ${x2 - 20 * dir},${y - 18} ${x2},${y}`;
  }
  // Backward (upward): loop around whichever side is emptier.
  const useRight = (ax + bx) / 2 >= width / 2;
  const x1 = useRight ? a.x + a.w : a.x;
  const x2 = useRight ? b.x + b.w + 5 : b.x - 5;
  const bulge = useRight ? Math.max(x1, x2) + 40 : Math.min(x1, x2) - 40;
  const y1 = a.y + NODE_H / 2;
  const y2 = b.y + NODE_H / 2;
  return `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x2},${y2}`;
}

/** Keep the tail of a long anchor path — the end is the informative part. */
function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-(max - 1))}`;
}

export interface SystemMapProps {
  widget: SystemMapWidget;
  /** Book-furniture figure number, e.g. "Figure I" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Invoked when an anchor chip in the annotation card is clicked. */
  onAnchorClick?: (anchor: Anchor) => void;
}

interface CardPlacement {
  left: number;
  top: number;
}

export function SystemMap({ widget, figureLabel, onAnchorClick }: SystemMapProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [selectedId, setSelectedId] = useState<string>();
  const [docked, setDocked] = useState(false);
  const [cardPos, setCardPos] = useState<CardPlacement | undefined>(undefined);

  // Measure the canvas; re-layout on container resize.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const measure = () => {
      const next = canvas.clientWidth;
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // ≤700px the card docks as a bottom plate (research.md §4.6).
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const query = matchMedia('(max-width: 700px)');
    const apply = () => setDocked(query.matches);
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, []);

  const layout = useMemo(() => layoutMap(widget, width), [widget, width]);

  const selected =
    selectedId === undefined ? undefined : widget.nodes.find((node) => node.id === selectedId);
  const connections =
    selected === undefined
      ? []
      : widget.edges.filter((edge) => edge.from === selected.id || edge.to === selected.id);

  const close = useCallback((refocusNode: boolean) => {
    setSelectedId((current) => {
      if (refocusNode && current !== undefined) {
        const el = rootRef.current?.querySelector(`[data-map-node="${current}"]`);
        (el as HTMLElement | null)?.focus?.();
      }
      return undefined;
    });
    setCardPos(undefined);
  }, []);

  // Esc and click-away dismiss the card (and clear the path lighting).
  useEffect(() => {
    if (selectedId === undefined) return undefined;
    const onDocKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const onDocClick = (event: globalThis.MouseEvent) => {
      const target = event.target as Element | null;
      if (target === null) return;
      if (target.closest('[data-map-node]') !== null) return;
      if (target.closest('[data-map-card]') !== null) return;
      close(false);
    };
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('click', onDocClick);
    return () => {
      document.removeEventListener('keydown', onDocKey);
      document.removeEventListener('click', onDocClick);
    };
  }, [selectedId, close]);

  // Place the annotation card beside its node: emptier side first, flip
  // fallbacks, below/above as last resort, clamped to the plate. Runs after
  // render so the card's real size is known. Docked mode needs no placement.
  useLayoutEffect(() => {
    if (selectedId === undefined || docked) return;
    const placedNode = layout.byId.get(selectedId);
    const card = cardRef.current;
    if (placedNode === undefined || card === null) return;
    const cardW = card.offsetWidth || 300;
    const cardH = card.offsetHeight || 180;
    const { x, y, w } = placedNode;
    const plateW = layout.width;
    const plateH = layout.height;
    let left: number;
    let top = y;
    const fitsRight = x + w + CARD_GAP + cardW <= plateW;
    const fitsLeft = x - CARD_GAP - cardW >= 0;
    const preferRight = x + w / 2 < plateW / 2;
    if (preferRight && fitsRight) left = x + w + CARD_GAP;
    else if (!preferRight && fitsLeft) left = x - CARD_GAP - cardW;
    else if (fitsRight) left = x + w + CARD_GAP;
    else if (fitsLeft) left = x - CARD_GAP - cardW;
    else {
      // Stack below (or above when the bottom would clip).
      left = Math.max(0, Math.min(x, plateW - cardW));
      top = y + NODE_H + CARD_GAP;
      if (top + cardH > plateH + 60 && y - CARD_GAP - cardH >= 0) top = y - CARD_GAP - cardH;
    }
    top = Math.max(0, Math.min(top, Math.max(0, plateH + 60 - cardH)));
    setCardPos({ left, top });
  }, [selectedId, docked, layout]);

  // Focus the card on open so its contents are keyboard-reachable.
  useEffect(() => {
    if (selectedId === undefined) return;
    cardRef.current?.focus?.();
  }, [selectedId]);

  const onNodeKeyDown = (event: KeyboardEvent, nodeId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(nodeId);
    }
  };

  const labelOf = (nodeId: string) => layout.byId.get(nodeId)?.node.label ?? nodeId;

  const card =
    selected === undefined ? null : (
      <aside
        ref={cardRef}
        data-map-card="true"
        role="dialog"
        aria-label={selected.label}
        tabIndex={-1}
        className={docked ? `${styles.card} ${styles.cardDocked}` : styles.card}
        style={
          docked
            ? undefined
            : {
                left: cardPos?.left ?? 0,
                top: cardPos?.top ?? 0,
                visibility: cardPos === undefined ? 'hidden' : undefined,
              }
        }
      >
        <div className={styles.cardHead}>
          <span className={styles.cardLabel}>{selected.label}</span>
          <button
            type="button"
            className={styles.cardDismiss}
            aria-label="Dismiss"
            onClick={() => close(true)}
          >
            ×
          </button>
        </div>
        {selected.description !== undefined && (
          <p className={styles.cardDescription}>
            <InlineProse text={selected.description} />
          </p>
        )}
        {selected.anchors !== undefined && selected.anchors.length > 0 && (
          <span className={styles.cardAnchors}>
            {selected.anchors.map((anchor, index) => (
              <AnchorChip
                key={index}
                anchor={anchor}
                className={styles.anchorChip}
                onAnchorClick={onAnchorClick}
              />
            ))}
          </span>
        )}
        {connections.length > 0 && (
          <ul className={styles.connections}>
            {connections.map((edge, index) => (
              <li key={index} className={styles.connection}>
                <span className={styles.direction} aria-hidden="true">
                  {edge.from === selected.id ? '→' : '←'}
                </span>{' '}
                <b>{labelOf(edge.from === selected.id ? edge.to : edge.from)}</b>
                {edge.label !== undefined && (
                  <>: <InlineProse text={edge.label} /></>
                )}
                {edge.anchors !== undefined && edge.anchors.length > 0 && (
                  <span className={styles.cardAnchors}>
                    {edge.anchors.map((anchor, anchorIndex) => (
                      <AnchorChip
                        key={anchorIndex}
                        anchor={anchor}
                        className={styles.anchorChip}
                        onAnchorClick={onAnchorClick}
                      />
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>
    );

  return (
    <figure className={styles.figure} data-widget="system-map" ref={rootRef}>
      <div className={styles.panelHead}>
        <span className={styles.panelTitle}>{widget.title ?? 'System map'}</span>
      </div>
      <div className={styles.canvas} ref={canvasRef} style={{ height: layout.height }}>
        <svg
          className={styles.wires}
          width="100%"
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <marker
              id={`arrow-${widget.id}`}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0L10,5L0,10z" className={styles.arrowHead} />
            </marker>
            <marker
              id={`arrow-lit-${widget.id}`}
              viewBox="0 0 10 10"
              refX="8.5"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0L10,5L0,10z" className={styles.arrowHeadLit} />
            </marker>
          </defs>
          {widget.edges.map((edge, index) => {
            const from = layout.byId.get(edge.from);
            const to = layout.byId.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const lit =
              selected !== undefined && (edge.from === selected.id || edge.to === selected.id);
            return (
              <path
                key={`${edge.from}-${edge.to}-${index}`}
                className={styles.wire}
                data-lit={lit ? 'true' : undefined}
                d={edgePath(from, to, layout.width)}
                markerEnd={`url(#arrow${lit ? '-lit' : ''}-${widget.id})`}
              />
            );
          })}
        </svg>
        {layout.placed.map(({ node, x, y, w }) => {
          const anchorFile = node.anchors?.[0]?.file;
          return (
            <div
              key={node.id}
              data-map-node={node.id}
              className={styles.node}
              role="button"
              tabIndex={0}
              aria-label={node.label}
              aria-pressed={node.id === selectedId}
              data-selected={node.id === selectedId || undefined}
              style={{ left: x, top: y, width: w, height: NODE_H }}
              onClick={() => setSelectedId(node.id)}
              onKeyDown={(event) => onNodeKeyDown(event, node.id)}
            >
              <span className={styles.nodeLabel} title={node.label}>
                {node.label}
              </span>
              {anchorFile !== undefined && (
                <span className={styles.nodeAnchor}>{tail(anchorFile, 34)}</span>
              )}
            </div>
          );
        })}
        {!docked && card}
      </div>
      {docked && card}
      <figcaption className={styles.caption}>
        {figureLabel !== undefined && <span className={styles.figureNumber}>{figureLabel} · </span>}
        {selected === undefined ? (
          <span>
            Click a node to see what it does, where it lives in the code, and its labeled
            connections. The annotation opens beside it.
          </span>
        ) : (
          <span>{selected.label} is selected. Its connections are lit on the plate.</span>
        )}
      </figcaption>
    </figure>
  );
}
