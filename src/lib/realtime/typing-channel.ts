import type { RealtimeChannel } from "@supabase/supabase-js";

/** Presence payload tracked on the typing channel. */
export interface TypingPresenceEntry {
  user_id: string;
  typing: boolean;
  at: number;
}

export type TypingChannelStatus =
  | "CREATED"
  | "SUBSCRIBING"
  | "SUBSCRIBED"
  | "UNSUBSCRIBING"
  | "CLOSED";

/**
 * Subscription lifecycle guard for a realtime typing presence channel.
 *
 * A raw `RealtimeChannel` only accepts `track()` once the server confirms the
 * join; calling it earlier throws `"tried to push 'presence' to '...' before
 * joining"`. Merely obtaining the channel object says nothing about readiness.
 * This wrapper tracks the *actual* subscription status and defers presence
 * updates until the channel is really SUBSCRIBED.
 *
 * Readiness is derived from the two signals supabase/realtime-js exposes:
 * - the `subscribe()` callback, which reports the initial join (SUBSCRIBED)
 *   plus every close/error/timeout, and
 * - the channel `system` events, which the Realtime server emits on every
 *   successful (re)join — this is what keeps the status accurate across socket
 *   drops and reconnects (the initial join fires both, so the duplicate
 *   publish is an idempotent presence merge).
 *
 * `publish()` is safe to call at any time from any typing burst:
 * - while SUBSCRIBED it pushes immediately;
 * - otherwise it records the desired state and flushes it the moment the
 *   channel (re)subscribes, so an early keystroke is never lost and never
 *   throws. Repeated publishes while unsubscribed collapse to the latest state,
 *   so a burst that starts and stops while connecting emits a single update.
 */
export class TypingChannel {
  private status: TypingChannelStatus = "CREATED";
  private desiredTyping = false;
  private pending = false;
  private disposed = false;

  constructor(
    private readonly channel: RealtimeChannel,
    private readonly userId: string,
  ) {}

  get currentStatus(): TypingChannelStatus {
    return this.status;
  }

  get isSubscribed(): boolean {
    return this.status === "SUBSCRIBED";
  }

  /**
   * Subscribe the underlying channel and start tracking readiness. Call
   * exactly once per channel; mirrors `channel.subscribe(callback)`.
   */
  subscribe(): void {
    if (this.status !== "CREATED") {
      return;
    }
    this.setStatus("SUBSCRIBING");
    this.channel
      .on("system", {}, (payload: { extension?: string; status?: string }) => {
        if (payload.extension !== "system") {
          return;
        }
        if (payload.status === "ok") {
          this.subscribed();
        } else {
          this.setStatus("SUBSCRIBING");
        }
      })
      .subscribe((status) => {
        switch (status) {
          case "SUBSCRIBED":
            this.subscribed();
            break;
          case "CLOSED":
            this.setStatus("CLOSED");
            break;
          default:
            // CHANNEL_ERROR / TIMED_OUT: still (re)connecting.
            this.setStatus("SUBSCRIBING");
        }
      });
  }

  /**
   * Record the desired remote typing state. Safe before subscribe, while
   * subscribing, and while (re)connecting; the update is published as soon as
   * the channel is actually SUBSCRIBED.
   */
  publish(typing: boolean): void {
    this.desiredTyping = typing;
    this.pending = true;
    this.flush();
  }

  /** Seal the controller; further publishes become no-ops. */
  dispose(): void {
    this.disposed = true;
    this.setStatus("CLOSED");
  }

  private subscribed(): void {
    if (this.disposed) {
      return;
    }
    this.setStatus("SUBSCRIBED");
    this.pending = true;
    this.flush();
  }

  private flush(): void {
    if (this.disposed || this.status !== "SUBSCRIBED" || !this.pending) {
      return;
    }
    this.pending = false;
    void this.channel.track({
      user_id: this.userId,
      typing: this.desiredTyping,
      at: Date.now(),
    });
  }

  private setStatus(status: TypingChannelStatus): void {
    this.status = status;
  }
}
