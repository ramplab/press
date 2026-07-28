import { Fragment, useState } from 'react';
import type { Anchor, OverlayDataModelNode, OverlayDataModelWidget } from '@ramplab/spec';
import { InlineProse } from './InlineProse.js';
import { AnchorChip } from './AnchorChip.js';
import styles from './DataModelExplorer.module.css';

export interface DataModelExplorerProps {
  widget: OverlayDataModelWidget;
  /** Whether this widget came from the machine base or the human overlay. */
  origin?: 'base' | 'overlay';
  /** Book-furniture figure number, e.g. "Figure III" (set by the Lab). */
  figureLabel?: string | undefined;
  /** Invoked when an anchor chip is clicked, e.g. to open the file in an editor. */
  onAnchorClick?: (anchor: Anchor) => void;
}

interface Selection {
  node: OverlayDataModelNode;
  path: string;
}

/**
 * Annotated data-model explorer, ported from the reference lab's JSON
 * explorer: a collapsible field tree on the left, and a sticky panel on the
 * right explaining the selected field — with anchors back to the code that
 * defines and reads it.
 */
export function DataModelExplorer({ widget, origin = 'base', figureLabel, onAnchorClick }: DataModelExplorerProps) {
  const [selected, setSelected] = useState<Selection | undefined>(undefined);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <section
      className={styles.explorer}
      data-widget="data-model"
      data-origin={origin}
      aria-label={widget.title ?? 'Data model'}
    >
      <header className={styles.head}>
        <span className={styles.badge}>
          {figureLabel !== undefined ? `${figureLabel} · ` : ''}data model
        </span>
        <span className={styles.title}>{widget.title ?? 'Data model'}</span>
        {origin === 'overlay' && <span className={styles.overlayBadge}>team note</span>}
        {widget.source !== undefined && <code className={styles.source}>{widget.source.file}</code>}
      </header>
      <div className={styles.body}>
        <div className={styles.tree}>
          <div className={styles.row}>
            <span className={styles.punct}>{'{'}</span>
          </div>
          <NodeRows
            nodes={widget.nodes}
            depth={1}
            parentPath=""
            selectedPath={selected?.path}
            collapsedPaths={collapsedPaths}
            onToggle={toggle}
            onSelect={(node, path) => setSelected({ node, path })}
          />
          <div className={styles.row}>
            <span className={styles.punct}>{'}'}</span>
          </div>
        </div>
        <div>
          <aside className={styles.panel} aria-label="Field notes">
            {selected === undefined ? (
              <span className={styles.placeholder}>
                ← click a key to see what it means, why it exists, and which code reads it.
              </span>
            ) : (
              <FieldNotes selection={selected} onAnchorClick={onAnchorClick} />
            )}
          </aside>
        </div>
      </div>
    </section>
  );
}

interface NodeRowsProps {
  nodes: readonly OverlayDataModelNode[];
  depth: number;
  parentPath: string;
  selectedPath: string | undefined;
  collapsedPaths: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onSelect: (node: OverlayDataModelNode, path: string) => void;
}

function NodeRows({
  nodes,
  depth,
  parentPath,
  selectedPath,
  collapsedPaths,
  onToggle,
  onSelect,
}: NodeRowsProps) {
  return (
    <>
      {nodes.map((node, index) => {
        const path = parentPath === '' ? node.name : `${parentPath}.${node.name}`;
        const children = node.children ?? [];
        const hasChildren = children.length > 0;
        const isCollapsed = collapsedPaths.has(path);
        const comma = index < nodes.length - 1 ? <span className={styles.punct}>,</span> : null;
        const [open, close] = looksLikeArray(node.type) ? ['[', ']'] : ['{', '}'];

        return (
          <Fragment key={path}>
            <div className={styles.row} style={{ paddingLeft: depth * 16 }}>
              {hasChildren ? (
                <button
                  type="button"
                  className={styles.toggle}
                  aria-expanded={!isCollapsed}
                  aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${node.name}`}
                  onClick={() => onToggle(path)}
                >
                  {isCollapsed ? '▸' : '▾'}
                </button>
              ) : (
                <span className={styles.toggle} aria-hidden="true" />
              )}
              <button
                type="button"
                className={styles.key}
                aria-pressed={path === selectedPath}
                onClick={() => onSelect(node, path)}
              >
                {node.name}
              </button>
              <span className={styles.punct}>: </span>
              {hasChildren ? (
                <span className={styles.punct}>{isCollapsed ? `${open} … ${close}` : open}</span>
              ) : (
                <ExampleValue node={node} />
              )}
              {(!hasChildren || isCollapsed) && comma}
            </div>
            {hasChildren && !isCollapsed && (
              <>
                <NodeRows
                  nodes={children}
                  depth={depth + 1}
                  parentPath={path}
                  selectedPath={selectedPath}
                  collapsedPaths={collapsedPaths}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
                <div className={styles.row} style={{ paddingLeft: depth * 16 }}>
                  <span className={styles.toggle} aria-hidden="true" />
                  <span className={styles.punct}>{close}</span>
                  {comma}
                </div>
              </>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

function looksLikeArray(type: string): boolean {
  return type.endsWith('[]') || type.startsWith('Array<');
}

function ExampleValue({ node }: { node: OverlayDataModelNode }) {
  if (node.example === undefined) {
    return <span className={styles.typeHint}>{node.type}</span>;
  }
  if (node.example === null) {
    return <span className={styles.punct}>null</span>;
  }
  switch (typeof node.example) {
    case 'string':
      return <span className={styles.string}>&quot;{node.example}&quot;</span>;
    case 'number':
      return <span className={styles.number}>{node.example}</span>;
    default:
      return <span className={styles.boolean}>{String(node.example)}</span>;
  }
}

interface FieldNotesProps {
  selection: Selection;
  onAnchorClick: ((anchor: Anchor) => void) | undefined;
}

function FieldNotes({ selection, onAnchorClick }: FieldNotesProps) {
  const { node, path } = selection;
  return (
    <>
      <h4 className={styles.panelPath}>
        {path} <span className={styles.panelType}>· {node.type}</span>
      </h4>
      {node.annotation === undefined ? (
        <span className={styles.placeholder}>No notes for this key yet.</span>
      ) : (
        <>
          <p className={styles.panelBody}>
            <InlineProse text={node.annotation.body} />
          </p>
          {node.annotation.readBy !== undefined && (
            <p className={styles.readBy}>
              <InlineProse text={node.annotation.readBy} />
            </p>
          )}
          {node.annotation.anchors !== undefined && node.annotation.anchors.length > 0 && (
            <span className={styles.anchors}>
              {node.annotation.anchors.map((anchor, index) => (
                <AnchorChip
                  key={index}
                  anchor={anchor}
                  className={styles.anchor}
                  onAnchorClick={onAnchorClick}
                />
              ))}
            </span>
          )}
        </>
      )}
    </>
  );
}

function AnchorLabel({ anchor }: { anchor: Anchor }) {
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
