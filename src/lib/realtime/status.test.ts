import { describe, expect, it } from "vitest";
import { availabilityView, connectionLabel, toneClasses } from "@/lib/realtime/status";
import type { RoomAvailability } from "@/lib/realtime/presence";

describe("connectionLabel", () => {
  it("labels every connection state", () => {
    expect(connectionLabel("connecting")).toBe("Connecting…");
    expect(connectionLabel("connected")).toBe("Connected");
    expect(connectionLabel("reconnecting")).toBe("Reconnecting…");
    expect(connectionLabel("offline")).toBe("Offline");
  });
});

describe("availabilityView", () => {
  const ALL: RoomAvailability[] = [
    "connecting",
    "reconnecting",
    "waiting-for-peer",
    "peer-away",
    "peer-offline",
    "available",
    "expired",
  ];

  it("renders every availability state", () => {
    for (const availability of ALL) {
      const view = availabilityView(availability, "Sam");
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.detail.length).toBeGreaterThan(0);
      expect(["muted", "success", "warning", "danger"]).toContain(view.tone);
    }
  });

  it("gates the composer only when the chat is unavailable", () => {
    expect(availabilityView("available", null).chatAvailable).toBe(true);
    expect(availabilityView("peer-away", null).chatAvailable).toBe(true);
    expect(availabilityView("connecting", null).chatAvailable).toBe(false);
    expect(availabilityView("reconnecting", null).chatAvailable).toBe(false);
    expect(availabilityView("waiting-for-peer", null).chatAvailable).toBe(false);
    expect(availabilityView("peer-offline", null).chatAvailable).toBe(false);
    expect(availabilityView("expired", null).chatAvailable).toBe(false);
  });

  it("names the peer in peer states and stays generic without one", () => {
    expect(availabilityView("peer-offline", "Sam").label).toContain("Sam");
    expect(availabilityView("peer-offline", null).label).not.toContain("null");
    expect(availabilityView("available", "Sam").label).toBe("Both online");
  });

  it("marks expiry as a danger state", () => {
    expect(availabilityView("expired", null).tone).toBe("danger");
    expect(availabilityView("available", null).tone).toBe("success");
  });

  it("toneClasses returns a non-empty class string for every tone", () => {
    for (const tone of ["muted", "success", "warning", "danger"] as const) {
      expect(toneClasses(tone).length).toBeGreaterThan(0);
    }
  });
});
