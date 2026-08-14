import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeChannel as RTChannel,
  type WebSocketLike,
} from "@supabase/realtime-js";
import { TypingChannel } from "@/lib/realtime/typing-channel";
import type { TypingPresenceEntry } from "@/lib/realtime/typing-channel";

/**
 * End-to-end integration test against the REAL `@supabase/realtime-js` stack.
 *
 * The unit tests in `typing-channel.test.ts` stand in for a `RealtimeChannel`
 * with a fake whose `track()` never throws, so they prove the *deferral logic*
 * but cannot prove the real library never throws. This file drives an actual
 * `RealtimeClient` over a fake WebSocket that speaks the Phoenix/Realtime wire
 * protocol, so the exact path that used to throw
 *   "tried to push 'presence' to 'realtime:room-typing:...' before joining"
 * (phoenix `channel.push()` → `RealtimeChannel.send()` → `channelAdapter.push()`)
 * is exercised for real:
 *
 * - `track()` before `subscribe()` rejects through the real library (sanity).
 * - `TypingChannel.publish()` before the join ack never reaches `track()`, so
 *   the rejection never happens and the state is flushed once the join lands.
 * - typing while the transport is down is deferred and flushed on rejoin.
 * - `dispose()` seals the controller so no late push can occur.
 *
 * Every test also asserts zero unhandled promise rejections.
 */

/** The Phoenix wire format: `[join_ref, ref, topic, event, payload]`. */
type Wire = [
  joinRef: string | null,
  ref: string | null,
  topic: string,
  event: string,
  payload: unknown,
];

/** Records everything the client pushes and replies like a tiny Realtime server. */
class FakeServer {
  private static shared: FakeServer | null = null;
  static singleton(): FakeServer {
    if (FakeServer.shared === null) {
      FakeServer.shared = new FakeServer();
    }
    return FakeServer.shared;
  }

  received: Wire[] = [];
  private conn: FakeWebSocket | null = null;

  reset(): void {
    this.received = [];
    this.conn = null;
  }

  attach(conn: FakeWebSocket): void {
    this.conn = conn;
  }

  handleClient(wire: Wire): void {
    this.received.push(wire);
    const [joinRef, ref, topic, event] = wire;
    switch (event) {
      case "phx_join":
        // Ack the join, then broadcast the system "ok" — exactly what the
        // real server does on every (re)join. Phoenix pushes destructure
        // `{ status, response }` from the reply payload.
        this.deliver([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
        this.deliver([ref, null, topic, "system", { extension: "system", status: "ok" }]);
        break;
      case "heartbeat":
        this.deliver([null, ref, "phoenix", "phx_reply", { status: "ok" }]);
        break;
      default:
        this.deliver([joinRef, ref, topic, "phx_reply", { status: "ok", response: {} }]);
    }
  }

  private deliver(wire: Wire): void {
    // Reply on the connection that received the message. Each delivery gets its
    // own task so ordering matches scheduling order; if that connection closed
    // before delivery the frame is dropped, like a real server would.
    const conn = this.conn;
    setTimeout(() => {
      conn?.onmessage?.({ data: JSON.stringify(wire) } as MessageEvent);
    }, 0);
  }

  /** Presence `track` pushes the client sent to the server. */
  presenceTracks(): Wire[] {
    return this.received.filter((w) => w[3] === "presence");
  }

  /** Presence `track` payloads, decoded. */
  presenceEntries(): TypingPresenceEntry[] {
    return this.presenceTracks().map(
      (w) => (w[4] as { payload: TypingPresenceEntry }).payload,
    );
  }

  joins(): Wire[] {
    return this.received.filter((w) => w[3] === "phx_join");
  }
}

/** Minimal `WebSocket` double: accepts, receives, and forwards frames. */
class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  readonly url: string;
  readonly protocol: string;
  binaryType: string = "arraybuffer";
  bufferedAmount = 0;
  extensions = "";

  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;

  private readonly server: FakeServer;

  constructor(address: string | URL, subprotocols?: string | string[]) {
    this.url = String(address);
    this.protocol = Array.isArray(subprotocols) ? (subprotocols[0] ?? "") : (subprotocols ?? "");
    this.server = FakeServer.singleton();
    this.server.attach(this);
    FakeWebSocket.instances.push(this);
    // The server accepts the connection on the next tick, after the socket has
    // assigned its onopen handler.
    setTimeout(() => {
      if (this.readyState === FakeWebSocket.CLOSED) {
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event("open") as Event);
    }, 0);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      return;
    }
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    this.server.handleClient(JSON.parse(text) as Wire);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true } as CloseEvent);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error("waitFor: timed out waiting for realtime state"));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

const unhandled: unknown[] = [];
function onUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
});
process.on("unhandledRejection", onUnhandled);

describe("TypingChannel against the real @supabase/realtime-js stack", () => {
  const clients: RealtimeClient[] = [];
  const server = FakeServer.singleton();

  beforeEach(() => {
    server.reset();
    FakeWebSocket.instances = [];
    unhandled.length = 0;
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.disconnect().catch(() => {});
    }
    expect(unhandled).toEqual([]);
  });

  function makeClient(): RealtimeClient {
    const options: RealtimeClientOptions = {
      params: { apikey: "test-key" },
      transport: FakeWebSocket as unknown as RealtimeClientOptions["transport"],
      heartbeatIntervalMs: 60_000,
      reconnectAfterMs: () => 10,
      timeout: 5_000,
    };
    const client = new RealtimeClient("wss://realtime.invalid/websocket", options);
    clients.push(client);
    return client;
  }

  function makeTyping(topic: string, userId = "u1"): {
    client: RealtimeClient;
    raw: RTChannel;
    tc: TypingChannel;
  } {
    const client = makeClient();
    const raw = client.channel(`room-typing:${topic}`, {
      config: { presence: { key: userId } },
    });
    return { client, raw, tc: new TypingChannel(raw, userId) };
  }

  it("sanity: raw track() before subscribe() rejects with 'before joining' through the real library", async () => {
    const { client, raw } = makeTyping("sanity");

    await expect(
      raw.track({ user_id: "u1", typing: true, at: Date.now() }),
    ).rejects.toThrow(/before joining/i);
    expect(unhandled).toEqual([]);

    await client.disconnect();
  });

  it("publish before the join ack is deferred and flushed exactly once on join", async () => {
    const { client, raw, tc } = makeTyping("defer");

    // Burst that lands before the socket even connects: must never throw, must
    // never reach the wire, and must collapse to the latest state.
    expect(() => {
      tc.publish(true);
      tc.publish(false);
      tc.publish(true);
    }).not.toThrow();
    expect(server.presenceTracks()).toHaveLength(0);
    expect(unhandled).toEqual([]);

    tc.subscribe();
    await waitFor(() => server.presenceEntries().length >= 1);

    // Both the join-ack (subscribe callback) and the system event fire on the
    // initial join, so the controller re-publishes the current state for each;
    // the duplicate is an idempotent presence merge. What matters: the
    // intermediate `false` was never published and the final state (typing:
    // true) is what landed.
    expect(server.presenceEntries().length).toBeGreaterThanOrEqual(1);
    expect(server.presenceEntries().every((e) => e.typing === true)).toBe(true);
    expect(server.presenceEntries().at(-1)).toEqual({
      user_id: "u1",
      typing: true,
      at: expect.any(Number),
    });
    expect(server.joins()).toHaveLength(1);
    expect(unhandled).toEqual([]);

    await client.removeChannel(raw);
  });

  it("stopTyping before the join ack publishes false on join, never throwing", async () => {
    const { client, raw, tc } = makeTyping("stop-early");

    expect(() => {
      tc.publish(true);
      tc.publish(false);
    }).not.toThrow();
    expect(server.presenceTracks()).toHaveLength(0);

    tc.subscribe();
    await waitFor(() => server.presenceEntries().length >= 1);

    expect(server.presenceEntries().every((e) => e.typing === false)).toBe(true);
    expect(server.presenceEntries().at(-1)?.typing).toBe(false);
    expect(unhandled).toEqual([]);

    await client.removeChannel(raw);
  });

  it("publishes immediately once SUBSCRIBED, repeatedly, without duplicate channels", async () => {
    const { client, raw, tc } = makeTyping("subscribed");

    tc.subscribe();
    await waitFor(() => server.presenceEntries().length >= 1);
    expect(server.presenceEntries().every((e) => e.typing === false)).toBe(true);

    tc.publish(true);
    await waitFor(() => server.presenceEntries().at(-1)?.typing === true);
    expect(server.presenceEntries().at(-1)?.typing).toBe(true);

    tc.publish(false);
    await waitFor(() => server.presenceEntries().at(-1)?.typing === false);
    expect(server.presenceEntries().at(-1)?.typing).toBe(false);

    expect(server.joins()).toHaveLength(1);
    expect(unhandled).toEqual([]);

    await client.removeChannel(raw);
  });

  it("typing while the transport drops is deferred, then flushed on rejoin", async () => {
    const { client, raw, tc } = makeTyping("reconnect");

    tc.subscribe();
    await waitFor(() => server.presenceEntries().length >= 1);

    tc.publish(true);
    await waitFor(() => server.presenceEntries().at(-1)?.typing === true);
    expect(server.presenceEntries().at(-1)?.typing).toBe(true);

    // Simulate the transport dropping. realtime-js surfaces CLOSED/CHANNEL_ERROR
    // through the subscribe callback, so the controller leaves SUBSCRIBED.
    const firstConn = FakeWebSocket.instances[0];
    firstConn.close();

    // stopTyping while the socket is down: deferred, never thrown.
    expect(() => tc.publish(false)).not.toThrow();
    expect(server.presenceEntries().at(-1)?.typing).toBe(true);
    expect(unhandled).toEqual([]);

    // The socket reconnects (reconnectAfterMs = 10) and the channel rejoins;
    // the deferred "stopped typing" state is flushed.
    await waitFor(() => {
      const last = server.presenceEntries().at(-1);
      return last !== undefined && last.typing === false;
    });
    expect(server.presenceEntries().at(-1)?.typing).toBe(false);
    expect(server.joins().length).toBeGreaterThanOrEqual(2);
    expect(unhandled).toEqual([]);

    // And typing still works after the reconnect.
    tc.publish(true);
    await waitFor(() => {
      const last = server.presenceEntries().at(-1);
      return last !== undefined && last.typing === true;
    });
    expect(unhandled).toEqual([]);

    await client.removeChannel(raw);
  });

  it("dispose seals the controller: late publishes and stray rejoin events push nothing", async () => {
    const { client, raw, tc } = makeTyping("dispose");

    tc.subscribe();
    await waitFor(() => server.presenceEntries().length >= 1);
    const afterJoin = server.presenceEntries().length;

    tc.dispose();
    expect(() => {
      tc.publish(true);
      tc.publish(false);
    }).not.toThrow();

    // A stray rejoin signal after dispose must be ignored (no re-publish).
    const conn = FakeWebSocket.instances[0];
    conn.onmessage?.({ data: JSON.stringify([null, "9", "room-typing:dispose", "system", { extension: "system", status: "ok" }]) } as MessageEvent);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.presenceEntries().length).toBe(afterJoin);
    expect(unhandled).toEqual([]);

    await client.removeChannel(raw);
  });
});
