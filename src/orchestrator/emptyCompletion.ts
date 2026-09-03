/**
 * Bounded recovery for a clean harness turn that performed tool work but
 * ended without a user-facing answer.
 *
 * This is intentionally a request-level continuation rather than a channel
 * workaround: the harness receives the same logical conversation and the
 * existing orchestration layer remains responsible for streaming the result.
 */

import type { HarnessRequest } from "../harnesses/types.ts";

/** Exactly one finalization attempt is allowed for an empty completion. */
export const MAX_EMPTY_COMPLETION_FINALIZATIONS = 1;

export const EMPTY_COMPLETION_FINALIZATION_PROMPT =
  "[Internal finalization] The tool work for this turn has completed, but no final response was produced. Give the user the concise final result now. Do not repeat the work or perform additional tool calls unless absolutely necessary to state the result.";

/** Preserve the request's logical conversation while asking only for closure. */
export function buildEmptyCompletionRequest(
  req: HarnessRequest,
): HarnessRequest {
  return {
    ...req,
    userMessage: `${req.userMessage}\n\n${EMPTY_COMPLETION_FINALIZATION_PROMPT}`,
  };
}
