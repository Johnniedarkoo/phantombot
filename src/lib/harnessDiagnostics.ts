export interface HarnessDiagnosticSnapshot {
  lastEvent: string;
  lastEventAt: number;
  lastActivityAt: number;
  activeTool?: string;
  activeToolCallId?: string;
  activeToolStartedAt?: number;
  toolCallsStarted: number;
  toolCallsCompleted: number;
}

/** Small, in-memory state used only to explain a watchdog kill. */
export class HarnessDiagnostics {
  private state: HarnessDiagnosticSnapshot = {
    lastEvent: "spawn",
    lastEventAt: Date.now(),
    lastActivityAt: Date.now(),
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
  };

  event(name: string, activity = false): void {
    const now = Date.now();
    this.state.lastEvent = name;
    this.state.lastEventAt = now;
    if (activity) this.state.lastActivityAt = now;
  }

  toolStart(name: string, callId: string): void {
    const now = Date.now();
    this.state = { ...this.state, lastEvent: "tool_start", lastEventAt: now,
      lastActivityAt: now, activeTool: name, activeToolCallId: callId,
      activeToolStartedAt: now, toolCallsStarted: this.state.toolCallsStarted + 1 };
  }

  toolEnd(event: "tool_end" | "tool_error" | "tool_cancel" = "tool_end"): void {
    const now = Date.now();
    this.state = { ...this.state, lastEvent: event, lastEventAt: now,
      lastActivityAt: now, activeTool: undefined, activeToolCallId: undefined,
      activeToolStartedAt: undefined,
      toolCallsCompleted: this.state.toolCallsCompleted + 1 };
  }

  snapshot(): HarnessDiagnosticSnapshot { return { ...this.state }; }
}
