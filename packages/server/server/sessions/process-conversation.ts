/**
 * process-conversation.ts — the IO half of the process-transcript link: which conversation the
 * process behind one of our panes is writing, read from a file that process holds OPEN.
 *
 * The pure modules hold every RULE (which file, which line or name, and every refusal —
 * `agy-conversation.ts` for agy, `process-transcript.ts` for codex and kimi); this one only walks
 * `/proc` and reads, and never decides anything. Same split as `harness-session-file.ts` /
 * `harness-sessions.ts`, and for the same reason: the rules are what needs pinning against real
 * bytes, and the filesystem is what must never throw into the poll.
 *
 * ## Cost, and why it is asked so narrowly
 *
 * The poll runs every five seconds over the whole fleet. A `/proc/<pid>/fd` sweep is a `readdir`
 * plus a `readlink` per descriptor, and the log read is the whole file — so the CALLER asks only
 * for a row whose harness has an entry in `HARNESS_PROCESS_TRANSCRIPTS` (plus the live processes of
 * those harnesses, for the collision guard). On a fleet with no agy, codex or kimi in it this module
 * is never called at all. A codex holder's walk is three `readlink`s of `exe` and one fd sweep.
 *
 * Failure is ABSENCE, always. No `/proc` (not Linux), a pid that has exited between the pane listing
 * and this read, a descriptor whose target cannot be resolved, an unreadable log: the answer is
 * `null`, the row keeps behaving exactly as it does today, and `conversationBlind`'s degradation
 * sentence in `chat-web.ts` is what the user sees. Nothing here may throw into the poll.
 */

import { readFile, readdir, readlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { ANTIGRAVITY_DIR } from '../config'
import { HARNESS_PROCESS_TRANSCRIPTS } from './harness-session-file'

/** Every path this process currently holds open. `[]` for anything that cannot be read. */
async function openFiles(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // not Linux, the process has exited, or the descriptors are not ours to read
  }
  const out: string[] = []
  for (const name of names) {
    try {
      out.push(await readlink(join(dir, name)))
    } catch {
    }
  }
  return out
}

/** The direct children of a pid, from every one of its threads. `[]` when unreadable. */
async function childrenOf(pid: number): Promise<number[]> {
  let tasks: string[]
  try {
    tasks = await readdir(`/proc/${pid}/task`)
  } catch {
    return []
  }
  const out = new Set<number>()
  for (const t of tasks) {
    try {
      for (const c of (await readFile(`/proc/${pid}/task/${t}/children`, 'utf-8')).split(/\s+/)) {
        const n = Number(c)
        if (Number.isInteger(n) && n > 0) out.add(n)
      }
    } catch {
    }
  }
  return [...out]
}

/** How deep under the pane a holder may sit: codex is pane -> shim -> node -> codex (3). */
const HOLDER_MAX_DEPTH = 5

/**
 * The processes under (and including) `pid` whose executable is named one of `holders`.
 *
 * Descends through anything else — a node shim, a login shell — and STOPS at a holder: what runs
 * below a holder is the commands it executes, and their descriptors must never be read as the
 * harness's own (a `cat` of another session's rollout would otherwise link this row to it). The
 * name is `/proc/<pid>/exe`'s basename and never `comm`: node renames its main thread (`MainThread`,
 * measured on the codex shim) and the kernel truncates `comm` to 15 bytes.
 */
async function holderPids(pid: number, holders: readonly string[], depth = 0): Promise<number[]> {
  let exe: string | null = null
  try {
    exe = basename(await readlink(`/proc/${pid}/exe`))
  } catch {
  }
  if (exe && holders.includes(exe)) return [pid]
  if (depth >= HOLDER_MAX_DEPTH) return []
  const out: number[] = []
  for (const c of await childrenOf(pid)) out.push(...await holderPids(c, holders, depth + 1))
  return out
}

/** Which file a pid's harness process holds open, and WHICH process holds it. */
export interface ProcessTranscriptFile {
  file: string
  /** The process holding it — the pid the collision guard compares, never the pid that was asked. */
  holder: number
}

/**
 * Which file the harness process behind `pid` holds open, or `null` when nothing here can say.
 *
 * Split out from `readProcessConversation` so a caller can resolve MANY pids FIRST — to run the
 * collision guard (`holderCollisions`) — before trusting any of them. For agy that check has to
 * happen before the read: once two processes are writing into the SAME log, nothing in it can be
 * safely attributed to either.
 *
 * More than one holder under one pane naming a file of this harness is ambiguity, not a choice, and
 * answers `null` — the same refusal `fileFromFds` makes for one process naming two conversations.
 */
export async function resolveProcessLog(
  harness: HarnessId,
  pid: number,
): Promise<ProcessTranscriptFile | null> {
  const source = HARNESS_PROCESS_TRANSCRIPTS[harness]
  if (!source) return null
  return resolveHolderFile(pid, source.holders, source.fileFromFds)
}

/**
 * The walk itself, with the harness's two facts passed in — exported so a test can drive it against
 * the REAL `/proc` with processes of its own rather than a mock of the very thing under test.
 */
export async function resolveHolderFile(
  pid: number,
  holders: readonly string[] | null,
  fileFromFds: (targets: readonly string[]) => string | null,
): Promise<ProcessTranscriptFile | null> {
  const pids = holders ? await holderPids(pid, holders) : [pid]
  let found: ProcessTranscriptFile | null = null
  for (const holder of pids) {
    const file = fileFromFds(await openFiles(holder))
    if (!file) continue
    if (found) return null
    found = { file, holder }
  }
  return found
}

/**
 * The identity two holders must never share — the conversation for a path-named harness, the file
 * itself for a content-named one (two agy processes in one log), or `null`.
 */
export function collisionKey(harness: HarnessId, resolved: ProcessTranscriptFile | null): string | null {
  const source = HARNESS_PROCESS_TRANSCRIPTS[harness]
  if (!source || !resolved) return null
  return source.conversation.from === 'path' ? source.conversation.read(resolved.file) : resolved.file
}

/**
 * The conversation the process behind `pid` is writing, or `null` when nothing here can say.
 *
 * `null` covers every distinguishable failure on purpose: this answer feeds
 * `recordConversation`, which writes a link that is then treated as exact everywhere, so the only
 * two outcomes worth having are a conversation somebody can point at and no answer at all.
 *
 * `known`, when given, is trusted over resolving fresh — a caller that already ran the collision
 * check has already paid for this pid's `/proc` walk, and must not ask twice: a pane that changes
 * between the two reads would answer a different fact than the one the guard checked.
 */
export async function readProcessConversation(
  harness: HarnessId,
  pid: number,
  known?: ProcessTranscriptFile | null,
): Promise<string | null> {
  const source = HARNESS_PROCESS_TRANSCRIPTS[harness]
  if (!source) return null

  const resolved = known !== undefined ? known : await resolveProcessLog(harness, pid)
  if (!resolved) return null
  if (source.conversation.from === 'path') return source.conversation.read(resolved.file)

  try {
    return source.conversation.read(await readFile(resolved.file, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Where each harness leaves the per-process logs `HARNESS_PROCESS_TRANSCRIPTS`' after-the-fact read lists. A `Record<HarnessId,
 * …>` so a harness added later has to say, rather than being absent by omission.
 */
const PROCESS_LOG_DIRS: Record<HarnessId, string | null> = {
  antigravity: join(ANTIGRAVITY_DIR, 'log'),
  claude: null,
  codex: null,
  gemini: null,
  copilot: null,
  kimi: null,
  opencode: null,
}

/**
 * The conversation a row's process created, recovered from the log it LEFT BEHIND — for the row
 * whose process ended before the live read (`readProcessConversation`) ever landed.
 *
 * Only the logs opened inside the spawn's window are READ: a log directory holds one file per
 * process the harness ever ran (64 conversations, hundreds of logs, on a real machine), and the
 * window is decided from the file NAME before any content is touched. The rules — which log, in
 * which folder, and every refusal — are `conversationFromSpawnWindow`'s; this only lists and reads.
 *
 * Failure is ABSENCE, always, like everything in this module: an unreadable directory or file is
 * `null`, and the row keeps behaving exactly as it does today.
 */
export async function readSpawnWindowConversation(
  o: {
    harness: HarnessId
    cwd: string
    spawnedMs: number
    rivalSpawnsMs?: readonly number[]
    taken?: ReadonlySet<string>
  },
  logsDir?: string,
): Promise<string | null> {
  const source = HARNESS_PROCESS_TRANSCRIPTS[o.harness]?.afterTheFact
  const dir = logsDir ?? PROCESS_LOG_DIRS[o.harness]
  if (!source || !dir) return null
  const { logStartMs, windowMs, conversationFromSpawn } = source

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const logs: { path: string; text: string }[] = []
  for (const name of names) {
    const path = join(dir, name)
    const start = logStartMs(path)
    if (start === null) continue
    if (start < o.spawnedMs - windowMs.before || start > o.spawnedMs + windowMs.after) continue
    try {
      logs.push({ path, text: await readFile(path, 'utf-8') })
    } catch {
      // One unreadable log is one fewer candidate. If it was the row's, the answer is `null`.
    }
  }
  return conversationFromSpawn({
    logs,
    spawnedMs: o.spawnedMs,
    cwd: o.cwd,
    ...(o.rivalSpawnsMs ? { rivalSpawnsMs: o.rivalSpawnsMs } : {}),
    ...(o.taken ? { taken: o.taken } : {}),
  })
}
