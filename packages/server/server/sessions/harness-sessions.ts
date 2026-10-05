/**
 * harness-sessions.ts — the IO half of `harness-session-file.ts`: reading what each harness records
 * about its own live sessions, cheaply enough to do it every five seconds.
 *
 * ## What this buys, in order of value
 *
 *  1. **An EXACT link between a harness's own record and one of our rows.** Claude writes the tmux
 *     session it is running inside, which for a session agentop started is `agentop-<our id>`. Every
 *     other correlation in this feature has had to guess by harness-and-directory — the guess that
 *     resolved every session in one repository to the same conversation and reopened three rows onto
 *     one conversation (`session-view.ts` records that bug). Here there is nothing to guess.
 *  2. **The conversation id, exactly**, for a session we started FRESH. `ManagedSession.conversationId`
 *     is otherwise only known for a row we reopened, because we handed the id over ourselves.
 *  3. **The name the user gave the session from inside it**, which is what this was asked for.
 *
 * ## Cost
 *
 * The poll runs every five seconds over the whole fleet, so the directory is listed once per poll and
 * each file is read only when its mtime has moved — the same shape of memo `repo-facts.ts` keeps per
 * directory. A machine with fifty stale session files pays one `readdir` and no reads at all.
 *
 * Failure is always ABSENCE. An unreadable directory, an unparseable file, a field of the wrong
 * type: the answer is "nothing is known about that session", which leaves every row exactly as it
 * behaves today. Nothing here may throw into the poll.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { CLAUDE_DIR } from '../config'
import {
  HARNESS_SESSION_SOURCES, parseHarnessSessionFile, tmuxSessionName,
  type HarnessSessionFile,
} from './harness-session-file'
import { idFromTmuxName } from './tmux-cli'
import { procAvailable, readProcStart, sameProcess } from './proc-liveness'

/**
 * Where each harness's own session records live on THIS machine.
 *
 * Resolved here rather than in the pure module, and from `CLAUDE_DIR` rather than `HOME_DIR`,
 * because that is the directory this product already treats as "the Claude installation being
 * measured" — a container mounting someone else's `~/.claude` reads that one, and reading the
 * container's own empty home instead would report a fleet of nothing.
 */
function homeOf(harness: HarnessId): string | undefined {
  return harness === 'claude' ? CLAUDE_DIR : undefined
}

interface Cached {
  mtimeMs: number
  file: HarnessSessionFile | null
}

const cache = new Map<string, Cached>()

/** Reset the memo. Tests only. */
export function forgetHarnessSessions(): void {
  cache.clear()
}

/** Read one record, from the memo unless the file has changed since. Never throws. */
async function readOne(path: string): Promise<Keyed | null> {
  let mtimeMs: number
  try {
    mtimeMs = (await stat(path)).mtimeMs
  } catch {
    cache.delete(path)
    return null
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.file ? { file: hit.file, mtimeMs } : null

  let file: HarnessSessionFile | null = null
  try {
    file = parseHarnessSessionFile(JSON.parse(await readFile(path, 'utf-8')))
  } catch {
    // Unreadable, mid-write, or not JSON at all. Absence, never a throw — and it is CACHED against
    // this mtime so a permanently broken file is not re-read every five seconds forever.
    file = null
  }
  cache.set(path, { mtimeMs, file })
  return file ? { file, mtimeMs } : null
}

export interface HarnessSessionIndex {
  /** Keyed by OUR managed session id, read out of the harness's `tmux` field. Exact. */
  byManagedId: Map<string, HarnessSessionFile>
  /** Keyed by OS pid — how an EXTERNAL session found in `/proc` is matched. Exact. */
  byPid: Map<number, HarnessSessionFile>
  /**
   * Keyed by the harness's own CONVERSATION id. Exact, and the only key that needs nothing else.
   *
   * The other two both require a second fact to be true: `byManagedId` needs the session to have
   * been started under tmux, and `byPid` needs the `/proc` scan to have surfaced the process. A
   * session that satisfies neither was invisible — and one that satisfies neither is not exotic, it
   * is a **background agent**: no tmux, and nothing in the scan.
   *
   * Measured on this machine on 2026-08-15: a session alive for 38 minutes, whose record held
   * `sessionId 581deab7…`, `name 'MAIN'` (typed, `nameSource` absent) and `tmux` NONE, was listed by
   * agentop as `closed`, under a title from the conversation store that predated the rename by days.
   * The file naming both the conversation and the live pid was read, indexed, and then never asked
   * for — because there was no key that fit it.
   */
  byConversation: Map<string, HarnessSessionFile>
}

/**
 * ## These records OUTLIVE their processes, and that is mostly a feature
 *
 * Measured on this machine on 2026-08-14: 53 files, of which about a dozen belong to processes that
 * are still running. A record left behind by a session that has ended is exactly what keeps the name
 * a person typed inside it readable on the `lost` row afterwards, which is the point.
 *
 * The one thing staleness can do is put TWO records under one key, when a pid was reused or a file
 * was left behind for a tmux session name that came round again. `readdir` order would then decide
 * which one wins, which is no decision at all — so the NEWEST file wins, and `mtimeMs` is already
 * being read for the memo.
 *
 * `byPid` needs no such care in practice: it is only ever looked up with a pid `/proc` just reported,
 * so a record for a dead process is never asked for.
 */
interface Keyed {
  file: HarnessSessionFile
  mtimeMs: number
}

const EMPTY: HarnessSessionIndex = {
  byManagedId: new Map(), byPid: new Map(), byConversation: new Map(),
}

/** An empty index, for a caller that has nothing to look up. */
export function emptyHarnessSessionIndex(): HarnessSessionIndex {
  return { byManagedId: new Map(), byPid: new Map(), byConversation: new Map() }
}

/**
 * Every live session record this machine's harnesses have written, indexed both ways it is looked up.
 *
 * Both indexes are EXACT — a tmux session name and an OS pid — which is the whole point of reading
 * these files rather than inferring anything.
 */
export async function loadHarnessSessions(
  harnesses: readonly HarnessId[] = ['claude'],
): Promise<HarnessSessionIndex> {
  const out = emptyHarnessSessionIndex()
  // How fresh the record already sitting under each managed id is, so the newest wins rather than
  // whichever `readdir` happened to hand over last. See the note above `Keyed`.
  const seenAt = new Map<string, number>()
  // Asked ONCE for the whole sweep rather than per file: off Linux the answer is the same 60 times,
  // and it decides whether `alive` is a fact or stays `undefined`.
  const canProbe = await procAvailable()

  for (const harness of harnesses) {
    const source = HARNESS_SESSION_SOURCES[harness]
    const home = homeOf(harness)
    // A harness with no reader behaves exactly as it does today. Absence is the decision.
    if (!source || !home) continue

    const dir = join(home, source.dir)
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      continue // no such directory: this harness has never run here, which is not an error
    }

    // The files are READ concurrently (a machine accumulates hundreds — 741 here — because the harness
    // never deletes a dead process's record, and reading them one after another was ~300 ms of every
    // `/api/fleet`), and the indexing below still walks them in directory order, so what wins is
    // unchanged.
    const wanted = names.filter(n => source.matches.test(n))
    const prefetched = new Map<string, { read: NonNullable<Awaited<ReturnType<typeof readOne>>>; procStart: Awaited<ReturnType<typeof readProcStart>> | undefined }>()
    for (let i = 0; i < wanted.length; i += 32) {
      await Promise.all(wanted.slice(i, i + 32).map(async name => {
        const r = await readOne(join(dir, name))
        if (!r) return
        const pid = r.file.pid
        prefetched.set(name, { read: r, procStart: canProbe && pid !== undefined ? await readProcStart(pid) : undefined })
      }))
    }

    for (const name of wanted) {
      const pre = prefetched.get(name)
      if (!pre) continue
      const read = pre.read
      const { mtimeMs } = read
      // Liveness is stamped here because this is the impure layer and the answer is about NOW.
      // Only asked where `/proc` exists at all, and only for a record that carries the
      // anti-recycling key — everywhere else it stays `undefined`, meaning "nobody could tell",
      // which every reader must treat as unknown rather than as "not running".
      const pid = read.file.pid
      const file: HarnessSessionFile = {
        ...read.file,
        harness,
        ...(canProbe && pid !== undefined
          ? { alive: sameProcess(read.file.procStart, pre.procStart) }
          : {}),
      }
      if (file.pid !== undefined) out.byPid.set(file.pid, file)

      // Indexed BEFORE the tmux gate below, and that placement is the fix: everything past that
      // `continue` is skipped for a session that was not started under tmux, which is exactly the
      // case that had no key at all. Newest-wins for the same reason `byManagedId` needs it — a
      // conversation resumed several times leaves a record per run, and `readdir` order deciding
      // which name is current is no decision.
      const conversation = file.sessionId
      if (conversation) {
        const key = `c:${conversation}`
        if (mtimeMs >= (seenAt.get(key) ?? -Infinity)) {
          seenAt.set(key, mtimeMs)
          out.byConversation.set(conversation, file)
        }
      }

      const tmux = tmuxSessionName(file)
      const managedId = tmux ? idFromTmuxName(tmux) : null
      // `idFromTmuxName` returns null for a tmux session that is not ours, which is the ordinary
      // case for a user's own tmux — claimed rows would then be somebody else's.
      if (!managedId) continue
      if (mtimeMs < (seenAt.get(managedId) ?? -Infinity)) continue
      seenAt.set(managedId, mtimeMs)
      out.byManagedId.set(managedId, file)
    }
  }

  return out
}

export { EMPTY as EMPTY_HARNESS_SESSIONS }
