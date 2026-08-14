/**
 * Pure typing-indicator state machine (Part 5).
 *
 * Typing indicators are ephemeral by design: nothing here is ever persisted to
 * the database or the server — a peer only ever receives a transient realtime
 * presence update. The state machine:
 *
 * - `onActivity()` is called on every keystroke. It returns `true` exactly
 *   once per typing burst (on the transition idle → active), which is what the
 *   caller publishes to the peer. While active, further keystrokes are
 *   debounced: they only extend the idle timeout, they do not re-broadcast.
 * - `tick()` is called on a fixed interval and returns `true` when the idle
 *   timeout elapsed since the last keystroke, telling the caller to publish
 *   the "stopped typing" update. This is the debounce that bounds broadcasts.
 * - `stop()` is called on blur / unmount to force the "stopped typing"
 *   update.
 *
 * The peer side never relies on this machine: the realtime presence entry
 * auto-expires when a participant disconnects, so a closed tab also clears the
 * indicator (see `useRoomTyping`), and the viewer adds a safety timeout.
 */
export class TypingTracker {
  private state: "idle" | "active" = "idle";
  private lastActivityAt = 0;

  constructor(
    private readonly opts: {
      /** Idle timeout: after this long without a keystroke typing ends. */
      idleMs: number;
      /** Clock abstraction so tests can control time. */
      clock: () => number;
    },
  ) {}

  /** True while a typing burst is in progress. */
  get active(): boolean {
    return this.state === "active";
  }

  /**
   * Record a keystroke. Returns `true` when the caller should publish the
   * "started typing" update (only on the idle → active transition).
   */
  onActivity(): boolean {
    const now = this.opts.clock();
    const started = this.state === "idle";
    this.state = "active";
    this.lastActivityAt = now;
    return started;
  }

  /**
   * Advance the idle timer. Returns `true` when the caller should publish the
   * "stopped typing" update because the burst went idle.
   */
  tick(): boolean {
    if (this.state !== "active") {
      return false;
    }
    if (this.opts.clock() - this.lastActivityAt >= this.opts.idleMs) {
      this.state = "idle";
      return true;
    }
    return false;
  }

  /**
   * Force the burst to end (blur, unmount, disconnect). Returns `true` when
   * the caller should publish the "stopped typing" update.
   */
  stop(): boolean {
    if (this.state !== "active") {
      return false;
    }
    this.state = "idle";
    return true;
  }
}
