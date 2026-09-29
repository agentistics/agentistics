/**
 * canonical/event-id.ts — an event's id is DERIVED from what the event is, never minted.
 *
 * ## Why an id is derived
 *
 * The journal's idempotency is `UNIQUE(event_id)` plus `INSERT OR IGNORE`. That pair is the whole
 * reason a REPLAY (re-reading a transcript after a parser fix, a backfill, a restarted watcher)
 * converges with LIVE ingestion instead of doubling it: the same fact, reached twice, hashes to the
 * same id and the second insert is a no-op. A random id (a UUID, a counter, a timestamp) would make
 * every re-read a new row, and the journal would grow by one full copy of history per replay with
 * no error anywhere. The flip side is just as load-bearing: two DIFFERENT facts must never share an
 * id, or the second one is silently dropped as a "duplicate". Every field in the key below is there
 * to hold one of those two directions.
 *
 * ## Why each field is in the key (the SOURCE path)
 *
 * - **`sourceKind` + `sourceId`** — two producers keep unrelated ref spaces. A hook's `0007` and a
 *   transcript's line `7` are different facts; without the producer in the key they could collide.
 * - **`sourceRef`** — identifies the RECORD, not the file: `claude:<conversationId>:<lineNo>` for a
 *   transcript line. Keying on the file would collapse every line of a conversation into one event.
 * - **`type`** — one record legitimately yields several event types (an assistant line is a model
 *   completion AND the request of each tool it names), and each must survive as its own row.
 * - **`ordinal`** — two events of the SAME type from ONE record: a line carrying parallel `tool_use`
 *   blocks produces n `tool.requested` events, told apart only by their position.
 *
 * ## THE SPLIT — contradiction O-8 (found by B1.0, recorded by the coordinator 2026-09-25)
 *
 * Spec §4.1 as written puts `sourceKind`/`sourceId` in the key AND promises that "the same billed
 * response read from a transcript, a hook and a gateway is one event with one id". Both cannot
 * hold: with the source in the key, three producers can NEVER yield the same id, and the journal
 * would store one billed response three times — `usage-dedupe.ts`'s 60-90 % over-count rebuilt one
 * layer down. The resolution: **for a `model.*` event carrying the provider's own response id, the
 * key is `(type, providerRequestId, ordinal)` and EXCLUDES the source**; every other event keeps the
 * source path above. That is `usage-dedupe.ts`'s measured rule — one `message.id` is one billing
 * event (session 4c3a96ac: 148 usage lines over 79 distinct ids, the stored figure equal to the
 * per-line sum) — generalised from lines of one transcript to every producer that can see the
 * response.
 *
 * ## Why the provider (`ProviderId`) is NOT in the key
 *
 * Two sources can LABEL the same response differently — a gateway that routed it through a cloud
 * vendor and the harness that asked for it by the model vendor's name — and a label in the key
 * would split the one response again. Provider response ids already carry the provider's own
 * namespace (`msg_…`, `chatcmpl-…`), so the id alone identifies it. STATED RISK: two providers
 * minting the identical id string would be merged into one event. That is accepted as far less
 * likely than the mislabel it prevents.
 *
 * ## A model event with NO provider id falls back to the source path
 *
 * What cannot be shown to be the same response is not merged by a guess — `usage-dedupe.ts`'s rule
 * that a record with no id is always counted. An EMPTY `providerRequestId` is treated as absent: an
 * empty string shared by every id-less producer would otherwise become the one key they all
 * collapse into.
 *
 * ## Domain separation
 *
 * The preimage is a JSON array opening with a VERSION tag (`agentistics.event-id/v1`) and a PATH tag
 * (`'source'` | `'provider'`). JSON encoding quotes and escapes every string, so no quote, comma,
 * bracket, backslash or NUL inside a field can shift a field boundary (`a:b|c` never equals `a|b:c`),
 * and the path tag means a source-path input cannot be crafted to spell a provider-path preimage.
 * **Bumping the version tag re-keys every event in existence**, so it is never changed without a
 * journal migration — a journal written before the change would split in two on the next replay.
 * The ordinal enters as a STRING (`String(n)`), because `JSON.stringify` turns both `NaN` and
 * `Infinity` into `null` and they would collide; `-0` reads as `0`. An ABSENT ordinal is `'0'`, so a
 * producer that omits it on the first event converges with one that writes `0`.
 *
 * ## The hash is dependency-free TypeScript, on purpose
 *
 * `@agentistics/core` is bundled into the web app by Vite through its barrel, so `node:crypto` and
 * Bun APIs are unavailable here. `sha256Hex` is FIPS 180-4 SHA-256 over the UTF-8 bytes that
 * `TextEncoder` produces. STATED LIMIT: `TextEncoder` maps a lone surrogate to U+FFFD, so two strings
 * differing only in lone surrogates hash alike. No real source id contains one.
 *
 * ## Stated knock-on for §4.2 (not this module's to fix)
 *
 * `INSERT OR IGNORE` keeps the FIRST row for an id, while `usage-dedupe.ts` keeps the LAST record.
 * They agree in every measured sample, because the repeats are byte-identical; but a producer that
 * ever wrote a partial usage first would be kept partial by the journal. The journal, not this
 * function, decides which copy survives.
 */

import type { EventType, SourceKind } from './event'

/** Hex characters kept from the SHA-256 digest (128 bits). */
export const EVENT_ID_LENGTH = 32

/** The event types keyed on the provider's own response id when one is present (O-8). */
export const PROVIDER_KEYED_TYPES = [
  'model.invoked',
  'model.started',
  'model.delta',
  'model.completed',
  'model.failed',
] as const satisfies readonly EventType[]

export interface EventIdInput {
  sourceKind: SourceKind
  sourceId: string
  /** Identifies the RECORD, not the file — e.g. `claude:<conversationId>:<lineNo>`. */
  sourceRef: string
  type: EventType
  /** Disambiguates events of one type from one record. Absent ≡ 0. */
  ordinal?: number
  /** The provider's own response id (`message.id` for Claude). Only read for `PROVIDER_KEYED_TYPES`. */
  providerRequestId?: string
}

const VERSION_TAG = 'agentistics.event-id/v1'

const PROVIDER_KEYED: ReadonlySet<string> = new Set(PROVIDER_KEYED_TYPES)

function ordinalKey(ordinal: number | undefined): string {
  return ordinal === undefined ? '0' : String(ordinal)
}

/** The exact string that is hashed. Exported so the encoding itself can be tested. */
export function eventIdPreimage(input: EventIdInput): string {
  const ord = ordinalKey(input.ordinal)
  const pid = input.providerRequestId
  if (PROVIDER_KEYED.has(input.type) && typeof pid === 'string' && pid.length > 0) {
    return JSON.stringify([VERSION_TAG, 'provider', input.type, pid, ord])
  }
  return JSON.stringify([
    VERSION_TAG, 'source', input.sourceKind, input.sourceId, input.sourceRef, input.type, ord,
  ])
}

/** The event's identity: 32 lowercase hex chars. Pure, total, never throws. */
export function deriveEventId(input: EventIdInput): string {
  return sha256Hex(eventIdPreimage(input)).slice(0, EVENT_ID_LENGTH)
}

// ── SHA-256 (FIPS 180-4) ────────────────────────────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const HEX = '0123456789abcdef'

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex chars. Pure and total. */
export function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text)
  const bitLen = msg.length * 8
  // message + 0x80 + zero pad + 8-byte length, rounded up to a 64-byte multiple
  const total = Math.ceil((msg.length + 9) / 64) * 64
  const buf = new Uint8Array(total)
  buf.set(msg)
  buf[msg.length] = 0x80
  const view = new DataView(buf.buffer)
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)
  view.setUint32(total - 4, bitLen >>> 0, false)

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  const w = new Uint32Array(64)

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
  }

  let out = ''
  for (const word of [h0, h1, h2, h3, h4, h5, h6, h7]) {
    for (let s = 28; s >= 0; s -= 4) out += HEX[(word >>> s) & 0xf]
  }
  return out
}
