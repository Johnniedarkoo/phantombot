/**
 * Bounded recovery for a clean harness turn that performed tool work but
 * ended without a user-facing answer.
 *
 * This is intentionally a request-level continuation rather than a channel
 * workaround: the harness receives the same logical conversation and the
 * existing orchestration layer remains responsible for streaming the result.
 */

import type { HarnessRequest } from "../harnesses/types.ts";
import type { PartialAttempt } from "./resume.ts";

/** Exactly one finalization attempt is allowed for an empty completion. */
export const MAX_EMPTY_COMPLETION_FINALIZATIONS = 1;

export const EMPTY_COMPLETION_FINALIZATION_PROMPT =
  "[Internal finalization] The tool work for this turn has completed, but no final response was produced. Give the user the concise final result now. Do not repeat the work or perform additional tool calls unless absolutely necessary to state the result.";

/** Preserve the request's logical conversation while asking only for closure. */
export function buildEmptyCompletionRequest(
  req: HarnessRequest,
  partial: PartialAttempt,
): HarnessRequest {
  const lines = [
    "[phantombot — automatic finalization of a completed turn]",
    "",
    "The previous process completed its tool work but did not provide a final user-facing answer. This is a fresh process with the original conversation and user request above.",
  ];
  if (partial.text) {
    lines.push(
      "",
      "The previous process had already narrated this to the user; do not repeat it:",
      "---",
      partial.text,
      "---",
    );
  }
  if (partial.toolCalls.length > 0) {
    lines.push(
      "",
      "These tool calls were observed during the completed work:",
      ...partial.toolCalls.map((call) => `  - ${call}`),
    );
    if (partial.droppedToolCalls > 0) {
      lines.push(`  - (…and ${partial.droppedToolCalls} more, not listed)`);
    }
    lines.push(
      "Their detailed results are not available to this fresh process. Do not repeat the work or perform more tool calls unless absolutely necessary to state the result.",
    );
  }
  lines.push(EMPTY_COMPLETION_FINALIZATION_PROMPT);
  return {
    ...req,
    userMessage: `${req.userMessage}\n\n${lines.join("\n")}`,
  };
}
