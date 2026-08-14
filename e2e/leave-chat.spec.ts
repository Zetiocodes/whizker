import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import {
  createRoom,
  E2E_MISSING_MSG,
  e2eAdminConfigured,
  e2eConfigured,
  expectText,
  joinRoom,
  makeAccounts,
  signup,
  waitForChatReady,
  type E2EAccounts,
} from "./helpers";

/**
 * "Leave chat" (Part 10): leaving a chat must permanently end it for BOTH
 * participants. The leaver is redirected to the dashboard and their
 * membership is deleted; the remaining participant sees "[Name] left the
 * chat." over realtime and a permanent ended screen on refresh; the room's
 * keys, encrypted content and metadata are destroyed server-side; and the
 * room code can never be reused (direct URL, join form, or a third user).
 */

function makeAdminClient(): SupabaseClient<Database> | null {
  if (!e2eAdminConfigured) {
    return null;
  }
  return createClient<Database>(
    process.env.E2E_SUPABASE_URL!,
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function leaveChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Leave chat" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Leave this chat?")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Leave chat" }).click();
  await page.waitForURL("**/dashboard");
}

function thirdAccount(): { username: string; password: string; displayName: string } {
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    username: `${process.env.E2E_USER_A_USERNAME ?? "e2e"}_${suffix}`,
    password: process.env.E2E_USER_A_PASSWORD!,
    displayName: "Third Person",
  };
}

test.describe("leave chat", () => {
  test.skip(!e2eConfigured, E2E_MISSING_MSG);

  test("leaving a chat permanently ends it for both participants", async ({
    browser,
  }) => {
    test.setTimeout(300_000);

    const accounts: E2EAccounts = makeAccounts();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const codeRef: { code: string } = { code: "" };

    try {
      await signup(pageA, accounts.a);
      await signup(pageB, accounts.b);

      const code = await createRoom(pageA);
      codeRef.code = code;
      await joinRoom(pageB, code);

      await waitForChatReady(pageA);
      await waitForChatReady(pageB);
      await expectText(pageA, "Both online");
      await expectText(pageB, "Both online");

      // A sends a message so there is real encrypted content to destroy.
      await pageA.locator('textarea[aria-label="Message"]').fill("leave me behind");
      await pageA.getByRole("button", { name: /send/i }).click();
      await expectText(pageB, "leave me behind");

      // A leaves; the dialog is explicit about the permanent destruction.
      await leaveChat(pageA);
      await expectText(pageA, "Your rooms", 30_000);

      // B learns instantly over realtime: "[A's display name] left the chat."
      await expect(
        pageB.getByText(new RegExp(`${accounts.a.displayName} left the chat`)),
      ).toBeVisible({ timeout: 30_000 });
      await expect(pageB.getByText("This chat has ended", { exact: true })).toBeVisible();

      // The chat cannot be used again, even after a refresh: B's composer is
      // gone and the ended screen persists (server-side `closed` status).
      await pageB.reload();
      await expect(pageB.getByText("This chat has ended", { exact: true })).toBeVisible();
      await expect(pageB.locator('textarea[aria-label="Message"]')).toHaveCount(0);

      // Server-side: the room is closed, its content and keys are gone, the
      // leaver's membership is deleted, and exactly one 'left' event exists.
      const admin = makeAdminClient();
      if (admin) {
        const { data: room } = await admin
          .from("rooms")
          .select("id, status")
          .eq("code", code)
          .maybeSingle();
        expect(room?.status).toBe("closed");

        const roomId = room!.id;
        const { count: messages } = await admin
          .from("messages")
          .select("id", { count: "exact" })
          .eq("room_id", roomId);
        expect(messages).toBe(0);

        const { count: keys } = await admin
          .from("room_keys")
          .select("id", { count: "exact" })
          .eq("room_id", roomId);
        expect(keys).toBe(0);

        const { count: participants } = await admin
          .from("room_participants")
          .select("id", { count: "exact" })
          .eq("room_id", roomId);
        expect(participants).toBe(1);

        const { data: events } = await admin
          .from("room_events")
          .select("type, display_name")
          .eq("room_id", roomId);
        expect(events).toHaveLength(1);
        expect(events![0].type).toBe("left");
        expect(events![0].display_name).toBe(accounts.a.displayName);
      }
    } finally {
      await ctxB?.close().catch(() => {});
      await ctxA?.close().catch(() => {});
    }
  });

  test("a closed room can never be reopened or reused", async ({ browser }) => {
    test.setTimeout(300_000);

    const accounts: E2EAccounts = makeAccounts();
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signup(pageA, accounts.a);
      await signup(pageB, accounts.b);

      const code = await createRoom(pageA);
      await joinRoom(pageB, code);
      await waitForChatReady(pageA);
      await waitForChatReady(pageB);

      // Close the room.
      await leaveChat(pageA);

      // A opens the old code directly: an ended screen, never a join prompt.
      await pageA.goto(`/c/${code}`);
      await expect(pageA.getByText("This chat has ended", { exact: true })).toBeVisible();

      // A tries the join form with the dead code on the dashboard.
      await pageA.goto("/dashboard");
      await pageA.getByPlaceholder("XXXX-XXXX-XXXX").fill(code);
      await pageA.getByRole("button", { name: /join/i }).click();
      await expect(
        pageA.getByRole("alert").getByText("This chat has already ended."),
      ).toBeVisible();

      // A brand-new third user cannot join either.
      const ctxC = await browser.newContext();
      const pageC = await ctxC.newPage();
      try {
        await signup(pageC, thirdAccount());
        await pageC.getByPlaceholder("XXXX-XXXX-XXXX").fill(code);
        await pageC.getByRole("button", { name: /join/i }).click();
        await expect(
          pageC.getByRole("alert").getByText("This chat has already ended."),
        ).toBeVisible();
      } finally {
        await ctxC?.close().catch(() => {});
      }
    } finally {
      await ctxB?.close().catch(() => {});
      await ctxA?.close().catch(() => {});
    }
  });
});
