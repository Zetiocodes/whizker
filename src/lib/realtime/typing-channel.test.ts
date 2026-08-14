import { describe, expect, it, vi } from "vitest";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { TypingChannel } from "@/lib/realtime/typing-channel";
import type { TypingChannelStatus } from "@/lib/realtime/typing-channel";

interface TrackedPayload {
  user_id: string;
  typing: boolean;
  at: number;
}

/**
 * Minimal stand-in for a `RealtimeChannel`. Records what is pushed and lets
 * the test drive the join/close/rejoin lifecycle exactly like
 * supabase/realtime-js does: the `subscribe` callback fires for the initial
 * join and every close/error/timeout, and the `system` event fires on every
 * successful (re)join.
 */
function makeFake() {
  let sysCb: ((payload: { extension?: string; status?: string }) => void) | null = null;
  let subCb: ((status: string, err?: Error) => void) | null = null;
  const tracks: TrackedPayload[] = [];
  const on = vi.fn((event: string, _opts: unknown, cb: unknown) => {
    if (event === "system") {
      sysCb = cb as (payload: { extension?: string; status?: string }) => void;
    }
    return fake;
  });
  const subscribe = vi.fn((cb?: (status: string, err?: Error) => void) => {
    subCb = cb ?? null;
    return fake;
  });
  const track = vi.fn((payload: TrackedPayload) => {
    tracks.push(payload);
    return Promise.resolve();
  });
  const fake = { on, subscribe, track };
  const channel = fake as unknown as RealtimeChannel;
  return {
    channel,
    tracks,
    joined: () => subCb?.("SUBSCRIBED"),
    closed: () => subCb?.("CLOSED"),
    timedOut: () => subCb?.("TIMED_OUT"),
    channelError: () => subCb?.("CHANNEL_ERROR"),
    systemOk: () => sysCb?.({ extension: "system", status: "ok" }),
    systemError: () => sysCb?.({ extension: "system", status: "error" }),
    subscribeCallCount: () => subscribe.mock.calls.length,
  };
}

describe("TypingChannel", () => {
  it("track before subscription is safely deferred, never thrown", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");

    // Publishing while the channel is only CREATED (before subscribe()) and
    // while SUBSCRIBING must never throw and never push.
    expect(() => {
      tc.publish(true);
      tc.publish(false);
    }).not.toThrow();
    expect(fake.tracks).toHaveLength(0);

    tc.subscribe();
    expect(() => tc.publish(true)).not.toThrow();
    expect(fake.tracks).toHaveLength(0);

    fake.joined();
    expect(fake.tracks).toHaveLength(1);
    expect(fake.tracks[0]).toEqual({ user_id: "u1", typing: true, at: expect.any(Number) });
  });

  it("publishes immediately once SUBSCRIBED", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();
    expect(fake.tracks).toHaveLength(1);
    expect(fake.tracks[0].typing).toBe(false);

    tc.publish(true);
    expect(fake.tracks).toHaveLength(2);
    expect(fake.tracks[1].typing).toBe(true);

    tc.publish(false);
    expect(fake.tracks).toHaveLength(3);
    expect(fake.tracks[2].typing).toBe(false);
  });

  it("stopTyping before subscription publishes false on subscribe, no runtime error", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();

    expect(() => {
      tc.publish(true);
      tc.publish(false);
    }).not.toThrow();
    expect(fake.tracks).toHaveLength(0);

    fake.joined();
    expect(fake.tracks).toHaveLength(1);
    expect(fake.tracks[0].typing).toBe(false);
  });

  it("collapses a burst that happens while connecting to the latest state", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();

    tc.publish(true);
    tc.publish(false);
    tc.publish(true);
    fake.joined();

    expect(fake.tracks).toHaveLength(1);
    expect(fake.tracks[0].typing).toBe(true);
  });

  it("publishes on the initial join even when idle", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();
    expect(fake.tracks).toHaveLength(1);
    expect(fake.tracks[0].typing).toBe(false);
  });

  it("reconnect: after a drop, publishes are deferred and flushed on rejoin", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();
    expect(fake.tracks).toHaveLength(1);

    fake.closed();
    expect(tc.currentStatus).toBe("CLOSED");

    // Typing while the socket is down: deferred, not thrown.
    tc.publish(true);
    expect(fake.tracks).toHaveLength(1);

    fake.systemOk();
    expect(tc.currentStatus).toBe("SUBSCRIBED");
    expect(fake.tracks).toHaveLength(2);
    expect(fake.tracks[1].typing).toBe(true);
  });

  it("reconnect: publishes current state on rejoin even without a preceding drop event", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();

    tc.publish(true);
    expect(fake.tracks).toHaveLength(2);

    // A rejoin signal with no CLOSED in between still re-publishes the latest
    // desired state, so presence is never left stale after a reconnect.
    fake.systemOk();
    expect(fake.tracks).toHaveLength(3);
    expect(fake.tracks[2].typing).toBe(true);
  });

  it("channel error / timeout keep publishes deferred until rejoin", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();

    fake.channelError();
    expect(tc.currentStatus).toBe("SUBSCRIBING");
    tc.publish(true);
    expect(fake.tracks).toHaveLength(1);

    fake.systemOk();
    expect(fake.tracks).toHaveLength(2);
    expect(fake.tracks[1].typing).toBe(true);

    fake.timedOut();
    tc.publish(false);
    expect(fake.tracks).toHaveLength(2);

    fake.joined();
    expect(fake.tracks).toHaveLength(3);
    expect(fake.tracks[2].typing).toBe(false);
  });

  it("dispose seals the controller: late publishes and stray rejoin events are ignored", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    fake.joined();
    expect(fake.tracks).toHaveLength(1);

    tc.dispose();
    expect(tc.currentStatus).toBe("CLOSED");

    tc.publish(true);
    fake.systemOk();
    tc.publish(false);
    expect(fake.tracks).toHaveLength(1);
    expect(tc.currentStatus).toBe("CLOSED");
  });

  it("tracks the full lifecycle status", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    const seen: TypingChannelStatus[] = [tc.currentStatus];

    tc.subscribe();
    seen.push(tc.currentStatus);
    fake.joined();
    seen.push(tc.currentStatus);
    fake.closed();
    seen.push(tc.currentStatus);
    fake.systemError();
    seen.push(tc.currentStatus);
    fake.systemOk();
    seen.push(tc.currentStatus);
    tc.dispose();
    seen.push(tc.currentStatus);

    expect(seen).toEqual([
      "CREATED",
      "SUBSCRIBING",
      "SUBSCRIBED",
      "CLOSED",
      "SUBSCRIBING",
      "SUBSCRIBED",
      "CLOSED",
    ]);
  });

  it("subscribes exactly once even if subscribe() is called repeatedly", () => {
    const fake = makeFake();
    const tc = new TypingChannel(fake.channel, "u1");
    tc.subscribe();
    tc.subscribe();
    tc.subscribe();
    expect(fake.subscribeCallCount()).toBe(1);
  });
});
