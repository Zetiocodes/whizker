// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { useRoomTyping } from "@/hooks/use-room-typing";

type PresencePayload = { user_id: string; typing: boolean; at: number };
type SystemPayload = { extension?: string; status?: string };
type SubscribeCb = (status: string, err?: Error) => void;

/** Minimal `RealtimeChannel` double that records pushes and lifecycle events. */
class FakeChannel {
  tracks: PresencePayload[] = [];
  private sysCb: ((p: SystemPayload) => void) | null = null;
  private syncCb: (() => void) | null = null;
  private subCb: SubscribeCb | null = null;
  private presence: Record<string, PresencePayload[]> = {};

  constructor(public readonly topic: string) {}

  on(event: string, _opts: object, cb: (p?: SystemPayload) => void): this {
    if (event === "system") {
      this.sysCb = cb as (p: SystemPayload) => void;
    }
    if (event === "presence") {
      this.syncCb = cb as () => void;
    }
    return this;
  }

  subscribe(cb?: SubscribeCb): this {
    this.subCb = cb ?? null;
    return this;
  }

  track(payload: PresencePayload): Promise<string> {
    this.tracks.push(payload);
    this.presence[`pres:${payload.user_id}`] = [{ ...payload }];
    return Promise.resolve("ok");
  }

  presenceState<T>(): Record<string, T[]> {
    return this.presence as Record<string, T[]>;
  }

  joined(): void {
    this.subCb?.("SUBSCRIBED");
  }

  closed(): void {
    this.subCb?.("CLOSED");
  }

  systemOk(): void {
    this.sysCb?.({ extension: "system", status: "ok" });
  }

  setPresence(entries: PresencePayload[]): void {
    this.presence = { pres: entries };
    this.syncCb?.();
  }
}

function makeSupabase() {
  const channels: FakeChannel[] = [];
  const removed: FakeChannel[] = [];
  const client = {
    channel: (topic: string) => {
      const ch = new FakeChannel(topic);
      channels.push(ch);
      return ch;
    },
    removeChannel: (ch: unknown) => {
      removed.push(ch as FakeChannel);
      return Promise.resolve("ok");
    },
  } as unknown as SupabaseClient<Database>;
  return { client, channels, removed };
}

function renderTyping(overrides: {
  client?: SupabaseClient<Database>;
  roomId?: string;
  enabled?: boolean;
} = {}) {
  const { client, channels, removed } = makeSupabase();
  const initialProps = {
    client: overrides.client ?? client,
    roomId: overrides.roomId ?? "r1",
    userId: "u1",
    peerUserId: "u2",
    enabled: overrides.enabled ?? true,
  };
  const utils = renderHook((props: typeof initialProps) => useRoomTyping(props), { initialProps });
  return { ...utils, client, channels, removed };
}

describe("useRoomTyping subscription race", () => {
  it("defer: typing before the channel joins is published on join, never thrown", () => {
    const { result, channels } = renderTyping();
    expect(channels).toHaveLength(1);
    const ch = channels[0];

    expect(() => {
      act(() => {
        result.current.notifyActivity();
      });
    }).not.toThrow();
    expect(ch.tracks).toHaveLength(0);

    act(() => ch.joined());
    expect(ch.tracks).toHaveLength(1);
    expect(ch.tracks[0]).toEqual({ user_id: "u1", typing: true, at: expect.any(Number) });
  });

  it("defer: stopTyping before the channel joins never throws", () => {
    const { result, channels } = renderTyping();
    const ch = channels[0];

    expect(() => {
      act(() => {
        result.current.notifyActivity();
        result.current.stopTyping();
      });
    }).not.toThrow();
    expect(ch.tracks).toHaveLength(0);

    act(() => ch.joined());
    expect(ch.tracks).toHaveLength(1);
    expect(ch.tracks[0].typing).toBe(false);
  });

  it("publishes immediately once SUBSCRIBED, repeatedly, without duplicate channels", () => {
    const { result, channels } = renderTyping();
    const ch = channels[0];

    act(() => ch.joined());
    expect(ch.tracks[0].typing).toBe(false);

    act(() => {
      result.current.notifyActivity();
      result.current.notifyActivity();
      result.current.notifyActivity();
      result.current.notifyActivity();
    });
    expect(channels).toHaveLength(1);
    expect(ch.tracks.at(-1)?.typing).toBe(true);

    act(() => result.current.stopTyping());
    expect(ch.tracks.at(-1)?.typing).toBe(false);
  });

  it("reconnect: typing while the socket drops is deferred and flushed on rejoin", () => {
    const { result, channels } = renderTyping();
    const ch = channels[0];

    act(() => ch.joined());
    act(() => result.current.notifyActivity());
    expect(ch.tracks.at(-1)?.typing).toBe(true);

    act(() => ch.closed());
    expect(() => {
      act(() => result.current.stopTyping());
    }).not.toThrow();
    expect(ch.tracks.at(-1)?.typing).toBe(true);

    act(() => ch.systemOk());
    expect(ch.tracks.at(-1)?.typing).toBe(false);
  });

  it("enabled=false creates no channel and typing calls are safe no-ops", () => {
    const { result, channels } = renderTyping({ enabled: false });
    expect(channels).toHaveLength(0);

    expect(() => {
      act(() => {
        result.current.notifyActivity();
        result.current.stopTyping();
      });
    }).not.toThrow();
  });

  it("cleanup: unmount removes the channel and seals it; late calls are safe", () => {
    const { result, channels, removed, unmount } = renderTyping();
    const ch = channels[0];

    act(() => ch.joined());
    expect(removed).toHaveLength(0);
    const tracksBefore = ch.tracks.length;

    act(() => unmount());

    expect(removed).toContain(ch);
    expect(() => {
      act(() => {
        result.current.notifyActivity();
        result.current.stopTyping();
      });
    }).not.toThrow();
    expect(ch.tracks).toHaveLength(tracksBefore);
  });

  it("room change tears down the old channel and subscribes a fresh one", () => {
    const { client, channels, removed, rerender } = renderTyping();
    const first = channels[0];

    act(() => first.joined());
    rerender({ client, roomId: "r2", userId: "u1", peerUserId: "u2", enabled: true });

    expect(removed).toContain(first);
    expect(channels).toHaveLength(2);

    const second = channels[1];
    expect(() => {
      act(() => {
        second.joined();
      });
    }).not.toThrow();
    expect(second.tracks.length).toBeGreaterThan(0);
  });

  it("peer typing indicator reflects presence sync", () => {
    const { result, channels } = renderTyping();
    const ch = channels[0];
    act(() => ch.joined());

    expect(result.current.peerTyping).toBe(false);
    act(() => ch.setPresence([{ user_id: "u2", typing: true, at: Date.now() }]));
    expect(result.current.peerTyping).toBe(true);

    act(() => ch.setPresence([{ user_id: "u2", typing: false, at: Date.now() }]));
    expect(result.current.peerTyping).toBe(false);
  });
});
