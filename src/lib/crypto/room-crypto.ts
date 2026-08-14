/**
 * End-to-end encryption orchestration for a room.
 *
 * Runs entirely in the browser. The server only ever sees:
 * - ephemeral / identity PUBLIC keys,
 * - wrapped_key (the DEK sealed under the user's own identity key),
 * - key_check (an HMAC, not a key).
 *
 * Key agreement (no server participation):
 *   DEK = HKDF-SHA256(ECDH(own_ephemeral_priv, peer_ephemeral_pub),
 *                     salt = room_id, info = "whisper/room-dek/v1")
 * Both participants derive the same 32-byte DEK from the other's public key;
 * the server cannot because it holds neither ephemeral private key.
 *
 * State machine per participant:
 *   awaiting-peer  no peer ephemeral public key yet (guest not joined).
 *   ready          DEK derived and stored; messages can be encrypted/decrypted.
 *   error          permanent problem (tampered keys, mismatch). Never reveals
 *                  internals.
 *
 * Recovery: if the ephemeral private key is lost but the identity key
 * survives, the DEK is unwrapped from the participant's own wrapped_key and
 * verified against key_check. Only when both are gone is history unrecoverable
 * (documented in docs/ENCRYPTION.md).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { base64UrlToBytes, bytesToBase64Url, type Bytes } from "./encode";
import {
  ENCRYPTION_VERSION,
  KEY_EXCHANGE_ALGORITHM,
  computeKeyCheck,
  deriveRoomDek,
  generateEcdhKeyPair,
  unwrapRoomDek,
  wrapRoomDek,
} from "./primitives";
import {
  getEphemeralKey,
  getIdentityKey,
  putEphemeralKey,
  putIdentityKey,
  putRoomKey,
  type IdentityKeyRecord,
} from "./key-store";

export type RoomCryptoStatus = "awaiting-peer" | "ready" | "error";

export interface RoomCryptoState {
  status: RoomCryptoStatus;
  /** 32-byte room DEK. Non-null only when status === "ready". */
  dek: Bytes | null;
  /** User-facing message; never includes internals. Null when healthy. */
  error: string | null;
}

const USER_FACING_ERRORS = {
  cryptoUnavailable: "Your browser could not generate encryption keys.",
  load: "Could not load the room encryption keys.",
  derive: "Your device could not derive the room encryption key.",
  save: "Could not save your encryption key. Check your connection and try again.",
  invalid: "The room encryption key is invalid. The room cannot proceed.",
  mismatch:
    "Key mismatch: this room's encryption keys do not agree. The conversation cannot proceed safely.",
} as const;

async function ensureIdentityKey(userId: string): Promise<IdentityKeyRecord> {
  const existing = await getIdentityKey(userId);
  if (existing) {
    return existing;
  }
  const pair = await generateEcdhKeyPair();
  const record: IdentityKeyRecord = {
    userId,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
  await putIdentityKey(record);
  return record;
}

/**
 * Ensure the user's identity key exists and its public half is published to
 * `user_public_keys`. Idempotent; safe to call once per room session.
 */
export async function ensureIdentityKeyPublished(
  client: SupabaseClient<Database>,
  userId: string,
): Promise<IdentityKeyRecord> {
  const identity = await ensureIdentityKey(userId);
  const publicKeyB64 = bytesToBase64Url(identity.publicKey);
  const { data: existing } = await client
    .from("user_public_keys")
    .select("public_key, algorithm")
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing || existing.public_key !== publicKeyB64 || existing.algorithm !== KEY_EXCHANGE_ALGORITHM) {
    const { error } = await client.from("user_public_keys").upsert(
      { user_id: userId, public_key: publicKeyB64, algorithm: KEY_EXCHANGE_ALGORITHM },
      { onConflict: "user_id" },
    );
    if (error) {
      throw error;
    }
  }
  return identity;
}

/**
 * Advance the participant's room-key state as far as the current data allows.
 * Returns the state; the caller re-runs this on realtime changes and on a
 * slow poll until status is "ready".
 */
export async function synchronizeRoomKeys(
  client: SupabaseClient<Database>,
  params: { roomId: string; userId: string },
): Promise<RoomCryptoState> {
  const { roomId, userId } = params;

  let identity: IdentityKeyRecord;
  try {
    identity = await ensureIdentityKey(userId);
  } catch {
    return { status: "error", dek: null, error: USER_FACING_ERRORS.cryptoUnavailable };
  }

  const { data: rows, error: rowsError } = await client
    .from("room_keys")
    .select("user_id, ephemeral_public_key, wrapped_key, key_check")
    .eq("room_id", roomId);

  if (rowsError) {
    return { status: "error", dek: null, error: USER_FACING_ERRORS.load };
  }

  const ownRow = (rows ?? []).find((row) => row.user_id === userId) ?? null;
  const peerRow = (rows ?? []).find((row) => row.user_id !== userId) ?? null;

  // 1) Recovery: we already derived this DEK. Unwrap it from our own
  //    wrapped_key (sealed under the identity key) and verify agreement.
  if (ownRow && ownRow.wrapped_key !== "") {
    try {
      const dek = await unwrapRoomDek(ownRow.wrapped_key, identity.privateKey, identity.publicKey, roomId);
      const keyCheck = await computeKeyCheck(dek);
      if (ownRow.key_check !== "" && ownRow.key_check !== keyCheck) {
        return { status: "error", dek: null, error: USER_FACING_ERRORS.invalid };
      }
      if (peerRow && peerRow.key_check !== "" && peerRow.key_check !== keyCheck) {
        return { status: "error", dek: null, error: USER_FACING_ERRORS.mismatch };
      }
      await putRoomKey({ roomId, dek, keyCheck });
      return { status: "ready", dek, error: null };
    } catch {
      // Tampered/invalid wrapped key. Fall through to re-derive from the
      // peer's ephemeral public key (still possible while that exists).
    }
  }

  // 2) Ensure our per-room ephemeral keypair exists. Created once, reused for
  //    the room's whole lifetime; never rotated (rotation would fork the DEK).
  let ephemeral = await getEphemeralKey(roomId);
  if (!ephemeral) {
    const pair = await generateEcdhKeyPair();
    ephemeral = { roomId, publicKey: pair.publicKey, privateKey: pair.privateKey };
    await putEphemeralKey(ephemeral);
  }
  const ownPublicB64 = bytesToBase64Url(ephemeral.publicKey);

  // 3) Peer ephemeral public key available -> derive the room DEK.
  if (peerRow && peerRow.ephemeral_public_key !== "") {
    try {
      const { dek, keyCheck } = await deriveRoomDek({
        roomId,
        ownEphemeralPrivateKey: ephemeral.privateKey,
        peerEphemeralPublicKey: base64UrlToBytes(peerRow.ephemeral_public_key),
      });

      // Verify the peer derived the same DEK BEFORE persisting anything.
      if (peerRow.key_check !== "" && peerRow.key_check !== keyCheck) {
        return { status: "error", dek: null, error: USER_FACING_ERRORS.mismatch };
      }

      const wrapped = await wrapRoomDek(dek, identity.privateKey, identity.publicKey, roomId);
      if (ownRow) {
        const { error } = await client
          .from("room_keys")
          .update({ wrapped_key: wrapped, key_check: keyCheck, ephemeral_public_key: ownPublicB64 })
          .eq("room_id", roomId)
          .eq("user_id", userId);
        if (error) {
          return { status: "error", dek: null, error: USER_FACING_ERRORS.save };
        }
      } else {
        const { error } = await client.from("room_keys").insert({
          room_id: roomId,
          user_id: userId,
          wrapped_key: wrapped,
          ephemeral_public_key: ownPublicB64,
          key_exchange: KEY_EXCHANGE_ALGORITHM,
          version: ENCRYPTION_VERSION,
          key_check: keyCheck,
        });
        if (error) {
          return { status: "error", dek: null, error: USER_FACING_ERRORS.save };
        }
      }

      await putRoomKey({ roomId, dek, keyCheck });
      return { status: "ready", dek, error: null };
    } catch {
      return { status: "error", dek: null, error: USER_FACING_ERRORS.derive };
    }
  }

  // 4) No peer key yet. Publish our ephemeral public key (placeholder row for
  //    the owner, real row for a guest who joined an owner-less key set) and
  //    wait for the peer.
  if (ownRow) {
    if (ownRow.ephemeral_public_key !== ownPublicB64) {
      const { error } = await client
        .from("room_keys")
        .update({ ephemeral_public_key: ownPublicB64 })
        .eq("room_id", roomId)
        .eq("user_id", userId);
      if (error) {
        return { status: "error", dek: null, error: USER_FACING_ERRORS.save };
      }
    }
  } else {
    const { error } = await client.from("room_keys").insert({
      room_id: roomId,
      user_id: userId,
      wrapped_key: "",
      ephemeral_public_key: ownPublicB64,
      key_exchange: KEY_EXCHANGE_ALGORITHM,
      version: ENCRYPTION_VERSION,
      key_check: "",
    });
    if (error) {
      return { status: "error", dek: null, error: USER_FACING_ERRORS.save };
    }
  }

  return { status: "awaiting-peer", dek: null, error: null };
}
