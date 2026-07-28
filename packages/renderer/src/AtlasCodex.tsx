import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { SystemMapWidget } from '@ramplab/spec';
import { toRoman } from './roman.js';
import { H_GAP, MIN_NODE_W, NODE_H, layersOf, layoutMap } from './systemMapLayout.js';
import styles from './AtlasCodex.module.css';

/*
 * The Atlas Codex hero (issues #26/#27) — the catalog's signature object: an
 * orbitable bound *edition* of a real codebase, rendered with hand-rolled
 * CSS 3D (six faces on a perspective stage, no libraries). The front cover
 * etches the WHOLE codebase map faintly (the union of every module's system
 * map) and threads the BRIGHT lit journey — the flagship trace's order — as a
 * real subset of that map. The spine carries the lab's chapters in roman
 * numerals, and the page fore-edge threads the same journey as a lit seam.
 * Drag to orbit (mouse + touch), arrow keys to nudge; an idle auto-rotate
 * pauses on interaction. The lit journey nodes are real, focusable DOM with
 * rich labels — the path is keyboard- and AT-navigable; the faint full-map
 * nodes are decorative etching (the product thesis: map the whole codebase AND
 * light a path through it).
 *
 * The cover map's node positions come from the SHARED layout engine
 * (`systemMapLayout.ts`) — the exact code the in-lab SystemMap widget uses —
 * so the full map and the lit journey are laid out by one source of truth, and
 * the journey is a highlighted subset of the etched map, not a separate overlay.
 *
 * SSR / reduced motion: the first render (server and client) is a composed
 * STATIC edition — angled, full map etched, whole journey lit, no animation —
 * so the static catalog ships a poster that hydrates with zero layout shift.
 * After mount, when motion is allowed, the seam animates and (on a fine
 * pointer) the book idles; `prefers-reduced-motion` keeps the static edition.
 */

/**
 * The cover map is laid out in the shared engine's own coordinate space (wide
 * enough that the widest layer isn't split into single-node rows), then
 * normalised into this fixed etch width so the SVG's node/label sizes stay
 * constant across labs of different map densities. The SVG then scales to fill
 * the cover face.
 */
const ETCH_WIDTH = 240;
/** Vertical tilt clamp so the edition never flips (research.md §5). */
const TILT_CLAMP = 68;
const START_TILT = 12;
const START_TURN = -34;
/** Seconds the fully-lit seam holds before the journey replays. */
const SEAM_HOLD = 2.4;

export interface AtlasCodexProps {
  /** The featured edition's title, set on the cover. */
  title: string;
  /** Chapter count → roman-numeral bands on the spine (I…N). */
  chapters: number;
  /**
   * The whole codebase map — the union of every module's system map (real
   * nodes/edges from the spec). Etched faintly on the cover.
   */
  map: SystemMapWidget;
  /**
   * The lit journey: the flagship trace's node ids in order. A subset of
   * `map`'s node ids — the bright seam threaded through the etched full map.
   */
  journey: string[];
  /** The chapter the journey recaps, e.g. "Chapter I · End to end: …". */
  chapterLabel: string;
  /** Where the edition was set from, e.g. the spec path (cover imprint). */
  setFrom?: string | undefined;
  /** Link to open the featured edition (caption call-to-action). */
  href?: string | undefined;
}

interface Stop {
  id: string;
  label: string;
  role: string | undefined;
  anchor: string | undefined;
  index: number;
}

/**
 * Shorten a node label for the etched cover only (the full label stays in the
 * node's aria-label and the interaction detail card). Keeps the dense maps'
 * labels from colliding — the cover text is decorative.
 */
function coverLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15).trimEnd()}…` : label;
}

/* ---- cover-label collision handling ---------------------------------------
 * On denser union maps (calcom, excalidraw) several journey stops land close
 * together and their etched labels pile into an unreadable cluster. We place
 * labels GREEDILY in journey (reading) order and skip any whose box would
 * overlap a label already placed — the skipped stop keeps its dot and its full
 * text stays in the node's aria-label / <title> and the hover detail card, so
 * nothing is lost, only the decorative cover text is thinned to stay legible.
 * The geometry is a pure function of the (already truncated) label text and the
 * node's centre in the etch's viewBox coordinates, so it runs identically on
 * the server and the client and is unit-testable without a real DOM. */

/** SVG `font-size` of a cover label (matches `.spot text` in the CSS). */
const LABEL_FONT = 7.2;
/** Average glyph advance as a fraction of the font size (UI font, mixed case). */
const LABEL_CHAR_W = 0.58;
/** Gap between a node's dot and its label — matches the `x` offset at render. */
const LABEL_GAP = 12;
/** Slack padded around each label box so near-touching labels also cull. */
const LABEL_PAD = 1.4;

export interface LabelInput {
  id: string;
  /** Node centre in etch viewBox units. */
  cx: number;
  cy: number;
  /** The already-truncated cover text. */
  text: string;
}

export interface LabelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The bounding box a cover label occupies, in etch viewBox units. Labels for
 * nodes on the cover's right half read leftward (`text-anchor: end`), left-half
 * nodes read rightward, so the box hangs off the correct side of the dot — the
 * same anchoring the render uses to keep labels off the cover edge.
 */
export function coverLabelRect(input: LabelInput, etchWidth: number): LabelRect {
  const width = input.text.length * LABEL_FONT * LABEL_CHAR_W;
  const anchorLeft = input.cx > etchWidth / 2;
  const startX = anchorLeft ? input.cx - LABEL_GAP - width : input.cx + LABEL_GAP;
  const baseline = input.cy + 2.6;
  return {
    x0: startX - LABEL_PAD,
    x1: startX + width + LABEL_PAD,
    y0: baseline - LABEL_FONT * 0.8 - LABEL_PAD,
    y1: baseline + LABEL_FONT * 0.25 + LABEL_PAD,
  };
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * The cover-label placement inputs for a map + journey, in journey (priority)
 * order: each journey node's centre in the etch's viewBox coordinates plus its
 * truncated cover text. Lays the whole map out with the SAME shared engine and
 * normalisation the cover render uses, so the culling decision matches exactly
 * what is drawn. Exported so the zero-overlap guarantee is unit-testable for
 * every lab's real map — including labs (e.g. calcom) that never reach the hero.
 */
export function coverLabelInputs(
  map: SystemMapWidget,
  journey: readonly string[],
  etchWidth: number,
): LabelInput[] {
  const widestLayer = layersOf(map).reduce((mx, row) => Math.max(mx, row.length), 1);
  const engineWidth = widestLayer * (MIN_NODE_W + H_GAP) - H_GAP;
  const layout = layoutMap(map, engineWidth);
  const scale = etchWidth / layout.width;
  const inputs: LabelInput[] = [];
  for (const id of journey) {
    const placed = layout.byId.get(id);
    if (placed === undefined) continue;
    const node = map.nodes.find((candidate) => candidate.id === id);
    inputs.push({
      id,
      cx: (placed.x + placed.w / 2) * scale,
      cy: (placed.y + NODE_H / 2) * scale,
      text: coverLabel(node?.label ?? id),
    });
  }
  return inputs;
}

/**
 * Greedily choose which cover labels to render: walk the stops in journey
 * order (highest priority first) and keep a label only if its box clears every
 * label already kept. Returns the set of ids whose label is shown; the rest
 * render as a bare dot. Guarantees zero label overlap on the cover at real map
 * density, for every lab.
 */
export function visibleCoverLabels(inputs: readonly LabelInput[], etchWidth: number): Set<string> {
  const placed: LabelRect[] = [];
  const shown = new Set<string>();
  for (const input of inputs) {
    const rect = coverLabelRect(input, etchWidth);
    if (placed.some((other) => rectsOverlap(rect, other))) continue;
    placed.push(rect);
    shown.add(input.id);
  }
  return shown;
}

/** Format a node's first anchor as `file · symbol` for the detail card. */
function anchorText(map: SystemMapWidget, nodeId: string): string | undefined {
  const anchor = map.nodes.find((node) => node.id === nodeId)?.anchors?.[0];
  if (anchor === undefined) return undefined;
  return anchor.symbol !== undefined ? `${anchor.file} · ${anchor.symbol}` : anchor.file;
}

export function AtlasCodex({
  title,
  chapters,
  map,
  journey,
  chapterLabel,
  setFrom,
  href,
}: AtlasCodexProps) {
  // The journey (lit) is the flagship trace order, restricted to nodes that
  // actually landed in the union layout — degrade gracefully if a trace id is
  // somehow absent (it shouldn't be: the trace map is one of the unioned maps).
  const order = useMemo(
    () => journey.filter((id) => map.nodes.some((node) => node.id === id)),
    [journey, map],
  );
  const journeySet = useMemo(() => new Set(order), [order]);
  // Lay the whole map out in the shared engine's coordinate space, wide enough
  // that the widest layer keeps its nodes side-by-side (never split into a tall
  // single-node column), then normalise into the fixed etch width.
  const layout = useMemo(() => {
    const widestLayer = layersOf(map).reduce((max, row) => Math.max(max, row.length), 1);
    const engineWidth = widestLayer * (MIN_NODE_W + H_GAP) - H_GAP;
    return layoutMap(map, engineWidth);
  }, [map]);
  const scale = ETCH_WIDTH / layout.width;
  const etchHeight = layout.height * scale;
  const nodeCenter = useCallback(
    (id: string): { x: number; y: number } | undefined => {
      const placed = layout.byId.get(id);
      if (placed === undefined) return undefined;
      return { x: (placed.x + placed.w / 2) * scale, y: (placed.y + NODE_H / 2) * scale };
    },
    [layout, scale],
  );
  const orderIndex = useMemo(
    () => new Map(order.map((id, index) => [id, index])),
    [order],
  );
  const stops = useMemo<Stop[]>(
    () =>
      order.map((id, index) => {
        const node = map.nodes.find((candidate) => candidate.id === id);
        return {
          id,
          label: node?.label ?? id,
          role: node?.description,
          anchor: anchorText(map, id),
          index,
        };
      }),
    [order, map],
  );
  const stopById = useMemo(() => new Map(stops.map((stop) => [stop.id, stop])), [stops]);

  // Which journey stops get an etched cover label: greedy, journey order first,
  // skipping any whose box would overlap a label already placed (see
  // `visibleCoverLabels`). Skipped stops keep their dot and their full text in
  // the aria-label / detail card, so no readable label ever overlaps another.
  const labeledStops = useMemo(
    () => visibleCoverLabels(coverLabelInputs(map, order, ETCH_WIDTH), ETCH_WIDTH),
    [map, order],
  );

  // The whole journey renders lit on the server and on the first client pass
  // (the poster). After mount the animation may reset this to 0 and replay.
  const [litCount, setLitCount] = useState(order.length);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [hoverId, setHoverId] = useState<string | undefined>(undefined);

  const sceneRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<HTMLDivElement | null>(null);
  const rotXRef = useRef(START_TILT);
  const rotYRef = useRef(START_TURN);
  const draggingRef = useRef(false);
  const pausedUntilRef = useRef(0);
  const lastRef = useRef({ x: 0, y: 0 });

  const applyTransform = useCallback(() => {
    const book = bookRef.current;
    if (book === null) return;
    book.style.transform = `rotateX(${rotXRef.current}deg) rotateY(${rotYRef.current}deg)`;
  }, []);

  const pauseAuto = useCallback(() => {
    pausedUntilRef.current = (typeof performance !== 'undefined' ? performance.now() : Date.now()) +
      3400;
  }, []);

  // Interaction + animation are wired only after hydration, so the static
  // poster is never disturbed on the server. Reduced motion keeps the whole
  // journey lit and still; a coarse pointer keeps drag but drops auto-rotate.
  useEffect(() => {
    const prefersReduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    applyTransform();
    if (prefersReduced || typeof requestAnimationFrame !== 'function') {
      setLitCount(order.length);
      return undefined;
    }
    const allowAuto = !coarse;
    setLitCount(0);
    let raf = 0;
    let last = 0;
    let seam = 0;
    const frame = (time: number) => {
      const dt = Math.min(0.05, last === 0 ? 0 : (time - last) / 1000);
      last = time;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const idle = now >= pausedUntilRef.current;
      if (allowAuto && idle && !draggingRef.current) {
        rotYRef.current += dt * 9;
        applyTransform();
      }
      seam += dt * 0.9;
      if (seam > order.length + SEAM_HOLD) seam = 0;
      const next = Math.min(order.length, Math.floor(seam));
      setLitCount((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [order.length, applyTransform]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    try {
      sceneRef.current?.setPointerCapture(event.pointerId);
    } catch {
      /* setPointerCapture unsupported (e.g. jsdom) */
    }
    draggingRef.current = true;
    lastRef.current = { x: event.clientX, y: event.clientY };
    pauseAuto();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = event.clientX - lastRef.current.x;
    const dy = event.clientY - lastRef.current.y;
    lastRef.current = { x: event.clientX, y: event.clientY };
    rotYRef.current += dx * 0.4;
    rotXRef.current = Math.max(-TILT_CLAMP, Math.min(TILT_CLAMP, rotXRef.current - dy * 0.32));
    applyTransform();
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      sceneRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
    pauseAuto();
  };

  const nudge = (dTilt: number, dTurn: number) => {
    rotXRef.current = Math.max(-TILT_CLAMP, Math.min(TILT_CLAMP, rotXRef.current + dTilt));
    rotYRef.current += dTurn;
    applyTransform();
    pauseAuto();
  };
  const onSceneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const STEP = 7;
    if (event.key === 'ArrowLeft') nudge(0, -STEP);
    else if (event.key === 'ArrowRight') nudge(0, STEP);
    else if (event.key === 'ArrowUp') nudge(-STEP, 0);
    else if (event.key === 'ArrowDown') nudge(STEP, 0);
    else if (event.key === 'Escape') {
      setSelectedId(undefined);
      setHoverId(undefined);
      return;
    } else return;
    event.preventDefault();
  };

  const selectNode = (id: string) => {
    setSelectedId(id);
    pauseAuto();
  };
  const onNodeKeyDown = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectNode(id);
    }
  };

  const activeId = hoverId ?? selectedId;
  const activeStop = activeId === undefined ? undefined : stopById.get(activeId);

  const isLit = (id: string) => {
    const index = orderIndex.get(id);
    return index !== undefined && index < litCount;
  };

  return (
    <figure className={styles.figure}>
      <div className={styles.stage}>
        <div
          ref={sceneRef}
          className={styles.scene}
          role="group"
          tabIndex={0}
          aria-roledescription="orbitable edition"
          aria-label={`An orbitable bound edition of ${title}. Its cover is etched with the codebase's system map, its spine carries ${toRoman(chapters)} chapters, and its page fore-edge threads the request's journey. Drag or use the arrow keys to orbit; Tab to the map's nodes to read each stop.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onSceneKeyDown}
        >
          <div
            ref={bookRef}
            className={styles.book}
            style={{ transform: `rotateX(${START_TILT}deg) rotateY(${START_TURN}deg)` }}
          >
            {/* FRONT COVER — title + etched system map */}
            <div className={`${styles.face} ${styles.front}`}>
              <span className={styles.coverFrame} aria-hidden="true" />
              <span className={styles.imprint}>RampLab Editions</span>
              <span className={styles.coverTitle}>{title}</span>
              <span className={styles.coverSub}>The whole codebase, one path lit</span>
              <svg
                className={styles.etch}
                viewBox={`0 0 ${ETCH_WIDTH} ${etchHeight}`}
                preserveAspectRatio="xMidYMid meet"
                role="group"
                aria-label={`The codebase system map: ${map.nodes.length} modules and connections, with a ${stops.length}-stop journey lit through it`}
              >
                {/* All edges of the whole map — faint by default; the segments
                    between two lit journey nodes glow as the seam threads. */}
                {map.edges.map((edge, index) => {
                  const from = nodeCenter(edge.from);
                  const to = nodeCenter(edge.to);
                  if (from === undefined || to === undefined) return null;
                  const litEdge =
                    journeySet.has(edge.from) &&
                    journeySet.has(edge.to) &&
                    isLit(edge.from) &&
                    isLit(edge.to);
                  return (
                    <line
                      key={`${edge.from}-${edge.to}-${index}`}
                      className={styles.etchEdge}
                      data-lit={litEdge || undefined}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                    />
                  );
                })}
                {/* Faint, decorative etching of every node NOT on the journey —
                    the "map of the whole system" the lit path runs through. */}
                {layout.placed.map((placed) => {
                  if (journeySet.has(placed.node.id)) return null;
                  const center = nodeCenter(placed.node.id);
                  if (center === undefined) return null;
                  return (
                    <circle
                      key={placed.node.id}
                      className={styles.faintNode}
                      cx={center.x}
                      cy={center.y}
                      r={3.4}
                      aria-hidden="true"
                    >
                      <title>{placed.node.label}</title>
                    </circle>
                  );
                })}
                {/* The lit journey: real, focusable nodes with labels. */}
                {stops.map((stop) => {
                  const center = nodeCenter(stop.id);
                  if (center === undefined) return null;
                  const { x: cx, y: cy } = center;
                  // Anchor the label toward the cover's centre (nodes on the
                  // left half read rightward, right half leftward) so the lit
                  // journey's labels never run off the cover edge.
                  const labelLeft = cx > ETCH_WIDTH / 2;
                  return (
                    <g
                      key={stop.id}
                      className={styles.spot}
                      data-lit={isLit(stop.id) || undefined}
                      data-selected={stop.id === activeId || undefined}
                      tabIndex={0}
                      role="button"
                      aria-label={`Stop ${stop.index + 1} of ${stops.length}: ${stop.label}${stop.role !== undefined ? ` · ${stop.role}` : ''}`}
                      onPointerEnter={() => setHoverId(stop.id)}
                      onPointerLeave={() => setHoverId(undefined)}
                      onFocus={() => setHoverId(stop.id)}
                      onBlur={() => setHoverId(undefined)}
                      onClick={() => selectNode(stop.id)}
                      onKeyDown={(event) => onNodeKeyDown(event, stop.id)}
                    >
                      {/* Generous transparent hit target — the dot itself is tiny. */}
                      <circle className={styles.hit} cx={cx} cy={cy} r={16} />
                      <circle cx={cx} cy={cy} r={7} />
                      {/* The etched label is rendered only when it clears every
                          label already placed (collision-culled); the dropped
                          text still lives in this node's aria-label and card. */}
                      {labeledStops.has(stop.id) && (
                        <text
                          x={labelLeft ? cx - LABEL_GAP : cx + LABEL_GAP}
                          y={cy + 2.6}
                          textAnchor={labelLeft ? 'end' : 'start'}
                        >
                          {coverLabel(stop.label)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
              {setFrom !== undefined && (
                <span className={`${styles.imprint} ${styles.imprintFoot}`}>Set from {setFrom}</span>
              )}
            </div>

            {/* BACK COVER — colophon */}
            <div className={`${styles.face} ${styles.back}`} aria-hidden="true">
              <span className={styles.pressMark}>Colophon</span>
              <span className={styles.colophon}>
                <b>One request, start to finish.</b>
                <br />
                {stops.length} stops from the client's connection to the bytes the last handler
                returns, bound and mapped.
              </span>
              <span className={styles.pressMark}>RampLab · MMXXVI</span>
            </div>

            {/* SPINE (left) — chapters in roman numerals */}
            <div className={`${styles.face} ${styles.left}`} aria-hidden="true">
              <span className={styles.pressEmblem}>✦</span>
              <span className={styles.spineTitle}>{title}</span>
              <span className={styles.spineBands}>
                {Array.from({ length: chapters }, (_, index) => (
                  <span key={index} className={styles.band} data-current={index === 0 || undefined}>
                    <span className={styles.bandNum}>{toRoman(index + 1)}</span>
                  </span>
                ))}
              </span>
              <span className={styles.pressEmblem}>✦</span>
            </div>

            {/* FORE-EDGE (right) — the journey seam over page striations */}
            <div className={`${styles.face} ${styles.right}`} aria-hidden="true">
              <span className={styles.edgeThread} />
              {stops.map((stop) => (
                <span key={stop.id} className={styles.edgeMark} data-lit={isLit(stop.id) || undefined}>
                  <span className={styles.tick} />
                </span>
              ))}
            </div>

            <div className={`${styles.face} ${styles.top}`} aria-hidden="true" />
            <div className={`${styles.face} ${styles.bottom}`} aria-hidden="true" />
          </div>
        </div>

        <aside
          className={styles.card}
          data-show={activeStop !== undefined || undefined}
          role="status"
          aria-live="polite"
        >
          {activeStop !== undefined && (
            <>
              <span className={styles.cardKick}>
                Path stop · {activeStop.index + 1} of {stops.length}
              </span>
              <span className={styles.cardLabel}>{activeStop.label}</span>
              {activeStop.role !== undefined && (
                <span className={styles.cardRole}>{activeStop.role}</span>
              )}
              <span className={styles.cardChapter}>{chapterLabel}</span>
              {activeStop.anchor !== undefined && (
                <span className={styles.cardAnchor}>{activeStop.anchor}</span>
              )}
            </>
          )}
        </aside>
      </div>

      <figcaption className={styles.caption}>
        <b>{title}, bound and mapped, with the request's path lit along its edge.</b>
        <span className={styles.captionSub}>
          Cover: the whole codebase map · Spine: {toRoman(chapters)} chapters · Fore-edge: one
          request&apos;s journey
        </span>
        {href !== undefined && (
          <a className={styles.captionCta} href={href}>
            Open this edition →
          </a>
        )}
      </figcaption>
    </figure>
  );
}
