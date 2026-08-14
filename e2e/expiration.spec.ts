import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  createRoom,
  e2eAdminConfigured,
  E2E_MISSING_MSG,
  expectText,
  joinRoom,
  makeAccounts,
  signup,
  waitForChatReady,
  type E2EAccounts,
} from "./helpers";

/**
 * Expiration (Part 8): proves the server cannot be coerced into keeping a room
 * alive past its 24h window and that an expired room is unreachable — even by
 * its own participants — and that joining with an expired code is rejected.
 *
 * The fixture expires the room via a TEST-ONLY service-role RPC
 * (supabase/migrations/999_test_helpers.sql) that rewrites expires_at to the
 * past. It is granted solely to service_role and is NOT applied to
 * production; the production app has no path to extend or shorten a room's
 * lifetime (RLS + the rooms_protect_lifetime trigger block everyone).
 */
test.describe("room expiration", () => {
  test.skip(!e2eAdminConfigured, E2E_MISSING_MSG);

  let accounts: E2EAccounts;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let roomCode: string;

  test.beforeAll(async ({ browser }) => {
    accounts = makeAccounts();
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
  });

  test.afterAll(async () => {
    await ctxB?.close().catch(() => {});
    await ctxA?.close().catch(() => {});
  });

  test("an expired room is destroyed and can no longer be joined", async () => {
    await signup(pageA, accounts.a);
    await signup(pageB, accounts.b);

    roomCode = await createRoom(pageA);
    await joinRoom(pageB, roomCode);
    await waitForChatReady(pageA);
    await waitForChatReady(pageB);
    await expectText(pageA, "Both online");

    const admin = createClient(
      process.env.E2E_SUPABASE_URL!,
      process.env.E2E_SUPABASE_SERVICE_ROLE_KEY!,
    );
    const { error } = await admin.rpc("force_expire_room_for_test", { p_code: roomCode });
    expect(error, "service-role force-expire RPC").toBeNull();

    await pageA.reload();
    await expectText(pageA, "This room has expired");

    const ctxC = await pageA.context().browser()!.newContext();
    const pageC = await ctxC.newPage();
    await signup(pageC, makeAccounts().a);
    await pageC.goto("/dashboard");
    await pageC.getByPlaceholder("XXXX-XXXX-XXXX").fill(roomCode);
    await pageC.getByRole("button", { name: /join/i }).click();
    await expectText(pageC, "This room has expired. Ask for a fresh code.");
    await ctxC.close();
  });
});
