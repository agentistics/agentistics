/**
 * journal/string-cache.ts — a BOUNDED, bidirectional cache over the journal's interned-string
 * dictionary (`event_strings`), replacing the two Maps `journal.ts` used to hold for the life of
 * the process (A1.8, item from the leader 2026-09-27).
 *
 * ── The defect it replaces ───────────────────────────────────────────────────────────────────────
 * `remember` (after every committed insert batch) and `lookup` (on every read) added to `idOf` /
 * `stringOf` and NOTHING ever evicted. A full replay or a wide cursor catch-up walk therefore
 * pinned every distinct interned string the process had EVER met — every session/run/agent/task id,
 * every `mode`/`confidence`/`adapter_version`/`type` string, and one `source_ref` base per
 * transcript file it had ever read — in BOTH directions, for as long as the server ran. Reported by
 * A4 round 1 at 350 MB peak on a live machine, following the 7.4 GB OOM this item answers
 * (t-f48e6e9193 / t-e1dea7cd6f). This module bounds it.
 *
 * ── Correctness never depends on it ──────────────────────────────────────────────────────────────
 * `getId` / `getString` answer `undefined` on anything not (or no longer) held, and this module
 * NEVER touches SQLite — `journal.ts`'s `intern` / `lookup` fall through to the `event_strings`
 * table on a miss exactly as they did with the old unbounded maps. A budget of `0` disables the
 * cache outright (`put` is a no-op, so nothing is ever cached and every call misses): the journal
 * then behaves exactly as if it held no cache at all, which is what
 * `journal-string-cache.test.ts`'s differential proves against an unbounded one.
 *
 * ── Why bytes, not entries ────────────────────────────────────────────────────────────────────────
 * A session id here is ~30 bytes; a `source_ref` base (a transcript path) can run past 200. An
 * entry-COUNT cap either wastes most of its budget on short ids or starves out the long paths, so
 * the budget is a BYTE ceiling (`maxBytes`) and `entryCost` prices one cached pair by the string's
 * own UTF-8 length — held TWICE, once per direction — plus a fixed per-entry bookkeeping cost.
 *
 * ── One entry, two indexes, evicted together ─────────────────────────────────────────────────────
 * `idOf` (string -> id) and `stringOf` (id -> string) name the SAME pair from opposite directions.
 * `touch` moves BOTH to the most-recently-used position on every access — `Map` iteration order is
 * insertion order, so a `delete` immediately followed by `set` re-inserts the key at the end, and
 * the LEAST-recently-used entry is always the first one `stringOf.keys()` yields. `evict` always
 * removes BOTH sides of the entry it drops: dropping one direction only would let `lookup` decode an
 * id the write side no longer recognises as cached (or the reverse), which is exactly the kind of
 * disagreement the two directions must never be allowed to have. Neither direction is ever "more
 * current" than the other — a committed `(string, id)` pair never changes (`event_strings` is
 * append-only: an id is never reused and a string never rewritten), so `put` on an already-held
 * pair is just a touch.
 */

/** Fixed bookkeeping cost of one cached pair: two `Map` slots (`idOf` + `stringOf`) plus the two
 *  JS string/number object headers involved. Not a measurement of V8/JSC internals — a deliberately
 *  round number so the budget errs toward evicting SOONER rather than undercounting real residency. */
const ENTRY_OVERHEAD_BYTES = 96

function entryCost(s: string): number {
  return Buffer.byteLength(s, 'utf8') * 2 + ENTRY_OVERHEAD_BYTES
}

export interface StringCacheStats {
  entries: number
  bytes: number
  maxBytes: number
}

/**
 * A bounded, bidirectional LRU over one journal's interned-string dictionary. `maxBytes <= 0`
 * disables it: `put` becomes a no-op and every `get*` call misses, so the caller reads the string
 * table on every access — the same behaviour as if this cache did not exist.
 */
export class StringCache {
  private readonly idOf = new Map<string, number>()
  private readonly stringOf = new Map<number, string>()
  private bytesUsed = 0

  constructor(private readonly maxBytes: number) {}

  getId(s: string): number | undefined {
    const id = this.idOf.get(s)
    if (id === undefined) return undefined
    this.touch(s, id)
    return id
  }

  getString(id: number): string | undefined {
    const s = this.stringOf.get(id)
    if (s === undefined) return undefined
    this.touch(s, id)
    return s
  }

  /** Records a COMMITTED `(s, id)` pair, or just touches it when already held. */
  put(s: string, id: number): void {
    if (this.maxBytes <= 0) return
    if (this.idOf.has(s)) { this.touch(s, id); return }
    this.idOf.set(s, id)
    this.stringOf.set(id, s)
    this.bytesUsed += entryCost(s)
    this.evict()
  }

  private touch(s: string, id: number): void {
    this.idOf.delete(s); this.idOf.set(s, id)
    this.stringOf.delete(id); this.stringOf.set(id, s)
  }

  private evict(): void {
    while (this.bytesUsed > this.maxBytes && this.stringOf.size > 0) {
      const oldestId = this.stringOf.keys().next().value as number
      const s = this.stringOf.get(oldestId)!
      this.stringOf.delete(oldestId)
      this.idOf.delete(s)
      this.bytesUsed -= entryCost(s)
    }
  }

  stats(): StringCacheStats {
    return { entries: this.stringOf.size, bytes: this.bytesUsed, maxBytes: this.maxBytes }
  }
}

/**
 * The default budget. MEASURED (A1.8, `scripts/measure-journal-string-cache.ts`): a full cold
 * ingest of this machine's real store (501 Claude transcripts, ~445k events after replay) followed
 * by a full `readFrom` cursor walk over everything just written left an UNBOUNDED cache
 * (`StringCache(Infinity)` — the old, unbounded `Map`-based behaviour exactly) holding its whole
 * dictionary at only 3419 entries / 0.57 MiB — this machine's entire history of distinct interned
 * strings (session/run/agent/task ids, the handful of `mode`/`confidence`/`type`/`adapter_version`
 * values, and one `source_ref` base per transcript file) fits in half a megabyte. 8 MiB is
 * ~14x that measured ceiling — generous headroom for a build many times this size, or a
 * long-lived server accumulating history across weeks, while still being three orders of
 * magnitude under the 350 MB peak (A4 round 1, t-f48e6e9193) this item exists to bound. A separate
 * stress run at a 64 KiB budget on the SAME real store forced real eviction (the dictionary clamped
 * to 374 entries / 0.06 MiB instead of 3419) with `readFrom` still returning byte-identical events —
 * proof the mechanism actually triggers and stays correct under pressure, not just in the unit
 * tests' synthetic data. `0` disables the cache outright (see the class doc); there is no
 * environment override because a server that needs a different budget needs the number MEASURED
 * for it, not guessed.
 */
export const DEFAULT_STRING_CACHE_BYTES = 8 * 1024 * 1024
