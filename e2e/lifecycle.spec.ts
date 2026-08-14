import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  containsPlaintext,
  createRoom,
  E2E_MISSING_MSG,
  e2eConfigured,
  expectText,
  joinRoom,
  makeAccounts,
  signup,
  solidPng,
  startSurveillance,
  waitForChatReady,
  type E2EAccounts,
  type Surveillance,
} from "./helpers";

const SECRET_A = "THIS_IS_A_SECRET_TEST_MESSAGE_FROM_ALICE";
const SECRET_B = "this is bob's secret reply to alice";
const SECRET_RECONNECT = "secret after reconnect, still encrypted";

test.describe("1-to-1 E2EE lifecycle", () => {
  test.skip(!e2eConfigured, E2E_MISSING_MSG);
  test.describe.configure({ mode: "serial" });

  let accounts: E2EAccounts;
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  let roomCode: string;
  let watchA: Surveillance;
  let watchB: Surveillance;

  test.beforeAll(async ({ browser }) => {
    accounts = makeAccounts();
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    watchA = startSurveillance(pageA);
    watchB = startSurveillance(pageB);
  });

  test.afterAll(async () => {
    await ctxB?.close().catch(() => {});
    await ctxA?.close().catch(() => {});
  });

  test("signup, create, join, key exchange and first messages", async () => {
    await signup(pageA, accounts.a);
    await signup(pageB, accounts.b);

    roomCode = await createRoom(pageA);
    await joinRoom(pageB, roomCode);

    await waitForChatReady(pageA);
    await waitForChatReady(pageB);
    await expectText(pageA, "Both online");

    await pageA.getByLabel("Message", { exact: true }).fill(SECRET_A);
    await pageA.getByRole("button", { name: /send/i }).click();
    await expectText(pageB, SECRET_A);

    await pageB.getByLabel("Message", { exact: true }).fill(SECRET_B);
    await pageB.getByRole("button", { name: /send/i }).click();
    await expectText(pageA, SECRET_B);
  });

  test("read receipt and typing indicator", async () => {
    const myBubble = pageA.locator("div.justify-end").filter({ hasText: SECRET_A }).first();
    await expect(myBubble.getByText("Read", { exact: true })).toBeVisible({ timeout: 30_000 });

    const typing = pageB.getByLabel("Message", { exact: true });
    await typing.click();
    await typing.pressSequentially("hello alice, just a draft");
    await expectText(pageA, `${accounts.b.displayName} is typing…`, 15_000);

    await typing.fill("");
    await expect(pageA.getByText(`${accounts.b.displayName} is typing…`)).toBeHidden({
      timeout: 15_000,
    });
  });

  test("image exchange, history after refresh, plaintext never on the wire", async () => {
    const png = solidPng(16, 16, [255, 0, 255, 255]);
    await pageA.locator('input[type="file"]').setInputFiles({
      name: "magenta.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expectText(pageA, "Image ready to send");
    await pageA.getByRole("button", { name: /send image/i }).click();

    await expect(pageB.locator('img[alt="Shared image"]')).toBeVisible({ timeout: 30_000 });

    await pageA.reload();
    await waitForChatReady(pageA);
    await expectText(pageA, SECRET_A);
    await expectText(pageA, SECRET_B);
    await expect(pageA.locator('img[alt="Shared image"]')).toBeVisible({ timeout: 20_000 });

    expect(containsPlaintext(watchA, SECRET_A)).toBe(false);
    expect(containsPlaintext(watchA, SECRET_B)).toBe(false);
    expect(containsPlaintext(watchB, SECRET_A)).toBe(false);
    expect(containsPlaintext(watchB, SECRET_B)).toBe(false);

    const upload = watchA.uploadBodies[0];
    expect(upload).toBeDefined();
    expect(upload.length).not.toBe(png.length);
    expect(upload.subarray(0, 4).toString("hex")).not.toBe("89504e47");
    expect(watchA.uploadContentTypes[0]).toContain("application/octet-stream");
  });

  test("closing User B's browser shows them offline to User A", async () => {
    // Closing the tab (not the whole context) drops B's presence entry so A
    // sees them offline, while B's IndexedDB identity/ephemeral keys survive
    // for the reconnect test below — E2EE recovery is device-scoped by design.
    await pageB.close().catch(() => {});
    await expectText(pageA, `Waiting for ${accounts.b.displayName} to reconnect`, 45_000);
  });

  test("User B reconnects and receives a new message", async () => {
    // Reconnect on the same device: a fresh browser context would have no
    // IndexedDB identity key, so the room DEK could not be restored (by
    // design). Reopening a tab in B's context recovers via `wrapped_key` —
    // the session cookie and IndexedDB keys both persist there, so no login
    // is needed.
    const pageB2 = await ctxB.newPage();
    await pageB2.goto(`/c/${roomCode}`);

    await waitForChatReady(pageB2);
    await expectText(pageA, "Both online");

    await pageA.getByLabel("Message", { exact: true }).fill(SECRET_RECONNECT);
    await pageA.getByRole("button", { name: /send/i }).click();
    await expectText(pageB2, SECRET_RECONNECT);

    await pageB2.close();
  });
});
