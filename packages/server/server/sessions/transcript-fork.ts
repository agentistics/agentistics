/**
 * transcript-fork.ts — a conversation that CONTINUES IN A NEW FILE is still the same conversation.
 *
 * A session's link to its transcript is exact (`--session-id <uuid>` at spawn), and exact is what
 * stopped it following. Measured 2026-10-05: an account hit its limit, the owner ran `/login`, and
 * Claude Code kept the very same pane and process but went on writing `e96caf0e….jsonl`, a NEW file
 * in the same project directory — one that REPLAYS the old conversation (683 of its 805 uuids are the
 * old file's, in the same order) and then continues it. The server stayed on the old file for good:
 * the owner's messages sat at "delivered — not read yet" and the answers never appeared, while the
 * terminal showed them.
 *
 * So after resolving a transcript, look for a SUCCESSOR in the same directory: a file written more
 * recently than the linked one that either
 *   (a) contains the linked file's last entries (their `uuid`s) — it replays the history, the shape
 *       `/login` and `/resume` produce — or
 *   (b) contains a prompt this session was sent and the linked file never received (the shape of a
 *       fork that does NOT replay: the pending message is the proof it is ours).
 * Anything that cannot be shown to continue the conversation is left alone: a sibling transcript in
 * the same directory is, far more often, ANOTHER session's.
 *
 * PURE decisions here (`continuesByUuids`, `containsPending`, `tailUuids`); the directory walk is the
 * only IO and takes its file system through `FsLike` so tests need no real project tree.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How many of the linked file's last uuids a successor must carry (or all of them, if fewer). */
export const FORK_MIN_SHARED = 3
const TAIL_UUIDS = 20
/** Only this many of the newest siblings are examined per resolve. */
const MAX_CANDIDATES = 8
/** A negative verdict for a candidate is remembered this long (the file may still grow into one). */
export const FORK_NEGATIVE_TTL_MS = 15_000

const UUID_FIELD = /"uuid"\s*:\s*"([0-9a-f-]{36})"/g

/** The last `n` entry uuids of a transcript's text, oldest first. */
export function tailUuids(text: string, n = TAIL_UUIDS): string[] {
  const all: string[] = []
  for (const m of text.matchAll(UUID_FIELD)) all.push(m[1]!)
  return all.slice(-n)
}

/** Does `candidateText` replay the history that ends with `tail`? */
export function continuesByUuids(tail: string[], candidateText: string): boolean {
  if (tail.length === 0) return false
  const need = Math.min(FORK_MIN_SHARED, tail.length)
  let shared = 0
  for (const u of tail) if (candidateText.includes(u) && ++shared >= need) return true
  return false
}

/** Is a prompt this session was sent (and the linked file lacks) written in the candidate? */
export function containsPending(pending: readonly string[], candidateText: string, linkedText: string): boolean {
  for (const raw of pending) {
    const t = raw.trim()
    if (t.length < 8) continue
    const needle = JSON.stringify(t).slice(1, -1)
    if (candidateText.includes(needle) && !linkedText.includes(needle)) return true
  }
  return false
}

export interface FsLike {
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>
  readFile(path: string): Promise<string>
}

export const realFs: FsLike = {
  readdir: d => readdir(d).catch(() => []),
  stat: p => stat(p).then(s => ({ mtimeMs: s.mtimeMs, size: s.size })).catch(() => null),
  readFile: p => readFile(p, 'utf-8'),
}

/** old path -> the successor found for it (verified to exist on every use). */
const successors = new Map<string, string>()
/** candidate path -> when a negative verdict expires. */
const negatives = new Map<string, number>()

/** Forget everything. Tests only. */
export function forgetForks(): void { successors.clear(); negatives.clear() }

/**
 * The newest transcript that continues the one at `path`, or `path` itself. Follows a chain
 * (a conversation can fork again), bounded.
 */
export async function followFork(
  path: string,
  opts: { pending?: readonly string[]; fs?: FsLike; now?: number } = {},
): Promise<string> {
  const fs = opts.fs ?? realFs
  const now = opts.now ?? Date.now()
  let current = path
  for (let hop = 0; hop < 5; hop++) {
    const remembered = successors.get(current)
    if (remembered && await fs.stat(remembered)) { current = remembered; continue }
    successors.delete(current)
    const next = await findSuccessor(current, opts.pending ?? [], fs, now)
    if (!next) break
    successors.set(current, next)
    current = next
  }
  return current
}

async function findSuccessor(path: string, pending: readonly string[], fs: FsLike, now: number): Promise<string | null> {
  const self = await fs.stat(path)
  if (!self) return null
  const dir = dirname(path)
  const names = (await fs.readdir(dir)).filter(n => n.endsWith('.jsonl') && join(dir, n) !== path)
  const found: { p: string; mtimeMs: number }[] = []
  for (const n of names) {
    const p = join(dir, n)
    const s = await fs.stat(p)
    if (s && s.size > 0 && s.mtimeMs > self.mtimeMs) found.push({ p, mtimeMs: s.mtimeMs })
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (found.length === 0) return null

  let linkedText: string
  try { linkedText = await fs.readFile(path) } catch { return null }
  const tail = tailUuids(linkedText)
  for (const c of found.slice(0, MAX_CANDIDATES)) {
    if ((negatives.get(c.p) ?? 0) > now) continue
    let text: string
    try { text = await fs.readFile(c.p) } catch { continue }
    if (continuesByUuids(tail, text) || containsPending(pending, text, linkedText)) return c.p
    negatives.set(c.p, now + FORK_NEGATIVE_TTL_MS)
  }
  return null
}
