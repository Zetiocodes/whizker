-- 003_messages_attachments.sql
-- Encrypted message and attachment metadata.
--
-- Security invariants:
-- - Only ciphertext and non-secret decryption metadata (IV, version) are
--   stored. There is NO plaintext message column and NO plaintext image
--   column.
-- - Image bytes are encrypted client-side and live in Supabase Storage;
--   attachments rows only hold the storage reference + metadata.

create type public.message_type as enum ('text', 'image');
create type public.message_status as enum ('sent', 'delivered', 'read');

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id           uuid                     primary key default gen_random_uuid(),
  room_id      uuid                     not null references public.rooms (id) on delete cascade,
  sender_id    uuid                     not null references auth.users (id) on delete cascade,
  type         public.message_type      not null default 'text',
  -- base64url AES-GCM ciphertext. NEVER plaintext.
  ciphertext   text                     not null check (length(ciphertext) > 0),
  -- base64url AES-GCM 96-bit nonce.
  iv           text                     not null check (length(iv) > 0),
  -- Encryption metadata format version (see src/types/encryption.ts).
  version      int                      not null default 1,
  status       public.message_status    not null default 'sent',
  created_at   timestamptz              not null default now(),
  delivered_at timestamptz,
  read_at      timestamptz
);

create index messages_room_created_idx on public.messages (room_id, created_at);

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------
create table public.attachments (
  id           uuid         primary key default gen_random_uuid(),
  room_id      uuid         not null references public.rooms (id) on delete cascade,
  message_id   uuid         not null references public.messages (id) on delete cascade,
  sender_id    uuid         not null references auth.users (id) on delete cascade,
  -- Reference to the ENCRYPTED blob in the Supabase Storage bucket. The blob
  -- itself is ciphertext; the bucket is private.
  storage_path text         not null,
  -- MIME type of the original image (safe, non-sensitive metadata).
  mime_type    text         not null,
  -- Size of the stored ciphertext blob.
  size_bytes   bigint       not null default 0 check (size_bytes >= 0),
  iv           text         not null check (length(iv) > 0),
  version      int          not null default 1,
  created_at   timestamptz  not null default now(),
  expires_at   timestamptz  not null
);

create index attachments_room_idx on public.attachments (room_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: deny everything until Part 3 adds participant policies.
-- ---------------------------------------------------------------------------
alter table public.messages enable row level security;
alter table public.messages force row level security;

alter table public.attachments enable row level security;
alter table public.attachments force row level security;

grant select on public.messages, public.attachments to authenticated;
