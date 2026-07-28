import { useCallback, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import {
  resolveModules,
  type LabSpec,
  type ResolvedModule,
  type ResolvedWidget,
} from '@ramplab/spec';
import { AnchorSourceContext } from './AnchorChip.js';
import { BrandMark } from './BrandMark.js';
import { Callout } from './Callout.js';
import { CapabilityPlate } from './CapabilityPlate.js';
import { CodeFigure } from './CodeFigure.js';
import { CodeWalkthrough } from './CodeWalkthrough.js';
import { DataModelExplorer } from './DataModelExplorer.js';
import { DecisionTable } from './DecisionTable.js';
import { InlineProse } from './InlineProse.js';
import { capabilitiesLedger, moduleCapability, resumeTargetId } from './journey.js';
import { ModuleNav } from './ModuleNav.js';
import { PipelineRunner } from './PipelineRunner.js';
import {
  createLocalProgressStore,
  emptyProgress,
  isModuleComplete,
  moduleProgressState,
  type CheckpointResult,
  type LabProgress,
  type ProgressStore,
} from './progress.js';
import { Quiz } from './Quiz.js';
import { toRoman } from './roman.js';
import { anchorHrefBuilder } from './sourceLink.js';
import { StateMachine } from './StateMachine.js';
import { SystemMap } from './SystemMap.js';
import {
  applyThemePreference,
  nextThemePreference,
  readThemePreference,
  type ThemePreference,
} from './themeControl.js';
import styles from './Lab.module.css';

/** Colophon provenance — only what is cheaply, honestly available. */
export interface EditionInfo {
  /** Where this edition was set from, e.g. `evals/results/2026-07-06-caddy.spec.json`. */
  setFrom?: string;
  /** Short git SHA of the RampLab checkout that built the viewer. */
  sha?: string;
}

export interface LabProps {
  spec: LabSpec;
  /**
   * Progress seam: defaults to a localStorage-backed store keyed by the lab
   * id. The hosted viewer swaps in an account-backed store here.
   */
  progressStore?: ProgressStore;
  /**
   * Controlled active module (e.g. driven by the URL in the hosted viewer).
   * Omitted / undefined renders the contents page — the edition's cover,
   * chapter list, Appendix A and colophon. When uncontrolled, the Lab opens
   * on the contents page and manages chapter selection internally.
   */
  activeModuleId?: string;
  /**
   * Called when the learner selects a module. Pair with `activeModuleId` to
   * make module navigation URL-driven (router push on select).
   */
  onSelectModule?: (moduleId: string) => void;
  /**
   * When given, contents entries render as real links to shareable
   * permalinks instead of buttons. See `ModuleNavProps.hrefFor`.
   */
  moduleHref?: (moduleId: string) => string;
  /** Permalink of the contents page (`/lab/<slug>`) for the running head. */
  contentsHref?: string;
  /** Client-side navigation to the contents page (paired with contentsHref). */
  onNavigateContents?: () => void;
  /**
   * Fires with every progress snapshot: once after the persisted progress
   * hydrates on mount, then after each change (module viewed, checkpoint
   * recorded, module completed).
   */
  onProgressChange?: (progress: LabProgress) => void;
  /** Colophon provenance (set-from line, builder SHA). */
  edition?: EditionInfo;
  /**
   * Who may read this edition, when the host knows. Rendered as a quiet mark
   * beside the book title. A workspace-only edition used to wear chrome
   * identical to a public one, down to a colophon sentence a public edition
   * also carries, so nothing on screen said which promise was in force.
   */
  audience?: string;
  /**
   * View-time coda for a chapter: rendered in the prose column after the
   * chapter's widgets, before the chapter-end footer. The viewer decides
   * per module (return null for none) — e.g. the web viewer appends the
   * live starter-issues shelf to the first-contribution chapter. Codas are
   * viewer furniture, not book content: nothing here is generator-verified.
   */
  moduleCoda?: (module: ResolvedModule) => ReactNode;
}

/**
 * DOM id of a widget's wrapper in the chapter view. Module-scoped, because
 * widget ids repeat across chapters (`capability-callout`, `module-quiz`).
 * Hosts use it to scroll a widget into view — e.g. the Q&A panel's "See:"
 * references in the hosted reader.
 */
export function widgetDomId(moduleId: string, widgetId: string): string {
  return `widget-${moduleId}--${widgetId}`;
}

const FIGURE_TYPES = new Set([
  'system-map',
  'code-figure',
  'state-machine',
  'pipeline',
  'data-model',
  'decision-table',
]);

const COUNT_WORDS = [
  'None',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
];

function countWord(value: number): string {
  return COUNT_WORDS[value] ?? String(value);
}

/**
 * Root lab component — the Edition (issue #22): a lab presented as a
 * produced book. The contents page carries the frontispiece, chapter list,
 * Appendix A (the capabilities record) and colophon; each module is a
 * chapter with a serif opener, its widgets as sections and figures, the
 * capability plate, and an end-of-chapter checkpoint. Orientation is book
 * furniture: running head, fore-edge progress mark, contents — there is no
 * app chrome. Checkpoint results and module completion flow through the
 * progress store, so they survive reload.
 */
export function Lab({
  spec,
  progressStore,
  activeModuleId: controlledModuleId,
  onSelectModule,
  moduleHref,
  contentsHref,
  onNavigateContents,
  onProgressChange,
  edition,
  audience,
  moduleCoda,
}: LabProps) {
  const modules = useMemo(() => resolveModules(spec), [spec]);
  const [internalModuleId, setInternalModuleId] = useState<string | undefined>(undefined);
  const activeModuleId = controlledModuleId ?? internalModuleId;

  const selectModule = useCallback(
    (moduleId: string) => {
      setInternalModuleId(moduleId);
      onSelectModule?.(moduleId);
      try {
        globalThis.scrollTo?.(0, 0);
      } catch {
        /* jsdom */
      }
    },
    [onSelectModule],
  );

  const goToContents = useCallback(() => {
    setInternalModuleId(undefined);
    onNavigateContents?.();
    try {
      globalThis.scrollTo?.(0, 0);
    } catch {
      /* jsdom */
    }
  }, [onNavigateContents]);

  const store = useMemo(
    () => progressStore ?? createLocalProgressStore(spec.id),
    [progressStore, spec.id],
  );
  const activeIndex = modules.findIndex((module) => module.id === activeModuleId);
  const activeModule = activeIndex === -1 ? undefined : modules[activeIndex];
  const activeId = activeModule?.id;

  // Start from empty progress so server-side prerenders (the hosted viewer
  // statically generates lab pages) match the client's first hydration pass;
  // the effect below immediately loads the persisted snapshot on mount.
  const [progress, setProgress] = useState<LabProgress>(emptyProgress);
  // A new spec/store (e.g. a different file loaded in the playground) brings
  // its own persisted progress along; opening a chapter marks it viewed, so
  // this doubles as the journey's "viewed" tracker on every module change.
  useEffect(() => {
    setProgress(activeId === undefined ? store.read() : store.setModuleViewed(activeId));
  }, [store, activeId]);
  // Surface every snapshot to the host (e.g. account-backed sync later).
  useEffect(() => {
    onProgressChange?.(progress);
  }, [onProgressChange, progress]);

  const onCheckpoint = useCallback(
    (module: ResolvedModule, widgetId: string, questionId: string, result: CheckpointResult) => {
      let next = store.recordCheckpoint(widgetId, questionId, result);
      if (isModuleComplete(module, next)) {
        next = store.setModuleCompleted(module.id, true);
      }
      setProgress(next);
    },
    [store],
  );

  const completedModuleIds = useMemo(
    () => new Set(Object.keys(progress.completedModules)),
    [progress],
  );
  const viewedModuleIds = useMemo(
    () =>
      new Set(
        modules
          .filter((module) => moduleProgressState(module.id, progress) !== 'unseen')
          .map((module) => module.id),
      ),
    [modules, progress],
  );
  const ledger = useMemo(() => capabilitiesLedger(modules, progress), [modules, progress]);
  const resumeId = useMemo(() => resumeTargetId(modules, progress), [modules, progress]);
  // Every anchor chip below becomes a source permalink when the spec knows
  // its repo; without provenance the chips render as plain labels.
  const anchorHref = useMemo(() => anchorHrefBuilder(spec.repo), [spec.repo]);

  return (
    <AnchorSourceContext.Provider value={anchorHref}>
    <div className={styles.root}>
      <RunningHead
        bookTitle={spec.title}
        audience={audience}
        chapterLabel={
          activeModule === undefined
            ? ''
            : `Chapter ${toRoman(activeIndex + 1)} · ${activeModule.title}`
        }
        unlocked={ledger.unlockedCount}
        total={ledger.entries.length}
        onContents={goToContents}
        contentsHref={contentsHref}
      />
      <ForeEdge
        modules={modules}
        completedModuleIds={completedModuleIds}
        currentId={activeId ?? resumeId}
      />
      {activeModule === undefined ? (
        <ContentsPage
          spec={spec}
          modules={modules}
          completedModuleIds={completedModuleIds}
          viewedModuleIds={viewedModuleIds}
          resumeId={resumeId}
          ledgerUnlocked={ledger.unlockedCount}
          onSelect={selectModule}
          hrefFor={moduleHref}
          edition={edition}
        />
      ) : (
        <Chapter
          module={activeModule}
          index={activeIndex}
          nextModule={modules[activeIndex + 1]}
          progress={progress}
          onCheckpoint={onCheckpoint}
          onSelect={selectModule}
          hrefFor={moduleHref}
          onContents={goToContents}
          contentsHref={contentsHref}
          coda={moduleCoda}
        />
      )}
    </div>
    </AnchorSourceContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/* Running head: the book's header — sans machinery, always present.  */
/* ------------------------------------------------------------------ */

function RunningHead({
  bookTitle,
  audience,
  chapterLabel,
  unlocked,
  total,
  onContents,
  contentsHref,
}: {
  bookTitle: string;
  audience: string | undefined;
  chapterLabel: string;
  unlocked: number;
  total: number;
  onContents: () => void;
  contentsHref: string | undefined;
}) {
  const interceptContents = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onContents();
  };
  return (
    <header className={styles.runhead}>
      <div className={styles.runheadRow}>
        {contentsHref !== undefined ? (
          <a className={styles.rhBook} href={contentsHref} onClick={interceptContents}>
            {bookTitle}
          </a>
        ) : (
          <button type="button" className={styles.rhBook} onClick={onContents}>
            {bookTitle}
          </button>
        )}
        {audience !== undefined && <span className={styles.rhAudience}>{audience}</span>}
        <span className={styles.rhChapter}>{chapterLabel}</span>
        <span className={styles.rhControls}>
          {total > 0 && (
            // A bare tick and a fraction reads as "chapters completed", and on
            // a seven-chapter edition with six checkpoints it showed 0/6 right
            // above the heading "Seven chapters". Say which count it is.
            <span
              className={styles.rhUnlocks}
              data-testid="capability-count"
              title={`${unlocked} of ${total} capabilities bound into this edition`}
            >
              ✓ {unlocked}/{total} capabilities
            </span>
          )}
          {contentsHref !== undefined ? (
            <a className={styles.rhButton} href={contentsHref} onClick={interceptContents}>
              Contents
            </a>
          ) : (
            <button type="button" className={styles.rhButton} onClick={onContents}>
              Contents
            </button>
          )}
          <ThemeToggle />
        </span>
      </div>
    </header>
  );
}

const THEME_LABELS: Record<ThemePreference, string> = {
  auto: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

function ThemeToggle() {
  // SSR-safe: prerender as 'auto', hydrate the stored preference on mount.
  const [preference, setPreference] = useState<ThemePreference>('auto');
  useEffect(() => {
    setPreference(readThemePreference());
  }, []);
  const cycle = () => {
    const next = nextThemePreference(preference);
    applyThemePreference(next);
    setPreference(next);
  };
  return (
    <button
      type="button"
      className={styles.rhButton}
      onClick={cycle}
      title="Theme follows your system until overridden"
      aria-label={`Theme: ${THEME_LABELS[preference]}`}
    >
      ◐ {THEME_LABELS[preference]}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Fore-edge mark: passive ambient progress on the page's right edge. */
/* ------------------------------------------------------------------ */

function ForeEdge({
  modules,
  completedModuleIds,
  currentId,
}: {
  modules: readonly ResolvedModule[];
  completedModuleIds: ReadonlySet<string>;
  currentId: string | undefined;
}) {
  return (
    <div className={styles.foredge} aria-hidden="true">
      {modules.map((module, index) => {
        const state = completedModuleIds.has(module.id)
          ? 'done'
          : module.id === currentId
            ? 'now'
            : 'ahead';
        const word = state === 'done' ? 'read' : state === 'now' ? 'your place' : 'ahead';
        return (
          <span
            key={module.id}
            data-state={state}
            title={`Chapter ${toRoman(index + 1)} · ${module.title} (${word})`}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Contents page: frontispiece, chapter list, Appendix A, colophon.   */
/* ------------------------------------------------------------------ */

function ContentsPage({
  spec,
  modules,
  completedModuleIds,
  viewedModuleIds,
  resumeId,
  ledgerUnlocked,
  onSelect,
  hrefFor,
  edition,
}: {
  spec: LabSpec;
  modules: readonly ResolvedModule[];
  completedModuleIds: ReadonlySet<string>;
  viewedModuleIds: ReadonlySet<string>;
  resumeId: string | undefined;
  ledgerUnlocked: number;
  onSelect: (moduleId: string) => void;
  hrefFor: ((moduleId: string) => string) | undefined;
  edition: EditionInfo | undefined;
}) {
  const entries = modules
    .map((module, index) => ({ module, index, capability: moduleCapability(module) }))
    .filter((entry) => entry.capability !== undefined);
  return (
    <main className={styles.leaf} id="lab-content">
      <section className={styles.frontispiece}>
        <hr className={styles.coverRuleDouble} />
        <div className={styles.imprintMark}>
          <BrandMark size={34} />
        </div>
        <p className={styles.imprint}>RampLab · Guided Editions</p>
        <h1 className={styles.coverTitle}>{spec.title}</h1>
        <p className={styles.editionLine}>
          {spec.repo !== undefined ? (
            <>
              Pressed from <code>{spec.repo}</code>. Every claim is checked against the code.
            </>
          ) : (
            <>Pressed from the codebase. Every claim is checked against the code.</>
          )}
        </p>
        <hr className={styles.coverRule} />
      </section>

      <section className={styles.prose} aria-labelledby="contents-heading">
        <div className={styles.sectionHead}>
          <span className={styles.kicker}>Contents</span>
          <h2 className={styles.displayHeading} id="contents-heading">
            {countWord(modules.length)} chapter{modules.length === 1 ? '' : 's'}
          </h2>
        </div>
        <ModuleNav
          modules={modules}
          activeModuleId=""
          onSelect={onSelect}
          completedModuleIds={completedModuleIds}
          viewedModuleIds={viewedModuleIds}
          resumeModuleId={resumeId}
          hrefFor={hrefFor}
        />
        <p className={styles.contentsNote}>
          Chapters build on one another, so read them in order. Your place is kept in this browser.
        </p>
      </section>

      {entries.length > 0 && (
        <>
          <div className={styles.divider} role="presentation" />
          <section
            className={styles.prose}
            aria-labelledby="appendix-heading"
            data-testid="capabilities-ledger"
          >
            <div className={styles.sectionHead}>
              <span className={styles.kicker}>Appendix A</span>
              <h2 className={styles.displayHeading} id="appendix-heading">
                What you can now do
              </h2>
              {/* "None of six ... so far" opened the appendix on a negative,
                  in the one place the edition is meant to say what the reader
                  is about to be able to do. */}
              <p className={styles.appendixCount}>
                {ledgerUnlocked === 0
                  ? `${countWord(entries.length)} capabilities to bind, one at each chapter's checkpoint.`
                  : `${countWord(ledgerUnlocked)} of ${countWord(entries.length).toLowerCase()} capabilities bound into this edition so far.`}
              </p>
            </div>
            <ol className={styles.appendixList}>
              {entries.map(({ module, index, capability }) => {
                const unlocked = completedModuleIds.has(module.id);
                return (
                  <li
                    key={module.id}
                    className={styles.appendixEntry}
                    data-module-id={module.id}
                    data-state={unlocked ? 'unlocked' : 'locked'}
                  >
                    {unlocked && (
                      <span className={styles.appendixMark} title="Bound">
                        ✓
                      </span>
                    )}
                    <span className={styles.appendixWho}>
                      <span className={styles.appendixChapter}>Chapter {toRoman(index + 1)}</span>
                      <span className={styles.appendixTitle}>{module.title}</span>
                    </span>
                    {/* Locked entries show the chapter title only — uncut pages. */}
                    {unlocked && capability !== undefined && (
                      <p className={styles.appendixBody}>
                        <InlineProse text={capability.body} />
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        </>
      )}

      <p className={styles.colophon}>
        {spec.repo !== undefined ? (
          <>
            This edition was pressed and bound by RampLab from <code>{spec.repo}</code>; every
            claim in it is checked against the code itself.
          </>
        ) : (
          <>
            This edition was pressed and bound by RampLab; every claim in it is checked
            against the code itself.
          </>
        )}
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Chapter view: opener, widgets as sections/figures, chapter end.    */
/* ------------------------------------------------------------------ */

function Chapter({
  module,
  index,
  nextModule,
  progress,
  onCheckpoint,
  onSelect,
  hrefFor,
  onContents,
  contentsHref,
  coda,
}: {
  module: ResolvedModule;
  index: number;
  nextModule: ResolvedModule | undefined;
  progress: LabProgress;
  onCheckpoint: (
    module: ResolvedModule,
    widgetId: string,
    questionId: string,
    result: CheckpointResult,
  ) => void;
  onSelect: (moduleId: string) => void;
  hrefFor: ((moduleId: string) => string) | undefined;
  onContents: () => void;
  contentsHref: string | undefined;
  coda: ((module: ResolvedModule) => ReactNode) | undefined;
}) {
  const roman = toRoman(index + 1);
  const capability = moduleCapability(module);
  let figureCount = 0;

  return (
    <main className={styles.leaf} id="lab-content">
      <article aria-labelledby={`module-${module.id}`}>
        <header className={styles.chapterOpen}>
          <div className={styles.prose}>
            <span className={styles.kicker}>Chapter {roman}</span>
            <h2 className={styles.chapterTitle} id={`module-${module.id}`}>
              {module.title}
            </h2>
            {/* Epigraph only when the generator wrote one — never fabricated. */}
            {module.summary !== undefined && (
              <p className={styles.epigraph}>
                <InlineProse text={module.summary} />
              </p>
            )}
            <hr className={styles.orn} />
          </div>
        </header>
        {module.widgets.map((resolved) => {
          const { widget } = resolved;
          const isFigure = FIGURE_TYPES.has(widget.type);
          const figureLabel = isFigure ? `Figure ${toRoman(++figureCount)}` : undefined;
          const isPlate =
            widget.type === 'callout' && widget.id === capability?.calloutId;
          const wide =
            widget.type === 'code-walkthrough' ||
            (isFigure && widget.type !== 'code-figure');
          return (
            <div
              key={widget.id}
              id={widgetDomId(module.id, widget.id)}
              className={wide ? styles.breakout : styles.prose}
            >
              <Widget
                resolved={resolved}
                module={module}
                chapterRoman={roman}
                figureLabel={figureLabel}
                isPlate={isPlate}
                progress={progress}
                onCheckpoint={onCheckpoint}
              />
            </div>
          );
        })}
        {coda !== undefined && <div className={styles.prose}>{coda(module)}</div>}
        <footer className={styles.chapterEnd}>
          <div className={styles.finis}>End of Chapter {roman}</div>
          {nextModule !== undefined ? (
            <NextLink
              label="Next"
              title={`Chapter ${toRoman(index + 2)} · ${nextModule.title}`}
              href={hrefFor?.(nextModule.id)}
              onFollow={() => onSelect(nextModule.id)}
            />
          ) : (
            <NextLink
              label="Finis"
              title="Contents & Appendix A"
              href={contentsHref}
              onFollow={onContents}
            />
          )}
        </footer>
      </article>
    </main>
  );
}

function NextLink({
  label,
  title,
  href,
  onFollow,
}: {
  label: string;
  title: string;
  href: string | undefined;
  onFollow: () => void;
}) {
  const body = (
    <>
      <em>{label}</em>
      {title}
    </>
  );
  if (href !== undefined) {
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onFollow();
    };
    return (
      <a className={styles.next} href={href} onClick={onClick}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" className={styles.next} onClick={onFollow}>
      {body}
    </button>
  );
}

/** Dispatch a resolved widget to its component by spec `type`. */
function Widget({
  resolved,
  module,
  chapterRoman,
  figureLabel,
  isPlate,
  progress,
  onCheckpoint,
}: {
  resolved: ResolvedWidget;
  module: ResolvedModule;
  chapterRoman: string;
  figureLabel: string | undefined;
  isPlate: boolean;
  progress: LabProgress;
  onCheckpoint: (
    module: ResolvedModule,
    widgetId: string,
    questionId: string,
    result: CheckpointResult,
  ) => void;
}): ReactNode {
  const { widget, origin } = resolved;
  switch (widget.type) {
    case 'callout':
      return isPlate ? (
        <CapabilityPlate widget={widget} origin={origin} />
      ) : (
        <Callout widget={widget} origin={origin} />
      );
    case 'system-map':
      return <SystemMap widget={widget} figureLabel={figureLabel} />;
    case 'data-model':
      return <DataModelExplorer widget={widget} origin={origin} figureLabel={figureLabel} />;
    case 'state-machine':
      return <StateMachine widget={widget} origin={origin} figureLabel={figureLabel} />;
    case 'decision-table':
      return <DecisionTable widget={widget} origin={origin} figureLabel={figureLabel} />;
    case 'code-walkthrough':
      return <CodeWalkthrough widget={widget} origin={origin} />;
    case 'code-figure':
      return <CodeFigure widget={widget} origin={origin} figureLabel={figureLabel} />;
    case 'pipeline':
      return <PipelineRunner widget={widget} origin={origin} figureLabel={figureLabel} />;
    case 'quiz':
      return (
        <Quiz
          widget={widget}
          origin={origin}
          results={progress.checkpoints[widget.id]}
          onResult={(questionId, result) => onCheckpoint(module, widget.id, questionId, result)}
          completionNote={`Chapter ${chapterRoman} is bound into your edition.`}
        />
      );
  }
}
