# PROJECT_STATUS.md

_Last updated: 2026-08-14 — Part 8 complete: final security audit, production hardening and Playwright E2E suite (6 opt-in tests covering the full lifecycle + forced expiration, skipped cleanly until pointed at a hosted Supabase test project). Live E2E verification remains pending a configured hosted Supabase test environment._

## Current architecture

A Next.js 16 (App Router) + TypeScript + Tailwind CSS v4 frontend backed by
Supabase (PostgreSQL + Realtime + Storage), designed to run on Vercel.

```
src/
├── actions/
│   ├── auth.ts            # server actions: signup / login / logout
│   └── rooms.ts           # server actions: create room / join room
├── app/
│   ├── (auth)/login/      # login page (client form + useActionState)
│   ├── (auth)/signup/     # signup page (incl. no-recovery warning)
│   ├── (app)/dashboard/   # create/join room UI + "Your rooms" list
│   ├── (app)/c/[code]/    # room page (room-shell: presence, countdown, chat)
│   ├── api/cron/purge-rooms/  # hourly purge of expired rooms
│   ├── globals.css        # Tailwind v4 + dark-first design tokens
│   ├── layout.tsx         # root layout + metadata
│   └── page.tsx           # landing page
├── components/
│   ├── account-menu.tsx     # account popover (display name, username, logout)
│   ├── app-shell.tsx        # global shell: responsive sidebar + main + context
│   ├── auth/auth-shell.tsx
│   ├── brand.tsx
│   ├── rooms/               # create-room-button, join-room-form (auto-format),
│   │   │                    #   inline-join, room-list-row (live countdown),
│   │   │                    #   room-shell (owns the single realtime client +
│   │   │                    #     connection + availability + layout),
│   │   │                    #   room-sidebar (code, countdown, participants),
│   │   │                    #   chat-header (display name, status, expiry),
│   │   │                    #   chat-panel (encrypted conversation + composer),
│   │   │                    #   emoji-picker, image-bubble (decrypt-on-view)
│   └── ui/                  # button, input, field, icon, spinner, badge,
│                            #   dialog (accessible modal), password-field
├── config/
│   └── index.ts           # limits, room-code format, crypto params,
│                          #   auth (synthetic email domain, session cookie),
│                          #   realtime timing constants, image limits
├── hooks/
│   ├── use-room-crypto.ts # room-key handshake state machine (realtime-driven)
│   ├── use-room-connection.ts  # realtime presence + heartbeat + connect state
│   ├── use-room-typing.ts      # ephemeral typing indicators (presence channel)
│   └── use-message-receipts.ts # debounced delivered/read receipt flush
├── lib/
│   ├── auth/
│   │   ├── session.ts     # getCurrentUser() (server-side, getUser()-validated)
│   │   └── validation.ts  # zod schemas (username/password/display name)
│   ├── chat/sort.ts       # deterministic message ordering (createdAt, id)
│   ├── crypto/            # E2EE (see docs/ENCRYPTION.md)
│   │   ├── encode.ts      # base64url (pure, browser + Node)
│   │   ├── primitives.ts  # ECDH-P256 / HKDF / AES-256-GCM / HMAC (+ binary)
│   │   ├── image.ts       # image payload + blob envelopes (AAD-bound)
│   │   ├── key-store.ts   # IndexedDB: identity + ephemeral + room DEKs
│   │   └── room-crypto.ts # key agreement state machine (server = ciphertext only)
│   ├── env.ts             # env-var handling
│   ├── image/             # Part 6 image pipeline (pure, DOM-free, tested)
│   │   ├── validation.ts  #   magic-byte sniffing + size/format limits
│   │   ├── metadata.ts    #   byte-level EXIF/GPS stripping (JPEG/PNG/WebP)
│   │   ├── pipeline.ts    #   encrypt-then-upload prep + attachment paths
│   │   └── preview.ts     #   object-URL preview lifecycle
│   ├── realtime/          # pure state machines (unit-tested, no network):
│   │   ├── presence.ts    #   connection + peer-presence + room availability
│   │   ├── typing.ts      #   TypingTracker (burst → idle → stop)
│   │   ├── receipts.ts    #   collectReceiptBatches + ReceiptBatcher
│   │   └── status.ts      #   user-facing labels / tones for availability
│   ├── rooms/code.ts      # secure room-code generation + normalization + input formatting
│   ├── rooms/summaries.ts # shared "my rooms" query (dashboard + sidebar)
│   ├── ui/format.ts       # pure UI formatters (countdown, expiry, clock, day)
│   ├── storage/
│   │   ├── upload.ts      # XHR upload with progress (session JWT, no service role)
│   │   └── cleanup.ts     # server-side purge of expired attachment blobs
│   ├── supabase/
│   │   ├── client.ts      # browser client (realtime: auto-refresh enabled)
│   │   ├── server.ts      # server client (request cookies)
│   │   └── admin.ts       # service-role client (server-only)
│   └── utils.ts           # cn()
├── proxy.ts               # Next.js Proxy: auth guards + session-cookie semantics
└── types/                 # domain types + typed Database schema (incl. RPCs)
supabase/
├── migrations/            # 001_profiles … 009_harden_attachment_policy
│                          #   999_test_helpers.sql = TEST-ONLY (never prod)
├── tests/                 # rls_checks.sql (authorization-boundary checks)
e2e/
├── helpers.ts             # accounts, signup/login, surveillance, test PNG
├── lifecycle.spec.ts      # full two-browser lifecycle + plaintext-on-wire checks
└── expiration.spec.ts     # forced-expiry fixture + join rejection
docs/
├── ENCRYPTION.md          # precise E2EE design + threat model
└── SECURITY.md            # honest V1 threat model + manual verification guide
```

## Installed dependencies

Runtime: `next` ^16.3.1 · `react`/`react-dom` ^19.2.8 ·
`@supabase/supabase-js` ^2.112.3 · `@supabase/ssr` ^0.12.4 · `zod` ^4.4 ·
`server-only`

Dev: `typescript` ^5.9.3 · `tailwindcss` ^4.3.3 + `@tailwindcss/postcss` ·
`eslint` ^9 + `eslint-config-next` ^16.3.1 · `vitest` ^4 · `@playwright/test`
^1.62 (E2E only) · `@types/*`

## Environment variables required

See `.env.example`:

| Variable                        | Required | Notes                                    |
| ------------------------------- | -------- | ---------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | yes      | public                                   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes      | public                                   |
| `SUPABASE_SERVICE_ROLE_KEY`     | yes      | signup auto-confirm + purge job          |
| `CRON_SECRET`                   | yes*     | bearer token for the purge cron route    |
| `NEXT_PUBLIC_APP_URL`           | no       | falls back to localhost                  |
| `E2E_*`                         | no       | Playwright live suite only; absent ⇒ skipped |

\* Required in production (cron) and any environment running the purge route;
optional locally.

## Part 2 — completed work

### Accounts (username/password)

- Username/password/display-name signup via Supabase Auth. Because Supabase
  identifies users by email/phone, each username maps deterministically to a
  reserved synthetic identifier `<username>@whisper.invalid` (RFC 2606
  `.invalid` can never be a real address). The identifier is never shown.
- Usernames are normalized (trim + lowercase), restricted to `[a-z0-9_]`,
  3–20 chars, and enforced UNIQUE in `public.profiles` — a concurrent
  duplicate signup is rolled back by the DB (trigger raises on
  unique_violation), so there is no TOCTOU window.
- Passwords: min 10 / max 128 chars; hashed by Supabase Auth (bcrypt); no
  plaintext storage, no reset/recovery. Signup UI warns the account is
  unrecoverable.
- User IDs are `auth.users.id` (uuid) — never derived from username, password
  or display name.
- If "Confirm email" is enabled on the project, signup still works: accounts
  are created server-side via the service-role `admin.createUser({ email_confirm: true })`
  call, which never sends a confirmation email to the synthetic address
  (it can never receive mail). The setting is irrelevant to signup.

### Session behavior

- Cookie-based session via `@supabase/ssr`; refresh preserves the session.
- Session-cookie semantics enforced in `src/proxy.ts`: `@supabase/ssr` writes
  ~400-day cookies by default, so the proxy re-stamps every auth cookie
  (prefix `whisper-session`) as a session cookie (no Max-Age) on each request.
  → Browser close ends the session; reopening requires login. This honors the
  product spec while keeping refresh persistence.
- `src/proxy.ts` (Next 16 renamed middleware → proxy) also refreshes expired
  tokens and guards routes: `/dashboard` requires auth, `/login` + `/signup`
  redirect authenticated users to `/dashboard`.
- Server components verify the session with `getUser()` (JWT validated
  against the auth server), never trusting the cookie alone.

### Database schema (`supabase/migrations/`)

- `001_profiles.sql` — `profiles` (id FK→auth.users, username UNIQUE +
  normalized check, display_name), `handle_new_user()` trigger (mirrors
  metadata → profile, rolls back on duplicate username), immutable-username
  trigger, RLS (own-row select/update only, FORCE).
- `002_rooms.sql` — `rooms` (code UNIQUE `XXXX-XXXX-XXXX` over
  `[A-HJ-NP-Z2-9]`, owner, created_at, expires_at = created_at + 24h enforced
  by trigger, immutable lifetime, status enum `waiting|active|expired`),
  `room_participants` (exactly two enforced by trigger, one-owner partial
  unique index, display-name snapshot), `room_keys` (wrapped DEK per recipient
  — Part 4), RLS deny-by-default.
- `003_messages_attachments.sql` — `messages` (ciphertext + iv + version +
  type/status enums, created/delivered/read timestamps; **no plaintext
  column**), `attachments` (storage_path to encrypted blob, mime, size, iv,
  created_at, expires_at; **no plaintext image column**), RLS deny-by-default.
- `004_realtime.sql` — adds rooms/room_participants/messages to the
  `supabase_realtime` publication (RLS-filtered; participant policies land in
  005).
- `005_rooms_part3.sql` — room state model (guarded `'full'` → `'waiting'`
  rename), the `create_room` / `join_room` / `touch_presence` /
  `purge_expired_rooms` SECURITY DEFINER functions, participant-scoped RLS
  policies on all five tables (expiry-aware), and execute grants (RPCs →
  `authenticated`, purge → `service_role` only).
- Row-Level Security is `ENABLE`d and `FORCE`d on every table. Profiles allow
  own-row access; rooms/participants/messages/attachments/keys are readable
  only by their participants and only while the room has not expired.

### UI

- Dark-first, Discord-inspired (not a copy) design system: `ui/button`,
  `ui/input`, `ui/field`, `auth/auth-shell`, `brand`.
- `/` landing with feature summary and auth links.
- `/signup` and `/login` — progressive-enhancement forms driven by server
  actions via `useActionState`, per-field and top-level errors, the explicit
  no-recovery warning on signup.
- `/dashboard` — protected shell with create-room / join-room forms and a
  "Your rooms" list (RLS-filtered, non-expired only).

## Part 3 — completed work

### Room lifecycle (server-side)

- `src/lib/rooms/code.ts` — `generateRoomCode()` draws 12 bytes from
  `crypto.getRandomValues` and maps `byte % 32` (unbiased: 256 is a multiple
  of 32) onto the 32-symbol unambiguous alphabet → 60 bits of entropy, format
  `XXXX-XXXX-XXXX`. `normalizeRoomCode()` canonicalizes user input (trims,
  uppercases, accepts with/without separators) so malformed codes never reach
  the database.
- `src/actions/rooms.ts` — `createRoomAction` (retries up to 5× on a code
  collision) and `joinRoomAction` (maps `room_expired` / `room_full` /
  `room_not_found` / `not_authenticated` to clean user messages; best-effort
  purge on expired). Both call the RPCs with the **user's** session (never the
  service-role client), so `auth.uid()` is correctly populated and RLS cannot
  be bypassed.
- DB RPCs (migration 005, SECURITY DEFINER): `create_room(p_code)` inserts the
  room + owner membership; `join_room(p_code)` takes a `FOR UPDATE` row lock,
  is idempotent for existing members, rejects missing/full/expired/malformed
  rooms, and marks the room `active` on the second join; `touch_presence(uuid)`
  refreshes `last_seen_at` (heartbeat); `purge_expired_rooms()` hard-deletes
  expired rooms (cascade clears participants/keys/messages/attachment rows).
- Expiry is never enforced by the browser: the hourly Vercel cron hits
  `/api/cron/purge-rooms` (bearer `CRON_SECRET`), and the room page fires a
  best-effort purge when it detects an expired room. Note: a `raise` inside
  `join_room` rolls the whole operation back, so expired rooms are deleted by
  the purge job, not at join time.

### Authorization (RLS)

- Participant-scoped, expiry-aware SELECT policies on `rooms`,
  `room_participants`, `room_keys` (own row only), `messages` and
  `attachments`, all via the existing `is_room_participant()` helper +
  `expires_at > now()`.
- No insert/update/delete policies exist on `rooms`/`room_participants`: the
  RPCs are the only mutation path. `purge_expired_rooms` is executable only by
  `service_role`; anon gets nothing.
- `supabase/tests/rls_checks.sql` — manual authorization-boundary checks to run
  in the SQL editor (anon reads, anon RPC execution, non-participant reads,
  expiry deletion, concurrent-join capacity).

### UI

- `/dashboard` — "Create a room" (one-click, redirects to the room) and "Join a
  room" (code input) cards, plus a "Your rooms" list via a nested
  `room_participants → rooms` select (typed through `Database.Relationships`).
- `/c/[code]` — room page. Server side: normalizes the code, fetches through
  RLS (participant + non-expired), and uses the admin client only to
  distinguish *expired* from *unknown* codes (inline join offered for active
  rooms the caller hasn't joined; 404 otherwise).
- `room-view` — client component with realtime presence (channel
  `room-presence:<roomId>`, `presenceState` → online user ids), a 30s
  `touch_presence` heartbeat, a live countdown to expiry, copy-to-clipboard
  (with fallback), participant list with online dots, and the four derived
  states: `waiting` / `active` / `temporarily_offline` / `expired`
  (`temporarily_offline` is derived from presence, never persisted).
- `src/proxy.ts` now also protects `/c/*`; the browser Supabase client enables
  `autoRefreshToken` so long-lived realtime connections never go stale (the
  proxy re-stamps session cookies on the next request).

### Tests

- `npm test` runs Vitest: `src/lib/rooms/code.test.ts` (format, alphabet,
  no ambiguous chars, uniqueness over 10k, normalization) and
  `src/lib/auth/validation.test.ts`. `vitest.config.ts` aliases `@` → `src`.

## Part 4 — completed work

### End-to-end encryption (design: `docs/ENCRYPTION.md`)

- Threat model: honest-but-curious server. Ciphertext + public keys only;
  no key signatures/pinning (active MITM explicitly out of scope for V1).
- Primitives (`src/lib/crypto/primitives.ts`, Web Crypto only): ECDH P-256,
  HKDF-SHA256, AES-256-GCM, HMAC-SHA256; pure functions, testable in Node.
  `encode.ts` is a dependency-free base64url codec.
- Keys: per-user ECDH identity keypair (private in IndexedDB, public published
  to `user_public_keys`) + per-room ephemeral ECDH keypair (public in
  `room_keys`, private in IndexedDB). Room DEK is **derived**, never stored:
  `DEK = HKDF(ECDH(own_eph_priv, peer_eph_pub), salt = room_id,
  info = "whisper/room-dek/v1")`. Both sides derive the same key; the server
  cannot (it holds neither ephemeral private key).
- `room_keys.key_check` = base64url HMAC(DEK, "whisper/key-check/v1"): both
  parties verify agreement without revealing the DEK. `wrapped_key` self-wraps
  the DEK under the identity key for recovery.
- Messages: AES-256-GCM, fresh random 12-byte nonce per message (schema CHECK:
  `char_length(iv) = 16`), AAD binds each payload to its room. No plaintext
  ever touches the DB, realtime, actions, routes, or logs.
- `key-store.ts`: IndexedDB (`whisper-keys`: identity/ephemeral/rooms).
  Room-scoped keys are wiped on room expiry; identity survives. Clearing site
  data destroys recoverability (documented; no escrow by design).
- `useRoomCrypto` + `synchronizeRoomKeys`: realtime-driven state machine
  (`awaiting-peer → ready | error`) with recovery via wrapped_key, slow poll
  fallback, and identity publish.
- UI: `chat-panel` (history decrypt, live stream with dedupe, error bubbles,
  composer gated on key readiness) rendered in the room card via a new `chat`
  slot on `room-view`. `chatEnabled: true`.

### Schema (`006_chat_e2ee.sql`)

- `user_public_keys` (public identity keys; select-all-authenticated,
  insert/update-own, RLS FORCE).
- `room_keys`: `key_check` column; RLS rewritten to `select` for any room
  participant, `insert`/`update` own row only.
- `messages`: RLS INSERT policy (`sender_id = auth.uid()`, participant, room
  not expired) + `messages_iv_length` CHECK.
- Realtime: `room_keys` + `user_public_keys` added to the publication.

### Tests

- `src/lib/crypto/encode.test.ts` + `primitives.test.ts`: base64url
  round-trip/canonicality, ECDH + DEK agreement across participants, round
  trips (Unicode), wrong-key / tampered ciphertext / tampered IV / wrong-room
  rejection, 500-message nonce uniqueness, server-with-only-public-keys cannot
  derive, stored row contains no plaintext, wrapped-key round trip + wrong
  identity + tamper rejection, key_check equality.

## Part 5 — completed work

### Realtime layer (presence, availability, typing, receipts)

- `src/lib/realtime/presence.ts` — three pure state machines (unit-tested, no
  network): **connection** (`connecting → connected | reconnecting | offline`),
  **peer presence** (`unknown → online → away → offline` with a fixed grace
  window), and **room availability**
  (`connecting / reconnecting / waiting-for-peer / peer-away / peer-offline /
  available / expired`) derived from the two. `reconnecting` vs `offline` is
  distinguished by the presence channel still being subscribed.
- `use-room-connection` — owns the realtime presence channel for a room:
  tracks this device, observes the peer, sends a `touch_presence` heartbeat and
  re-tracks every `presenceRetrackMs`, and drives the connection state machine.
  **Disconnect handling is driven entirely by realtime** (subscribe callback
  `SUBSCRIBED`/`CHANNEL_ERROR`/`CLOSED`/`TIMED_OUT` + system events), never by
  `beforeunload`/`pagehide` — browsers do not reliably fire those, and the
  server auto-expires stale presence entries anyway. No other client subscribes
  to presence; `room-shell` owns the single browser client and passes derived
  state down to `room-view` and `chat-panel`.
- `room-shell` — new client wrapper rendered by `/c/[code]` that owns the single
  `createClient()`, runs `useRoomConnection`, derives room availability, and
  renders `RoomView` (presence + countdown + chat slot) + `ChatPanel`.
  Reconnect/refresh always re-arms against the *same* room id — never a new
  room, never a new key.
- `chat-panel` — rewritten to receive `client`, `availability`, and `peerName`
  as props. Composer is gated on availability (blocked while `connecting` /
  `reconnecting` / `waiting-for-peer` / `peer-offline` / `expired`, with an
  inline availability hint; usable during `peer-away`). Live INSERT + UPDATE
  realtime handling; typing indicator; per-message **Sent / Delivered / Read**
  footer with timestamp; availability label + Encrypted badge in the header.

### Typing indicators (ephemeral)

- `src/lib/realtime/typing.ts` — `TypingTracker` (publish start once per burst,
  auto-stop after `typingIdleMs`, viewer requires entry age ≤ idle + leeway) +
  `use-room-typing` over a `room-typing:<roomId>` presence channel. **Nothing
  about typing is ever persisted**: only a transient realtime presence update;
  the channel is torn down on unmount and auto-cleared on disconnect.

### Delivered / read receipts (server-authoritative, migration 007)

- `mark_messages_delivered(p_room, p_message_ids)` and
  `mark_messages_read(...)` SECURITY DEFINER RPCs are the **only** way message
  status advances. Guards enforced inside the function (never in the client):
  caller is a participant of a non-expired room, `sender_id <> auth.uid()` (a
  recipient can only mark, never their own messages — receipts are not
  forgeable), missing/foreign ids silently skipped, `cardinality <= 500`,
  monotonic `sent → delivered → read` (a read backfills `delivered_at`; nothing
  ever moves backward). Grants only to `authenticated`, revoked from `public`.
- `src/lib/realtime/receipts.ts` — `collectReceiptBatches` + `ReceiptBatcher`:
  while the recipient is **not viewing** the conversation only `sent` messages
  collect `delivered`; while viewing, `sent` + `delivered` collect `read`. Only
  message **ids** cross the wire — never plaintext.
- `use-message-receipts` — debounced flush (`deliveredBatchMs`/`readBatchMs`),
  also flushed on `visibilitychange`/`focus`/`blur`. Read receipts only fire
  when `document.visibilityState === 'visible' && document.hasFocus()`, and
  nothing is re-sent after a batch commits.
- `chat-panel` shows the status footer only for **own** messages; recipients
  see no status (by design, matching the threat model — status would leak
  whether the other party had read).

### Tests

- `src/lib/realtime/presence.test.ts` (24), `typing.test.ts` (8),
  `receipts.test.ts` (12), `status.test.ts` (6) — 50 new tests. `npm test`
  now runs **95 tests across 8 files**, all passing (code, auth validation,
  crypto, realtime).
- `supabase/tests/rls_checks.sql` extended with receipt-RPC boundary checks:
  no UPDATE policy may exist on `messages`, anon cannot execute the RPCs, and
  commented manual checks for monotonicity / self-marking / expired / >500.

## Part 6 — completed work

### End-to-end encrypted image sharing (design: `docs/ENCRYPTION.md`)

- Pipeline, all client-side: **pick → validate → strip EXIF/GPS → encrypt →
  upload ciphertext → realtime delivery → decrypt on view**. Plaintext image
  bytes exist only in the sender's memory and (after decrypt) the recipient's
  — never on the server, never on the realtime bus. The sender's own message
  renders from the already-encrypted in-memory ciphertext (no re-download).
- `src/lib/crypto/image.ts` — reuses the Part 4 AES-256-GCM + room DEK with two
  AAD-bound envelopes: the **blob** (`aad "whisper/image-blob/v1|<roomId>|<msgId>|<attId>"`,
  binary in/out, fresh 12-byte nonce stored in `attachments.iv`) and the
  **message payload** (`aad "whisper/image/v1|<roomId>"`, plaintext
  `{"attachmentId":"<uuid>"}` — an encrypted pointer so the recipient can only
  learn which storage object belongs to a message by decrypting the message
  first). Both ciphertexts bind room + message + attachment, so a compromised
  server cannot replay or swap blobs.
- `src/lib/image/validation.ts` — magic-byte sniffing (JPEG/PNG/GIF/WebP; the
  browser MIME is never trusted), size checked on real bytes, `too-large` /
  `unsupported-type` / `invalid-image` → friendly messages. 8 MB plaintext cap
  (`appConfig.image.maxBytes`).
- `src/lib/image/metadata.ts` — byte-level EXIF/GPS stripping **before**
  encryption: JPEG drops APP1 (EXIF+XMP, keeps APP2/ICC), PNG drops
  tEXt/iTXt/zTXt/tIME/eXIf, WebP drops EXIF/ICCP + re-stamps RIFF size, GIF
  passes through (no standard container; documented). Best-effort: malformed
  files are sent unchanged, never corrupted.
- `src/lib/storage/upload.ts` — uploads **only ciphertext** as
  `application/octet-stream` via XHR to `POST /storage/v1/object/<bucket>/<path>`
  using the user's **session JWT** (never a service-role credential), with
  real upload progress. Paths are non-predictable: `<roomId>/<attachmentId>.bin`
  (both random uuids; no usernames, codes or sequences).
- `src/lib/image/preview.ts` — local object-URL previews (injected URL API,
  every preview revoked, including on unmount).
- `src/lib/storage/cleanup.ts` — `purgeExpiredAttachmentBlobs` (service-role,
  cron): lists the bucket, groups by room, keeps only live non-expired rooms,
  deletes the rest (sweeps orphaned uploads too). Runs **before** the room
  purge so paths still exist to enumerate.
- `chat-panel` — attach button + hidden file input, preview chip with size/MIME
  and upload progress bar, `prepareImageToSend` → `uploadEncryptedBlob` →
  `insert attachments row` → `insert messages row (type: image)` (realtime
  notifies the peer), own copy rendered from the in-memory ciphertext.
  Deterministic ordering via `sortMessages`. Image errors render inline
  ("couldn't be decrypted" / "no longer available") and never count toward the
  text failure footer.
- `image-bubble` — downloads the attachment row (must match decrypted ids +
  message id), verifies `blob.size === size_bytes`, decrypts with the room DEK,
  renders from a fresh object URL (revoked on unmount). Reports its stage
  (`loading → ready | error`) upward so read receipts only fire when the image
  is actually displayed.
- Receipts: `ReceiptCandidate.rendered` (default true = Part 5 text behaviour).
  An image message reports **delivered** while loading and **read** only once
  rendered on screen.

### Schema (`008_image_attachments.sql`)

- Private `encrypted-attachments` bucket (`public = false`, idempotent).
- `public.attachment_room_id(text)` SECURITY DEFINER helper — defensive uuid
  extraction from storage paths, never errors on malformed input (avoids a
  policy DoS vector).
- Storage policies (SELECT + INSERT, `authenticated`) scoped to room
  participants of non-expired rooms via `is_room_participant()`. **No client
  DELETE policy** on storage objects.
- `attachments` INSERT policy binds the metadata row to its object:
  `storage_path = room_id || '/' || id || '.bin'`, MIME allow-list, IV 16 chars,
  `sender_id = auth.uid()`, participant + non-expired room. Plus the
  `attachments_iv_length` CHECK constraint. `grant insert` to `authenticated`.

### Tests

- 55 new tests across 9 new files (`validation`, `metadata`, `pipeline`,
  `preview`, `crypto/image`, `storage/upload`, `storage/cleanup`,
  `chat/sort`) + rendered-gating cases in `realtime/receipts.test.ts`.
  `npm test` now runs **150 tests across 16 files**, all passing.
- `supabase/tests/rls_checks.sql` extended with Part 6 boundary checks:
  no UPDATE/DELETE policy on `attachments`, the `attachments_iv_length`
  constraint exists, bucket is private, expected storage policies exist, no
  client storage DELETE policy, `attachment_room_id()` exists, plus commented
  manual checks for path/MIME/IV binding and non-participant / expired access.

## Part 7 — completed work

### Design system (`src/app/globals.css` + `src/components/ui/`)

- Extended tokens: `--color-warning`, `--shadow-card` / `--shadow-overlay` /
  `--shadow-popover`, custom slim scrollbars, a `.focus-ring` utility, and
  subtle entrance animations (`message-in`, `fade-in`, `scale-in`,
  `typing-bounce`, `pulse-soft`) with a global `prefers-reduced-motion`
  override that disables every animation and transition.
- New dependency-free primitives: `ui/icon.tsx` (original hand-rolled 24×24
  stroke SVG set), `ui/spinner.tsx` (aria-aware), `ui/badge.tsx` (tone
  variants incl. E2EE/status pills), `ui/dialog.tsx` (accessible modal: focus
  trap, Escape + backdrop close, body scroll lock, `aria-modal`/`aria-labelledby`),
  `ui/password-field.tsx` (show/hide toggle wired into ARIA). `button.tsx`
  gained an `icon` size and `loading` spinner; `input.tsx` styles `aria-invalid`.

### Global app shell

- `app-shell.tsx` — fixed sidebar drawer on mobile / static rail on desktop,
  `h-dvh` layout so the mobile keyboard never clips the composer, `useSidebar()`
  context (the chat header re-uses the hamburger), a "Rooms" nav list with the
  active room highlighted, and an account popover pinned to the bottom. Backdrop
  + Escape close the drawer.
- `account-menu.tsx` — display name + username + logout (spinner while pending);
  closes on outside-click/Escape. Only display names are ever shown to peers.
- `lib/rooms/summaries.ts` — one shared `getMyRoomSummaries` drives both the
  dashboard list and the room sidebar (they always agree).
- `room-list-row.tsx` — client row with a live "in Xh Ym" remaining label,
  status dot and Expired badge (keeps `Date.now` out of the server render).

### Auth, landing, dashboard

- `AuthShell` — centered card + "End-to-end encrypted" pill. Login/signup use
  `PasswordField` toggles, spinner-loading submits, inline per-field errors and
  the explicit "No recovery" note (unchanged promise).
- Landing — hero + feature grid with icons and an E2EE badge (original artwork).
- Dashboard — two primary action cards (Create / Join), "Your rooms" with live
  countdowns, and a proper empty state.

### Room experience

- `room-shell.tsx` is now the full-page layout: AppShell + `room-sidebar.tsx`
  (join code with copy action, live 24h countdown, participants with online
  dots, presence label, privacy reminder) + full-height `ChatPanel`. Expired
  rooms render a dedicated "expired" card. Presence/availability derivation and
  room-key cleanup moved here. `room-view.tsx` was removed (superseded).
- `chat-header.tsx` — the other participant's **display name only** (never
  username/email/id), availability dot + human label, a live "N h left" expiry
  badge, the E2EE indicator, and the mobile sidebar toggle.
- `chat-panel.tsx` — rebuilt around the design system:
  - **Optimistic pending messages**: text appears instantly as "Sending…",
    reconciles to the realtime row, or becomes a **Failed** bubble with inline
    **Retry / Discard** — no DB/crypto internals ever shown.
  - Sent / Delivered / Read footers on own messages; timestamps via
    `formatClockTime`; undecryptable rows render human-only error bubbles
    ("Unable to decrypt this message." / "Unable to decrypt this image.").
  - Composer: auto-growing textarea, **Enter sends / Shift+Enter newline** with
    an IME-composition guard, emoji button with a curated picker (insert at
    cursor), attach + preview chip with real upload progress, disabled states
    while the chat is unavailable, and focus scroll-into-view for the mobile
    keyboard.
  - Offline / peer-away / waiting banners that state messages are end-to-end
    encrypted and stored as ciphertext for the 24-hour room lifetime — nothing
    is deleted merely because someone went offline (they never claim content is
    "stored only on your device").
  - Typing indicator with animated dots, empty/loading/error states, and an
    **image lightbox** built on the accessible `Dialog`.
- `image-bubble.tsx` — distinct "Loading…"/"Decrypting…" labels, ready state
  with a hover zoom affordance that **expands into the lightbox**, and separate
  "Unable to decrypt this image." vs "This image is no longer available." errors.

### Formatting helpers (pure, unit-tested)

- `lib/ui/format.ts` — `formatCountdown` (HH:MM:SS), `formatRelativeRemaining`
  ("in 23h 59m"), `formatRemainingShort` ("23h left"), `formatClockTime`
  (stable 24h), `formatDayLabel` (Today/Yesterday/short date).
- `lib/rooms/code.ts` — `formatRoomCodeInput`: progressive auto-formatting
  (uppercase + dash grouping, strips invalid chars, clamps to 12) used by the
  join form; the canonical `normalizeRoomCode` still runs server-side.

### Responsive + accessibility

- Breakpoints exercised: 320/375/390 (mobile drawer, full-viewport chat,
  compact composer), 768 (two-column dashboard cards), 1024/1280/1440 (static
  sidebar rail). No hard-coded widths — fluid layout with `sm:`/`lg:` tiers.
- Semantic landmarks (`aside`/`nav`/`main`/`header`), keyboard-operable
  drawer/dialog/lightbox/menu (Escape, focus trap, visible focus rings),
  `aria-label` on every icon button, `role="alert"` on form errors,
  `role="status"` on banners/typing, labelled progress bars, `aria-current` on
  the active room, contrast-checked tokens, `prefers-reduced-motion` support.

### Constraints honored

- **No new dependencies** (icons/dialog/spinner/badge/password-field are all
  hand-rolled) and no large UI framework — the dependency surface is unchanged.
- **Part 4 crypto and Part 5 realtime logic untouched** — only presentation was
  restructured. No RLS / auth / membership / 24h-expiry / storage rules changed.
- No client-side secrets, no `console.*`, no sensitive logging; usernames and
  ids never render inside a room; the E2EE indicator is text only
  ("End-to-end encrypted").
- No voice/video/group chat/user discovery/profiles/feeds/payments etc. added.

### Tests

- 22 new pure-logic tests: `lib/ui/format.test.ts` (18) +
  `formatRoomCodeInput` cases in `lib/rooms/code.test.ts` (4). Vitest here is
  Node-only (no DOM renderer), so UI logic is kept as pure functions and the
  components' behaviour is covered by typecheck + lint + build.
  `npm test` now runs **172 tests across 17 files**, all passing.

## Part 8 — completed work

### Final security audit

- **Secrets & env boundary**: no `.env` / `.env.local` present; `.gitignore`
  hardened to ignore `.env`, `.env.*`, `.env*.local` while tracking
  `.env.example` (verified with `git check-ignore`). Only `NEXT_PUBLIC_*` is
  client-visible; `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` are server-only
  (`server-only` + route handlers). Full-tree secret scan clean; no real
  secrets ever committed (repo has no commits).
- **Source hygiene**: grep audit finds no `console.*`, `eval`,
  `new Function`, `dangerouslySetInnerHTML`, `innerHTML`,
  `document.write`, `localStorage` or `sessionStorage` anywhere in `src/`.
- **Auth audit**: passwords never stored/logged; username uniqueness enforced
  by a DB `UNIQUE` index (concurrent dup rolls back); server-side `getUser()`
  validation on every protected page; session cookies re-stamped in the proxy;
  no recovery path — signup UI states the account is unrecoverable.
- **Room codes**: `crypto.getRandomValues` only (60-bit), no
  `Math.random`/timestamps/user-derived entropy; normalized before DB access;
  collision retry on insert; `create_room`/`join_room` are SECURITY DEFINER
  with `FOR UPDATE` locking and immutable `expires_at` (trigger blocks every
  role, including service_role).
- **E2EE**: AES-256-GCM with fresh 12-byte nonces, HKDF-derived room DEK from
  ECDH P-256, AAD room-binding, `wrapped_key` self-wrapping under the identity
  key, `key_check` HMAC agreement verification. Room code/password are never
  keys. Optimistic plaintext exists only in React state in memory; dedupe via
  `seenIds`; ciphertext only to DB + realtime.
- **Storage**: bucket private, `application/octet-stream` only,
  participant-scoped + expiry-aware; no client delete path; uploads use the
  user's session JWT, never the service role.
- **Dependencies**: `npm audit` → 0 vulnerabilities; `npm ls` → no duplicates,
  no unused top-level deps.

### Issues found and fixed

1. **Broken image send (real bug, unit tests never caught it)**: `sendImage`
   inserted the `attachments` row (FK to `messages.id`) **before** the
   `messages` row → immediate FK violation on a live DB. Fixed by reversing the
   order (message first, then attachment). A bounded recipient-side retry
   (`image-bubble.tsx`, 8 × 400 ms) covers the realtime race where the message
   row arrives before the attachment row.
2. **Unbound attachment insert policy**: the `attachments` INSERT policy did
   not verify the referenced message exists, is in the same room, was sent by
   `auth.uid()`, or is an image type. New migration
   `009_harden_attachment_policy.sql` drops and recreates the policy with all
   four bindings.
3. **Vercel cron would 405**: the purge route only exported `POST`, but Vercel
   cron fires a **GET** with `Authorization: Bearer <CRON_SECRET>` — the hourly
   purge would have failed. The route now handles both GET and POST.
4. **Wording**: banners previously implied content was "stored only on your
   device". Now accurate: end-to-end encrypted + stored as ciphertext for the
   24-hour room lifetime (reconnecting / peer-offline / waiting-for-peer).

### Playwright E2E suite (opt-in, no fabricated results)

- `@playwright/test` ^1.62 added as a devDependency; `playwright.config.ts`
  (workers 1, serial; conditional `webServer`; `E2E_BASE_URL` opt-out).
- `e2e/lifecycle.spec.ts` — two real browser contexts: signup, create, join,
  key exchange, both-direction messages, read receipts, typing indicator,
  closing B's browser → A sees offline, image send/receive (canvas-generated
  PNG), history after refresh, B reconnect + new message. Network surveillance
  (`request` bodies + `websocket` frames) asserts the plaintext secrets never
  appear on the wire and the storage upload is not the plaintext PNG.
- `e2e/expiration.spec.ts` — force-expires a room through the TEST-ONLY
  service-role RPC `force_expire_room_for_test` (migration 999, granted to
  service_role alone, never applied to prod), asserts the room shows
  "This room has expired" after reload and joining with the code is rejected.
- Without the `E2E_*` env vars the whole suite skips cleanly (verified: 6
  skipped). Live verification remains pending a configured hosted Supabase
  test environment.
- `.env.example` documents the `E2E_*` placeholders; `npm run test:e2e` /
  `test:e2e:install` / `test:all` scripts added; eslint + gitignore cover
  `e2e/`, `playwright.config.ts`, `playwright-report/`, `test-results/`.

### Performance audit

- Production client JS ≈ 1 MB total; largest chunks ≈ 300 KB / 224 KB (room +
  dashboard pages incl. Supabase client, realtime, crypto worker, image
  pipeline). Crypto runs in a Web Worker (verified in the bundle) so key
  agreement never janks the main thread. History + attachment lookups are
  indexed (`messages_room_created_idx`, `attachments_room_idx`). Login/signup
  static. No obvious bottlenecks.

### Docs

- `README.md` rewritten for the public GitHub release (status, invariants,
  setup incl. migrations 001–009, E2E guide, Vercel deployment + Hobby cron
  caveat, known limitations).
- `docs/SECURITY.md` added — honest V1 threat model (what is protected, what is
  not: active MITM, compromised devices/extensions, metadata, malicious
  participants) plus the manual verification checklist for a production trust.

## Verification performed

- [x] `npm run typecheck` passes
- [x] `npm run lint` passes (2 pre-existing warnings in `src/actions/rooms.ts`;
      the decrypted-blob `<img>` usages carry targeted `eslint-disable` comments)
- [x] `npm run build` passes (7 routes; `/dashboard` + `/c/[code]` dynamic)
- [x] `npm test` passes (172 tests: room-code, auth validation, crypto,
      realtime, image pipeline, storage, ordering, UI formatters)
- [x] `npx playwright test --list` → 6 tests; with no `E2E_*` vars → 6 skipped
      (clean skip, no server required)
- [x] `npm audit` → 0 vulnerabilities; secret scan clean; no `console.*`/`eval`
      in `src/`
- [ ] Visual QA via screenshots is not available in this environment — layout
      and responsive behaviour are verified by code review only.
- [ ] **Live E2E verification is pending a configured hosted Supabase test
      environment** (no local Postgres/Docker available): apply migrations
      001–009 (+ 999 test-only on a disposable project), run
      `supabase/tests/rls_checks.sql`, then `npm run test:e2e` and confirm all
      6 tests pass — including the plaintext-on-the-wire assertions and the
      forced-expiration fixture. Not faked.

## Next implementation phase

1. Configure a hosted Supabase test project, set the `E2E_*` env vars and run
   `npm run test:e2e` — the 6 Playwright tests (full lifecycle + expiration).
2. Optional hardening: out-of-band key verification (safety numbers) to close
   the active-MITM caveat documented in `docs/SECURITY.md`.
