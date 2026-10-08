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
 *   `AMBIGUOUS_MATCH`, the code the acting refusal already answers with
 *   (ADR 0011's bounded-disclosure shape: count, capped candidate snapshot
 *   lines, retryable refs), so no new machine vocabulary is introduced and
 *   every surface renders candidates from the one existing reader. #2870:
 *   this used to be reported as `selector_not_found`, which to an agent reads
 *   as "the element does not exist" on a screen where it is plainly on display.
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
      selector,
      matches: matchedNodes.length,
      candidates: matchedNodes
        .slice(0, OBSERVATION_CANDIDATE_LIMIT)
        .map((candidate) => formatSnapshotLine(candidate, 0, false)),
      hint: `Narrow the selector with role/id/longer text, or act on a printed candidate with a command that takes refs, such as press.`,
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
