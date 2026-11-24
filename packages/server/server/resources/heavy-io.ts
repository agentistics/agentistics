/**
 * resources/heavy-io.ts — the IO half of the heavy-job slot: the queue on disk, and `agentop heavy`.
 *
 * The queue is a directory per state (`<data>/heavy/waiting/<pid>.json`, `…/running/<pid>.json`), one
 * small file per job, written by the job itself — so any number of `agentop heavy` processes can
 * queue without a shared file to race on, and a job that dies leaves a file whose pid is dead, which
 * every reader ignores (and the next job sweeps).
 *
 * Running a job: wait until this job is at the HEAD of the queue, then try each slot that MemAvailable
 * allows without waiting, then join the blocking flock waiters on slot zero if all are busy.
 * Slot 0 is `/tmp/agentistics-heavy.lock`, the lock sessions already take by hand.
 */

import { hostWhich } from '../host-which'
import { unlinkSync } from 'node:fs'
import { mkdir, readdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { FLOCK_BUSY_CODE, flockHolders, heavyAttempts, heavyFlockArgs, heavyWaitLine, heavyLockPath, heavySlots, heavyTreePids, mergeHeavyJobs, parseFlockArgv, queuePosition, type HeavyRunning, type HeavyWaiter } from './heavy'
import { stat } from 'node:fs/promises'
import { pidAlive, readProcTable, type ProcStatRow } from './proc-read'
import { parseMeminfo } from '../sessions/memory-budget'

export const HEAVY_DIR = join(AGENTISTICS_DATA_DIR, 'heavy')

// Exec keeps flock's PID (and therefore queue accounting). The detached group also contains this
// watchdog and the wrapped command. Reparenting means the owner died without running its handlers.
// The watchdog opens no lock FD; a normal flock exit lets it leave without holding the slot open.
const PARENT_WATCHDOG = `
owner=$1
shift
group=$$
(
  while :; do
    read -r pid comm state parent rest < /proc/$group/stat 2>/dev/null || exit 0
    [ "$state" = Z ] && exit 0
    if [ "$parent" != "$owner" ]; then
      kill -KILL -"$group"
      exit 0
    fi
    sleep 0.1
  done
) </dev/null >/dev/null 2>&1 &
exec "$@"
`

export type { HeavyRunning } from './heavy'
export interface HeavyState {
  slots: number
  availableBytes: number | null
  running: HeavyRunning[]
  waiting: HeavyWaiter[]
}

async function readDirJson<T>(dir: string): Promise<T[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const out: T[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    try { out.push(JSON.parse(await readFile(join(dir, n), 'utf8')) as T) } catch { /* half-written */ }
  }
  return out
}

async function memAvailable(): Promise<number | null> {
  try { return parseMeminfo(await readFile('/proc/meminfo', 'utf8'))?.available ?? null } catch { return null }
}

/** Resident memory already deducted from MemAvailable. Swap must not reduce future RAM headroom. */
async function rssOf(pid: number, table: readonly ProcStatRow[], seen: Set<number>): Promise<number | null> {
  let total = 0
  let measured = false
  for (const member of heavyTreePids([pid], table)) {
    if (seen.has(member)) continue
    seen.add(member)
    try {
      const status = await readFile(`/proc/${member}/status`, 'utf8')
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status)
      if (rss) { total += Number(rss[1]) * 1024; measured = true }
    } catch { /* gone or unreadable: no resident bytes to credit */ }
  }
  return measured ? total : null
}

/**
 * The jobs holding or waiting on a slot through a BARE `flock` — the manual form every session used
 * before `agentop heavy` existed and many still do. The holder comes from `/proc/locks` (by the lock
 * file's inode); the waiters are the other `flock` processes naming the same file. Without this the
 * queue would say "0 running" while a full `tsc -b` held the slot.
 */
async function manualJobs(table: readonly ProcStatRow[], lockDir: string): Promise<{ running: HeavyRunning[]; waiting: HeavyWaiter[] }> {
  const running: HeavyRunning[] = []
  const waiting: HeavyWaiter[] = []
  if (process.platform !== 'linux') return { running, waiting }
  const locks = await readFile('/proc/locks', 'utf8').catch(() => '')
  const inodes = new Map<number, number>()
  for (let slot = 0; slot < 8; slot++) {
    const st = await stat(heavyLockPath(slot, lockDir)).catch(() => null)
    if (st) inodes.set(st.ino, slot)
  }
  if (inodes.size === 0) return { running, waiting }
  const holders = new Map<number, number>()
  const unknownSlots = new Map<string, { inode: number; slot: number }>()
  const livePids = new Set(table.map(row => row.pid))
  for (const [ino, slot] of inodes) for (const pid of flockHolders(locks, ino)) {
    if (livePids.has(pid)) holders.set(pid, slot)
    else unknownSlots.set(heavyLockPath(slot, lockDir), { inode: ino, slot })
  }
  for (const [inode, slot] of inodes) {
    const path = heavyLockPath(slot, lockDir)
    if ([...holders.values()].includes(slot) || unknownSlots.has(path)) continue
    // On this kernel /proc/locks can omit inherited FD locks after the acquiring process exits.
    // Probe without waiting, holding a free lock only for `true`. Only a successful probe proves
    // it is free; a busy lock or any probe error still needs the fdinfo fallback.
    let free = false
    try {
      const probe = Bun.spawn(['flock', '-n', '-E', String(FLOCK_BUSY_CODE), path, 'true'], {
        stdout: 'ignore', stderr: 'ignore',
      })
      free = await probe.exited === 0
    } catch { /* unavailable probe: preserve holder detection through fdinfo */ }
    if (!free) unknownSlots.set(path, { inode, slot })
  }
  // `flock 9` can exit while the shell/job keeps its open file description. Linux then reports
  // no global holder (or an exited pid). Find the processes retaining that locked descriptor, not every
  // process that merely opened the lock file. Free slots never need an FD scan.
  if (unknownSlots.size > 0) {
    for (const row of table) {
      const fds = await readdir(`/proc/${row.pid}/fd`).catch(() => [] as string[])
      for (const fd of fds) {
        const path = await readlink(`/proc/${row.pid}/fd/${fd}`).catch(() => '')
        const unknown = unknownSlots.get(path)
        if (!unknown) continue
        const info = await readFile(`/proc/${row.pid}/fdinfo/${fd}`, 'utf8').catch(() => '')
        if (flockHolders(info, unknown.inode).length > 0) holders.set(row.pid, unknown.slot)
      }
    }
    // Inherited descriptors appear in every child too; retain the outermost holder tree only.
    const nested = new Set([...holders.keys()].flatMap(pid => heavyTreePids([pid], table).slice(1)))
    for (const pid of nested) holders.delete(pid)
  }
  // A holder may have exec'd the command (`flock -F`) or be a shell using `flock <fd>`.
  // Trust the kernel's holder pid even when its process name/argv no longer mentions flock.
  for (const [pid, slot] of holders) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean)
    const parsed = parseFlockArgv(argv)
    const st = await stat(`/proc/${pid}`).catch(() => null)
    running.push({ pid, sinceMs: st?.mtimeMs ?? Date.now(), command: table.find(r => r.pid === pid)?.comm === 'flock'
      ? parsed?.command ?? '' : argv.join(' ').slice(0, 200), slot, usedBytes: null, manual: true })
  }
  for (const row of table) {
    if (row.comm !== 'flock' || holders.has(row.pid)) continue
    const argv = (await readFile(`/proc/${row.pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean)
    const parsed = parseFlockArgv(argv)
    if (!parsed || ![...inodes.values()].some(slot => heavyLockPath(slot, lockDir) === parsed.lock)) continue
    const st = await stat(`/proc/${row.pid}`).catch(() => null)
    waiting.push({ pid: row.pid, sinceMs: st?.mtimeMs ?? Date.now(), command: parsed.command, manual: true })
  }
  return { running, waiting }
}

/** What is running and waiting right now — dead entries dropped, manual `flock` jobs included. */
export async function readHeavyState(dir = HEAVY_DIR, lockDir = '/tmp'): Promise<HeavyState> {
  const ours = (await readDirJson<HeavyRunning>(join(dir, 'running'))).filter(r => pidAlive(r.pid))
  const queued = (await readDirJson<HeavyWaiter>(join(dir, 'waiting'))).filter(w => pidAlive(w.pid))
  const table = readProcTable(Date.now(), true) ?? []
  const manual = await manualJobs(table, lockDir)
  const { running, waiting } = mergeHeavyJobs(ours, queued, manual)
  const seen = new Set<number>()
  for (const r of running) r.usedBytes = await rssOf(r.pid, table, seen)
  const availableBytes = await memAvailable()
  const runningBytes = running.reduce((n, r) => n + (r.usedBytes ?? 0), 0)
  return { slots: availableBytes === null ? 1 : heavySlots(availableBytes, runningBytes), availableBytes, running, waiting }
}

/**
 * `agentop heavy [--] <cmd…>` — run one heavy job through the slot. Returns the command's exit code.
 * `say` prints the queue state to stderr (stdout belongs to the command).
 */
export async function runHeavy(argv: string[], say: (line: string) => void, dir = HEAVY_DIR, lockDir = '/tmp'): Promise<number> {
  const cmd = argv[0] === '--' ? argv.slice(1) : argv
  if (cmd.length === 0) { say('usage: agentop heavy -- <command> [args…]'); return 2 }
  const flock = hostWhich('flock')
  const command = cmd.join(' ').slice(0, 200)
  if (!flock || process.platform !== 'linux') {
    say('agentop heavy: no flock here — running without the slot.')
    return await Bun.spawn(cmd, { stdio: ['inherit', 'inherit', 'inherit'] }).exited
  }
  const me: HeavyWaiter = { pid: process.pid, sinceMs: Date.now(), command }
  await mkdir(join(dir, 'waiting'), { recursive: true })
  await mkdir(join(dir, 'running'), { recursive: true })
  const waitFile = join(dir, 'waiting', `${process.pid}.json`)
  const runFile = join(dir, 'running', `${process.pid}.json`)
  await writeFile(waitFile, JSON.stringify(me))
  let activeChild: ReturnType<typeof Bun.spawn> | undefined
  let signalExit: number | undefined
  const cleanup = () => {
    if (activeChild) {
      try { process.kill(-activeChild.pid, 'SIGKILL') } catch { /* already exited */ }
    }
    // exit handlers cannot await filesystem IO.
    for (const file of [waitFile, runFile]) { try { unlinkSync(file) } catch { /* absent */ } }
  }
  const cancel = (code: number) => {
    if (signalExit !== undefined) return
    signalExit = code
    cleanup()
    // Reap our direct flock child before exiting; exit's synchronous fallback cannot await it.
    void Promise.resolve(activeChild?.exited).then(() => process.exit(code))
  }
  const onTerm = () => cancel(143)
  const onInt = () => cancel(130)
  const onHup = () => cancel(129)
  process.on('exit', cleanup)
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  process.on('SIGHUP', onHup)
  let lastLine = ''
  const reportWaiting = (state: HeavyState) => {
    const { position, of } = queuePosition(state.waiting, process.pid, pidAlive)
    // Memory drifts every tick; only queue/holder changes warrant another line.
    const key = JSON.stringify([position, of, state.slots, state.running.map(r => [r.pid, r.manual]), state.waiting.filter(w => w.manual).length])
    if (key !== lastLine) { lastLine = key; say(heavyWaitLine(state, position, of)) }
  }
  try {
    for (;;) {
      const state = await readHeavyState(dir, lockDir)
      const { position } = queuePosition(state.waiting, process.pid, pidAlive)
      for (const { slot, blocking } of heavyAttempts(position, state.slots)) {
        if (blocking) reportWaiting(state)
        const child = activeChild = Bun.spawn(['sh', '-c', PARENT_WATCHDOG, 'agentop-heavy-watch', String(process.pid), flock, ...heavyFlockArgs({ slot, blocking }, cmd, lockDir)], {
          detached: true,
          stdio: ['inherit', 'inherit', 'inherit'],
          env: { ...process.env, AGENTISTICS_HEAVY_JOB: '1' },
        })
        if (blocking) {
          // Keep the parent at the head until the child really acquires the lock. Readers use
          // flockPid to identify our waiting child and the eventual holder without double counts.
          await writeFile(waitFile, JSON.stringify({ ...me, flockPid: child.pid }))
          let finished = false
          void child.exited.then(() => { finished = true })
          while (!finished) {
            await Promise.race([child.exited, Bun.sleep(2000)])
            if (finished) break
            const current = await readHeavyState(dir, lockDir)
            if (current.running.some(r => r.pid === child.pid)) break
            reportWaiting(current)
          }
        } else {
          await writeFile(runFile, JSON.stringify({ ...me, pid: child.pid, slot, usedBytes: null }))
          await unlink(waitFile).catch(() => {})
        }
        const code = await child.exited
        // Stop the watchdog even when flock already exited; wrapped descendants share this group.
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
        activeChild = undefined
        if (signalExit !== undefined) process.exit(signalExit)
        if (blocking || code !== FLOCK_BUSY_CODE) return code
        // Busy: back in the queue at the same place, and the next slot is tried.
        await unlink(runFile).catch(() => {})
        await writeFile(waitFile, JSON.stringify(me))
      }
      reportWaiting(state)
      await Bun.sleep(2000)
    }
  } finally {
    cleanup()
    process.off('exit', cleanup)
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
    process.off('SIGHUP', onHup)
  }
}
