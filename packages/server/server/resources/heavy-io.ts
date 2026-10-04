/**
 * resources/heavy-io.ts — the IO half of the heavy-job slot: the queue on disk, and `agentop heavy`.
 *
 * The queue is a directory per state (`<data>/heavy/waiting/<pid>.json`, `…/running/<pid>.json`), one
 * small file per job, written by the job itself — so any number of `agentop heavy` processes can
 * queue without a shared file to race on, and a job that dies leaves a file whose pid is dead, which
 * every reader ignores (and the next job sweeps).
 *
 * Running a job: wait until this job is at the HEAD of the queue, then try each slot that MemAvailable
 * allows with `flock -n -E 254 <lock> <cmd…>` — flock holds the lock for exactly as long as the
 * command runs and releases it however the command ends. A busy slot answers 254 at once and the
 * next slot is tried. Slot 0 is `/tmp/agentistics-heavy.lock`, the lock sessions already take by hand.
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'
import { FLOCK_BUSY_CODE, flockHolders, heavyLockPath, heavySlots, parseFlockArgv, queuePosition, type HeavyWaiter } from './heavy'
import { stat } from 'node:fs/promises'
import { pidAlive } from './proc-read'
import { parseMeminfo } from '../sessions/memory-budget'

export const HEAVY_DIR = join(AGENTISTICS_DATA_DIR, 'heavy')

export interface HeavyRunning extends HeavyWaiter {
  slot: number
  usedBytes: number | null
  /** Started with a bare `flock` on the slot's lock rather than through `agentop heavy`. */
  manual?: boolean
}
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

/**
 * RSS + swap of a process AND its descendants — a heavy job runs as `flock`'s child (and `tsc` as
 * `bun`'s), so the pid on record holds almost nothing itself.
 */
async function rssOf(pid: number, depth = 0): Promise<number | null> {
  try {
    const s = await readFile(`/proc/${pid}/status`, 'utf8')
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+) kB$`, 'm').exec(s)?.[1] ?? 0) * 1024
    let total = kb('VmRSS') + kb('VmSwap')
    if (depth < 6) {
      const kids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8').catch(() => '')).trim()
      for (const k of kids ? kids.split(/\s+/).map(Number) : []) total += (await rssOf(k, depth + 1)) ?? 0
    }
    return total
  } catch { return null }
}

/**
 * The jobs holding or waiting on a slot through a BARE `flock` — the manual form every session used
 * before `agentop heavy` existed and many still do. The holder comes from `/proc/locks` (by the lock
 * file's inode); the waiters are the other `flock` processes naming the same file. Without this the
 * queue would say "0 running" while a full `tsc -b` held the slot.
 */
async function manualJobs(): Promise<{ running: HeavyRunning[]; waiting: HeavyWaiter[] }> {
  const running: HeavyRunning[] = []
  const waiting: HeavyWaiter[] = []
  if (process.platform !== 'linux') return { running, waiting }
  const locks = await readFile('/proc/locks', 'utf8').catch(() => '')
  const inodes = new Map<number, number>()
  for (let slot = 0; slot < 8; slot++) {
    const st = await stat(heavyLockPath(slot)).catch(() => null)
    if (st) inodes.set(st.ino, slot)
  }
  if (inodes.size === 0) return { running, waiting }
  const holders = new Map<number, number>()
  for (const [ino, slot] of inodes) for (const pid of flockHolders(locks, ino)) holders.set(pid, slot)
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter(n => /^\d+$/.test(n))
  for (const n of pids) {
    const pid = Number(n)
    const comm = (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim()
    if (comm !== 'flock') continue
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0').filter(Boolean)
    const parsed = parseFlockArgv(argv)
    if (!parsed) continue
    const slot = [...inodes.entries()].find(([, sl]) => heavyLockPath(sl) === parsed.lock)?.[1]
    if (slot === undefined) continue
    const st = await stat(`/proc/${pid}`).catch(() => null)
    const sinceMs = st ? st.mtimeMs : Date.now()
    if (holders.has(pid)) running.push({ pid, sinceMs, command: parsed.command, slot, usedBytes: await rssOf(pid), manual: true })
    else waiting.push({ pid, sinceMs, command: parsed.command })
  }
  return { running, waiting }
}

/** What is running and waiting right now — dead entries dropped, manual `flock` jobs included. */
export async function readHeavyState(dir = HEAVY_DIR): Promise<HeavyState> {
  const ours = (await readDirJson<HeavyRunning>(join(dir, 'running'))).filter(r => pidAlive(r.pid))
  const manual = await manualJobs()
  // A job run through `agentop heavy` is ALSO a flock holder; keep our richer record, not both.
  const ourPids = new Set(ours.map(r => r.pid))
  const running = [...ours, ...manual.running.filter(r => !ourPids.has(r.pid))]
  for (const r of running) if (r.usedBytes === null || r.usedBytes === undefined) r.usedBytes = await rssOf(r.pid)
  const waiting = [
    ...(await readDirJson<HeavyWaiter>(join(dir, 'waiting'))).filter(w => pidAlive(w.pid)),
    ...manual.waiting,
  ].filter((w, i, all) => all.findIndex(x => x.pid === w.pid) === i)
    .sort((a, b) => a.sinceMs - b.sinceMs || a.pid - b.pid)
  const availableBytes = await memAvailable()
  const runningBytes = running.reduce((n, r) => n + (r.usedBytes ?? 0), 0)
  return { slots: availableBytes === null ? 1 : heavySlots(availableBytes, runningBytes), availableBytes, running, waiting }
}

const GB = 1024 * 1024 * 1024

/**
 * `agentop heavy [--] <cmd…>` — run one heavy job through the slot. Returns the command's exit code.
 * `say` prints the queue state to stderr (stdout belongs to the command).
 */
export async function runHeavy(argv: string[], say: (line: string) => void, dir = HEAVY_DIR): Promise<number> {
  const cmd = argv[0] === '--' ? argv.slice(1) : argv
  if (cmd.length === 0) { say('usage: agentop heavy -- <command> [args…]'); return 2 }
  const flock = Bun.which('flock')
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
  const cleanup = () => { void unlink(waitFile).catch(() => {}); void unlink(runFile).catch(() => {}) }
  process.on('exit', cleanup)
  let lastLine = ''
  try {
    for (;;) {
      const state = await readHeavyState(dir)
      const { position, of } = queuePosition(state.waiting, process.pid, pidAlive)
      if (position <= 1) {
        // At the head: try every slot the machine allows right now.
        for (let slot = 0; slot < state.slots; slot++) {
          const child = Bun.spawn([flock, '-n', '-E', String(FLOCK_BUSY_CODE), heavyLockPath(slot), ...cmd], {
            stdio: ['inherit', 'inherit', 'inherit'],
            env: { ...process.env, AGENTISTICS_HEAVY_JOB: '1' },
          })
          await writeFile(runFile, JSON.stringify({ ...me, pid: child.pid, slot, usedBytes: null }))
          await unlink(waitFile).catch(() => {})
          const code = await child.exited
          if (code !== FLOCK_BUSY_CODE) return code
          // Busy: back in the queue at the same place, and the next slot is tried.
          await unlink(runFile).catch(() => {})
          await writeFile(waitFile, JSON.stringify(me))
        }
      }
      const avail = state.availableBytes === null ? '?' : `${(state.availableBytes / GB).toFixed(1)} GB`
      // Said again only when the QUEUE moves — available memory drifts every tick and is not news.
      const key = `${position}/${of}/${state.running.length}/${state.slots}`
      if (key !== lastLine) {
        lastLine = key
        const holder = state.running[0]
        say(`agentop heavy: waiting — position ${Math.max(1, position)} of ${Math.max(1, of)}, `
          + `${state.running.length} running in ${state.slots} slot(s), ${avail} available`
          + (holder ? ` (running: ${holder.command.slice(0, 60)})` : ''))
      }
      await Bun.sleep(2000)
    }
  } finally {
    cleanup()
  }
}
