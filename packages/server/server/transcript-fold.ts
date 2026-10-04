/**
 * transcript-fold.ts — a JSONL transcript read ONCE and then only as it grows (PERF.1 step 3).
 *
 * The historic chat and the session list re-read and re-parsed every transcript in full on every
 * request (a 70 MB file per open, every file of a project per list). A fold keeps, per file, the state
 * built from the lines read so far and the byte offset it reached:
 *
 * - same size and mtime: the state as it is, no read at all;
 * - grown: only the new bytes are read and folded (a transcript is append-only);
 * - shrunk or rewritten in place (same size, new mtime): read again from the start.
 *
 * Only COMPLETE lines are folded; a line still being written waits for its newline. Entries are kept
 * in an LRU bounded by count and by a size the caller estimates, so a machine with thousands of
 * transcripts holds what is in use, not everything ever opened.
 */
import { open, stat } from 'node:fs/promises'

export interface FoldSpec<S> {
  init(): S
  /** One complete line, already parsed. Lines that are not JSON objects are skipped before this. */
  fold(state: S, line: Record<string, unknown>): void
  /** A rough size of the state in bytes, for the LRU's budget. */
  weigh?(state: S): number
}

interface Entry<S> { size: number; mtimeMs: number; offset: number; state: S; weight: number }

const CHUNK = 1 << 20

export function createTranscriptFold<S>(spec: FoldSpec<S>, limits: { maxEntries: number; maxWeight?: number }) {
  const cache = new Map<string, Entry<S>>()
  let totalWeight = 0
  const inflight = new Map<string, Promise<S | null>>()

  function evict() {
    for (const [k, e] of cache) {
      if (cache.size <= limits.maxEntries && (limits.maxWeight === undefined || totalWeight <= limits.maxWeight)) break
      cache.delete(k)
      totalWeight -= e.weight
    }
  }

  async function readFrom(path: string, entry: Entry<S>, size: number): Promise<void> {
    const fh = await open(path, 'r')
    try {
      let pos = entry.offset
      let carry = ''
      const dec = new TextDecoder()
      const buf = Buffer.allocUnsafe(CHUNK)
      while (pos < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos)
        if (bytesRead === 0) break
        const text = carry + dec.decode(buf.subarray(0, bytesRead), { stream: true })
        pos += bytesRead
        const lastNl = text.lastIndexOf('\n')
        if (lastNl < 0) { carry = text; continue }
        for (const raw of text.slice(0, lastNl).split('\n')) {
          if (!raw) continue
          let v: unknown
          try { v = JSON.parse(raw) } catch { continue }
          if (v && typeof v === 'object' && !Array.isArray(v)) spec.fold(entry.state, v as Record<string, unknown>)
        }
        carry = text.slice(lastNl + 1)
      }
      // The offset is the end of the last COMPLETE line: a half-written one is read again next time.
      entry.offset = pos - Buffer.byteLength(carry, 'utf8')
    } finally {
      await fh.close()
    }
  }

  async function load(path: string): Promise<S | null> {
    let st
    try { st = await stat(path) } catch { const e = cache.get(path); if (e) { cache.delete(path); totalWeight -= e.weight } return null }
    const prev = cache.get(path)
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      cache.delete(path); cache.set(path, prev) // most recently used
      return prev.state
    }
    const grown = prev && st.size > prev.size
    const entry: Entry<S> = grown ? prev! : { size: 0, mtimeMs: 0, offset: 0, state: spec.init(), weight: 0 }
    try { await readFrom(path, entry, st.size) } catch { return prev?.state ?? null }
    entry.size = st.size
    entry.mtimeMs = st.mtimeMs
    if (prev) { cache.delete(path); totalWeight -= prev.weight }
    entry.weight = spec.weigh?.(entry.state) ?? 0
    cache.set(path, entry)
    totalWeight += entry.weight
    evict()
    return entry.state
  }

  return {
    /** The folded state of this file now, or null when it cannot be read. Concurrent calls share one read. */
    get(path: string): Promise<S | null> {
      const running = inflight.get(path)
      if (running) return running
      const p = load(path).finally(() => inflight.delete(path))
      inflight.set(path, p)
      return p
    },
    size: () => cache.size,
    weight: () => totalWeight,
    clear() { cache.clear(); totalWeight = 0 },
  }
}
