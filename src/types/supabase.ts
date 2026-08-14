/**
 * Typed Supabase database schema.
 *
 * This is the planned V1 schema, used to type the Supabase clients.
 * Tables/columns may be adjusted in Part 2 (migrations + RLS) but the
 * data model below is the source of truth for the client types.
 *
 * Security invariants:
 * - Only ciphertext and non-secret encryption metadata are stored.
 * - No plaintext message or image contents are ever persisted.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

/** Values of `rooms.status`. */
export type RoomStatusDb = "waiting" | "active" | "expired";
/** Values of `room_participants.role`. */
export type ParticipantRoleDb = "owner" | "guest";
/** Values of `messages.type`. */
export type MessageTypeDb = "text" | "image";
/** Values of `messages.status`. */
export type MessageStatusDb = "sent" | "delivered" | "read";

export interface Database {
  public: {
    Tables: {
      /**
       * One row per authenticated account.
       * `id` is a foreign key to `auth.users`.
       */
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string;
          created_at: string;
        };
        Insert: {
          id: string;
          username: string;
          display_name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          username?: string;
          display_name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      /** Temporary 1-to-1 rooms with a hard 24-hour lifetime. */
      rooms: {
        Row: {
          id: string;
          /** Human-readable join code, unique. */
          code: string;
          owner_id: string;
          created_at: string;
          /** Exactly `created_at` + 24 hours. */
          expires_at: string;
          status: RoomStatusDb;
        };
        Insert: {
          id?: string;
          code: string;
          owner_id: string;
          created_at?: string;
          expires_at: string;
          status?: RoomStatusDb;
        };
        Update: {
          id?: string;
          code?: string;
          owner_id?: string;
          created_at?: string;
          expires_at?: string;
          status?: RoomStatusDb;
        };
        Relationships: [];
      };
      /** Membership records; exactly two per room. */
      room_participants: {
        Row: {
          id: string;
          room_id: string;
          user_id: string;
          role: ParticipantRoleDb;
          /** Peer-visible name snapshot at join time. */
          display_name: string;
          joined_at: string;
          last_seen_at: string | null;
        };
        Insert: {
          id?: string;
          room_id: string;
          user_id: string;
          role: ParticipantRoleDb;
          display_name: string;
          joined_at?: string;
          last_seen_at?: string | null;
        };
        Update: {
          id?: string;
          room_id?: string;
          user_id?: string;
          role?: ParticipantRoleDb;
          display_name?: string;
          joined_at?: string;
          last_seen_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "room_participants_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      /** Per-user public identity keys (ECDH P-256). Private keys never reach the server. */
      user_public_keys: {
        Row: {
          user_id: string;
          /** base64url public identity key. */
          public_key: string;
          /** Key exchange algorithm identifier. */
          algorithm: KeyExchangeAlgorithmDb;
          created_at: string;
        };
        Insert: {
          user_id: string;
          public_key: string;
          algorithm?: KeyExchangeAlgorithmDb;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          public_key?: string;
          algorithm?: KeyExchangeAlgorithmDb;
          created_at?: string;
        };
        Relationships: [];
      };
      /**
       * Room data-encryption-key (DEK), wrapped for the participant's own
       * identity key. The DEK itself is derived client-side from ephemeral
       * ECDH and NEVER stored server-side.
       */
      room_keys: {
        Row: {
          id: string;
          room_id: string;
          /** Recipient account id. */
          user_id: string;
          /**
           * base64url wrapped DEK (self-wrap under the identity key).
           * `''` = placeholder published before the key could be derived.
           */
          wrapped_key: string;
          /** base64url ephemeral public key used for the exchange. */
          ephemeral_public_key: string;
          /** Key exchange algorithm identifier. */
          key_exchange: KeyExchangeAlgorithmDb;
          /**
           * base64url HMAC-SHA256(DEK, "whisper/key-check/v1"): lets both
           * participants verify they derived the same DEK.
           */
          key_check: string;
          /** Encryption metadata version. */
          version: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          room_id: string;
          user_id: string;
          wrapped_key: string;
          ephemeral_public_key: string;
          key_exchange: KeyExchangeAlgorithmDb;
          key_check?: string;
          version?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          room_id?: string;
          user_id?: string;
          wrapped_key?: string;
          ephemeral_public_key?: string;
          key_exchange?: KeyExchangeAlgorithmDb;
          key_check?: string;
          version?: number;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "room_keys_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      /** Encrypted message ciphertext + non-secret decryption metadata. */
      messages: {
        Row: {
          id: string;
          room_id: string;
          sender_id: string;
          type: MessageTypeDb;
          /** base64url AES-GCM ciphertext. NEVER plaintext. */
          ciphertext: string;
          /** base64url AES-GCM IV. */
          iv: string;
          /** Encryption metadata version. */
          version: number;
          status: MessageStatusDb;
          created_at: string;
          delivered_at: string | null;
          read_at: string | null;
        };
        Insert: {
          id?: string;
          room_id: string;
          sender_id: string;
          type: MessageTypeDb;
          ciphertext: string;
          iv: string;
          version?: number;
          status?: MessageStatusDb;
          created_at?: string;
          delivered_at?: string | null;
          read_at?: string | null;
        };
        Update: {
          id?: string;
          room_id?: string;
          sender_id?: string;
          type?: MessageTypeDb;
          ciphertext?: string;
          iv?: string;
          version?: number;
          status?: MessageStatusDb;
          created_at?: string;
          delivered_at?: string | null;
          read_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      /** Encrypted image blobs (referenced from Supabase Storage). */
      attachments: {
        Row: {
          id: string;
          room_id: string;
          message_id: string;
          sender_id: string;
          /** Path of the encrypted blob in the storage bucket. */
          storage_path: string;
          mime_type: string;
          /** Size of the stored ciphertext blob in bytes. */
          size_bytes: number;
          /** base64url AES-GCM IV. */
          iv: string;
          version: number;
          created_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          room_id: string;
          message_id: string;
          sender_id: string;
          storage_path: string;
          mime_type: string;
          size_bytes?: number;
          iv: string;
          version?: number;
          created_at?: string;
          expires_at: string;
        };
        Update: {
          id?: string;
          room_id?: string;
          message_id?: string;
          sender_id?: string;
          storage_path?: string;
          mime_type?: string;
          size_bytes?: number;
          iv?: string;
          version?: number;
          created_at?: string;
          expires_at: string;
        };
        Relationships: [
          {
            foreignKeyName: "attachments_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "rooms";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      /**
       * SECURITY DEFINER. Creates a room owned by the current user plus the
       * owner's membership row. Raises 'invalid_code' for malformed codes; a
       * unique violation on rooms.code propagates for caller-side retries.
       */
      create_room: {
        Args: { p_code: string };
        Returns: {
          id: string;
          code: string;
          owner_id: string;
          created_at: string;
          expires_at: string;
          status: RoomStatusDb;
        };
      };
      /**
       * SECURITY DEFINER. Joins the room with the given code, idempotently for
       * existing members. Raises 'invalid_code' / 'room_not_found' /
       * 'room_expired' / 'room_full' / 'not_authenticated'.
       */
      join_room: {
        Args: { p_code: string };
        Returns: {
          id: string;
          code: string;
          owner_id: string;
          created_at: string;
          expires_at: string;
          status: RoomStatusDb;
        };
      };
      /**
       * SECURITY DEFINER. Refreshes the current user's last_seen_at for a
       * room (presence heartbeat).
       */
      touch_presence: {
        Args: { p_room: string };
        Returns: undefined;
      };
      /**
       * SECURITY DEFINER. Hard-deletes all expired rooms and returns how many
       * were removed. Service-role only; callers must be the cron job.
       */
      purge_expired_rooms: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      /**
       * SECURITY DEFINER. Advances the recipient-side delivery receipt:
       * marks `sent` messages the CALLER received (sender_id <> auth.uid())
       * in a room as `delivered`, in one batched write. Never touches
       * ciphertext/IV/sender and never marks the caller's own messages.
       */
      mark_messages_delivered: {
        Args: { p_room: string; p_message_ids: string[] };
        Returns: number;
      };
      /**
       * SECURITY DEFINER. Advances the recipient-side read receipt: marks
       * `sent`/`delivered` messages the CALLER received (sender_id <>
       * auth.uid()) in a room as `read` (delivered_at implied), in one batched
       * write. Cannot forge another user's receipts and cannot touch message
       * contents.
       */
      mark_messages_read: {
        Args: { p_room: string; p_message_ids: string[] };
        Returns: number;
      };
    };
    Enums: {
      room_status: RoomStatusDb;
      participant_role: ParticipantRoleDb;
      message_type: MessageTypeDb;
      message_status: MessageStatusDb;
    };
    CompositeTypes: { [_ in never]: never };
  };
}

export type KeyExchangeAlgorithmDb = "ECDH-P256" | "X25519";

/** Row types, convenient for non-typed query helpers. */
export type Tables = Database["public"]["Tables"];
export type TableRow<T extends keyof Tables> = Tables[T]["Row"];
export type TableInsert<T extends keyof Tables> = Tables[T]["Insert"];
export type TableUpdate<T extends keyof Tables> = Tables[T]["Update"];
