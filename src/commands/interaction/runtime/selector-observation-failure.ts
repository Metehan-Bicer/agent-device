import { formatSelectorFailure, selectorFailureHint } from '@agent-device/selectors';
import type { SelectorPipelineOutcome } from '@agent-device/selectors/selector-pipeline';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { AppError, type AppErrorDetails } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { formatSnapshotLine } from '@agent-device/capture-kit/snapshot-lines';

/**
 * The shared failure door for the observation reads that refuse to guess which
 * element they mean (`is` predicates other than `exists`/`absent`, and
 * `get attrs` — both `readUnique` rows). The pipeline reports three distinct
 * refusals and they are three different facts about the screen, so the door
 * keys on the outcome kind, never on message text:
 *
 * - `none` — nothing matched: `selector_not_found`, which genuinely means the
 *   element is not in the tree.
 * - `ambiguous` — N nodes matched and the row refuses to choose:
 *   `selector_ambiguous` with the match count and bounded candidate lines,
 *   shaped exactly like the acting rows' `AMBIGUOUS_MATCH` so every surface
 *   renders candidates from one reader. #2870: this used to be reported as
 *   `selector_not_found`, which to an agent reads as "the element does not
 *   exist" on a screen where it is plainly on display.
 * - `occluded` — the row ignores occlusion and cannot produce it; the caller
 *   keeps its own not-found shape.
 */

/** Bounded like the acting refusal: enough @refs to retry, never an unbounded payload. */
const OBSERVATION_CANDIDATE_LIMIT = 5;

function selectorNotFoundFailure(
  selectorExpression: string,
  options: { command: string; unique: boolean } & AppErrorDetails,
): AppError {
  const { command, unique, ...details } = options;
  return new AppError('COMMAND_FAILED', formatSelectorFailure(selectorExpression, [], { unique }), {
    command,
    reason: INTERACTION_ERROR_REASONS.selectorNotFound,
    hint: selectorFailureHint([]),
    ...details,
  });
}

function selectorAmbiguousFailure(
  selector: string,
  matchedNodes: readonly SnapshotNode[],
  options: { command: string } & AppErrorDetails,
): AppError {
  const { command, ...details } = options;
  return new AppError(
    'AMBIGUOUS_MATCH',
    `Selector matched ${matchedNodes.length} elements: ${selector}`,
    {
      command,
      reason: INTERACTION_ERROR_REASONS.selectorAmbiguous,
      selector,
      matches: matchedNodes.length,
      candidates: matchedNodes
        .slice(0, OBSERVATION_CANDIDATE_LIMIT)
        .map((candidate) => formatSnapshotLine(candidate, 0, false)),
      hint: `List the matches with find '${selector}' list, then re-run with one printed @ref or a more specific selector.`,
      ...details,
    },
  );
}

/** The refusal this observation route owes its caller for a non-target pipeline outcome. */
export function observationReadFailure(params: {
  outcome: SelectorPipelineOutcome;
  selectorExpression: string;
  command: string;
  details?: AppErrorDetails;
}): AppError {
  const { outcome, selectorExpression, command, details } = params;
  if (outcome.kind === 'ambiguous') {
    return selectorAmbiguousFailure(outcome.selector, outcome.matchedNodes, {
      command,
      ...details,
    });
  }
  return selectorNotFoundFailure(selectorExpression, { command, unique: true, ...details });
}
