# Security: threat model and V1 limitations

This document describes, honestly, what Whisper protects against and what it
does **not**. Read it before trusting the product with anything sensitive. It
complements [docs/ENCRYPTION.md](./ENCRYPTION.md), which describes the exact
cryptographic design.

## What the product is

Two anonymous users chat in a room that is created, joined, used and destroyed
within a fixed 24-hour window. Message and image contents are end-to-end
encrypted in the browser. The server stores only ciphertext plus the metadata
required to operate (participant identities, timestamps, ciphertext sizes).

## What it protects against

| Threat | Protection |
| --- | --- |
| Server-side database breach | Ciphertext-only. No DEK, no private keys, no room codes used as keys, no plaintext passwords are stored. |
| A curious/malicious database admin reading messages | Cannot decrypt: AES-256-GCM ciphertext, keys never leave the browsers. |
| A malicious Supabase **auth/admin client** (the app's server) | Holds no key material beyond what clients give it; cannot decrypt stored ciphertext. It can substitute keys during agreement (see caveats). |
| Attacker who steals an account password | Sees display name and rooms of that user only; messages are still encrypted with the room DEK, which the attacker lacks (they would have to be a participant of the room with keys present). A participant leaving a room loses the DEK on expiry. |
| Attacker guessing room codes | 60 bits of cryptographic randomness per code (`crypto.getRandomValues`); no timing/predictable source; membership enforced server-side. |
| Forced room extension / deletion | `rooms.expires_at` is immutable for **every** role (`rooms_protect_lifetime` trigger) — even the service role cannot extend or shorten a room's life. RLS hides expired rooms immediately. |
| Deleting/overwriting ciphertext in storage | No client delete path; object access is participant-scoped and expiry-aware; blobs are cleaned by the server-side purge. |
| Browsing other participants' rooms | RLS on every table restricts reads to room participants within the room's lifetime. |
| Malicious client sending "read" receipts for others | Receipt RPCs are SECURITY DEFINER and rewrite only the caller's own sender_id rows. |
| Server logs leaking message content | App has no `console.*`; plaintext never leaves the browser except inside the HTTPS request to the origin, and the server never persists it. |

## What it does NOT protect against (V1 — be honest with yourself)

1. **Active MITM by the server.** Keys are not signed or pinned. A malicious
   server could present its own ephemeral public keys during key agreement and
   decrypt the conversation. This is inherent to a server-mediated
   key-exchange without out-of-band verification. Fixing this requires
   fingerprint pinning / a safer key agreement protocol — a documented future
   hardening step, not implemented.

2. **Compromised devices and malicious browser extensions.** Whatever the
   browser can decrypt, the browser's owner/attacker can read. Web Crypto gives
   no protection against malware on the device, a keylogger, a malicious
   extension, or someone with physical access while the app is open.

3. **Metadata.** The server knows who created/joined which room, when, from
   which IP, and the size/timing of every ciphertext. The app does not attempt
   traffic analysis resistance (e.g., padding or cover traffic).

4. **Malicious participants.** A participant is a full member of the E2EE
   group: they can see everything in the room, and could exfiltrate it. Two
   people who exchange room codes with a third party effectively invite them.

5. **Sophisticated coercion of the operator.** The service holds no keys, so
   compelling the operator to reveal conversation contents is not possible —
   but compelling them to serve malicious code or substitute keys *is* (see
   MITM above).

6. **Identity/anonymity guarantees are weak by design.** Anonymity rests on
   the display name and on the operator not logging; the server can trivially
   correlate sessions, IPs and behavior. Do not claim "anonymous" beyond what
   it is.

7. **Username enumeration / replay of public data.** Public metadata is public;
   the design intentionally avoids adding obstacles (rate limiting, captchas)
   that would break the casual anonymous UX.

## Defense-in-depth details

- RLS is `FORCE`d on every table; direct client DML on rooms/participants/keys
  is impossible — mutations go through SECURITY DEFINER RPCs (`create_room`,
  `join_room`, `touch_presence`, receipt RPCs) that validate membership and
  expiry.
- Expiry is enforced in three layers: RLS read guards (`expires_at > now()`),
  the `rooms_protect_lifetime` trigger (immutability for all roles), and the
  hourly purge (hard delete + storage blob cleanup). Even a completely broken
  cron cannot extend a room's life.
- Attachment uploads are `application/octet-stream` only, participant-scoped,
  path-pinned to `<room_id>/<message_id>.bin`, and the insert policy requires
  the referenced message to exist, be in the same room, be sender-owned, and be
  an image.
- Secrets boundary: the only client-visible values are `NEXT_PUBLIC_*`;
  `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` are server-only and never
  bundled. Verified by grep; the client bundle contains no `console.*` and no
  `eval`.
- The Playwright E2E suite asserts the plaintext secrets never appear in any
  HTTP request body or WebSocket frame, and that an expired room is
  unreachable and unjoinable.

## What to verify manually before trusting a production deployment

This repo ships the code and the tests, but an independent audit of the
deployment is the only thing that establishes trust in a live instance.
Recommended manual verification:

1. **Reproduce the E2E suite** against your own hosted Supabase test project
   (`npm run test:e2e`) and confirm all 6 tests pass — including the network
   plaintext assertions and the forced-expiration fixture.
2. **Inspect the deployed JS** for the expected properties: no plaintext
   strings beyond UI copy, no `SUPABASE_SERVICE_ROLE_KEY`, no `CRON_SECRET`.
3. **Review the SQL migrations** (`supabase/migrations/001`–`009`) and the RLS
   checks (`supabase/tests/rls_checks.sql`) — confirm every policy, trigger and
   SECURITY DEFINER function matches the documented intent. Confirm
   `999_test_helpers.sql` is **absent** from production.
4. **Test expiry end-to-end** in production after the 24h window: the room must
   be unreachable, unjoinable, and its storage objects gone.
5. **Confirm the purge cron** runs on your Vercel plan (Hobby cron limits may
   reduce its frequency; expiry itself is still RLS-enforced).
6. **Do not** disable RLS, add client delete paths, switch the storage bucket
   to public, or add logging of message contents — any of these silently
   breaks the guarantees above.
