/**
 * pane-activity.ts — has anything in a session's process tree WRITTEN since we last looked? (PERF.IDLE)
 *
 * A watched terminal is captured by spawning tmux (`capture-pane` + `display-message`), every half
 * second at first and every 1.5 s once the screen has been still for a while. On a still screen
 * nearly every one of those processes learns that nothing changed — and with five browser tabs
 * watching idle sessions that was ~200 tmux processes a minute, the largest part of what a connected
 * client cost the server.
 *
 * A screen changes because a program WROTE to the pane. `/proc/<pid>/io`'s `wchar` counts every byte
 * a process passed to write(2) — the terminal included, and its own files too, which only ever errs
 * toward capturing — so the sum over the session's process tree is a stamp that cannot stay the same
 * across a write. Reading it is a handful of procfs reads and no process. When the stamp is unknown
 * (not Linux, a tree we may not read, no pid for the row) the caller captures exactly as before.
 *
 * What it cannot see — a resize from another attached client, tmux's own redraws, a process outside
 * the tree writing to the pty — is why the caller still captures at a bounded interval regardless.
 */
import { readdirSync, readFileSync } from 'node:fs'

/** How deep, and how wide, a tree is walked: a harness and the commands it runs, not a fork bomb. */
const MAX_PROCESSES = 64

/** PURE. The stamp, or `null` when any member could not be read (then nothing may be concluded). */
export function activityStamp(members: ReadonlyArray<{ pid: number; wchar: number | null }>): string | null {
  if (members.length === 0) return null
  let total = 0
  for (const m of members) {
    if (m.wchar === null || !Number.isFinite(m.wchar)) return null
    total += m.wchar
  }
  return `${members.map(m => m.pid).join(',')}|${total}`
}

/** PURE. `wchar` out of a `/proc/<pid>/io` text, `null` when absent. */
export function parseWchar(io: string): number | null {
  const m = /^wchar:\s+(\d+)$/m.exec(io)
  return m ? Number(m[1]) : null
}

function childrenOf(pid: number, root: string): number[] {
  const out: number[] = []
  let tids: string[]
  try { tids = readdirSync(`${root}/${pid}/task`) } catch { return out }
  for (const tid of tids) {
    let text = ''
    try { text = readFileSync(`${root}/${pid}/task/${tid}/children`, 'utf8') } catch { continue }
    for (const c of text.split(' ')) { const n = Number(c); if (Number.isInteger(n) && n > 0) out.push(n) }
  }
  return out
}

/** The write stamp of `pid` and everything under it, `null` when it cannot be read whole. */
export function processTreeActivity(pid: number, root = '/proc'): string | null {
  if (process.platform !== 'linux' && root === '/proc') return null
  const members: Array<{ pid: number; wchar: number | null }> = []
  const queue = [pid]
  const seen = new Set<number>()
  while (queue.length > 0 && members.length < MAX_PROCESSES) {
    const p = queue.shift()!
    if (seen.has(p)) continue
    seen.add(p)
    let io: string
    try { io = readFileSync(`${root}/${p}/io`, 'utf8') } catch (e) {
      // A child that exited between the listing and here simply left. Anything else — the root gone,
      // a member we may not read — and nothing may be concluded about the tree.
      if (p !== pid && (e as NodeJS.ErrnoException)?.code === 'ENOENT') continue
      return null
    }
    members.push({ pid: p, wchar: parseWchar(io) })
    queue.push(...childrenOf(p, root))
  }
  if (queue.length > 0) return null // too large to vouch for: capture as before
  return activityStamp(members)
}
