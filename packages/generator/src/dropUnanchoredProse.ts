/**
 * Ungrounded prose is dropped, not fatal.
 *
 * A pressing of supabase died four minutes in on one line:
 *
 *     ✖ machine-generated content must carry at least one code anchor
 *       → at base.modules[0].widgets[0].edges[0].anchors
 *
 * The edge said "Renders page content" and cited nothing. The map was
 * otherwise whole — every node anchored, every callout anchored — and the run
 * was lost over a single unsourced phrase on a single arrow. It is the same
 * failure #107 collected three times over (`nodes[0]`, `nodes[7]`,
 * `nodes[10]`), and the fixes since then have all been about saying it more
 * clearly rather than surviving it.
 *
 * The severity ladder was upside down. PLAN.md §3 says unverified claims are
 * dropped from the base spec, and `resolveAnchors` implements exactly that:
 * an anchor pointing at a file that does not exist costs you the widget and
 * the run continues. A missing anchor — the lesser sin, and the recoverable
 * one — cost you the whole pressing.
 *
 * So it is dropped here instead. Prose the model did not ground is removed
 * before validation, and the shape it hung on survives: an unanchored edge
 * label leaves the arrow, an unanchored node description leaves the node. The
 * schema already blesses these ("a bare node is pure diagram structure"), so
 * nothing invalid is being smuggled past a gate. The gate is unchanged —
 * ungrounded prose still never ships. It is now enforced structurally rather
 * than fatally, which is what the rest of the pipeline already did.
 *
 * **Only where the prose is optional.** A quiz explanation, a walkthrough
 * step's commentary, a code figure's caption and a decision-table rule's
 * explanation are all required by the schema: deleting one moves the failure
 * rather than fixing it, and would hollow out the widget on the way. Those are
 * left exactly as they came, to fail validation and earn a retry.
 */

/** One piece of prose the press discarded, and where the model wrote it. */
export interface ProseDrop {
  /**
   * Path in the model's OWN payload (`systemMap.edges[0].label`), not in the
   * assembled spec — this is read by whoever has to fix a prompt.
   */
  path: string;
  /** What the model wrote there, truncated. */
  text: string;
  /**
   * Which model call wrote it: `map`, or the id of the chapter whose author
   * did. A path alone is only unambiguous within one reply, because every
   * chapter's author numbers its own `widgets[…]` from zero — without this,
   * `widgets[2].states[0].description` names seven places in a seven-chapter
   * press. Stamped by the stage; this function cannot know it.
   */
  source?: string;
}

export interface ProseDropResult<T> {
  /** The payload with unanchored optional prose removed. Never mutated in place. */
  value: T;
  /** Every drop made, in payload order. */
  drops: ProseDrop[];
}

/**
 * Strip unanchored optional prose from one widget payload. `widgetPath` names
 * the widget in the model's own coordinates and prefixes every reported drop.
 */
export function dropUnanchoredProse<T>(widget: T, widgetPath: string): ProseDropResult<T> {
  const drops: ProseDrop[] = [];
  return { value: pruneWidget(widget, widgetPath, drops) as T, drops };
}

/** Attribute drops to the model call that produced them. See {@link ProseDrop.source}. */
export function fromSource(drops: ProseDrop[], source: string): ProseDrop[] {
  return drops.map((drop) => ({ ...drop, source }));
}

// ---------------------------------------------------------------------------
// Per-widget-type pruning
// ---------------------------------------------------------------------------

/**
 * Deliberately keyed on `type` rather than walking structurally for anything
 * named `description`. A system-map node's `label` is required and carries no
 * claim; a state's `description` is an optional note object; a quiz's
 * `explanation` must not be touched at all. Only the type says which is which,
 * and guessing wrong here deletes the widget's spine.
 */
function pruneWidget(widget: unknown, path: string, drops: ProseDrop[]): unknown {
  if (!isRecord(widget)) return widget;

  switch (widget['type']) {
    case 'system-map': {
      // Sibling form: the prose is a plain string next to an `anchors` array.
      const withNodes = pruneEach(widget, 'nodes', path, (entry, entryPath) =>
        dropSiblingProse(entry, 'description', entryPath, drops),
      );
      return pruneEach(withNodes, 'edges', path, (entry, entryPath) =>
        dropSiblingProse(entry, 'label', entryPath, drops),
      );
    }
    case 'state-machine': {
      const withStates = pruneEach(widget, 'states', path, (entry, entryPath) =>
        dropOptionalNote(entry, 'description', entryPath, drops),
      );
      return pruneEach(withStates, 'transitions', path, (entry, entryPath) =>
        dropOptionalNote(entry, 'commentary', entryPath, drops),
      );
    }
    case 'pipeline':
      return pruneEach(widget, 'stages', path, (entry, entryPath) =>
        dropOptionalNote(entry, 'description', entryPath, drops),
      );
    case 'decision-table': {
      // Rule explanations are required; only the default outcome's is not.
      const defaultOutcome = widget['defaultOutcome'];
      if (!isRecord(defaultOutcome)) return widget;
      return {
        ...widget,
        defaultOutcome: dropOptionalNote(
          defaultOutcome,
          'explanation',
          `${path}.defaultOutcome`,
          drops,
        ),
      };
    }
    case 'data-model': {
      const nodes = widget['nodes'];
      if (!Array.isArray(nodes)) return widget;
      return { ...widget, nodes: pruneDataModelNodes(nodes, `${path}.nodes`, drops) };
    }
    default:
      // Callouts, quizzes, walkthroughs and figures carry no optional prose:
      // every claim in them is required, so there is nothing droppable.
      return widget;
  }
}

/** Annotations live at every depth of the field tree, so recurse through children. */
function pruneDataModelNodes(nodes: unknown[], path: string, drops: ProseDrop[]): unknown[] {
  return nodes.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const pruned = dropOptionalNote(entry, 'annotation', entryPath, drops);
    if (!isRecord(pruned) || !Array.isArray(pruned['children'])) return pruned;
    return {
      ...pruned,
      children: pruneDataModelNodes(pruned['children'], `${entryPath}.children`, drops),
    };
  });
}

// ---------------------------------------------------------------------------
// The two shapes a droppable claim comes in
// ---------------------------------------------------------------------------

/**
 * Sibling form (system-map nodes and edges): a plain prose string with its
 * anchors in a sibling `anchors` array. Drop the prose; the node or edge stays
 * as bare diagram structure.
 */
function dropSiblingProse(
  entry: unknown,
  proseKey: string,
  path: string,
  drops: ProseDrop[],
): unknown {
  if (!isRecord(entry)) return entry;
  const prose = entry[proseKey];
  if (typeof prose !== 'string') return entry;
  // Empty prose is the absence it means (#174) — remove it, but there is
  // nothing to report, because nothing was lost.
  if (prose.trim() === '') return without(entry, proseKey);
  if (isAnchored(entry)) return entry;
  drops.push({ path: `${path}.${proseKey}`, text: truncate(prose) });
  return without(entry, proseKey);
}

/**
 * Note form (`{ body, anchors }`) at an OPTIONAL position: drop the whole
 * note. Callers must only pass keys the schema marks optional — see the module
 * comment on why required notes are left to fail.
 */
function dropOptionalNote(
  entry: unknown,
  noteKey: string,
  path: string,
  drops: ProseDrop[],
): unknown {
  if (!isRecord(entry)) return entry;
  const note = entry[noteKey];
  if (!isRecord(note) || isAnchored(note)) return entry;
  const body = note['body'];
  drops.push({
    path: `${path}.${noteKey}`,
    text: typeof body === 'string' ? truncate(body) : '',
  });
  return without(entry, noteKey);
}

// ---------------------------------------------------------------------------

/** The schema's `.min(1)` on anchors, asked of an unvalidated payload. */
function isAnchored(value: Record<string, unknown>): boolean {
  const anchors = value['anchors'];
  return Array.isArray(anchors) && anchors.length > 0;
}

/**
 * Map over `widget[key]` when it is an array, leaving the widget untouched
 * when it is not — an absent or malformed list is validation's problem, and
 * writing `undefined` back over it would only change which error you get.
 */
function pruneEach(
  widget: Record<string, unknown>,
  key: string,
  path: string,
  prune: (entry: unknown, entryPath: string) => unknown,
): Record<string, unknown> {
  const value = widget[key];
  if (!Array.isArray(value)) return widget;
  return {
    ...widget,
    [key]: value.map((entry, index) => prune(entry, `${path}.${key}[${index}]`)),
  };
}

function without(entry: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _dropped, ...rest } = entry;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}
