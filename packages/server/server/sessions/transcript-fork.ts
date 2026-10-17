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
 * **A file ANOTHER ROW IS LINKED TO is never a successor** (`foreign`), whatever its content says.
 * Measured 2026-10-17 (QA chat-activity-live-1): two sessions started in one folder — one queued by
 * the memory guard, the same one started with `force` — each born linked to its own `--session-id`,
 * and each chat showed the OTHER's conversation. The registry was right; this follow was not. Two
 * sessions that replayed the same history carry the same uuids, and two sessions sent the same prompt
 * both "contain the pending prompt", so the newer sibling passed both tests above while being a live
 * conversation of its own — and the memo then held the wrong file for the life of the process. The
 * file name IS the conversation id for Claude, so the caller names the ids other rows own and they
 * are skipped at every hop, remembered successors included. A refusal is logged once per pair.
 *
 * PURE decisions here (`continuesByUuids`, `containsPending`, `tailUuids`); the directory walk is the
 * only IO and takes its file system through `FsLike` so tests need no real project tree.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

/** `from -> to` pairs already logged as refused, so a refusal is said once, not once per poll. */
const refusedLogged = new Set<string>()

/** Forget everything. Tests only. */
export function forgetForks(): void { successors.clear(); negatives.clear(); refusedLogged.clear() }

/** The conversation id a Claude transcript path names: its file name without `.jsonl`. */
export function conversationOfPath(path: string): string {
  return basename(path, '.jsonl')
}

/** PURE: may `candidate` be followed from `from`? Never when another row owns its conversation. */
export function followAllowed(candidate: string, foreign: ReadonlySet<string> | undefined): boolean {
  return !foreign || !foreign.has(conversationOfPath(candidate))
}

function logRefused(from: string, to: string): void {
  const key = `${from}\0${to}`
  if (refusedLogged.has(key)) return
  refusedLogged.add(key)
  console.warn(`[sessions] refused to follow ${conversationOfPath(from)} into ${conversationOfPath(to)}: another session is linked to that conversation`)
}

/**
 * The newest transcript that continues the one at `path`, or `path` itself. Follows a chain
 * (a conversation can fork again), bounded.
 */
export async function followFork(
  path: string,
  opts: {
    pending?: readonly string[]
    /**
     * Conversation ids OTHER rows are linked to — never a successor. See the header. A function is
     * asked once, and only when a newer sibling exists to be judged (it may read the registry).
     */
    foreign?: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>)
    fs?: FsLike
    now?: number
  } = {},
): Promise<string> {
  const fs = opts.fs ?? realFs
  const now = opts.now ?? Date.now()
  let foreign: ReadonlySet<string> | undefined = typeof opts.foreign === 'function' ? undefined : opts.foreign
  const lazy = typeof opts.foreign === 'function' ? opts.foreign : null
  const owners = async (): Promise<ReadonlySet<string> | undefined> => {
    if (lazy && !foreign) foreign = await lazy().catch(() => new Set<string>())
    return foreign
  }
  let current = path
  for (let hop = 0; hop < 5; hop++) {
    const remembered = successors.get(current)
    if (remembered) {
      const allowed = followAllowed(remembered, await owners())
      if (allowed && await fs.stat(remembered)) { current = remembered; continue }
      if (!allowed) logRefused(current, remembered)
    }
    successors.delete(current)
    const next = await findSuccessor(current, opts.pending ?? [], owners, fs, now)
    if (!next) break
    successors.set(current, next)
    current = next
  }
  return current
}

async function findSuccessor(
  path: string,
  pending: readonly string[],
  owners: () => Promise<ReadonlySet<string> | undefined>,
  fs: FsLike,
  now: number,
): Promise<string | null> {
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
  const foreign = await owners()
  for (const c of found.slice(0, MAX_CANDIDATES)) {
    if ((negatives.get(c.p) ?? 0) > now) continue
    // Not remembered as a negative: who owns a conversation can change, what a file holds cannot.
    if (!followAllowed(c.p, foreign)) { logRefused(path, c.p); continue }
    let text: string
    try { text = await fs.readFile(c.p) } catch { continue }
    if (continuesByUuids(tail, text) || containsPending(pending, text, linkedText)) return c.p
    negatives.set(c.p, now + FORK_NEGATIVE_TTL_MS)
  }
  return null
}
