/**
 * Minimal HTTP + SSE client for an agent-room server (a separate small
 * project: a shared chat room for friends' agents and their owners). Only the
 * calls this channel uses.
 *
 * Contract summary: bearer token per bot; `GET /api/stream?after=<id>` is an
 * outbound server-sent-events stream whose `message` events carry
 * `wake: true` when this bot is @mentioned; `POST /api/rooms/<room>/messages`
 * replies. The server enforces identity, a human-refilled bot budget, a
 * cooldown and owner pause — see that repo's README.
 */

export interface RoomMessage {
  id: number;
  room: string;
  sender: string;
  sender_kind: "human" | "agent";
  text: string;
  reply_to: number | null;
  mentions: string[];
  created_at: number;
  /** Present on stream events for an agent connection. */
  wake?: boolean;
}

export interface RoomInfo {
  name: string;
  budget_remaining: number;
  last_id: number;
}

export type StreamEvent =
  | { type: "message"; message: RoomMessage }
  | { type: "other"; event: string; data: unknown };

/** Error from the room server, carrying its `{error, message}` body. */
export class AgentRoomError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRoomError";
  }
}

export class AgentRoomClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new AgentRoomError(
        res.status,
        typeof body.error === "string" ? body.error : "http_error",
        typeof body.message === "string" ? body.message : res.statusText,
      );
    }
    return body as T;
  }

  me(): Promise<{ kind: string; name: string; owner: string; paused: boolean }> {
    return this.json("/api/me");
  }

  rooms(): Promise<RoomInfo[]> {
    return this.json("/api/rooms");
  }

  /** The latest `limit` messages of a room, oldest first. */
  recent(room: string, limit: number): Promise<RoomMessage[]> {
    return this.json(`/api/rooms/${encodeURIComponent(room)}/messages?limit=${limit}`);
  }

  post(room: string, text: string, replyTo?: number): Promise<RoomMessage> {
    return this.json(`/api/rooms/${encodeURIComponent(room)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text, reply_to: replyTo ?? null }),
    });
  }

  /**
   * One stream connection. Yields events until the server closes it or
   * `signal` aborts; the caller reconnects with the last id it saw.
   */
  async *stream(after: number, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/stream?after=${after}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new AgentRoomError(
        res.status,
        typeof body.error === "string" ? body.error : "stream_failed",
        typeof body.message === "string" ? body.message : res.statusText,
      );
    }
    yield* parseSse(res.body);
  }
}

/** Parse a server-sent-events byte stream into agent-room events. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue; // keepalive comment
      const parsed = JSON.parse(data) as unknown;
      yield event === "message"
        ? { type: "message", message: parsed as RoomMessage }
        : { type: "other", event, data: parsed };
    }
  }
}
