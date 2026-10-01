/**
 * process-conversation.ts — the IO half of `agy-conversation.ts`: which conversation the process
 * behind one of our panes is writing, read from the log that process holds OPEN.
 *
 * The pure module holds every RULE (which file, which line, and every refusal); this one only
 * performs the two reads and never decides anything. Same split as
 * `harness-session-file.ts` / `harness-sessions.ts`, and for the same reason: the rules are what
 * needs pinning against real bytes, and the filesystem is what must never throw into the poll.
 *
 * ## Cost, and why it is asked so narrowly
 *
 * The poll runs every five seconds over the whole fleet. A `/proc/<pid>/fd` sweep is a `readdir`
 * plus a `readlink` per descriptor, and the log read is the whole file — so the CALLER asks only
 * for a row that has NO link yet and whose harness has an entry in `HARNESS_PROCESS_LOGS`. On a
 * fleet with no antigravity in it this module is never called at all, and a linked agy row is asked
 * exactly once: `recordConversation` writes the id, and the next poll skips it.
 *
 * Failure is ABSENCE, always. No `/proc` (not Linux), a pid that has exited between the pane listing
 * and this read, a descriptor whose target cannot be resolved, an unreadable log: the answer is
 * `null`, the row keeps behaving exactly as it does today, and `conversationBlind`'s degradation
 * sentence in `chat-web.ts` is what the user sees. Nothing here may throw into the poll.
 */

import { readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { ANTIGRAVITY_DIR } from '../config'
import { HARNESS_PROCESS_LOGS } from './harness-session-file'

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
      // A descriptor closed between the listing and the resolve, or a link we may not follow. One
      // missing entry is one fewer candidate, never a failed read of the rest.
    }
  }
  return out
}

/**
 * Which log the process at `pid` holds open for this harness, or `null` when nothing here can say.
 *
 * Split out from `readProcessConversation` so a caller can resolve MANY pids' logs FIRST — to run
 * `agyLogCollisions` (`agy-conversation.ts`) — before reading any of their content. That check has
 * to happen before the read: once two processes are writing into the SAME file, nothing in it can
 * be safely attributed to either of them, so there is no "read first, decide after" that is safe.
 */
export async function resolveProcessLog(
  harness: HarnessId,
  pid: number,
): Promise<string | null> {
  const source = HARNESS_PROCESS_LOGS[harness]
  if (!source) return null
  return source.logFromFds(await openFiles(pid))
}

/**
 * The conversation the process at `pid` is writing, or `null` when nothing here can say.
 *
 * `null` covers every distinguishable failure on purpose: this answer feeds
 * `recordConversation`, which writes a link that is then treated as exact everywhere, so the only
 * two outcomes worth having are a conversation somebody can point at and no answer at all.
 *
 * `knownLog`, when given, is trusted over resolving fresh — a caller that already ran the
 * collision check above has already paid for this pid's `/proc/<pid>/fd` sweep, and asking again
 * on a fleet with a live agy process would sweep it twice every poll for no reason.
 */
export async function readProcessConversation(
  harness: HarnessId,
  pid: number,
  knownLog?: string | null,
): Promise<string | null> {
  const source = HARNESS_PROCESS_LOGS[harness]
  if (!source) return null

  const log = knownLog !== undefined ? knownLog : await resolveProcessLog(harness, pid)
  if (!log) return null

  try {
    return source.conversationFrom(await readFile(log, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Where each harness leaves the per-process logs `HARNESS_PROCESS_LOGS` reads. A `Record<HarnessId,
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
  const source = HARNESS_PROCESS_LOGS[o.harness]
  const dir = logsDir ?? PROCESS_LOG_DIRS[o.harness]
  if (!source || !dir) return null
  const { logStartMs, windowMs, conversationFromSpawn } = source.afterTheFact

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
