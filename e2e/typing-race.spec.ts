import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createRoom,
  E2E_MISSING_MSG,
  e2eConfigured,
  expectText,
  joinRoom,
  makeAccounts,
  signup,
  waitForChatReady,
  type E2EAccounts,
} from "./helpers";

/**
 * The realtime runtime errors this suite guards against: publishing presence
 * (or any event) to a channel that has not joined yet.
 */
const RACE_ERROR_PATTERNS = [
  /before joining/i,
  /before subscribing/i,
  /before join/i,
  /channel not joined/i,
];

/** Collects uncaught page errors + console errors that match the race patterns. */
function monitorRealtimeErrors(page: Page): string[] {
  const raceErrors: string[] = [];
  page.on("pageerror", (err) => {
    if (RACE_ERROR_PATTERNS.some((p) => p.test(err.message))) {
      raceErrors.push(`pageerror: ${err.message}`);
    }
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (RACE_ERROR_PATTERNS.some((p) => p.test(msg.text()))) {
      raceErrors.push(msg.text());
    }
  });
  return raceErrors;
}

/**
 * Holds server frames for the typing channel topic (`realtime:room-typing:*`)
 * so the typing channel stays in SUBSCRIBING while the user types — a
 * deterministic reproduction of the "track before join" race. All other frames
 * (presence channel, presence sync) flow untouched so the room still reaches
 * "available". `holdNow()` arms the hold; `release()` flushes the held frames
 * so the deferred publish fires, and deactivates the hold for good.
 */
function holdTypingJoin(page: Page): {
  holdNow: () => void;
  release: () => void;
  frames: Array<{ dir: "up" | "down"; topic: string; held: boolean }>;
} {
  let active = false;
  const held: Array<string | Buffer> = [];
  const frames: Array<{ dir: "up" | "down"; topic: string; held: boolean }> = [];
  let serverRoute: { send: (message: string | Buffer) => void } | null = null;

  const topicOf = (message: string | Buffer): string => {
    const text = typeof message === "string" ? message : message.toString("utf8");
    try {
      const parsed = JSON.parse(text) as { topic?: unknown };
      return typeof parsed.topic === "string" ? parsed.topic : "<none>";
    } catch {
      return "<parse-error>";
    }
  };

  void page.routeWebSocket((url) => url.pathname.includes("/realtime/"), (ws) => {
    const server = ws.connectToServer();
    serverRoute = server;
    // Page -> server: pass everything through untouched.
    ws.onMessage((message) => {
      frames.push({ dir: "up", topic: topicOf(message), held: false });
      void server.send(message);
    });
    // Server -> page: hold only typing-channel frames while active.
    server.onMessage((message) => {
      const topic = topicOf(message);
      const typingTopic = topic.startsWith("realtime:room-typing:");
      const holdThis = active && typingTopic;
      frames.push({ dir: "down", topic, held: holdThis });
      if (holdThis) {
        held.push(message);
      } else {
        void ws.send(message);
      }
    });
  });

  return {
    holdNow: () => {
      active = true;
    },
    release: () => {
      active = false;
      const toSend = held.splice(0);
      for (const message of toSend) {
        void serverRoute?.send(message);
      }
    },
    frames,
  };
}

function captureTypingFrames(page: Page): string[] {
  const seen: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (e) => {
      const text = typeof e.payload === "string" ? e.payload : Buffer.from(e.payload).toString("utf8");
      if (text.includes("room-typing:")) seen.push(text);
    });
  });
  return seen;
}

test.describe("typing indicator subscription race", () => {
  test.skip(!e2eConfigured, E2E_MISSING_MSG);

  test("rapid typing, deferred join, reconnect, leave and refresh never hit track-before-join", async ({
    browser,
  }) => {
    test.setTimeout(300_000);

    const accounts: E2EAccounts = makeAccounts();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const raceA = monitorRealtimeErrors(pageA);
    const raceB = monitorRealtimeErrors(pageB);
    const framesB = captureTypingFrames(pageB);

    // Wire the hold before any navigation so it intercepts the very first
    // typing-channel join on page A.
    const hold = holdTypingJoin(pageA);

    try {
      await signup(pageA, accounts.a);
      await signup(pageB, accounts.b);

      const code = await createRoom(pageA);
      await joinRoom(pageB, code);

      // Arm the hold before the room becomes chat-ready, so the typing channel
      // join lands while we are holding its server frames.
      hold.holdNow();

      await waitForChatReady(pageA);
      await waitForChatReady(pageB);
      await expectText(pageA, "Both online");
      await expectText(pageB, "Both online");

      const composerA = pageA.locator('textarea[aria-label="Message"]');
      const indicatorB = pageB.getByText(`${accounts.a.displayName} is typing…`);

      // 1) Deterministic race: type while the typing channel is still joining.
      //    The publish must be deferred, never thrown, and flushed on join.
      await composerA.pressSequentially("before the typing channel joins", { delay: 50 });
      await expect(indicatorB).toBeHidden();
      hold.release();
      try {
        await expect(indicatorB).toBeVisible({ timeout: 20_000 });
      } catch (e) {
        console.log("DIAG A frames:", JSON.stringify(hold.frames, null, 1));
        console.log("DIAG B typing frames:", JSON.stringify(framesB, null, 1));
        throw e;
      }
      await composerA.fill("");
      await expect(indicatorB).toBeHidden({ timeout: 15_000 });

      // 2) Rapid start/stop typing repeatedly.
      for (let i = 0; i < 3; i++) {
        await composerA.pressSequentially("rapid burst", { delay: 20 });
        await composerA.fill("");
        await pageB.waitForTimeout(300);
      }
      await expect(indicatorB).toBeHidden({ timeout: 15_000 });

      // 3) Connection drop then reconnect: typing keeps working, no errors.
      await ctxA.setOffline(true);
      await expect(pageA.getByText(/Connection lost|Reconnecting/i).first()).toBeVisible({
        timeout: 30_000,
      });
      await ctxA.setOffline(false);
      await expectText(pageA, "Both online");
      await expectText(pageB, "Both online");
      await composerA.pressSequentially("after the reconnect", { delay: 50 });
      await expect(indicatorB).toBeVisible({ timeout: 20_000 });
      await composerA.fill("");
      await expect(indicatorB).toBeHidden({ timeout: 15_000 });

      // 4) Leave the room while typing: the indicator must clear.
      await composerA.pressSequentially("leaving mid-burst");
      await pageA.close();
      await expect(indicatorB).toBeHidden({ timeout: 30_000 });

      // 5) Return to the room and type again.
      const pageA2 = await ctxA.newPage();
      const raceA2 = monitorRealtimeErrors(pageA2);
      await pageA2.goto(`/c/${code}`);
      await waitForChatReady(pageA2);
      await expectText(pageA2, "Both online");
      const composerA2 = pageA2.locator('textarea[aria-label="Message"]');
      await composerA2.pressSequentially("back in the room", { delay: 50 });
      await expect(indicatorB).toBeVisible({ timeout: 20_000 });
      await composerA2.fill("");
      await expect(indicatorB).toBeHidden({ timeout: 15_000 });

      // 6) Refresh while typing, then immediately type again.
      await composerA2.pressSequentially("about to refresh");
      await pageA2.reload();
      await waitForChatReady(pageA2);
      await expectText(pageA2, "Both online");
      const composerA3 = pageA2.locator('textarea[aria-label="Message"]');
      await composerA3.pressSequentially("after the refresh", { delay: 30 });
      await expect(indicatorB).toBeVisible({ timeout: 20_000 });
      await composerA3.fill("");
      await expect(indicatorB).toBeHidden({ timeout: 15_000 });

      // 7) No track-before-join runtime errors on either side, across the
      //    entire run (including the held-join scenario).
      expect([...raceA, ...raceB, ...raceA2]).toEqual([]);
    } finally {
      await ctxB?.close().catch(() => {});
      await ctxA?.close().catch(() => {});
    }
  });
});
