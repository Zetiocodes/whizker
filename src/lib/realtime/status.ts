/**
 * User-facing labels for realtime connection and room-availability states
 * (Part 5). Kept as pure functions so every state the UI can render is
 * enumerated and tested, and no string logic leaks into components.
 *
 * None of these labels ever include message content — they describe the
 * connection, never the conversation.
 */

import type { ConnectionStatus, RoomAvailability } from "./presence";

export type Tone = "muted" | "success" | "warning" | "danger";

export interface AvailabilityView {
  /** Short status shown in the chat header. */
  label: string;
  /** One-line explanation, also used as the composer hint when gated. */
  detail: string;
  tone: Tone;
  /** True when the composer and message stream are usable. */
  chatAvailable: boolean;
}

export function connectionLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting…";
    case "offline":
      return "Offline";
  }
}

const TONE_CLASSES: Record<Tone, string> = {
  muted: "border-border bg-surface-raised text-muted",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-amber-400/30 bg-amber-400/10 text-amber-400",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

export function toneClasses(tone: Tone): string {
  return TONE_CLASSES[tone];
}

export function availabilityView(
  availability: RoomAvailability,
  peerName: string | null,
): AvailabilityView {
  switch (availability) {
    case "connecting":
      return {
        label: "Connecting…",
        detail: "Connecting to the room.",
        tone: "muted",
        chatAvailable: false,
      };
    case "reconnecting":
      return {
        label: "Reconnecting…",
        detail:
          "Connection lost. Messages sent now are stored and appear when it returns.",
        tone: "warning",
        chatAvailable: false,
      };
    case "waiting-for-peer":
      return {
        label: "Waiting for the other person",
        detail: "The conversation unlocks when the second person joins.",
        tone: "muted",
        chatAvailable: false,
      };
    case "peer-away":
      return {
        label: peerName ? `Waiting for ${peerName} to reconnect…` : "Waiting to reconnect…",
        detail: `${peerName ?? "The other person"} dropped off for a moment.`,
        tone: "warning",
        chatAvailable: true,
      };
    case "peer-offline":
      return {
        label: peerName ? `Waiting for ${peerName} to reconnect` : "Waiting for the other person",
        detail: `${peerName ?? "The other person"} is offline. New messages are saved and delivered when they return.`,
        tone: "warning",
        chatAvailable: false,
      };
    case "available":
      return {
        label: "Both online",
        detail: "Messages are end-to-end encrypted.",
        tone: "success",
        chatAvailable: true,
      };
    case "expired":
      return {
        label: "Room expired",
        detail: "This room has expired and is being destroyed.",
        tone: "danger",
        chatAvailable: false,
      };
  }
}
