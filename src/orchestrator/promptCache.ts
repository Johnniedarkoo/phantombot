import { createHash } from "node:crypto";

import type { PromptCacheSettings } from "../config.ts";
import type { HistoryTurn } from "../harnesses/types.ts";
import {
  renderConversationPayload,
  type PromptEpochTurn,
} from "../harnesses/payload.ts";

const DEFAULT_HISTORY_LIMIT = 30;

interface EpochState {
  key: string;
  persona: string;
  conversation: string;
  systemFingerprint: string;
  baseHistory: HistoryTurn[];
  canonicalHistory: HistoryTurn[];
  epochTurns: PromptEpochTurn[];
  active: boolean;
}

export interface PromptCacheEpochPlan {
  readonly state: EpochState;
  readonly baseHistory: readonly HistoryTurn[];
  readonly epochTurns: readonly PromptEpochTurn[];
  readonly turnContext: string | undefined;
  readonly userMessage: string;
  readonly rebased: boolean;
  readonly retainEpoch: boolean;
}

export interface PreparePromptCacheInput {
  settings: PromptCacheSettings;
  persona: string;
  conversation: string;
  systemPrompt: string;
  history: readonly HistoryTurn[];
  historyLimit?: number;
  turnContext?: string;
  userMessage: string;
}

/**
 * In-process prompt-cache state. It contains only disposable serialization
 * artifacts. Canonical history remains in PhantomBot's MemoryStore and is
 * re-read on every turn so a restart, edit, reset, or process race can only
 * cause a benign rebase.
 */
export class PromptCacheEpochManager {
  private readonly states = new Map<string, EpochState>();

  prepare(input: PreparePromptCacheInput): PromptCacheEpochPlan | undefined {
    if (!input.settings.enabled) return undefined;

    const key = cacheKey(input.persona, input.conversation);
    const historyLimit = Math.max(
      0,
      input.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    );
    const fingerprint = systemFingerprint(input.systemPrompt);
    let state = this.states.get(key);
    let rebased = false;

    if (
      !state ||
      state.active ||
      state.systemFingerprint !== fingerprint ||
      !sameHistory(
        input.history,
        historyTail(state.canonicalHistory, historyLimit),
      )
    ) {
      state = this.newState({
        key,
        persona: input.persona,
        conversation: input.conversation,
        systemFingerprint: fingerprint,
        history: input.history,
      });
      this.states.set(key, state);
      rebased = true;
    }

    const projected = estimatePromptBytes({
      systemPrompt: input.systemPrompt,
      history: state.baseHistory,
      epochTurns: state.epochTurns,
      turnContext: input.turnContext,
      userMessage: input.userMessage,
    });

    // A full canonical prompt can itself be larger than the configured
    // optimization budget. Preserve normal chat correctness in that case:
    // send this turn from canonical history and do not retain an oversized
    // epoch. The budget is a cache-epoch ceiling, not a reason to reject a
    // user turn.
    let retainEpoch = true;
    if (projected > input.settings.maxEpochBytes) {
      if (state.epochTurns.length > 0) {
        state = this.newState({
          key,
          persona: input.persona,
          conversation: input.conversation,
          systemFingerprint: fingerprint,
          history: input.history,
        });
        this.states.set(key, state);
        rebased = true;
      }
      if (
        estimatePromptBytes({
          systemPrompt: input.systemPrompt,
          history: state.baseHistory,
          epochTurns: [],
          turnContext: input.turnContext,
          userMessage: input.userMessage,
        }) > input.settings.maxEpochBytes
      ) {
        state.active = true;
        retainEpoch = false;
        return {
          state,
          baseHistory: state.baseHistory,
          epochTurns: [],
          turnContext: input.turnContext,
          userMessage: input.userMessage,
          rebased,
          retainEpoch,
        };
      }
    }

    state.active = true;
    return {
      state,
      baseHistory: state.baseHistory,
      epochTurns: state.epochTurns,
      turnContext: input.turnContext,
      userMessage: input.userMessage,
      rebased,
      retainEpoch,
    };
  }

  complete(plan: PromptCacheEpochPlan, assistantMessage: string): void {
    const state = plan.state;
    state.active = false;
    if (this.states.get(state.key) !== state) return;

    if (!plan.retainEpoch) {
      this.states.delete(state.key);
      return;
    }

    const nextTurn: PromptEpochTurn = {
      turnContext: plan.turnContext ?? "",
      userMessage: plan.userMessage,
      assistantMessage,
    };
    state.epochTurns.push(nextTurn);
    state.canonicalHistory.push(
      { role: "user", text: plan.userMessage },
      { role: "assistant", text: assistantMessage },
    );
  }

  fail(plan: PromptCacheEpochPlan): void {
    plan.state.active = false;
    if (this.states.get(plan.state.key) !== plan.state) return;
    // A failed request has no durable turn to append. Retain the prior epoch
    // so an ordinary retry can reuse the same safe prefix.
  }

  clear(): void {
    this.states.clear();
  }

  private newState(
    input: Omit<
      EpochState,
      "baseHistory" | "canonicalHistory" | "epochTurns" | "active"
    > & { history: readonly HistoryTurn[] },
  ): EpochState {
    const history = cloneHistory(input.history);
    return {
      key: input.key,
      persona: input.persona,
      conversation: input.conversation,
      systemFingerprint: input.systemFingerprint,
      baseHistory: history,
      canonicalHistory: cloneHistory(history),
      epochTurns: [],
      active: false,
    };
  }
}

export const promptCacheEpochs = new PromptCacheEpochManager();

export function clearPromptCacheEpochs(): void {
  promptCacheEpochs.clear();
}

/** Rendered UTF-8 byte count used only for the backend-neutral epoch bound. */
export function estimatePromptBytes(input: {
  systemPrompt: string;
  history: readonly HistoryTurn[];
  epochTurns?: readonly PromptEpochTurn[];
  turnContext?: string;
  userMessage: string;
}): number {
  const payload = renderConversationPayload(input);
  // This measures only PhantomBot's rendered system/payload bytes. It is not
  // an exact model-token count: harness/chat-template/tool tokens may exist
  // outside this measurement. Keeping the bound byte-based avoids pretending
  // that one tokenizer or backend applies to every supported harness.
  return (
    Buffer.byteLength(input.systemPrompt, "utf8") +
    Buffer.byteLength(payload, "utf8") +
    (input.systemPrompt.length > 0 && payload.length > 0 ? 2 : 0)
  );
}

function cacheKey(persona: string, conversation: string): string {
  return `${persona}\u0000${conversation}`;
}

function systemFingerprint(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

function cloneHistory(history: readonly HistoryTurn[]): HistoryTurn[] {
  return history.map((turn) => ({ role: turn.role, text: turn.text }));
}

function sameHistory(
  left: readonly HistoryTurn[],
  right: readonly HistoryTurn[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (turn, index) =>
      turn.role === right[index]?.role && turn.text === right[index]?.text,
  );
}

function historyTail(
  history: readonly HistoryTurn[],
  limit: number,
): readonly HistoryTurn[] {
  return limit === 0 ? [] : history.slice(-limit);
}
