import { z } from 'zod';

/**
 * Lab spec schema, version 1.
 *
 * Core invariants modeled here (see PLAN.md §3):
 * - Every machine-generated teachable unit carries >= 1 code anchor.
 * - Base (machine-owned, regenerated freely) is split from the human overlay
 *   (lead edits keyed to stable module/widget IDs; may be unanchored).
 * - Modules and widgets carry stable string IDs so overlay entries and
 *   progress tracking survive regeneration.
 */
export const SCHEMA_VERSION = 1;

/**
 * Stable, human-readable identifier. Kebab-case keeps IDs URL- and
 * diff-friendly; stability across regenerations is what matters.
 */
export const idSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'IDs must be stable kebab-case strings (lowercase letters, digits, hyphens)',
  );

/**
 * A code anchor: the mechanical link from teachable content back to source.
 * File path is required; symbol and line range sharpen the reference.
 */
export const anchorSchema = z.object({
  file: z.string().min(1, 'anchor.file must be a non-empty repo-relative path'),
  symbol: z.string().min(1).optional(),
  lines: z
    .object({
      start: z.int().positive(),
      end: z.int().positive(),
    })
    .refine((range) => range.end >= range.start, {
      message: 'lines.end must be >= lines.start',
    })
    .optional(),
  /**
   * Content hash of the anchored region, emitted by anchor resolution
   * (`@ramplab/generator`). Powers staleness detection on regeneration:
   * if the anchored code's fingerprint changes, flag for review.
   */
  fingerprint: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'fingerprint must be "sha256:" followed by 64 hex chars')
    .optional(),
});

export const calloutKindSchema = z.enum(['why', 'warning', 'connects-to']);

const calloutFields = {
  id: idSchema,
  type: z.literal('callout'),
  kind: calloutKindSchema,
  title: z.string().min(1).optional(),
  body: z.string().min(1, 'callout.body must be non-empty'),
} as const;

/**
 * Machine-generated callout: anchors are a structural requirement.
 */
export const calloutWidgetSchema = z.object({
  ...calloutFields,
  anchors: z
    .array(anchorSchema)
    .min(1, 'machine-generated content must carry at least one code anchor'),
});

const dataModelAnnotationFields = {
  body: z.string().min(1, 'annotation.body must be non-empty'),
  /** Who consumes this field — the "Read by: …" line under the explanation. */
  readBy: z.string().min(1).optional(),
} as const;

/**
 * A system-map node. A bare node (id + label) is pure diagram structure; the
 * moment it carries teachable content (a description), the anchor requirement
 * kicks in.
 */
export const systemMapNodeSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1, 'node.label must be non-empty'),
    description: z.string().min(1).optional(),
    anchors: z.array(anchorSchema).optional(),
  })
  .refine((node) => node.description === undefined || (node.anchors?.length ?? 0) >= 1, {
    message: 'machine-generated content must carry at least one code anchor',
    path: ['anchors'],
  });

/**
 * A directed system-map edge. The label is the edge's commentary ("what flows
 * here"), so a labeled edge is teachable content and must be anchored.
 */
export const systemMapEdgeSchema = z
  .object({
    from: idSchema,
    to: idSchema,
    label: z.string().min(1).optional(),
    anchors: z.array(anchorSchema).optional(),
  })
  .refine((edge) => edge.label === undefined || (edge.anchors?.length ?? 0) >= 1, {
    message: 'machine-generated content must carry at least one code anchor',
    path: ['anchors'],
  });

/**
 * System map: the clickable architecture diagram. Node IDs must be unique and
 * every edge endpoint must name an existing node — a dangling edge is a spec
 * bug, not a rendering concern.
 */
export const systemMapWidgetSchema = z
  .object({
    id: idSchema,
    type: z.literal('system-map'),
    title: z.string().min(1).optional(),
    nodes: z.array(systemMapNodeSchema).min(1, 'a system map needs at least one node'),
    edges: z.array(systemMapEdgeSchema),
  })
  .superRefine((widget, ctx) => {
    const nodeIds = new Set<string>();
    widget.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `duplicate node id "${node.id}"`,
        });
      }
      nodeIds.add(node.id);
    });
    widget.edges.forEach((edge, index) => {
      for (const end of ['from', 'to'] as const) {
        if (!nodeIds.has(edge[end])) {
          ctx.addIssue({
            code: 'custom',
            path: ['edges', index, end],
            message: `edge ${end} references unknown node "${edge[end]}"`,
          });
        }
      }
    });
  });

/**
 * Machine-generated node annotation: a teachable unit, so anchors are a
 * structural requirement.
 */
export const dataModelAnnotationSchema = z.object({
  ...dataModelAnnotationFields,
  anchors: z
    .array(anchorSchema)
    .min(1, 'machine-generated content must carry at least one code anchor'),
});

/** Human-overlay node annotation: tribal knowledge may be unanchored. */
export const overlayDataModelAnnotationSchema = z.object({
  ...dataModelAnnotationFields,
  anchors: z.array(anchorSchema).optional(),
});

const dataModelNodeFields = {
  name: z.string().min(1, 'node.name must be non-empty'),
  /** Display type, e.g. `string`, `Person[]`, `Record<fieldId, DocumentData>`. */
  type: z.string().min(1, 'node.type must be non-empty'),
  /** Optional example value rendered next to the name, JSON-explorer style. */
  example: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
} as const;

/**
 * One field in the annotated data-model tree. Nodes are addressed by their
 * name path (`people.source`), so sibling names must be unique — enforced at
 * the widget level, where the whole tree is in view.
 *
 * The recursive schemas need explicit interfaces: TypeScript cannot infer a
 * type referenced in its own initializer.
 */
export interface DataModelNode {
  name: string;
  type: string;
  example?: string | number | boolean | null | undefined;
  annotation?: DataModelAnnotation | undefined;
  children?: DataModelNode[] | undefined;
}

export interface OverlayDataModelNode {
  name: string;
  type: string;
  example?: string | number | boolean | null | undefined;
  annotation?: OverlayDataModelAnnotation | undefined;
  children?: OverlayDataModelNode[] | undefined;
}

export const dataModelNodeSchema: z.ZodType<DataModelNode> = z.object({
  ...dataModelNodeFields,
  annotation: dataModelAnnotationSchema.optional(),
  get children() {
    return z.array(dataModelNodeSchema).optional();
  },
});

export const overlayDataModelNodeSchema: z.ZodType<OverlayDataModelNode> = z.object({
  ...dataModelNodeFields,
  annotation: overlayDataModelAnnotationSchema.optional(),
  get children() {
    return z.array(overlayDataModelNodeSchema).optional();
  },
});

const dataModelFields = {
  id: idSchema,
  type: z.literal('data-model'),
  title: z.string().min(1).optional(),
  /** The type definition the whole model is drawn from, shown in the header. */
  source: anchorSchema.optional(),
} as const;

interface NamedTreeNode {
  readonly name: string;
  readonly children?: readonly NamedTreeNode[] | undefined;
}

/** Reject duplicate sibling names anywhere in the tree — paths stay unambiguous. */
function checkSiblingNames(
  nodes: readonly NamedTreeNode[],
  path: readonly (string | number)[],
  ctx: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    if (seen.has(node.name)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate sibling node name "${node.name}" — node paths must be unambiguous`,
        path: [...path, index, 'name'],
      });
    }
    seen.add(node.name);
    if (node.children !== undefined) {
      checkSiblingNames(node.children, [...path, index, 'children'], ctx);
    }
  });
}

/**
 * Annotated data-model explorer: a tree of fields with expand/collapse and
 * per-node annotations linking each field back to the code that reads it.
 */
export const dataModelWidgetSchema = z
  .object({
    ...dataModelFields,
    nodes: z.array(dataModelNodeSchema).min(1, 'a data model needs at least one node'),
  })
  .superRefine((widget, ctx) => checkSiblingNames(widget.nodes, ['nodes'], ctx));

export const overlayDataModelWidgetSchema = z
  .object({
    ...dataModelFields,
    nodes: z.array(overlayDataModelNodeSchema).min(1, 'a data model needs at least one node'),
  })
  .superRefine((widget, ctx) => checkSiblingNames(widget.nodes, ['nodes'], ctx));

/**
 * Human-overlay callout: identical shape, but anchors are optional — tribal
 * knowledge is allowed to be unanchored.
 */
export const overlayCalloutWidgetSchema = z.object({
  ...calloutFields,
  anchors: z.array(anchorSchema).optional(),
});

/**
 * A grounded prose note attached to a state, transition, or pipeline stage.
 * In the machine base, anchors are a structural requirement; the overlay
 * variant relaxes them for tribal knowledge.
 */
const anchoredNoteSchema = z.object({
  body: z.string().min(1, 'note body must be non-empty'),
  anchors: z
    .array(anchorSchema)
    .min(1, 'machine-generated content must carry at least one code anchor'),
});

const overlayNoteSchema = z.object({
  body: z.string().min(1, 'note body must be non-empty'),
  anchors: z.array(anchorSchema).optional(),
});

/**
 * State-machine widget: clickable states, animated transition paths. Base and
 * overlay variants share everything except the anchor requirement on the
 * machine-generated prose (state descriptions and edge commentary), so both
 * are stamped from this factory.
 */
function stateMachineWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      id: idSchema,
      type: z.literal('state-machine'),
      title: z.string().min(1).optional(),
      states: z
        .array(
          z.object({
            id: idSchema,
            label: z.string().min(1, 'state.label must be non-empty'),
            description: noteSchema.optional(),
          }),
        )
        .min(1, 'a state machine needs at least one state'),
      transitions: z.array(
        z.object({
          from: idSchema,
          to: idSchema,
          trigger: z.string().min(1, 'transition.trigger must be non-empty'),
          commentary: noteSchema.optional(),
        }),
      ),
    })
    .superRefine((machine, ctx) => {
      const stateIds = new Set<string>();
      machine.states.forEach((state, index) => {
        if (stateIds.has(state.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['states', index, 'id'],
            message: `duplicate state id "${state.id}"`,
          });
        }
        stateIds.add(state.id);
      });
      machine.transitions.forEach((transition, index) => {
        for (const end of ['from', 'to'] as const) {
          if (!stateIds.has(transition[end])) {
            ctx.addIssue({
              code: 'custom',
              path: ['transitions', index, end],
              message: `transition.${end} references unknown state "${transition[end]}"`,
            });
          }
        }
      });
    });
}

/**
 * Machine-generated state machine: every description and commentary must be
 * anchored.
 */
export const stateMachineWidgetSchema = stateMachineWidgetWith(anchoredNoteSchema);

export const overlayStateMachineWidgetSchema = stateMachineWidgetWith(overlayNoteSchema);

/** One choice of a decision-table select input. */
export const decisionTableOptionSchema = z.object({
  value: z.string().min(1, 'option.value must be non-empty'),
  /** Display label; the raw value is shown when omitted. */
  label: z.string().min(1).optional(),
});

/**
 * A declared decision-table input — the small typed form the learner edits.
 * Booleans render as yes/no chips, selects as dropdowns; `default` is the
 * value the playground starts from. Select defaults must name a declared
 * option — enforced at the widget level, where the whole table is in view.
 */
export const decisionTableInputSchema = z.discriminatedUnion('type', [
  z.object({
    id: idSchema,
    label: z.string().min(1, 'input.label must be non-empty'),
    type: z.literal('boolean'),
    default: z.boolean(),
  }),
  z.object({
    id: idSchema,
    label: z.string().min(1, 'input.label must be non-empty'),
    type: z.literal('select'),
    options: z
      .array(decisionTableOptionSchema)
      .min(2, 'a select input needs at least two options'),
    default: z.string().min(1),
  }),
]);

/**
 * One equality test over a declared input's current value. A rule matches
 * when every one of its conditions holds (AND).
 */
export const decisionTableConditionSchema = z.object({
  input: idSchema,
  equals: z.union([z.boolean(), z.string().min(1)]),
});

/**
 * Decision-table / rule playground: the learner edits the declared inputs,
 * the table is evaluated top to bottom, and the FIRST rule whose conditions
 * all hold wins — later rules are not evaluated (the table short-circuits,
 * like the reference lab's "personal guarantee" table). When no rule
 * matches, the optional `defaultOutcome` applies.
 *
 * Base and overlay variants share everything except the anchor requirement
 * on the machine-generated prose (rule and default-outcome explanations),
 * so both are stamped from this factory. Cross-references are spec bugs,
 * not rendering concerns: every condition must name a declared input and,
 * for selects, a declared option value.
 */
function decisionTableWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      id: idSchema,
      type: z.literal('decision-table'),
      title: z.string().min(1).optional(),
      inputs: z
        .array(decisionTableInputSchema)
        .min(1, 'a decision table needs at least one input'),
      rules: z
        .array(
          z.object({
            when: z
              .array(decisionTableConditionSchema)
              .min(1, 'a rule needs at least one condition'),
            outcome: z.string().min(1, 'rule.outcome must be non-empty'),
            explanation: noteSchema,
          }),
        )
        .min(1, 'a decision table needs at least one rule'),
      defaultOutcome: z
        .object({
          outcome: z.string().min(1, 'defaultOutcome.outcome must be non-empty'),
          explanation: noteSchema.optional(),
        })
        .optional(),
    })
    .superRefine((widget, ctx) => {
      const inputsById = new Map<string, DecisionTableInput>();
      widget.inputs.forEach((input, index) => {
        if (inputsById.has(input.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['inputs', index, 'id'],
            message: `duplicate input id "${input.id}"`,
          });
        }
        inputsById.set(input.id, input);
        if (input.type !== 'select') return;
        const values = new Set<string>();
        input.options.forEach((option, optionIndex) => {
          if (values.has(option.value)) {
            ctx.addIssue({
              code: 'custom',
              path: ['inputs', index, 'options', optionIndex, 'value'],
              message: `duplicate option value "${option.value}" on input "${input.id}"`,
            });
          }
          values.add(option.value);
        });
        if (!values.has(input.default)) {
          ctx.addIssue({
            code: 'custom',
            path: ['inputs', index, 'default'],
            message: `default "${input.default}" is not an option of select input "${input.id}"`,
          });
        }
      });
      widget.rules.forEach((rule, ruleIndex) => {
        rule.when.forEach((condition, conditionIndex) => {
          const path = ['rules', ruleIndex, 'when', conditionIndex];
          const input = inputsById.get(condition.input);
          if (input === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'input'],
              message: `condition references undeclared input "${condition.input}"`,
            });
            return;
          }
          if (input.type === 'boolean' && typeof condition.equals !== 'boolean') {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'equals'],
              message: `condition on boolean input "${input.id}" must compare against a boolean`,
            });
          }
          if (
            input.type === 'select' &&
            (typeof condition.equals !== 'string' ||
              !input.options.some((option) => option.value === condition.equals))
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'equals'],
              message: `${JSON.stringify(condition.equals)} is not an option of select input "${input.id}"`,
            });
          }
        });
      });
    });
}

/**
 * Machine-generated decision table: every rule explanation (and the default
 * outcome's, when present) must be anchored.
 */
export const decisionTableWidgetSchema = decisionTableWidgetWith(anchoredNoteSchema);

export const overlayDecisionTableWidgetSchema = decisionTableWidgetWith(overlayNoteSchema);

/**
 * A 1-based inclusive line range *within a widget's own code excerpt* (not
 * within the source file — the `source` anchor carries file coordinates).
 */
const excerptLineRangeSchema = z
  .object({
    start: z.int().positive(),
    end: z.int().positive(),
  })
  .refine((range) => range.end >= range.start, {
    message: 'lines.end must be >= lines.start',
  });

/**
 * Fields shared by both code widgets: the displayed excerpt (one array entry
 * per line, so line counts are structural) and an optional `source` anchor
 * saying where the excerpt lives in the repo. The key is named `source` on
 * purpose — anchor resolution collects `source` fields structurally, and the
 * renderer numbers the gutter from `source.lines.start`.
 */
const codeExcerptFields = {
  id: idSchema,
  code: z.array(z.string()).min(1, 'a code excerpt needs at least one line'),
  source: anchorSchema.optional(),
} as const;

/** Flag any step/highlight range that points past the end of the excerpt. */
function checkExcerptRange(
  range: { start: number; end: number },
  lineCount: number,
  path: readonly (string | number)[],
  ctx: z.core.$RefinementCtx,
): void {
  if (range.end > lineCount) {
    ctx.addIssue({
      code: 'custom',
      path: [...path],
      message: `line range ${range.start}–${range.end} exceeds the excerpt (${lineCount} line${lineCount === 1 ? '' : 's'})`,
    });
  }
}

/**
 * Code walkthrough: the reference lab's step-through panel. Prev/next moves
 * through an ordered list of steps; each step highlights a line range of the
 * excerpt and shows its commentary. Commentary is a teachable unit, so the
 * base variant requires anchors; both variants are stamped from this factory.
 */
function codeWalkthroughWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      ...codeExcerptFields,
      type: z.literal('code-walkthrough'),
      title: z.string().min(1).optional(),
      steps: z
        .array(
          z.object({
            /** Excerpt-relative lines this step lights up (1 = first code entry). */
            lines: excerptLineRangeSchema,
            commentary: noteSchema,
          }),
        )
        .min(1, 'a code walkthrough needs at least one step'),
    })
    .superRefine((widget, ctx) => {
      widget.steps.forEach((step, index) => {
        checkExcerptRange(step.lines, widget.code.length, ['steps', index, 'lines'], ctx);
      });
    });
}

/**
 * Machine-generated walkthrough: every step's commentary must be anchored.
 */
export const codeWalkthroughWidgetSchema = codeWalkthroughWidgetWith(anchoredNoteSchema);

export const overlayCodeWalkthroughWidgetSchema = codeWalkthroughWidgetWith(overlayNoteSchema);

/**
 * Code figure: a standalone highlighted excerpt with an anchored caption —
 * the reference lab's `figure.code` block used across modules. The caption is
 * the teachable unit (anchors required in the base); `highlight` optionally
 * lights up the lines the caption talks about.
 */
function codeFigureWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      ...codeExcerptFields,
      type: z.literal('code-figure'),
      caption: noteSchema,
      /** Excerpt-relative lines to emphasize, if any. */
      highlight: excerptLineRangeSchema.optional(),
    })
    .superRefine((widget, ctx) => {
      if (widget.highlight !== undefined) {
        checkExcerptRange(widget.highlight, widget.code.length, ['highlight'], ctx);
      }
    });
}

export const codeFigureWidgetSchema = codeFigureWidgetWith(anchoredNoteSchema);

export const overlayCodeFigureWidgetSchema = codeFigureWidgetWith(overlayNoteSchema);

/**
 * What flows through a pipeline stage: the data it receives and the data it
 * hands to the next stage. Short structural labels (like transition
 * triggers), so no anchor requirement — the stage's description carries the
 * grounded prose.
 */
export const pipelineFlowSchema = z
  .object({
    in: z.string().min(1).optional(),
    out: z.string().min(1).optional(),
  })
  .refine((flow) => flow.in !== undefined || flow.out !== undefined, {
    message: 'flow must name what comes in, what goes out, or both',
  });

/**
 * Pipeline-runner widget: a staged process animation. Stages run in spec
 * order — the learner plays or steps through them, and each stage lights up
 * with its description (the anchored teachable unit) and what flows in/out.
 * Base and overlay variants share everything except the anchor requirement
 * on stage descriptions, so both are stamped from this factory.
 */
function pipelineWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      id: idSchema,
      type: z.literal('pipeline'),
      title: z.string().min(1).optional(),
      stages: z
        .array(
          z.object({
            id: idSchema,
            label: z.string().min(1, 'stage.label must be non-empty'),
            description: noteSchema.optional(),
            flow: pipelineFlowSchema.optional(),
          }),
        )
        .min(1, 'a pipeline needs at least one stage'),
    })
    .superRefine((pipeline, ctx) => {
      const stageIds = new Set<string>();
      pipeline.stages.forEach((stage, index) => {
        if (stageIds.has(stage.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', index, 'id'],
            message: `duplicate stage id "${stage.id}"`,
          });
        }
        stageIds.add(stage.id);
      });
    });
}

/** One selectable answer. The id is stable so checkpoint results survive regeneration. */
export const quizOptionSchema = z.object({
  id: idSchema,
  label: z.string().min(1, 'option.label must be non-empty'),
});

/**
 * Checkpoint quiz: end-of-module multiple choice. The explanation is the
 * teachable unit — a quiz answer is a machine claim about the code, so in the
 * base it must be anchored (PLAN.md §3); the overlay variant relaxes that.
 * Base and overlay are stamped from this factory, like the state machine.
 *
 * The correct answer is referenced by option id (not index) so a regenerated
 * question can reorder options without silently flipping the answer.
 */
function quizWidgetWith<Note extends z.ZodType>(noteSchema: Note) {
  return z
    .object({
      id: idSchema,
      type: z.literal('quiz'),
      title: z.string().min(1).optional(),
      questions: z
        .array(
          z.object({
            id: idSchema,
            prompt: z.string().min(1, 'question.prompt must be non-empty'),
            options: z
              .array(quizOptionSchema)
              .min(2, 'a question needs at least two options'),
            correctOptionId: idSchema,
            explanation: noteSchema,
          }),
        )
        .min(1, 'a quiz needs at least one question'),
    })
    .superRefine((quiz, ctx) => {
      const questionIds = new Set<string>();
      quiz.questions.forEach((question, questionIndex) => {
        if (questionIds.has(question.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions', questionIndex, 'id'],
            message: `duplicate question id "${question.id}"`,
          });
        }
        questionIds.add(question.id);
        const optionIds = new Set<string>();
        question.options.forEach((option, optionIndex) => {
          if (optionIds.has(option.id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['questions', questionIndex, 'options', optionIndex, 'id'],
              message: `duplicate option id "${option.id}"`,
            });
          }
          optionIds.add(option.id);
        });
        if (!optionIds.has(question.correctOptionId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['questions', questionIndex, 'correctOptionId'],
            message: `correctOptionId references unknown option "${question.correctOptionId}"`,
          });
        }
      });
    });
}

/**
 * Machine-generated pipeline: every stage description must be anchored.
 */
export const pipelineWidgetSchema = pipelineWidgetWith(anchoredNoteSchema);

export const overlayPipelineWidgetSchema = pipelineWidgetWith(overlayNoteSchema);

/** Machine-generated quiz: every answer's explanation must be anchored. */
export const quizWidgetSchema = quizWidgetWith(anchoredNoteSchema);

export const overlayQuizWidgetSchema = quizWidgetWith(overlayNoteSchema);

/**
 * All widget types allowed in the machine-owned base. The discriminated union
 * is the extension point for the rest of the widget library.
 */
export const baseWidgetSchema = z.discriminatedUnion('type', [
  calloutWidgetSchema,
  systemMapWidgetSchema,
  dataModelWidgetSchema,
  stateMachineWidgetSchema,
  decisionTableWidgetSchema,
  codeWalkthroughWidgetSchema,
  codeFigureWidgetSchema,
  pipelineWidgetSchema,
  quizWidgetSchema,
]);

export const overlayWidgetSchema = z.discriminatedUnion('type', [
  overlayCalloutWidgetSchema,
  overlayDataModelWidgetSchema,
  overlayStateMachineWidgetSchema,
  overlayDecisionTableWidgetSchema,
  overlayCodeWalkthroughWidgetSchema,
  overlayCodeFigureWidgetSchema,
  overlayPipelineWidgetSchema,
  overlayQuizWidgetSchema,
]);

export const moduleSchema = z.object({
  id: idSchema,
  title: z.string().min(1),
  summary: z.string().optional(),
  widgets: z.array(baseWidgetSchema),
});

/**
 * One human edit, keyed to stable IDs in the base. v1 supports a single
 * operation: insert a widget into a module (after a given widget, or at the
 * end). Never silently discarded on regeneration.
 */
export const overlayEntrySchema = z.object({
  id: idSchema,
  target: z.object({
    moduleId: idSchema,
    afterWidgetId: idSchema.optional(),
  }),
  widget: overlayWidgetSchema,
});

export const labSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: idSchema,
  title: z.string().min(1),
  repo: z.string().optional(),
  /** What kind of codebase this is, e.g. "TypeScript · Next.js" — the shelf
   * card's kicker. Stamped mechanically at pressing time (job.ts), or by the
   * eval report's richer judge-written profile for catalog editions. */
  profile: z.string().optional(),
  /**
   * Who pressed this edition, for the shelf's "Pressed by …" line (founder,
   * 2026-07-26). Provenance like `repo` and `profile`, and stamped the same
   * way: by the press, never by the presser.
   *
   * **Server-authoritative.** The hosted press stamps it from the signed-in
   * session; a press with nobody signed in leaves it absent, which is the
   * honest answer and keeps anonymous public pressing (pricing D1) as
   * friction-free as it was. Anything that ingests a spec pressed on someone
   * else's machine MUST overwrite whatever this says with the authenticated
   * uploader, because a local file can claim any name at all.
   */
  pressedBy: z.string().min(1).optional(),
  /**
   * The commit this edition was pressed from (founder, 2026-07-26).
   *
   * Anchors are only checkable against the tree they were written against.
   * Without this, anyone re-verifying a spec clones `HEAD`, the repository has
   * moved on, honest anchors drift, and a sound edition is rejected for a
   * reason that is not its fault. With it, verification is exact and the
   * library can also say "pressed against abc1234, the repo has moved on
   * since" — the staleness signal the anchor fingerprints were designed for.
   */
  commit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, 'commit must be a lowercase hex git sha')
    .optional(),
  base: z.object({
    modules: z.array(moduleSchema).min(1, 'a lab needs at least one module'),
  }),
  overlay: z.array(overlayEntrySchema).default([]),
});

export type Anchor = z.infer<typeof anchorSchema>;
export type CalloutKind = z.infer<typeof calloutKindSchema>;
export type CalloutWidget = z.infer<typeof calloutWidgetSchema>;
export type SystemMapNode = z.infer<typeof systemMapNodeSchema>;
export type SystemMapEdge = z.infer<typeof systemMapEdgeSchema>;
export type SystemMapWidget = z.infer<typeof systemMapWidgetSchema>;
export type DataModelAnnotation = z.infer<typeof dataModelAnnotationSchema>;
export type DataModelWidget = z.infer<typeof dataModelWidgetSchema>;
export type OverlayCalloutWidget = z.infer<typeof overlayCalloutWidgetSchema>;
export type OverlayDataModelAnnotation = z.infer<typeof overlayDataModelAnnotationSchema>;
export type OverlayDataModelWidget = z.infer<typeof overlayDataModelWidgetSchema>;
export type StateMachineWidget = z.infer<typeof stateMachineWidgetSchema>;
export type OverlayStateMachineWidget = z.infer<typeof overlayStateMachineWidgetSchema>;
/** Widest (overlay) shapes — what the renderer consumes. */
export type StateMachineNote = z.infer<typeof overlayNoteSchema>;
export type StateMachineState = OverlayStateMachineWidget['states'][number];
export type StateMachineTransition = OverlayStateMachineWidget['transitions'][number];
export type DecisionTableOption = z.infer<typeof decisionTableOptionSchema>;
export type DecisionTableInput = z.infer<typeof decisionTableInputSchema>;
export type DecisionTableCondition = z.infer<typeof decisionTableConditionSchema>;
/** A learner-editable input value: booleans for toggles, strings for selects. */
export type DecisionTableInputValue = DecisionTableCondition['equals'];
export type DecisionTableWidget = z.infer<typeof decisionTableWidgetSchema>;
export type OverlayDecisionTableWidget = z.infer<typeof overlayDecisionTableWidgetSchema>;
/** Widest (overlay) shapes — what the renderer consumes. */
export type DecisionTableExplanation = z.infer<typeof overlayNoteSchema>;
export type DecisionTableRule = OverlayDecisionTableWidget['rules'][number];
export type DecisionTableDefaultOutcome = NonNullable<
  OverlayDecisionTableWidget['defaultOutcome']
>;
export type CodeWalkthroughWidget = z.infer<typeof codeWalkthroughWidgetSchema>;
export type OverlayCodeWalkthroughWidget = z.infer<typeof overlayCodeWalkthroughWidgetSchema>;
/** Widest (overlay) step shape — what the renderer consumes. */
export type CodeWalkthroughStep = OverlayCodeWalkthroughWidget['steps'][number];
export type CodeFigureWidget = z.infer<typeof codeFigureWidgetSchema>;
export type OverlayCodeFigureWidget = z.infer<typeof overlayCodeFigureWidgetSchema>;
export type PipelineFlow = z.infer<typeof pipelineFlowSchema>;
export type PipelineWidget = z.infer<typeof pipelineWidgetSchema>;
export type OverlayPipelineWidget = z.infer<typeof overlayPipelineWidgetSchema>;
/** Widest (overlay) stage shape — what the renderer consumes. */
export type PipelineStage = OverlayPipelineWidget['stages'][number];
export type QuizOption = z.infer<typeof quizOptionSchema>;
export type QuizWidget = z.infer<typeof quizWidgetSchema>;
export type OverlayQuizWidget = z.infer<typeof overlayQuizWidgetSchema>;
/** Widest (overlay) question shape — what the renderer consumes. */
export type QuizQuestion = OverlayQuizWidget['questions'][number];
export type BaseWidget = z.infer<typeof baseWidgetSchema>;
export type OverlayWidget = z.infer<typeof overlayWidgetSchema>;
export type LabModule = z.infer<typeof moduleSchema>;
export type OverlayEntry = z.infer<typeof overlayEntrySchema>;
export type LabSpec = z.infer<typeof labSpecSchema>;
