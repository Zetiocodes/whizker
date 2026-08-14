import { deflateSync } from "node:zlib";
import { expect, type Page } from "@playwright/test";

/**
 * Shared helpers for the Playwright E2E suite (Part 8).
 *
 * Everything here is opt-in: if the E2E env vars (see .env.example) are not
 * set, `e2eConfigured` is false and every spec skips. The suite exercises the
 * real product through two real browser contexts (User A and User B) with the
 * E2E network assertions wired in — no result is ever fabricated.
 */

export const e2eConfigured = Boolean(
  process.env.E2E_USER_A_USERNAME &&
    process.env.E2E_USER_A_PASSWORD &&
    process.env.E2E_USER_A_DISPLAY_NAME &&
    process.env.E2E_USER_B_USERNAME &&
    process.env.E2E_USER_B_PASSWORD &&
    process.env.E2E_USER_B_DISPLAY_NAME,
);

export const e2eAdminConfigured = e2eConfigured &&
  Boolean(process.env.E2E_SUPABASE_URL && process.env.E2E_SUPABASE_SERVICE_ROLE_KEY);

export const E2E_MISSING_MSG =
  "Playwright live E2E verification is pending a configured hosted Supabase test environment.";

export interface E2EAccounts {
  a: { username: string; password: string; displayName: string };
  b: { username: string; password: string; displayName: string };
}

/** Real credentials for two fresh users; a random suffix avoids collisions. */
export function makeAccounts(): E2EAccounts {
  const suffix = Math.random().toString(36).slice(2, 8);
  const base = (v: string | undefined) => (v ? `${v}_${suffix}` : `e2e_${suffix}`);
  return {
    a: {
      username: base(process.env.E2E_USER_A_USERNAME),
      password: process.env.E2E_USER_A_PASSWORD!,
      displayName: process.env.E2E_USER_A_DISPLAY_NAME!,
    },
    b: {
      username: base(process.env.E2E_USER_B_USERNAME),
      password: process.env.E2E_USER_B_PASSWORD!,
      displayName: process.env.E2E_USER_B_DISPLAY_NAME!,
    },
  };
}

export async function signup(page: Page, account: { username: string; password: string; displayName: string }) {
  await page.goto("/signup");
  await page.getByLabel("Username", { exact: true }).fill(account.username);
  await page.getByLabel("Display name", { exact: true }).fill(account.displayName);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByLabel("Confirm password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/dashboard");
}

export async function login(page: Page, account: { username: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Username", { exact: true }).fill(account.username);
  await page.getByLabel("Password", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL("**/dashboard");
}

/** Creates a room on the dashboard and returns the extracted room code. */
export async function createRoom(page: Page): Promise<string> {
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Create a room" }).click();
  await page.waitForURL("**/c/**");
  const code = new URL(page.url()).pathname.split("/").pop();
  if (!code) throw new Error("could not extract room code from URL");
  return code;
}

/** Joins a room from the dashboard join form. */
export async function joinRoom(page: Page, code: string) {
  await page.goto("/dashboard");
  await page.getByPlaceholder("XXXX-XXXX-XXXX").fill(code);
  await page.getByRole("button", { name: /join/i }).click();
  await page.waitForURL(`**/c/${code}`);
}

/**
 * Waits until the room is usable for this client: the E2EE badge lit and the
 * composer textarea enabled. This is the point where the key exchange has
 * completed and both sides can encrypt/decrypt.
 */
export async function waitForChatReady(page: Page, timeout = 45_000) {
  await expectText(page, "End-to-end encrypted", timeout);
  const composer = page.locator('textarea[aria-label="Message"]');
  await composer.waitFor({ state: "visible", timeout });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement | null;
      return !!el && !el.disabled;
    },
    undefined,
    { timeout },
  );
}

export function expectText(page: Page, text: string, timeout = 20_000) {
  return expect(page.getByText(text, { exact: true }).first()).toBeVisible({ timeout });
}

/** Sleep helper (presence / receipt timings are intentionally lenient). */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Collects every WebSocket frame and storage-upload request for a page so the
 * tests can assert the plaintext message/image never appears on the wire.
 */
export interface Surveillance {
  sent: string[];
  received: string[];
  uploadBodies: Buffer[];
  uploadContentTypes: string[];
}

function frameText(payload: string | ArrayBuffer | Buffer): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload).toString("utf8");
  return payload.toString("utf8");
}

export function startSurveillance(page: Page): Surveillance {
  const s: Surveillance = { sent: [], received: [], uploadBodies: [], uploadContentTypes: [] };
  page.on("websocket", (ws) => {
    ws.on("framesent", (e) => s.sent.push(frameText(e.payload)));
    ws.on("framereceived", (e) => s.received.push(frameText(e.payload)));
  });
  // The upload is a cross-origin XMLHttpRequest to Supabase Storage; those
  // request bodies are not exposed through `request.postDataBuffer()`, so the
  // body is read via route interception instead (still forwarded untouched).
  void page.route("**/storage/v1/object/encrypted-attachments/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      const body = req.postDataBuffer();
      if (body) s.uploadBodies.push(body);
      s.uploadContentTypes.push(req.headers()["content-type"] ?? "");
    }
    await route.continue();
  });
  return s;
}

/** True when the plaintext value appears in any captured frame or upload. */
export function containsPlaintext(s: Surveillance, value: string): boolean {
  const haystack = [...s.sent, ...s.received].join("\n");
  return haystack.includes(value) || s.uploadBodies.some((b) => b.toString("utf8").includes(value));
}

/** A recognizable solid-color PNG (valid, minimal, deterministic bytes). */
export function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const crcTable = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeData), 0);
    return Buffer.concat([len, typeData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = row + 1 + x * 4;
      raw[o] = rgba[0];
      raw[o + 1] = rgba[1];
      raw[o + 2] = rgba[2];
      raw[o + 3] = rgba[3];
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
