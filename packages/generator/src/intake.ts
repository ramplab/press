/**
 * Lead intake (PLAN.md §4, curation loop step 1): the optional 2-minute
 * questionnaire an onboarding lead fills in before generation. Three
 * questions, three string lists — deliberately free-form, because the lead
 * types answers, not configuration.
 *
 * The intake steers generation in two places:
 * - the **curriculum-plan prompt** (module selection and ordering), and
 * - the **pass-1 flagship pick** (an intake hint that matches a system-map
 *   node overrides the pure-centrality choice — see `flagship.ts`).
 *
 * It is prompt/heuristic *input* only: nothing from the intake is copied
 * into the lab spec, so `@ramplab/spec` is untouched.
 */

export interface LeadIntake {
  /** "What must a week-one hire master?" */
  weekOneMastery?: string[];
  /** "What is under active development?" */
  activeDevelopment?: string[];
  /** "What trips people up?" */
  gotchas?: string[];
}

/** True when at least one intake question has at least one answer. */
export function hasIntakeAnswers(intake: LeadIntake | undefined): intake is LeadIntake {
  if (intake === undefined) return false;
  return (
    (intake.weekOneMastery?.length ?? 0) > 0 ||
    (intake.activeDevelopment?.length ?? 0) > 0 ||
    (intake.gotchas?.length ?? 0) > 0
  );
}

/**
 * Render the intake as a prompt section for the curriculum planner (and the
 * flagship author's brief). Returns `''` when there is nothing to say, so
 * callers can interpolate unconditionally.
 */
export function renderIntakeSection(intake: LeadIntake | undefined): string {
  if (!hasIntakeAnswers(intake)) return '';

  const blocks: string[] = [
    'The onboarding lead completed a 2-minute intake. Let these answers steer ' +
      'which modules you choose, how you order them, and what you emphasize:',
  ];
  const question = (label: string, answers: string[] | undefined): void => {
    if (answers === undefined || answers.length === 0) return;
    blocks.push(`${label}\n${answers.map((a) => `- ${a}`).join('\n')}`);
  };
  question('What must a week-one hire master? (teach these first)', intake.weekOneMastery);
  question(
    'What is under active development? (favor the current code paths)',
    intake.activeDevelopment,
  );
  question(
    'What trips people up? (call these out in the modules that touch them)',
    intake.gotchas,
  );
  return `\n${blocks.join('\n\n')}\n`;
}
