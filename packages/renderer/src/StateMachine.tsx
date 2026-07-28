import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import type {
  Anchor,
  OverlayStateMachineWidget,
  StateMachineState,
  StateMachineTransition,
} from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './StateMachine.module.css';

export interface StateMachineProps {
  widget: OverlayStateMachineWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Book-furniture figure number, e.g. "Figure III" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Called when an anchor chip is clicked (e.g. to open the file). */
  onAnchorClick?: (anchor: Anchor) => void;
}

/**
 * State-machine widget, ported from the reference lab's `.sm` diagrams:
 * kebab-cased spec states become clickable SVG nodes, transitions become
 * curved edge paths. Selecting a state lights up its outgoing paths and shows
 * the state's description plus per-edge commentary with anchor chips.
 *
 * Layout is automatic (the spec carries no coordinates): states are placed in
 * columns by BFS depth from the machine's entry states.
 */
export function StateMachine({ widget, origin = 'base', figureLabel, onAnchorClick }: StateMachineProps) {
  const markerId = useId();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  const layout = useMemo(() => layoutMachine(widget), [widget]);
  const statesById = useMemo(
    () => new Map(widget.states.map((state) => [state.id, state])),
    [widget],
  );

  const selected = selectedId !== undefined ? statesById.get(selectedId) : undefined;
  const outgoing =
    selected !== undefined
      ? widget.transitions.filter((transition) => transition.from === selected.id)
      : [];

  const onNodeKeyDown = (event: KeyboardEvent, stateId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelectedId(stateId);
    }
  };

  return (
    <section className={styles.frame} data-widget="state-machine" data-origin={origin}>
      <header className={styles.head}>
        <span className={styles.badge}>
          {figureLabel !== undefined ? `${figureLabel} · ` : ''}state machine
        </span>
        <span className={styles.title}>{widget.title ?? 'State machine'}</span>
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
      </header>
      <div className={styles.body}>
        <div className={styles.diagram}>
          <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="presentation">
            <defs>
              <marker
                id={`${markerId}-arr`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0L10,5L0,10z" className={styles.arrow} />
              </marker>
              <marker
                id={`${markerId}-arr-lit`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0L10,5L0,10z" className={styles.arrowLit} />
              </marker>
            </defs>
            {layout.edges.map((edge) => {
              const lit = selected !== undefined && edge.transition.from === selected.id;
              return (
                <g key={edge.key}>
                  <path
                    className={styles.edge}
                    data-lit={lit ? 'true' : undefined}
                    d={edge.path}
                    markerEnd={`url(#${markerId}-arr${lit ? '-lit' : ''})`}
                  />
                  <text
                    className={styles.edgeLabel}
                    data-lit={lit ? 'true' : undefined}
                    x={edge.labelX}
                    y={edge.labelY}
                    textAnchor="middle"
                  >
                    {edge.transition.trigger}
                  </text>
                </g>
              );
            })}
            {layout.nodes.map((node) => {
              const isSelected = node.state.id === selectedId;
              const isReachable =
                selected !== undefined &&
                outgoing.some((transition) => transition.to === node.state.id);
              return (
                <g
                  key={node.state.id}
                  className={styles.node}
                  data-selected={isSelected ? 'true' : undefined}
                  data-reachable={isReachable ? 'true' : undefined}
                  role="button"
                  tabIndex={0}
                  aria-label={node.state.label}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(node.state.id)}
                  onKeyDown={(event) => onNodeKeyDown(event, node.state.id)}
                >
                  <rect x={node.x} y={node.y} width={node.width} height={NODE_HEIGHT} rx={10} />
                  <text x={node.x + node.width / 2} y={node.y + NODE_HEIGHT / 2 + 4} textAnchor="middle">
                    {node.state.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className={styles.info}>
          {selected === undefined ? (
            <span className={styles.placeholder}>Click a state above.</span>
          ) : (
            <>
              <p className={styles.stateLine}>
                <b>{selected.label}</b>
                {selected.description !== undefined && (
                  <>: <InlineProse text={selected.description.body} /></>
                )}
              </p>
              {selected.description !== undefined && (
                <AnchorChips anchors={selected.description.anchors} onAnchorClick={onAnchorClick} />
              )}
              {outgoing.length === 0 ? (
                <p className={styles.terminal}>Terminal state: no outgoing transitions.</p>
              ) : (
                <ul className={styles.transitionList}>
                  {outgoing.map((transition) => (
                    <li key={transitionKey(transition)}>
                      <span className={styles.trigger}>{transition.trigger}</span>
                      {' → '}
                      <b>{statesById.get(transition.to)?.label ?? transition.to}</b>
                      {transition.commentary !== undefined && (
                        <>
                          <span className={styles.commentary}>
                            <InlineProse text={transition.commentary.body} />
                          </span>
                          <AnchorChips
                            anchors={transition.commentary.anchors}
                            onAnchorClick={onAnchorClick}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function AnchorChips({
  anchors,
  onAnchorClick,
}: {
  anchors?: readonly Anchor[];
  onAnchorClick?: ((anchor: Anchor) => void) | undefined;
}) {
  if (anchors === undefined || anchors.length === 0) return null;
  return (
    <span className={styles.anchors}>
      {anchors.map((anchor, index) => (
        <AnchorChip
          key={index}
          anchor={anchor}
          className={styles.anchor}
          onAnchorClick={onAnchorClick}
        />
      ))}
    </span>
  );
}

function transitionKey(transition: StateMachineTransition): string {
  return `${transition.from}->${transition.to}:${transition.trigger}`;
}

/* ---------------------------------------------------------------------------
 * Automatic layout: columns by BFS depth, curved edges like the reference lab.
 * ------------------------------------------------------------------------- */

const NODE_HEIGHT = 44;
const COLUMN_GAP = 72;
const ROW_GAP = 34;
const PADDING = 18;
/** Approximate mono glyph width at font-size 12px. */
const CHAR_WIDTH = 7.4;

interface LaidOutNode {
  state: StateMachineState;
  x: number;
  y: number;
  width: number;
  column: number;
}

interface LaidOutEdge {
  key: string;
  transition: StateMachineTransition;
  path: string;
  labelX: number;
  labelY: number;
}

interface MachineLayout {
  width: number;
  height: number;
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
}

function nodeWidth(label: string): number {
  return Math.max(96, Math.round(label.length * CHAR_WIDTH) + 30);
}

/** BFS depth from entry states (no incoming edges; falls back to the first). */
function columnByDepth(widget: OverlayStateMachineWidget): Map<string, number> {
  const depths = new Map<string, number>();
  const roots = widget.states.filter(
    (state) =>
      !widget.transitions.some(
        (transition) => transition.to === state.id && transition.from !== state.id,
      ),
  );
  const queue = (roots.length > 0 ? roots : widget.states.slice(0, 1)).map((state) => state.id);
  for (const id of queue) depths.set(id, 0);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const transition of widget.transitions) {
      if (transition.from !== current || depths.has(transition.to)) continue;
      depths.set(transition.to, (depths.get(current) ?? 0) + 1);
      queue.push(transition.to);
    }
  }
  // States unreachable from any entry point get their own trailing column.
  const maxDepth = Math.max(0, ...depths.values());
  for (const state of widget.states) {
    if (!depths.has(state.id)) depths.set(state.id, maxDepth + 1);
  }
  return depths;
}

function layoutMachine(widget: OverlayStateMachineWidget): MachineLayout {
  const depths = columnByDepth(widget);
  const columnCount = Math.max(...depths.values()) + 1;
  const columns: StateMachineState[][] = Array.from({ length: columnCount }, () => []);
  for (const state of widget.states) {
    columns[depths.get(state.id) ?? 0]?.push(state);
  }

  const columnWidths = columns.map((column) =>
    Math.max(...column.map((state) => nodeWidth(state.label)), 0),
  );
  const tallest = Math.max(...columns.map((column) => column.length));
  const innerHeight = tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;

  const nodes: LaidOutNode[] = [];
  const byId = new Map<string, LaidOutNode>();
  let x = PADDING;
  columns.forEach((column, columnIndex) => {
    const columnHeight = column.length * NODE_HEIGHT + (column.length - 1) * ROW_GAP;
    let y = PADDING + (innerHeight - columnHeight) / 2;
    for (const state of column) {
      const width = nodeWidth(state.label);
      const node: LaidOutNode = {
        state,
        x: x + (columnWidths[columnIndex] ?? width) / 2 - width / 2,
        y,
        width,
        column: columnIndex,
      };
      nodes.push(node);
      byId.set(state.id, node);
      y += NODE_HEIGHT + ROW_GAP;
    }
    x += (columnWidths[columnIndex] ?? 0) + COLUMN_GAP;
  });

  const width = x - COLUMN_GAP + PADDING;
  const hasBackEdge = widget.transitions.some(
    (transition) =>
      (byId.get(transition.from)?.column ?? 0) > (byId.get(transition.to)?.column ?? 0),
  );
  const height = PADDING * 2 + innerHeight + (hasBackEdge ? 44 : 0);

  const edges: LaidOutEdge[] = widget.transitions.flatMap((transition, index) => {
    const from = byId.get(transition.from);
    const to = byId.get(transition.to);
    if (from === undefined || to === undefined) return [];
    return [edgeFor(transition, index, from, to, PADDING + innerHeight)];
  });

  return { width, height, nodes, edges };
}

function edgeFor(
  transition: StateMachineTransition,
  index: number,
  from: LaidOutNode,
  to: LaidOutNode,
  bottomY: number,
): LaidOutEdge {
  const key = `${index}-${transitionKey(transition)}`;

  if (from.column < to.column) {
    // Forward: right edge of A to left edge of B (the reference's default curve).
    const ax = from.x + from.width;
    const ay = from.y + NODE_HEIGHT / 2;
    const bx = to.x;
    const by = to.y + NODE_HEIGHT / 2;
    return {
      key,
      transition,
      path: `M${ax},${ay} C${ax + 26},${ay} ${bx - 26},${by} ${bx},${by}`,
      labelX: (ax + bx) / 2,
      labelY: (ay + by) / 2 - 7,
    };
  }

  if (from.column === to.column && from.state.id !== to.state.id) {
    // Same column: connect vertically along the column's right side.
    const goingDown = to.y > from.y;
    const ax = from.x + from.width;
    const ay = from.y + NODE_HEIGHT / 2;
    const bx = to.x + to.width;
    const by = to.y + NODE_HEIGHT / 2;
    const bulge = Math.max(ax, bx) + 34;
    return {
      key,
      transition,
      path: `M${ax},${ay} C${bulge},${ay} ${bulge},${by} ${bx},${by}`,
      labelX: bulge + 4,
      labelY: (ay + by) / 2 + (goingDown ? 0 : 4),
    };
  }

  if (from.state.id === to.state.id) {
    // Self loop: small arc over the node.
    const cx = from.x + from.width / 2;
    const y = from.y;
    return {
      key,
      transition,
      path: `M${cx + 18},${y} C${cx + 44},${y - 34} ${cx - 44},${y - 34} ${cx - 18},${y}`,
      labelX: cx,
      labelY: y - 30,
    };
  }

  // Backward: swoop under the diagram from A's bottom to B's bottom.
  const ax = from.x + from.width / 2;
  const bx = to.x + to.width / 2;
  const ay = from.y + NODE_HEIGHT;
  const by = to.y + NODE_HEIGHT;
  const dip = bottomY + 32;
  return {
    key,
    transition,
    path: `M${ax},${ay} C${ax},${dip} ${bx},${dip} ${bx},${by}`,
    labelX: (ax + bx) / 2,
    labelY: dip - 2,
  };
}
