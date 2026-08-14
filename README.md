# Whisper

Temporary anonymous **1-to-1 end-to-end encrypted** chat.

Two people create accounts, one creates a room, the other joins with a short
human-readable code, they chat — and 24 hours later the room, its messages and
its images are permanently destroyed. The server never sees plaintext and
holds no keys capable of decrypting anything.

> **Status: encrypted chat + images shipped, security-audited, Playwright E2E
> suite ready.** Auth (username/password), session handling, the database
> schema with Row-Level Security, temporary rooms (create / join with a secure
> code, presence, typing, read receipts, 24-hour expiry + server-side purge),
> **end-to-end-encrypted messaging** and **end-to-end-encrypted image sharing**
> (validate → strip EXIF/GPS → encrypt in the browser → upload only ciphertext
> to a private bucket → decrypt on view) are implemented. A 6-test Playwright
> E2E suite (full lifecycle + forced expiration) is wired up and skips cleanly
> until pointed at a hosted Supabase test project — live E2E verification is
> **pending a configured hosted Supabase test environment** and is not faked.
> See [PROJECT_STATUS.md](./PROJECT_STATUS.md),
> [docs/ENCRYPTION.md](./docs/ENCRYPTION.md) and
> [docs/SECURITY.md](./docs/SECURITY.md) for the design and threat model.

## Concept

- **Accounts** are username + password + display name. No email, no phone, no
  recovery — a lost password means a lost account.
- **Rooms** are temporary, capped at **two participants**, and expire exactly
  **24 hours** after creation. Expiry is enforced server-side; a client can
  neither extend nor shorten a room's lifetime.
- **End-to-end encryption** (AES-256-GCM via the Web Crypto API, keys derived
  from ephemeral-ephemeral ECDH) happens entirely in the browser for **messages
  and images**. Room codes are never used as keys. Image EXIF/GPS metadata is
  stripped in the browser before encryption, and only ciphertext is ever
  uploaded to storage.
- **Anonymity:** a participant only ever sees the other's display name.

## Tech stack

| Layer        | Choice                                             |
| ------------ | -------------------------------------------------- |
| Frontend     | Next.js (App Router) · TypeScript · Tailwind CSS   |
| Backend      | Supabase · PostgreSQL · Supabase Realtime · Storage |
| Auth         | Username/password via Supabase Auth                |
| Crypto       | Web Crypto API (AES-256-GCM, HKDF-SHA256, ECDH P-256) |
| Testing      | Vitest (unit) · Playwright (E2E)                   |
| Hosting      | Vercel · GitHub (open source)                      |

## Security invariants

- The server never receives plaintext message or image contents: every message
  and image is AES-256-GCM sealed in the browser before it is written, and the
  server stores only ciphertext + IV. Images additionally have EXIF/GPS
  metadata stripped locally before encryption, and only the opaque ciphertext
  blob (never an `image/*` content type) reaches the private storage bucket.
  See [docs/ENCRYPTION.md](./docs/ENCRYPTION.md).
- The room DEK is derived from ephemeral-ephemeral ECDH (`HKDF(ECDH(...))`) in
  each browser; the server never sees a private key or a plaintext key and
  cannot recover the DEK from what it stores. Key agreement is verified by both
  parties via a non-revealing `key_check` HMAC.
- The server never stores plaintext passwords, encryption keys, or room codes
  used as keys. No `console.*`, no secrets in the client bundle — the only
  client-visible keys are the `NEXT_PUBLIC_*` values.
- Room codes are generated from cryptographically secure randomness (60 bits),
  are never used as keys, and membership is enforced server-side.
- Row-Level Security is enabled (`FORCE`) on every table; rooms, participants,
  keys, messages and attachments are readable only by their participants and
  only while the room is within its 24-hour lifetime. Clients can never mutate
  rooms directly — only through the `create_room` / `join_room` /
  `touch_presence` database functions — and can only insert messages
  (ciphertext) and attachment metadata as themselves into their own non-expired
  rooms. Attachment inserts are additionally bound to a message that exists, is
  in the same room, was sent by the same user, and is an image type. The storage
  bucket is private; object access is participant-scoped and expiry-aware, with
  no client delete path for blobs.
- Expiration and hard deletion are enforced server-side (hourly cron purge,
  which empties expired encrypted blobs before removing the room rows), never
  by the browser. Room-scoped keys are wiped from the device on expiry.
- **Honest caveat (V1):** keys are not signed or pinned. Metadata (who, when,
  message size) and authorship within a room are established by the server, and
  a *malicious* server could substitute public keys (active MITM). A
  compromised browser or malicious browser extension can read whatever the
  browser can decrypt. Out-of-band key verification is a documented future
  hardening step. Full details in [docs/SECURITY.md](./docs/SECURITY.md).

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project values
npm run dev
```

### Supabase setup

1. Create a Supabase project.
2. In the SQL editor, run the migrations in `supabase/migrations/` in order:
   `001` → `009`. They create the schema, RLS policies, realtime
   configuration, the E2EE key-agreement functions, the read-receipt RPCs, and
   migration `008` creates the private `encrypted-attachments` storage bucket
   with participant-scoped policies (`009` hardens the attachment insert
   policy). `999_test_helpers.sql` is **test-only** — do NOT apply it to
   production (it exists for the E2E expiration fixture).
3. Copy your project URL, anon key, and service-role key into `.env.local`.
   Also set `CRON_SECRET` (e.g. `openssl rand -hex 32`) for the purge job.
4. *Authentication → Providers → Email → Confirm email* may be left in either
   state. Accounts are created server-side with the service-role key and
   `email_confirm: true`, so **no confirmation email is ever sent** to the
   synthetic `<username>@whisper.invalid` identifier and signup works
   identically whether the toggle is on or off.
5. (Vercel only) Deploying on Vercel adds the hourly `/api/cron/purge-rooms`
   job automatically from `vercel.json`; configure `CRON_SECRET` there too.
   The job empties expired encrypted blobs from storage **before** purging the
   room rows. Vercel cron invokes the route with a GET request and the
   `CRON_SECRET` bearer header; the route accepts both GET and POST.

### How username auth works

Supabase Auth identifies users by email/phone. Since this product has neither,
each username maps deterministically to a reserved synthetic identifier:

```
<username>@whisper.invalid   (RFC 2606 reserved, can never be a real address)
```

The username lives in `public.profiles` (UNIQUE, created by a trigger on
`auth.users`). The unique index is what guarantees no two accounts can share a
username — a concurrent duplicate signup is rolled back. Usernames are
normalized to lowercase and restricted to `[a-z0-9_]`.

### Session semantics

Sessions live in **session cookies**: refreshing the page keeps you signed in,
closing the browser ends the session and requires re-authentication. The
`src/proxy.ts` file refreshes expired tokens and re-stamps auth cookies as
session cookies on every request.

## Testing

- **Unit tests** (node, no network): `npm test` → 172 tests across 17 files
  covering room codes, the realtime presence/typing/receipt state machines,
  message ordering, image validation/EXIF-stripping/preview pipeline, E2EE
  primitives and storage cleanup.
- **Playwright E2E** (live, opt-in): `npx playwright install chromium`, then
  set the `E2E_*` vars (see `.env.example`) and run `npm run test:e2e`. The
  suite drives two real browsers through the full lifecycle — signup, create,
  join, key exchange, both-direction messages, read receipts, typing
  indicators, disconnect/reconnect, encrypted image sharing, history after
  refresh — and asserts the plaintext secrets never appear in any HTTP body or
  WebSocket frame. `e2e/expiration.spec.ts` force-expires a room via the
  test-only service-role RPC and asserts it becomes unreachable and unjoinable.
  Without the env vars the whole suite skips cleanly (6 skipped). Live
  verification is **pending a configured hosted Supabase test environment**.
- Run everything: `npm run test:all` (typecheck + lint + unit + build).

## Deployment (Vercel)

- Framework detection is automatic (`next build`). Set the project env vars
  from `.env.example`: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`.
- The hourly purge cron is declared in `vercel.json` and authenticated with
  `CRON_SECRET` automatically by Vercel. **Hobby-plan caveat:** Vercel Hobby
  restricts cron jobs (daily at best) — the hourly schedule effectively runs
  less often. This is safe: expiry is enforced by RLS and the
  `rooms_protect_lifetime` trigger in the database, not by the cron; the cron
  only reclaims storage. Prefer a Pro deployment if hourly cleanup matters.
- Deploy the app and Supabase project to the same region for lower latency.

## Known limitations (V1)

- No key pinning / out-of-band key verification (see Security invariants).
- A malicious server could mount an active MITM; a compromised device or
  malicious extension can read what the browser can decrypt.
- Metadata (participant identities, timestamps, ciphertext sizes) is visible to
  the server by design.
- Accounts are unrecoverable if the password is lost (intentional).
- Presence/typing are display-only and could be spoofed by a custom client.

## Project structure

```
src/
├── actions/        # server actions (auth + room create/join)
├── app/
│   ├── (auth)/     # login + signup pages
│   ├── (app)/      # authenticated pages (dashboard, room /c/[code])
│   ├── api/        # cron route handlers (purge-expired-rooms)
│   ├── layout.tsx  # root layout
│   └── page.tsx    # landing
├── components/     # app shell (responsive sidebar), account menu, auth shell,
│                   #   room layout/sidebar/chat, UI primitives (dialog, icons,
│                   #   badges, spinner, password field, buttons, inputs)
├── config/         # central configuration (incl. realtime + image limits)
├── hooks/          # client hooks (room-crypto handshake, realtime presence,
│                   #   typing indicators, message receipts)
├── lib/
│   ├── auth/       # validation schemas + session helpers
│   ├── chat/       # deterministic message ordering
│   ├── crypto/     # E2EE: base64url, Web Crypto primitives, image envelopes,
│   │               #   IndexedDB keys, room-key agreement state machine
│   ├── env.ts
│   ├── image/      # image validation, EXIF stripping, encrypt/upload prep,
│   │               #   preview lifecycle
│   ├── realtime/   # pure state machines for presence / typing / receipts /
│   │               #   availability (unit-tested, no network)
│   ├── rooms/      # room-code generation/normalization + input formatting +
│   │               #   shared "my rooms" summary
│   ├── storage/    # authenticated ciphertext upload + expiry blob purge
│   ├── supabase/   # browser / server / admin clients
│   ├── ui/         # pure UI formatters (countdown, expiry, clock, day label)
│   └── utils.ts
├── proxy.ts        # Next.js Proxy (auth guards + session-cookie semantics)
└── types/          # domain + database types
e2e/                # Playwright suite (lifecycle + expiration, opt-in)
supabase/
├── migrations/     # SQL migrations + RLS (001–009; 999 = test-only)
└── tests/          # SQL authorization-boundary checks
docs/
├── ENCRYPTION.md   # precise E2EE design + threat model
└── SECURITY.md     # honest V1 threat model + what to verify manually
```

## License

Open source.
