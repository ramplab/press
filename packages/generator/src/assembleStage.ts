import { parseLabSpec, type LabModule, type LabSpec } from '@ramplab/spec';
import {
  resolveAnchors,
  type ResolutionPolicy,
  type ResolutionReport,
} from './resolveAnchors.js';

/**
 * The assemble stage (PLAN.md §4): merge the map stage's overview module and
 * the authored modules — in plan order — into one lab spec, revalidate the
 * whole thing against `@ramplab/spec`, and run anchor resolution per policy.
 *
 * Deliberately **mechanical**: no model call. Every creative decision was
 * made upstream (map named the lab, plan ordered the modules, authors wrote
 * the content); assembly only merges, validates, and grounds. Module ids are
 * already stable — `repo-overview` from the map stage, plan ids for authored
 * modules — so overlay entries and learner progress survive regeneration.
 */

export interface AssembleOptions {
  /** @default 'drop' */
  policy?: ResolutionPolicy;
  /**
   * Id of the authored module that opens the lab (issue #18, iteration 2):
   * concrete-before-abstract applies to the curriculum too, so the flagship
   * trace goes first and the map's overview module follows as the zoom-out.
   * Undefined or unmatched keeps the map's modules first.
   */
  leadModuleId?: string;
}

export interface AssembleResult {
  /** The merged, validated, anchor-resolved lab spec. */
  spec: LabSpec;
  /** Full anchor-resolution report over the merged spec. */
  report: ResolutionReport;
}

/**
 * Merge `authoredModules` (already in plan order) with the map spec's own
 * modules and revalidate. The module named by `leadModuleId` — the flagship
 * trace — is pulled to the front so the learner meets walked code before the
 * map's architectural overview; the remaining authored modules keep plan
 * order after it. Throws `LabSpecParseError` if the merge violates the spec
 * schema — e.g. a duplicate module id, which upstream stages are built to
 * prevent.
 */
export function assembleLab(
  mapSpec: LabSpec,
  authoredModules: readonly LabModule[],
  repoDir: string,
  options: AssembleOptions = {},
): AssembleResult {
  const lead = authoredModules.filter((m) => m.id === options.leadModuleId);
  const rest = authoredModules.filter((m) => m.id !== options.leadModuleId);
  const candidate = {
    schemaVersion: mapSpec.schemaVersion,
    id: mapSpec.id,
    title: mapSpec.title,
    ...(mapSpec.repo !== undefined ? { repo: mapSpec.repo } : {}),
    base: {
      modules: [...lead, ...mapSpec.base.modules, ...rest],
    },
    overlay: mapSpec.overlay,
  };

  // Single validation path: a JSON round-trip plus parseLabSpec guarantees
  // the merged spec is exactly what a consumer would load from disk.
  const merged = parseLabSpec(JSON.parse(JSON.stringify(candidate)));

  const { spec, report } = resolveAnchors(merged, repoDir, {
    policy: options.policy ?? 'drop',
  });
  return { spec, report };
}
