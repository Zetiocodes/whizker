/**
 * Client-side key storage (IndexedDB).
 *
 * Private keys and the room DEK live ONLY here, in the browser's storage:
 * - `identity`: the user's long-lived ECDH P-256 identity keypair. The public
 *   half is published to `user_public_keys`; the private half never leaves
 *   this store.
 * - `ephemeral`: per-room ephemeral ECDH keypairs used for the room key
 *   agreement. Deleted when a room expires.
 * - `rooms`: the derived room DEK + key_check, keyed by room id. Deleted when
 *   a room expires.
 *
 * The store is deliberately small and flat: no wallet, no sync, no export.
 * Clearing site data wipes the identity key, which means previously derived
 * room DEKs can no longer be recovered (their wrapped form is unrecoverable)
 * — this is documented in docs/ENCRYPTION.md.
 *
 * All functions are browser-only; nothing here may be imported into a Server
 * Component or an action.
 */

import type { Bytes } from "./encode";

export interface IdentityKeyRecord {
  userId: string;
  publicKey: Bytes;
  privateKey: Bytes;
}

export interface EphemeralKeyRecord {
  roomId: string;
  publicKey: Bytes;
  privateKey: Bytes;
}

export interface RoomKeyRecord {
  roomId: string;
  dek: Bytes;
  keyCheck: string;
}

const DB_NAME = "whisper-keys";
const DB_VERSION = 1;
const STORE_IDENTITY = "identity";
const STORE_EPHEMERAL = "ephemeral";
const STORE_ROOMS = "rooms";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available in this context"));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_IDENTITY)) {
          db.createObjectStore(STORE_IDENTITY, { keyPath: "userId" });
        }
        if (!db.objectStoreNames.contains(STORE_EPHEMERAL)) {
          db.createObjectStore(STORE_EPHEMERAL, { keyPath: "roomId" });
        }
        if (!db.objectStoreNames.contains(STORE_ROOMS)) {
          db.createObjectStore(STORE_ROOMS, { keyPath: "roomId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("could not open IndexedDB"));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transaction(storeName: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

export async function getIdentityKey(userId: string): Promise<IdentityKeyRecord | undefined> {
  const store = await transaction(STORE_IDENTITY, "readonly");
  return requestAsPromise(store.get(userId)) as Promise<IdentityKeyRecord | undefined>;
}

export async function putIdentityKey(record: IdentityKeyRecord): Promise<void> {
  const store = await transaction(STORE_IDENTITY, "readwrite");
  await requestAsPromise(store.put(record));
}

export async function getEphemeralKey(roomId: string): Promise<EphemeralKeyRecord | undefined> {
  const store = await transaction(STORE_EPHEMERAL, "readonly");
  return requestAsPromise(store.get(roomId)) as Promise<EphemeralKeyRecord | undefined>;
}

export async function putEphemeralKey(record: EphemeralKeyRecord): Promise<void> {
  const store = await transaction(STORE_EPHEMERAL, "readwrite");
  await requestAsPromise(store.put(record));
}

export async function getRoomKey(roomId: string): Promise<RoomKeyRecord | undefined> {
  const store = await transaction(STORE_ROOMS, "readonly");
  return requestAsPromise(store.get(roomId)) as Promise<RoomKeyRecord | undefined>;
}

export async function putRoomKey(record: RoomKeyRecord): Promise<void> {
  const store = await transaction(STORE_ROOMS, "readwrite");
  await requestAsPromise(store.put(record));
}

/** Forget all keys bound to a room (called when the room expires). */
export async function deleteRoomKeys(roomId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_EPHEMERAL, STORE_ROOMS], "readwrite");
  await Promise.all([
    requestAsPromise(tx.objectStore(STORE_EPHEMERAL).delete(roomId)),
    requestAsPromise(tx.objectStore(STORE_ROOMS).delete(roomId)),
  ]);
}
