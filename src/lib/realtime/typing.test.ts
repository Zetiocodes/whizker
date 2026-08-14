import { describe, expect, it } from "vitest";
import { TypingTracker } from "@/lib/realtime/typing";

const IDLE = 4_000;

function makeTracker() {
  let now = 0;
  const tracker = new TypingTracker({
    idleMs: IDLE,
    clock: () => now,
  });
  return { tracker, advance: (ms: number) => (now += ms) };
}

describe("TypingTracker", () => {
  it("is idle initially", () => {
    const { tracker } = makeTracker();
    expect(tracker.active).toBe(false);
    expect(tracker.tick()).toBe(false);
  });

  it("publishes a start exactly once per burst, then debounces further keystrokes", () => {
    const { tracker, advance } = makeTracker();

    expect(tracker.onActivity()).toBe(true);
    expect(tracker.active).toBe(true);

    advance(100);
    expect(tracker.onActivity()).toBe(false);
    advance(100);
    expect(tracker.onActivity()).toBe(false);
    expect(tracker.active).toBe(true);
  });

  it("does not end the burst before the idle timeout elapses", () => {
    const { tracker, advance } = makeTracker();
    tracker.onActivity();
    advance(IDLE - 1);
    expect(tracker.tick()).toBe(false);
    expect(tracker.active).toBe(true);
  });

  it("ends the burst once the idle timeout elapses and publishes exactly one stop", () => {
    const { tracker, advance } = makeTracker();
    tracker.onActivity();

    advance(IDLE);
    expect(tracker.tick()).toBe(true);
    expect(tracker.active).toBe(false);

    expect(tracker.tick()).toBe(false);
  });

  it("keeps the burst alive while keystrokes keep arriving", () => {
    const { tracker, advance } = makeTracker();
    tracker.onActivity();

    for (let i = 0; i < 10; i++) {
      advance(IDLE - 500);
      tracker.onActivity();
      expect(tracker.active).toBe(true);
    }

    advance(IDLE);
    expect(tracker.tick()).toBe(true);
    expect(tracker.active).toBe(false);
  });

  it("starts a new burst (and publishes a new start) after going idle", () => {
    const { tracker, advance } = makeTracker();
    tracker.onActivity();
    advance(IDLE);
    tracker.tick();

    expect(tracker.active).toBe(false);
    expect(tracker.onActivity()).toBe(true);
  });

  it("stop() ends an active burst and returns true once", () => {
    const { tracker } = makeTracker();
    tracker.onActivity();
    expect(tracker.stop()).toBe(true);
    expect(tracker.active).toBe(false);
    expect(tracker.stop()).toBe(false);
  });

  it("stop() on an idle tracker returns false", () => {
    const { tracker } = makeTracker();
    expect(tracker.stop()).toBe(false);
  });
});
