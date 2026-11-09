/**
 * shell-backend.ts — opening, listing and closing utility shells against tmux.
 *
 * The DECISIONS are `shell-spec.ts`'s and the RECORD is `shell-store.ts`'s; what is here is the
 * tmux and filesystem work between them, plus the one rule that needs its own test —
 * `reconcileShells`.
 *
 * Everything runs on `SHELL_SOCKET`, never the fleet's. That is structural and not a naming
 * convention: on the fleet socket `parseTmuxList` would keep these sessions and `reconcileSessions`
 * would report each as an `unregistered` fleet row. See `tmux-cli.ts`'s note on `SHELL_SOCKET`.
 */

import { shellTmux as tmux } from './shell-tmux'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  killSessionArgs, listSessionsArgs, newSessionArgs, parseTmuxList, SHELL_SOCKET,
  tmuxListIsEmptyState,
} from './tmux-cli'
import { planShellOpen, type ShellRefusal } from './shell-spec'
import { readShells, writeShells, type ShellRecord } from './shell-store'

async function tmuxAvailable(): Promise<boolean> {
  return (await tmux(['-V'])).code === 0
}

async function dirExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** Which shell ids tmux is actually running on our socket. */
async function runningIds(): Promise<string[]> {
  const r = await tmux(listSessionsArgs(SHELL_SOCKET))
  if (r.code !== 0) {
    // Either "no server running on that socket" — the ordinary state before the day's first shell —
    // or a real failure. Both mean no shells; `tmuxListIsEmptyState` is consulted so the two can be
    // told apart in a log, and so this reads as a decision rather than a swallowed error.
    if (!tmuxListIsEmptyState(r.code, r.out, r.err)) {
      console.error(`[shell] tmux list-sessions on ${SHELL_SOCKET} failed: ${r.err.trim()}`)
    }
    return []
  }
  return parseTmuxList(r.out).map(s => s.id)
}

/**
 * PURE: the store, narrowed to what is really running.
 *
 * Records go ONE WAY only. A record whose pane is gone is DROPPED — typing `exit` is the ordinary
 * death of a shell, and a ghost record would make the ceiling refuse an open with nothing actually
 * running. A pane with NO record is not adopted, which is the exact opposite of `session-adopt.ts`
 * and is deliberate: a session there carries a name, a task and a conversation worth recovering,
 * while a shell carries none of that, and this store's whole job is to be the small exact list the
 * ceiling counts.
 */
export function reconcileShells(stored: ShellRecord[], running: string[]): ShellRecord[] {
  const live = new Set(running)
  return stored.filter(r => live.has(r.id))
}

export async function listShells(): Promise<ShellRecord[]> {
  const stored = await readShells()
  const live = reconcileShells(stored, await runningIds())
  if (live.length !== stored.length) await writeShells(live)
  return live
}

export async function openShell(o: {
  sessionId: string
  cwd: string | undefined
  now?: number
  timing?: (stage: string, ms: number) => void
}): Promise<{ ok: true; shell: ShellRecord } | { ok: false; reason: ShellRefusal }> {
  const now = o.now ?? Date.now()
  const timed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    try { return await work() } finally { o.timing?.(stage, performance.now() - started) }
  }
  const [open, cwdExists, available] = await Promise.all([
    timed('list', listShells),
    timed('cwd', async () => o.cwd ? dirExists(o.cwd) : false),
    timed('tmux', tmuxAvailable),
  ])
  const plan = planShellOpen({
    cwd: o.cwd,
    cwdExists,
    tmuxAvailable: available,
    openCount: open.length,
    shell: process.env.SHELL,
    platform: process.platform,
  })
  if (!plan.ok) return plan

  const id = randomUUID()
  const r = await timed('spawn', () => tmux(newSessionArgs({ id, cwd: plan.cwd, argv: plan.argv, socket: SHELL_SOCKET, path: process.env.PATH })))
  // tmux would not start it. `no-tmux` is the honest code: nothing the caller named went wrong with
  // the request, and the alternative is inventing a reason for a failure we cannot attribute.
  if (r.code !== 0) {
    console.error(`[shell] tmux new-session failed: ${r.err.trim()}`)
    return { ok: false, reason: 'no-tmux' }
  }

  const shell: ShellRecord = {
    id, sessionId: o.sessionId, cwd: plan.cwd, createdMs: now, lastViewedMs: now,
  }
  await timed('persist', () => writeShells([...open, shell]))
  return { ok: true, shell }
}

export async function closeShells(ids: string[]): Promise<{ closed: string[]; unknown: string[] }> {
  const open = await listShells()
  const known = new Set(open.map(r => r.id))
  const closed: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (!known.has(id)) { unknown.push(id); continue }
    await tmux(killSessionArgs(id, SHELL_SOCKET))
    closed.push(id)
  }
  // An id nobody knows is REPORTED rather than silently counted as closed: a caller that asked to
  // close four and hears "four closed" must not be told that about three.
  if (closed.length > 0) await writeShells(open.filter(r => !closed.includes(r.id)))
  return { closed, unknown }
}
