import { describe, expect, it } from "vitest";
import {
  INITIAL_CONNECTION_STATE,
  INITIAL_PEER_STATE,
  createConnectionReducer,
  createPeerReducer,
  deriveRoomAvailability,
  type ConnectionState,
} from "@/lib/realtime/presence";

const GRACE = 8_000;
const connection = createConnectionReducer(GRACE);
const peer = createPeerReducer(GRACE);

function conn(status: ConnectionState["status"], since: number): ConnectionState {
  return { status, since };
}

describe("connectionReducer", () => {
  it("starts connecting and becomes connected on subscribe", () => {
    const next = connection(INITIAL_CONNECTION_STATE, { type: "subscribed", at: 1_000 });
    expect(next).toEqual(conn("connected", 1_000));
  });

  it("stays connected on repeated subscribe events", () => {
    const state = connection(INITIAL_CONNECTION_STATE, { type: "subscribed", at: 1_000 });
    const again = connection(state, { type: "subscribed", at: 2_000 });
    expect(again.status).toBe("connected");
  });

  it("enters reconnecting on socket-down while connected", () => {
    const state = connection(INITIAL_CONNECTION_STATE, { type: "subscribed", at: 1_000 });
    const down = connection(state, { type: "socket-down", at: 5_000 });
    expect(down.status).toBe("reconnecting");
    expect(down.since).toBe(5_000);
  });

  it("goes offline only after the grace period without a resubscribe", () => {
    let state: ConnectionState = connection(INITIAL_CONNECTION_STATE, {
      type: "subscribed",
      at: 1_000,
    });
    state = connection(state, { type: "socket-down", at: 5_000 });

    expect(connection(state, { type: "grace-check", at: 12_000 }).status).toBe("reconnecting");
    expect(connection(state, { type: "grace-check", at: 13_000 }).status).toBe("offline");
  });

  it("recovers from reconnecting when a subscribe succeeds within the grace period", () => {
    let state: ConnectionState = connection(INITIAL_CONNECTION_STATE, {
      type: "subscribed",
      at: 1_000,
    });
    state = connection(state, { type: "socket-down", at: 5_000 });
    const back = connection(state, { type: "subscribed", at: 9_000 });
    expect(back.status).toBe("connected");
  });

  it("recovers from offline on a later subscribe", () => {
    let state: ConnectionState = connection(INITIAL_CONNECTION_STATE, {
      type: "subscribed",
      at: 1_000,
    });
    state = connection(state, { type: "socket-down", at: 5_000 });
    state = connection(state, { type: "grace-check", at: 13_000 });
    expect(state.status).toBe("offline");

    const back = connection(state, { type: "subscribed", at: 20_000 });
    expect(back.status).toBe("connected");
  });

  it("treats connecting like reconnecting on socket-down (initial connect failure)", () => {
    const state = connection(INITIAL_CONNECTION_STATE, { type: "socket-down", at: 1_000 });
    expect(state.status).toBe("reconnecting");
  });

  it("ignores stale events older than the current state", () => {
    const state = connection(INITIAL_CONNECTION_STATE, { type: "subscribed", at: 10_000 });
    const stale = connection(state, { type: "socket-down", at: 2_000 });
    expect(stale.status).toBe("connected");
  });
});

describe("peerReducer", () => {
  it("starts unknown and becomes online on a present sync", () => {
    const next = peer(INITIAL_PEER_STATE, { type: "sync", present: true, at: 1_000 });
    expect(next.presence).toBe("online");
    expect(next.lastSeen).toBe(1_000);
  });

  it("never promotes an unknown peer on absence alone", () => {
    const next = peer(INITIAL_PEER_STATE, { type: "sync", present: false, at: 1_000 });
    expect(next.presence).toBe("unknown");
    const afterGrace = peer(next, { type: "grace-check", at: 20_000 });
    expect(afterGrace.presence).toBe("unknown");
  });

  it("moves online -> away on absence, then offline after the grace period", () => {
    let state = peer(INITIAL_PEER_STATE, { type: "sync", present: true, at: 1_000 });
    state = peer(state, { type: "sync", present: false, at: 5_000 });
    expect(state.presence).toBe("away");
    expect(state.lastSeen).toBe(1_000);

    expect(peer(state, { type: "grace-check", at: 12_000 }).presence).toBe("away");
    expect(peer(state, { type: "grace-check", at: 13_000 }).presence).toBe("offline");
  });

  it("returns to online if the peer reappears during the grace period", () => {
    let state = peer(INITIAL_PEER_STATE, { type: "sync", present: true, at: 1_000 });
    state = peer(state, { type: "sync", present: false, at: 5_000 });
    expect(state.presence).toBe("away");

    const back = peer(state, { type: "sync", present: true, at: 9_000 });
    expect(back.presence).toBe("online");
    expect(back.lastSeen).toBe(9_000);
  });

  it("recovers from offline when the peer is seen again", () => {
    let state = peer(INITIAL_PEER_STATE, { type: "sync", present: true, at: 1_000 });
    state = peer(state, { type: "sync", present: false, at: 5_000 });
    state = peer(state, { type: "grace-check", at: 13_000 });
    expect(state.presence).toBe("offline");

    const back = peer(state, { type: "sync", present: true, at: 20_000 });
    expect(back.presence).toBe("online");
  });

  it("stays away on repeated absence syncs (grace timer not reset)", () => {
    let state = peer(INITIAL_PEER_STATE, { type: "sync", present: true, at: 1_000 });
    state = peer(state, { type: "sync", present: false, at: 5_000 });
    state = peer(state, { type: "sync", present: false, at: 5_500 });
    expect(state.presence).toBe("away");
    const offlineAt = peer(state, { type: "grace-check", at: 13_000 });
    expect(offlineAt.presence).toBe("offline");
  });
});

describe("deriveRoomAvailability", () => {
  const cases: Array<{
    connection: ConnectionState["status"];
    peer: "unknown" | "online" | "away" | "offline";
    expired: boolean;
    expected: string;
  }> = [
    { connection: "connected", peer: "online", expired: false, expected: "available" },
    { connection: "connecting", peer: "online", expired: false, expected: "connecting" },
    { connection: "reconnecting", peer: "online", expired: false, expected: "reconnecting" },
    { connection: "offline", peer: "online", expired: false, expected: "reconnecting" },
    { connection: "connected", peer: "unknown", expired: false, expected: "waiting-for-peer" },
    { connection: "connected", peer: "away", expired: false, expected: "peer-away" },
    { connection: "connected", peer: "offline", expired: false, expected: "peer-offline" },
    { connection: "connected", peer: "online", expired: true, expected: "expired" },
    { connection: "connecting", peer: "offline", expired: true, expected: "expired" },
  ];

  for (const c of cases) {
    it(`derives ${c.expected} for ${c.connection}+${c.peer}+expired=${c.expired}`, () => {
      expect(
        deriveRoomAvailability({
          connection: c.connection,
          peer: c.peer,
          expired: c.expired,
        }),
      ).toBe(c.expected);
    });
  }
});
