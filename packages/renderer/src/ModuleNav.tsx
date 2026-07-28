import type { MouseEvent } from 'react';
import type { ResolvedModule } from '@ramplab/spec';
import { toRoman } from './roman.js';
import styles from './ModuleNav.module.css';

export interface ModuleNavProps {
  modules: readonly ResolvedModule[];
  /** Module currently open, if any (the contents page itself has none). */
  activeModuleId: string;
  onSelect: (moduleId: string) => void;
  /** Modules whose checkpoints the learner has passed (from the progress store). */
  completedModuleIds?: ReadonlySet<string>;
  /** Modules the learner has opened; completion supersedes the viewed mark. */
  viewedModuleIds?: ReadonlySet<string>;
  /** Module the "Resume here" ribbon marks (the furthest-visited chapter). */
  resumeModuleId?: string | undefined;
  /**
   * When given, entries render as real links (`<a href=…>`) so every module
   * has a shareable, crawlable permalink. Plain left-clicks are intercepted
   * and routed through `onSelect` (the host does client-side navigation);
   * modified clicks (new tab, etc.) keep native link behavior.
   */
  hrefFor?: (moduleId: string) => string;
}

/** Chapter scope, from the widget census — sans metadata under the title. */
function censusOf(module: ResolvedModule): string {
  const types = module.widgets.map((resolved) => resolved.widget.type);
  const parts: string[] = [];
  const walkthroughs = types.filter((type) => type === 'code-walkthrough').length;
  if (walkthroughs > 0) {
    parts.push(walkthroughs === 1 ? '1 walkthrough' : `${walkthroughs} walkthroughs`);
  }
  const figures = types.filter((type) =>
    ['system-map', 'code-figure', 'state-machine', 'pipeline', 'data-model', 'decision-table'].includes(type),
  ).length;
  if (figures > 0) parts.push(figures === 1 ? '1 figure' : `${figures} figures`);
  const notes = types.filter((type) => type === 'callout').length;
  if (notes > 0) parts.push(notes === 1 ? '1 note' : `${notes} notes`);
  if (types.includes('quiz')) parts.push('checkpoint');
  return parts.join(' · ');
}

/**
 * The contents page's chapter list (Edition): roman numerals, sans entries
 * with dotted leaders, completion ✓, viewed marks, and the "Resume here"
 * ribbon. This IS the module navigation — the chapter view carries no
 * persistent nav; orientation lives here, in the running head, and in the
 * fore-edge mark.
 */
export function ModuleNav({
  modules,
  activeModuleId,
  onSelect,
  completedModuleIds,
  viewedModuleIds,
  resumeModuleId,
  hrefFor,
}: ModuleNavProps) {
  return (
    <nav aria-label="Modules" className={styles.nav}>
      <ol className={styles.list}>
        {modules.map((module, index) => {
          const completed = completedModuleIds?.has(module.id) === true;
          const viewed = !completed && viewedModuleIds?.has(module.id) === true;
          const census = censusOf(module);
          const body = (
            <>
              <span className={styles.num} aria-hidden="true">
                {toRoman(index + 1)}
              </span>
              <span className={styles.entry}>
                <span className={styles.title}>
                  {module.title}
                  {module.id === resumeModuleId && (
                    <span className={styles.ribbon} data-testid="journey-resume">
                      Resume here
                    </span>
                  )}
                </span>
                {census !== '' && <span className={styles.census}>{census}</span>}
              </span>
              <span className={styles.leader} aria-hidden="true" />
              <span
                className={styles.scope}
                aria-hidden="true"
                title={`${module.widgets.length} sections`}
              >
                {module.widgets.length}
              </span>
              {completed && (
                <span className={styles.done} role="img" aria-label="completed">
                  ✓
                </span>
              )}
              {viewed && (
                <span className={styles.seen} role="img" aria-label="viewed">
                  •
                </span>
              )}
            </>
          );
          const rowState = completed ? 'done' : viewed ? 'viewed' : 'ahead';
          if (hrefFor !== undefined) {
            const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              onSelect(module.id);
            };
            return (
              <li key={module.id} className={styles.row} data-state={rowState}>
                <a
                  href={hrefFor(module.id)}
                  className={styles.item}
                  aria-current={module.id === activeModuleId ? 'page' : undefined}
                  data-completed={completed ? 'true' : undefined}
                  data-viewed={viewed ? 'true' : undefined}
                  onClick={onClick}
                >
                  {body}
                </a>
              </li>
            );
          }
          return (
            <li key={module.id} className={styles.row} data-state={rowState}>
              <button
                type="button"
                className={styles.item}
                aria-current={module.id === activeModuleId ? 'true' : undefined}
                data-completed={completed ? 'true' : undefined}
                data-viewed={viewed ? 'true' : undefined}
                onClick={() => onSelect(module.id)}
              >
                {body}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
