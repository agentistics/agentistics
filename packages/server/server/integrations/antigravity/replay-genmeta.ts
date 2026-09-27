/**
 * integrations/antigravity/replay-genmeta.ts — PURE. agy's `gen_metadata` rows (one protobuf blob per
 * LLM CALL, `conversations/<conv>.db`) read as one `model.completed` per decoded row.
 *
 * ## The counters are `antigravity-protobuf.ts`'s, decoded by IT — never re-read here
 *
 * `parseGenMetadataBlob` is the legacy decoder and the only place the wire mapping lives, pinned by
 * its own tests and by the reconciliation against the provider's console recorded in its header:
 * - `usage.input` = `1.4.2`, `usage.cacheRead` = `1.4.5`, `usage.output` = `1.4.3` — and `1.4.3`
 *   ALREADY CONTAINS the thinking tokens `1.4.9`, so `reasoning.billing` is `included-in-output` and
 *   thinking is never added on top;
 * - `1.4.1` is a CONSTANT (the system-instruction size) and appears in no counter;
 * - `contextTokens` = `1.9.10.1`, a GAUGE (the context size at that call), never summed;
 * - `contextWindow` = `1.9.10.4`, the window agy itself DECLARES — a harness-stated window;
 * - `model` = `1.19`.
 * agy records NO cache-write counter, so `usage.cacheWrite` is ABSENT (D21) — never a 0.
 *
 * ## When — the one field this module decodes itself
 *
 * `occurredAt` is the call's own `google.protobuf.Timestamp` at `1.9.4` (`{1: seconds, 2: nanos}`),
 * which the legacy decoder never needed (it sums, it does not place). Measured on this machine:
 * present on 2.966 of 3.827 rows and monotonic by row `idx` on every one. A row without it (an older
 * agy wrote none) takes the previous timestamped row's instant — or, before any, the conversation's
 * first transcript step — and the event is then `estimated`: the counters are exact, the instant is
 * not, and an event is only as confident as its weakest input (D17). Chunk-independent by
 * construction: the carried instant only moves forward with `idx`.
 */
import { resolveProvider, type ProviderId } from '@agentistics/core'
import { parseGenMetadataBlob } from '../../adapters/antigravity-protobuf'
import { makeEvent, rowRef, type AntigravityReplayContext, type EmitEvent } from './replay-core'

export interface GenMetadataRow {
  /** `gen_metadata.idx` — the table's INTEGER PRIMARY KEY, i.e. the rowid legacy walks in. */
  idx: number
  data: Uint8Array | null
}

export interface GenMetaFoldState {
  ctx: AntigravityReplayContext
  /** The last row folded, to keep folding strictly forward. */
  lastIdx: number
  /** The instant of the last timestamped row — the fallback for a row that carries none. */
  lastAt: string | null
  /** The conversation's first transcript instant — the fallback before any timestamped row. */
  fallbackAt: string
  rows: number
  /** Rows the decoder refused (`parseGenMetadataBlob` → null). Legacy skips them too. */
  undecoded: number
  firstAt: string | null
  firstRef: string | null
  lastEventAt: string | null
  lastRef: string | null
}

export function emptyGenMetaFold(ctx: AntigravityReplayContext, fallbackAt: string): GenMetaFoldState {
  return { ctx, lastIdx: -1, lastAt: null, fallbackAt, rows: 0, undecoded: 0, firstAt: null, firstRef: null, lastEventAt: null, lastRef: null }
}

// ── The timestamp: a minimal, total protobuf walk to 1.9.4 ──────────────────────────────────────

interface Cur { b: Uint8Array; p: number; e: number }

function varint(c: Cur): number | null {
  let r = 0, shift = 1, n = 0
  while (c.p < c.e) {
    const x = c.b[c.p++]!
    r += (x & 0x7f) * shift
    if ((x & 0x80) === 0) return r
    shift *= 128
    if (++n >= 10) return null
  }
  return null
}

/** The byte range of field `field` (a LEN field) inside [start, end), or null. First match wins. */
function lenField(b: Uint8Array, start: number, end: number, field: number): [number, number] | null {
  const c: Cur = { b, p: start, e: end }
  while (c.p < c.e) {
    const key = varint(c)
    if (key === null) return null
    const f = Math.floor(key / 8), w = key % 8
    if (w === 0) { if (varint(c) === null) return null; continue }
    if (w === 1) { c.p += 8; continue }
    if (w === 5) { c.p += 4; continue }
    if (w !== 2) return null
    const len = varint(c)
    if (len === null || c.p + len > c.e) return null
    if (f === field) return [c.p, c.p + len]
    c.p += len
  }
  return null
}

function varintField(b: Uint8Array, start: number, end: number, field: number): number | null {
  const c: Cur = { b, p: start, e: end }
  while (c.p < c.e) {
    const key = varint(c)
    if (key === null) return null
    const f = Math.floor(key / 8), w = key % 8
    if (w === 0) { const v = varint(c); if (v === null) return null; if (f === field) return v; continue }
    if (w === 1) { c.p += 8; continue }
    if (w === 5) { c.p += 4; continue }
    if (w !== 2) return null
    const len = varint(c)
    if (len === null || c.p + len > c.e) return null
    c.p += len
  }
  return null
}

/** `1.9.4` as an ISO instant, or null. Never throws. */
export function genMetadataTimestamp(data: Uint8Array | null | undefined): string | null {
  try {
    if (!data || data.length === 0) return null
    const f1 = lenField(data, 0, data.length, 1)
    if (!f1) return null
    const f9 = lenField(data, f1[0], f1[1], 9)
    if (!f9) return null
    const f4 = lenField(data, f9[0], f9[1], 4)
    if (!f4) return null
    const seconds = varintField(data, f4[0], f4[1], 1)
    if (seconds === null || seconds <= 0) return null
    const nanos = varintField(data, f4[0], f4[1], 2) ?? 0
    const ms = seconds * 1000 + Math.floor(nanos / 1e6)
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  } catch {
    return null
  }
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────────

function providerOf(model: string): ProviderId {
  return model ? resolveProvider(model).id : 'other'
}

/** Rows in `idx` order. A row at or before the last folded `idx` is ignored (strictly forward). */
export function foldGenMetadataRows(s: GenMetaFoldState, rows: Iterable<GenMetadataRow>, emit: EmitEvent): void {
  for (const row of rows) {
    if (row.idx <= s.lastIdx) continue
    s.lastIdx = row.idx
    s.rows++
    const meta = parseGenMetadataBlob(row.data)
    if (!meta) { s.undecoded++; continue }
    const own = genMetadataTimestamp(row.data)
    if (own) s.lastAt = own
    const occurredAt = own ?? s.lastAt ?? s.fallbackAt
    const ref = rowRef(s.ctx, row.idx)
    emit(makeEvent(s.ctx, 'model.completed', {
      provider: providerOf(meta.modelId),
      model: meta.modelId,
      usage: { input: meta.inputTokens, output: meta.outputTokens, cacheRead: meta.cachedTokens },
      ...(meta.thinkingTokens > 0 ? { reasoning: { tokens: meta.thinkingTokens, billing: 'included-in-output' as const } } : {}),
      ...(meta.contextTokens > 0 ? { contextTokens: meta.contextTokens } : {}),
      ...(meta.contextWindow > 0 ? { contextWindow: meta.contextWindow } : {}),
      status: 'completed',
    }, { sourceRef: ref, occurredAt, confidence: own ? 'exact' : 'estimated' }))
    if (s.firstAt === null) { s.firstAt = occurredAt; s.firstRef = ref }
    s.lastEventAt = occurredAt
    s.lastRef = ref
  }
}

/** The dominant model of a set of rows — `readAntigravityTokens`'s rule (most rows; first on a tie). */
export function dominantModel(rows: Iterable<GenMetadataRow>): string {
  const counts = new Map<string, number>()
  for (const r of rows) {
    const m = parseGenMetadataBlob(r.data)
    if (m?.modelId) counts.set(m.modelId, (counts.get(m.modelId) ?? 0) + 1)
  }
  let best = '', n = 0
  for (const [id, c] of counts) if (c > n) { n = c; best = id }
  return best
}
