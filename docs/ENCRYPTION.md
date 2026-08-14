# End-to-End Encryption (V1)

This document is the precise design of the app's end-to-end encryption. It is
the source of truth for the implementation in `src/lib/crypto/*` and the
schema in `supabase/migrations/006_chat_e2ee.sql`.

## Threat model

- **Assumed adversary: an honest-but-curious server** (Supabase/Postgres,
  Realtime, Storage, Vercel). The server is trusted to run correctly and to
  not inject malicious JavaScript, but it should not be able to learn message
  contents even if it inspects everything it stores or relays.
- **What is protected:** the plaintext of every message **and of every image**.
  The server only ever sees AES-256-GCM ciphertext, per-message/per-image IVs,
  envelope version numbers, public keys, and key-agreement check HMACs. It
  never sees a private key, a room DEK, message plaintext, or image plaintext.
- **What is NOT protected (by design in V1):**
  - **Metadata:** the server knows the participants of each room, the sender,
    size and timing of every message/image, the storage paths and byte sizes of
    encrypted blobs, and when rooms are created/expired.
  - **Authorship:** within a room, who sent a message is established by the
    server (`sender_id`), not by cryptography. Either participant can
    impersonate the other toward the room.
  - **A malicious server (active MITM):** keys are not signed or pinned. A
    server that deviates from the protocol could substitute public keys during
    the exchange and decrypt traffic it relays. Defending against this needs
    out-of-band key verification (safety numbers / fingerprints), which is
    **out of scope for V1**.
  - **Device compromise:** all key material lives in the browser's IndexedDB.
    Anyone with access to the (unlocked) browser can read it.
  - **Image presence:** the server can see that an image message exists, its
    encrypted byte size, and the storage path, but cannot see or render the
    image itself.

## Key architecture

Three layers of key material, all generated in the browser with the Web Crypto
API:

```
identity keypair (ECDH P-256, long-lived, one per user per device)
   public  -> user_public_keys  (server, public by definition)
   private -> IndexedDB          (never leaves the device)

ephemeral keypair (ECDH P-256, one per user per room, 24h lifetime)
   public  -> room_keys.ephemeral_public_key (server, public)
   private -> IndexedDB          (never leaves the device)

room DEK (32 bytes, AES-256, derived, never stored in plaintext anywhere)
   derived from ephemeral-ephemeral ECDH, see below
   sealed copy -> room_keys.wrapped_key (self-wrap under the identity key)
```

### Why the DEK is *derived*, not random

The room DEK is **derived** from an ephemeral-ephemeral ECDH agreement rather
than generated randomly and shared. This makes the exchange fully
offline-tolerant and order-independent:

- The guest derives the DEK the moment it reads the owner's ephemeral public
  key — no round trip needed to "receive a wrapped key".
- The owner derives the DEK the moment the guest's ephemeral public key
  appears (via realtime).
- The server never handles a wrapped DEK produced for someone else, because
  nobody produces one: both parties compute the same value locally.

Room codes are never used as keys.

### The key agreement

```
shared = ECDH(own_ephemeral_private, peer_ephemeral_public)   // 32 bytes
DEK    = HKDF-SHA256(ikm = shared, salt = room_id, info = "whisper/room-dek/v1")
keyCheck = base64url(HMAC-SHA256(key = DEK, "whisper/key-check/v1"))
```

- Both participants run the same derivation with their own private key and the
  other's public key and arrive at the **same** DEK.
- The server holds both ephemeral *public* keys but neither *private* key, so
  it cannot compute `shared` and therefore cannot compute the DEK.
- `key_check` is a MAC of a constant under the DEK. It lets each side verify
  the other derived the same DEK **without revealing the DEK**. A mismatch
  aborts the room as an error (never auto-overwrites a key).

### The identity key and `wrapped_key`

`room_keys.wrapped_key` is the DEK sealed under the user's **own** identity
key (a self-wrap, not a transfer):

```
wrapKey = HKDF-SHA256(ECDH(identity_priv, identity_pub),
                      salt = room_id, info = "whisper/wrap/v1")
wrapped_key = base64url(iv12 || AES-256-GCM(wrapKey, DEK, aad="whisper/wrap/v1|<roomId>"))
```

It exists for **recovery**: if the per-room ephemeral material is lost from
IndexedDB (e.g. partial site-data wipe) but the identity key survives, the DEK
can be unwrapped from `wrapped_key` and verified against `key_check`. If both
are gone, history is unrecoverable (see *Key loss*).

## Room life-cycle flows

### Owner creates a room

1. Generates (or reuses) the identity keypair; publishes the public half to
   `user_public_keys` (upsert).
2. Generates an ephemeral keypair for the room; inserts a `room_keys` row with
   `ephemeral_public_key`, `wrapped_key = ''`, `key_check = ''` (placeholder —
   the DEK is not derivable until the guest's key exists).
3. Room shows **"Setting up…"** (`awaiting-peer`). No messages can be sent yet.

### Guest joins a room

1. Generates (or reuses) the identity keypair; publishes the public half.
2. Reads the owner's `room_keys` row → ephemeral public key present → derives
   the DEK.
3. Verifies the owner's `key_check` agrees (if already set).
4. Inserts its own `room_keys` row: its ephemeral public key, `wrapped_key`
   (DEK self-wrapped under its identity), `key_check`.
5. Room becomes **"Encrypted"** (`ready`).

### Owner detects the guest (realtime)

1. A `room_keys` INSERT event (the guest's row) wakes `useRoomCrypto`.
2. Derives the DEK from its own ephemeral private key + the guest's ephemeral
   public key, verifies `key_check` agreement.
3. Updates its placeholder row with `wrapped_key` + `key_check`.
4. Room becomes **"Encrypted"** (`ready`).

The DEK is never exchanged: each side derives it independently.

## Message encryption

Every message payload is sealed with AES-256-GCM:

```
envelope = { ciphertext, iv, version }
ciphertext = base64url(AES-256-GCM(DEK, utf8(plaintext), iv,
                                   aad = "whisper/message/v1|<roomId>"))
iv    = base64url(12 random bytes)     // FRESH for every message
version = 1
```

- **Nonce uniqueness:** the nonce is 96 bits of `crypto.getRandomValues`
  randomness, freshly drawn per message, and the schema enforces
  `char_length(iv) = 16` (12 bytes base64url). AES-GCM's one fatal misuse —
  nonce reuse under the same key — is prevented both at generation time and by
  the database constraint. This is the reason for the fixed 12-byte nonce
  length; a future version must keep this constraint in mind if it changes the
  nonce size.
- **Authenticated data (AAD):** each payload is cryptographically bound to its
  room id. A ciphertext replayed into another room fails authentication.
- **Integrity:** GCM authenticates the ciphertext; any tampering (including
  of the IV) causes decryption to throw, and the UI renders an error bubble
  with no content. Wrong-key decryption fails identically.

### Message insertion path (server never sees plaintext)

`ChatPanel` encrypts locally, then inserts **only** `{room_id, sender_id,
type, ciphertext, iv, version}` through the RLS-protected INSERT policy
(`sender_id = auth.uid()` and the caller must be a non-expired-room
participant). Realtime relays the ciphertext row; the peer decrypts locally.
Deduplication by message id handles the echo of one's own insert.

### History / reconnect

On load (and after any reconnect), history is re-fetched as ciphertext rows
and decrypted locally in order. A message whose row survives but whose key
material is gone renders as an undecryptable bubble; plaintext is never shown
for a failed decryption.

## Image sharing (Part 6)

Images use the same AES-256-GCM + room DEK machinery as text, with an added
**binary layer** and an **encrypted attachment pointer**. The whole flow is
client-side, in this order:

```
pick → validate (magic bytes, size) → strip EXIF/GPS → encrypt → upload
                                            ↑ only ciphertext ever leaves the browser
```

### The two ciphertexts of one image

1. **Blob** — the actual image bytes (post metadata-stripping), sealed as
   binary (no base64, no re-encode) and uploaded to the private storage bucket
   as opaque `application/octet-stream`:

   ```
   aad_blob = "whisper/image-blob/v1|<roomId>|<messageId>|<attachmentId>"
   blob_iv  = base64url(12 random bytes)   // stored in attachments.iv
   storage  = POST /storage/v1/object/encrypted-attachments/<roomId>/<attachmentId>.bin
   ```

2. **Message payload** — a small JSON pointer to the attachment row, sealed and
   stored in `messages.ciphertext` (the same realtime row text messages use):

   ```
   plaintext  = {"attachmentId":"<uuid>"}         // an encrypted pointer
   aad_meta   = "whisper/image/v1|<roomId>"
   stored as  messages.type = 'image' + { ciphertext, iv, version }
   ```

The recipient must decrypt the **payload first** to learn which storage object
belongs to the message; the attachment row is then checked against the
decrypted ids (`attachment.id === attachmentId`,
`attachment.message_id === messageId`) before its blob is downloaded and
decrypted with `aad_blob`. Because both ciphertexts are bound by AAD to the
exact room/message/attachment, a compromised server cannot replay or swap in a
different blob, and cannot re-bind a blob to another message.

### What the server sees for an image

- `messages` row: `type='image'`, ciphertext pointer, IV — no image bytes.
- `attachments` row: ids, `storage_path`, `mime_type` (the original image MIME,
  non-secret), ciphertext `size_bytes`, IV — no image bytes, no thumbnails.
- Storage object: opaque ciphertext bytes; **never** an `image/*` content type.
- The bucket is **private** (`public = false`); storage policies scope SELECT /
  INSERT to the two room participants while the room is live, and there is
  deliberately **no client DELETE policy** — removal happens only via the
  server-side hourly purge, which deletes blobs of expired rooms before the
  room cascade wipes the metadata rows.

A sender's own message decrypts from the in-memory ciphertext (no re-download);
a recipient downloads the ciphertext, verifies size + ids, decrypts, and shows
the image from a fresh object URL that is revoked on unmount.

### EXIF / metadata stripping

Sensitive metadata is removed **before** encryption, byte-level, in the
browser (no re-encode, so no quality/animation loss):

| Format | What is dropped |
| ------ | --------------- |
| JPEG   | APP1 segments (EXIF + XMP); APP2 (ICC profile) is kept for color fidelity |
| PNG    | `tEXt` / `iTXt` / `zTXt` / `tIME` / `eXIf` chunks |
| WebP   | `EXIF` / `ICCP` chunks; RIFF size re-stamped |
| GIF    | **none** — GIF has no standard EXIF/GPS container, so it is passed through byte-for-byte |

Stripping is best-effort and never blocks sending: a file whose structure does
not parse cleanly is sent unchanged rather than corrupted. Malformed or
non-strippable images are therefore the one documented case where EXIF could
still reach the recipient — the recipient decrypts the same bytes the sender
had. The sender's own copy and the recipient's decrypted copy are the only two
places plaintext image bytes ever exist.

### Images and read receipts

An image message only counts as **"read"** once the image is actually
*displayed* (`rendered`), never merely downloaded. While it is still
decrypting or awaiting its blob, the recipient reports it as **"delivered"**
only; the "read" receipt fires when the pixels are on screen. Text behaviour is
unchanged (rendered on decrypt).

## Room-key state machine (client)

`useRoomCrypto` drives `synchronizeRoomKeys()`:

| State           | Meaning                                          |
| --------------- | ------------------------------------------------ |
| `awaiting-peer` | No peer ephemeral public key yet. Poll + realtime. |
| `ready`         | DEK available; messages can be encrypted/decrypted. |
| `error`         | Permanent problem (key mismatch / tampering / unavailable crypto). No internals surfaced. |

Recovery order on every sync: (1) unwrap our own `wrapped_key` and verify
against `key_check` → ready; (2) else if the peer's ephemeral public key
exists → derive, verify, persist → ready; (3) else publish/refresh our own
ephemeral public key → `awaiting-peer`.

## What the server stores (and what it never does)

| Table/column         | Contains                                     | Never contains                  |
| -------------------- | -------------------------------------------- | ------------------------------- |
| `user_public_keys`   | public identity keys                         | private identity keys           |
| `room_keys.wrapped_key` | DEK sealed under the owner's own identity key (`''` = placeholder) | plaintext DEK |
| `room_keys.ephemeral_public_key` | ephemeral public keys          | ephemeral private keys          |
| `room_keys.key_check` | HMAC of a constant under the DEK            | the DEK                         |
| `messages.ciphertext` | AES-GCM ciphertext (text or image pointer) | plaintext |
| `messages.iv`         | non-secret nonce                            | —         |
| `attachments`         | ids, path, MIME, ciphertext size, IV        | image bytes |
| `encrypted-attachments` bucket | AES-GCM ciphertext blobs (`application/octet-stream`) | image bytes, image content types, public URLs |

There is **no plaintext message column, no plaintext attachment column, and
no policy that could add one**. No message or image plaintext is ever written
to the database, the storage bucket, the realtime bus, a server action, a
route handler, or a log.

## Realtime layer (Part 5) — presence, typing, receipts

The realtime layer adds **no plaintext surface**. What crosses the realtime bus
(and what is persisted):

| Channel / RPC              | Content                                        | Plaintext? |
| -------------------------- | ---------------------------------------------- | ---------- |
| `room-presence:<roomId>`   | `{ user_id }` presence entries (auto-expire)   | no content |
| `touch_presence` RPC       | room id + user id (heartbeat)                  | no content |
| `room-typing:<roomId>`     | `{ user_id, typing, at }` transient presence   | no content |
| `messages` INSERT/UPDATE   | ciphertext envelopes + message **ids** only    | no         |
| `attachments` INSERT       | metadata row (path, MIME, size, IV) — **no image bytes** | no |
| Storage upload (XHR)       | opaque ciphertext blob (`application/octet-stream`) | no |
| `mark_messages_delivered` / `mark_messages_read` RPC | room id + message id array | no |

- **Receipts carry only message ids.** The server-authoritative RPCs
  (migration 007) are the only path that advances a message's
  `sent → delivered → read` status; the server enforces that only the
  *recipient* can mark (never the sender, never a non-participant, never past
  expiry). A recipient seeing "Read" implies the other party had the
  conversation visible and focused — the client deliberately never sends that
  status for messages it did not receive.
- **Typing is ephemeral** — never persisted, torn down on unmount, auto-cleared
  on disconnect.
- **Availability is derived client-side** from realtime presence + connection
  state (see `src/lib/realtime/presence.ts`); it is never stored. The server
  stores only `room_participants.last_seen_at` (heartbeat, informational) and
  the monotonic receipt timestamps.
- Disconnect detection relies on the realtime subscription state and the
  server-side auto-expiry of stale presence entries — never on
  `beforeunload`/`pagehide`, and never on any content payload.

## Key storage and key loss

- All private keys and the DEK live in **IndexedDB** (`whisper-keys`, three
  stores: `identity`, `ephemeral`, `rooms`).
- Identity keys are per-user-per-device and persist across rooms.
- Ephemeral keys and the room DEK are per-room and are wiped from the device
  when the room expires (24h).
- **Key loss = data loss (by design):** if IndexedDB is cleared, the identity
  key is gone. Previously derived room DEKs can no longer be recovered even
  from their `wrapped_key` (which is sealed under that lost identity key).
  Rooms will start a fresh handshake, and old history renders as
  undecryptable bubbles. There is deliberately no key escrow and no recovery —
  this is a no-recovery product.
- No key material is ever exported, synced, or sent to the server.

## Testing

`src/lib/crypto/*.test.ts` run via `npm test` verify:

- base64url round-trips, canonicality, invalid-input rejection;
- ECDH agreement and DEK derivation compatibility (both participants derive
  identical DEK + `key_check`);
- encrypt/decrypt round trips (including Unicode), wrong-key rejection,
  tampered ciphertext / IV / AAD rejection, nonce uniqueness under one key;
- the server, holding only public keys, cannot derive the DEK, and a
  "server-side observer" holding only stored rows cannot decrypt;
- `wrapped_key` round trips under the identity key and rejects a wrong
  identity or tampered blob;
- **Part 6 image crypto:** image payload + blob round trips, AAD binding to
  room/message/attachment, tamper rejection, binary in/out, per-image nonce
  uniqueness, and that the persisted surface (blob bytes + payload row) never
  contains plaintext image bytes.

`src/lib/image/*` and `src/lib/storage/*.test.ts` cover the non-crypto parts of
the image pipeline: magic-byte validation, EXIF/GPS stripping per format,
preview object-URL lifecycle, path building/parsing, upload endpoint building,
and the expiry purge selection.

## Intended migration of a breaking change

- Bump `ENCRYPTION_VERSION` and add a `version` check at decrypt time; old
  envelopes (v1) remain decryptable while new messages use the new format.
- Keep the 12-byte (16-char base64url) IV constraint for the message table or
  migrate the column + constraint together.
- Rotating the derivation `info` strings or salt scheme invalidates every
  existing room DEK; only do so with the room lifetime (24h) in mind.
