/**
 * chunk.ts — chunked AES-256-GCM for one backup object, over the seal.ts core. PURE apart from the
 * randomness of `newObjectKey`.
 *
 * One object (a backup archive, a manifest) has its own random 256-bit data key (DEK). It is cut into
 * 4 MiB chunks, each sealed on its own so a large file never has to be held in memory:
 *
 *  - key   = HKDF-SHA256(ikm = DEK, no salt, info = "agentistics/backup/chunk/v1")
 *  - nonce = 4 zero bytes ‖ uint64-BE(index). A counter nonce is safe ONLY because the DEK is unique
 *    per object: **mint a new DEK for every object, and again for every re-seal of a changed one**
 *    (a retry included). Two different plaintexts under one DEK and index would break GCM.
 *  - AAD   = uint32-BE(len(objectId)) ‖ objectId (UTF-8) ‖ uint64-BE(index) ‖ uint64-BE(total)
 *  - output = ciphertext ‖ 16-byte tag
 *
 * Because every chunk is bound to its object, its place and the total count, reordering, duplicating,
 * truncating (including rewriting the total to match) and splicing chunks of another object all fail.
 * `objectId` and `total` come from the reader's own record of the object (for example a sealed
 * manifest or an index entry), never from the chunk.
 *
 * Nothing here logs, and no failure carries input: opening fails with a CODE.
 */
import { hkdfSync, randomBytes } from 'node:crypto'
import { KEY_BYTES, NONCE_BYTES, TAG_BYTES } from '../format'
import { aeadOpen, aeadSeal } from '../seal'

export const CHUNK_BYTES = 4 * 1024 * 1024
export const SEALED_CHUNK_MAX_BYTES = CHUNK_BYTES + TAG_BYTES
export const CHUNK_KEY_INFO = 'agentistics/backup/chunk/v1'

export type BackupStreamFailure = 'tampered' | 'truncated' | 'extra-chunk' | 'size-mismatch'

/** A streaming seal or open that cannot go on. The message holds the code and nothing else. */
export class BackupStreamError extends Error {
  constructor(readonly code: BackupStreamFailure) {
    super(`vault: backup stream ${code}`)
    this.name = 'BackupStreamError'
  }
}

/** A fresh per-object data key. The caller zeroes it. */
export function newObjectKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES))
}

/** PURE. How many chunks `size` bytes make. An empty object is ONE empty chunk, so it is still sealed. */
export function chunkCount(size: number, chunkSize: number = CHUNK_BYTES): number {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('vault: object size must be a non-negative integer')
  assertChunkSize(chunkSize)
  return Math.max(1, Math.ceil(size / chunkSize))
}

function assertChunkSize(n: number): void {
  if (!Number.isSafeInteger(n) || n < 1 || n > CHUNK_BYTES) throw new Error('vault: chunk size is out of range')
}

export interface ChunkRef {
  dek: Uint8Array
  objectId: string
  /** 0-based. */
  index: number
  total: number
}

function validRef(r: ChunkRef): boolean {
  return r.dek.length === KEY_BYTES && typeof r.objectId === 'string' && r.objectId.length > 0
    && Number.isSafeInteger(r.total) && r.total >= 1
    && Number.isSafeInteger(r.index) && r.index >= 0 && r.index < r.total
}

function chunkKey(dek: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', dek, new Uint8Array(0), CHUNK_KEY_INFO, KEY_BYTES))
}

function chunkNonce(index: number): Uint8Array {
  const n = Buffer.alloc(NONCE_BYTES)
  n.writeBigUInt64BE(BigInt(index), NONCE_BYTES - 8)
  return new Uint8Array(n)
}

function chunkAad(r: ChunkRef): Uint8Array {
  const id = Buffer.from(r.objectId, 'utf8')
  const out = Buffer.alloc(4 + id.length + 16)
  out.writeUInt32BE(id.length, 0)
  id.copy(out, 4)
  out.writeBigUInt64BE(BigInt(r.index), 4 + id.length)
  out.writeBigUInt64BE(BigInt(r.total), 12 + id.length)
  return new Uint8Array(out)
}

/** Seal one chunk → `ciphertext ‖ tag`. Throws on arguments that are a programming error. */
export function sealChunk(i: ChunkRef & { plaintext: Uint8Array }): Uint8Array {
  if (!validRef(i)) throw new Error('vault: invalid chunk reference')
  if (i.plaintext.length > CHUNK_BYTES) throw new Error('vault: chunk is too large')
  const key = chunkKey(i.dek)
  try { return aeadSeal(key, chunkNonce(i.index), chunkAad(i), i.plaintext) } finally { key.fill(0) }
}

export type ChunkOpenOutcome = { ok: true; plaintext: Uint8Array } | { ok: false; code: 'tampered' }

/** Open one chunk. Every failure, whatever its cause, is `tampered`. */
export function openChunk(i: ChunkRef & { sealed: Uint8Array }): ChunkOpenOutcome {
  if (!validRef(i) || i.sealed.length > SEALED_CHUNK_MAX_BYTES) return { ok: false, code: 'tampered' }
  const key = chunkKey(i.dek)
  try {
    const plaintext = aeadOpen(key, chunkNonce(i.index), chunkAad(i), i.sealed)
    return plaintext ? { ok: true, plaintext } : { ok: false, code: 'tampered' }
  } finally { key.fill(0) }
}

type ByteSource = Iterable<Uint8Array> | AsyncIterable<Uint8Array>

export interface SealedChunk { index: number; total: number; data: Uint8Array }

/**
 * Seal a stream. `source` may yield pieces of any length; they are re-cut into `chunkSize` chunks.
 * `size` must be declared up front (it fixes `total`, which every chunk is bound to); a source that
 * turns out shorter or longer throws `size-mismatch`, and the LAST chunk is only yielded once the
 * source has ended at exactly that size. After any throw, discard what was yielded AND the DEK.
 */
export async function* sealChunks(
  source: ByteSource, o: { dek: Uint8Array; objectId: string; size: number; chunkSize?: number },
): AsyncGenerator<SealedChunk> {
  const chunkSize = o.chunkSize ?? CHUNK_BYTES
  const total = chunkCount(o.size, chunkSize)
  const buf = new Uint8Array(Math.min(chunkSize, o.size))
  let index = 0
  let filled = 0
  let received = 0
  const sealBuffered = (): SealedChunk =>
    ({ index, total, data: sealChunk({ dek: o.dek, objectId: o.objectId, index, total, plaintext: buf.subarray(0, filled) }) })
  try {
    for await (const piece of source) {
      received += piece.length
      if (received > o.size) throw new BackupStreamError('size-mismatch')
      let at = 0
      while (at < piece.length) {
        const n = Math.min(piece.length - at, chunkSize - filled)
        buf.set(piece.subarray(at, at + n), filled)
        filled += n
        at += n
        if (filled === chunkSize && index < total - 1) {
          yield sealBuffered()
          index++
          filled = 0
        }
      }
    }
    if (received !== o.size) throw new BackupStreamError('size-mismatch')
    yield sealBuffered()
  } finally { buf.fill(0) }
}

/**
 * Open a stream of sealed chunks, in order. `objectId` and `total` are what the READER expects.
 * Throws `tampered`, `truncated` or `extra-chunk`. Plaintext is yielded chunk by chunk, so the output
 * is not complete — and must not be used as the object — until the generator finishes without
 * throwing (write to a temporary file, then rename).
 */
export async function* openChunks(
  chunks: ByteSource, o: { dek: Uint8Array; objectId: string; total: number },
): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(o.total) || o.total < 1) throw new BackupStreamError('tampered')
  let index = 0
  for await (const sealed of chunks) {
    if (index >= o.total) throw new BackupStreamError('extra-chunk')
    const r = openChunk({ dek: o.dek, objectId: o.objectId, index, total: o.total, sealed })
    if (!r.ok) throw new BackupStreamError(r.code)
    index++
    yield r.plaintext
  }
  if (index !== o.total) throw new BackupStreamError('truncated')
}
