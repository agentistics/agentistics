/**
 * structured-durable.ts — F2.0b: a structured session that SURVIVES the server (IO).
 *
 * Every tmux session already outlives `agentop server` (the unit's `KillMode=process`): the pane
 * belongs to the tmux server, not to us. A structured session's child belonged to us — its stdio were
 * our pipes — so it died with every restart and its row went `lost`. This module gives it the same
 * property, for every driver alike, through `StructuredSpawn.transport` (engine-api 1.10):
 *
 * - LAUNCH: the driver's child is started by a detached RELAY (`structured-relay.ts`) that owns its
 *   stdio and records both directions to disk; the server speaks to the relay over a unix socket.
 *   When the server goes away the child keeps running and its output keeps being recorded.
 * - RECORD: every call the host makes on the session (prompt / answer / cancel) is appended to
 *   `calls.jsonl` with the number of lines the driver had read when it was made.
 * - RE-ATTACH (`replay`): a fresh driver is started for the SAME request over a pipe that replays the
 *   recorded lines and calls in order and checks every write against what the relay delivered
 *   (`structured-replay.ts`), then continues live from where the record ends. No event is lost (the
 *   relay wrote it down) and none is duplicated (the replay emits to nobody: the composite registers
 *   the session only once the replay is done).
 *
 * Lines are delivered ONE PER MACROTASK, live and in replay alike: that is what makes a call land
 * between the same two lines in both, and so what makes the replay reproduce the original exactly.
 *
 * Everything lives in `<data dir>/structured/<managed id>/`, 0700, files 0600. It holds the
 * conversation's protocol traffic — the same text the harness's own transcript holds — and no secret
 * (`StructuredSpawn.env` never carries one). It is deleted when the session ends.
 */
import { noteStructuredLine } from '../plan-limits'
import { clearComposing, noteComposingLine } from './structured-composing'
import { spawn as spawnChild } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import path, { join } from 'node:path'
import type { HarnessId, StructuredPipe, StructuredSession, StructuredSpawn, StructuredTransport } from '@agentistics/engine-api'
import { AGENTISTICS_DATA_DIR } from '../config'
import { RELAY_FILES, type RelayLaunchSpec } from './structured-relay'
import {
  callsAt, isInRecord, isOutRecord, isReplayCall, parseJsonl, writeCheck,
  type InRecord, type OutRecord, type ReplayCall, type SessionCall,
} from './structured-replay'

/** What re-attach needs to start the same driver again. JSON, no secret. */
export interface SavedSpawn {
  v: 1
  harness: HarnessId
  /** Exactly what the driver was given, minus the transport. */
  spawn: Omit<StructuredSpawn, 'transport'>
  /** The bits of the host's `BackendSpawn` the fallback needs (`resumeSpawn`). */
  backend: { id: string; cwd: string; env?: Record<string, string>; structured?: unknown }
}

/** How the relay process is started: a checkout runs the source, a binary runs itself. */
export interface RelayCommand { command: string; args: string[] }

const RELAY_SCRIPT = path.resolve(import.meta.dir, 'structured-relay.ts')

export function relayCommand(): RelayCommand {
  return existsSync(RELAY_SCRIPT)
    ? { command: process.execPath, args: ['run', RELAY_SCRIPT] }
    : { command: process.execPath, args: ['__structured-relay'] }
}

const FILES = { ...RELAY_FILES, saved: 'spawn.json', calls: 'calls.jsonl', ending: 'ending' } as const
const CONNECT_TRIES = 200
const CONNECT_STEP_MS = 25

const immediate = (): Promise<void> => new Promise(r => setImmediate(r))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/** A connection to one relay: line-framed JSON both ways, reconnect-free (one attempt sequence). */
function relayConnection(sockPath: string, from: number, on: {
  line(l: string, t: number): void
  exit(code: number | null): void
  replaced(): void
}) {
  let sock: Socket | null = null
  let closed = false
  const queue: string[] = []
  let ended = false
  const finish = (code: number | null) => { if (ended) return; ended = true; on.exit(code) }
  const flush = () => { while (sock && !sock.destroyed && queue.length) sock.write(queue.shift()!) }
  ;(async () => {
    for (let i = 0; i < CONNECT_TRIES && !closed; i++) {
      // Not there yet (the relay is starting): wait, rather than ask the kernel and handle an error.
      const ok = existsSync(sockPath) && await new Promise<boolean>(resolve => {
        try {
          const s = createConnection({ path: sockPath })
          s.on('error', () => { s.destroy(); resolve(false) })
          s.once('connect', () => { sock = s; resolve(true) })
        } catch { resolve(false) }
      })
      if (ok) break
      await sleep(CONNECT_STEP_MS)
    }
    if (!sock || closed) { if (!closed) finish(null); return }
    const s: Socket = sock
    s.setEncoding('utf8')
    let buf = ''
    let replaced = false
    s.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const raw = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: Record<string, unknown>
        try { msg = JSON.parse(raw) as Record<string, unknown> } catch { continue }
        if (typeof msg.o === 'string') on.line(msg.o, typeof msg.t === 'number' ? msg.t : Date.now())
        else if ('x' in msg) finish(typeof msg.x === 'number' ? msg.x : null)
        else if (msg.bye === 'replaced') { replaced = true; on.replaced() }
      }
    })
    s.on('error', () => {})
    s.on('close', () => { if (!replaced && !closed) finish(null) })
    s.write(`${JSON.stringify({ hello: { from } })}\n`)
    flush()
  })()
  return {
    write(w: string) { queue.push(`${JSON.stringify({ w })}\n`); flush() },
    kill() { queue.push(`${JSON.stringify({ k: 1 })}\n`); flush() },
    /** Drop the connection without touching the child (what a dying server does, and the tests). */
    detach() { closed = true; sock?.destroy() },
  }
}

/** A line-paced source: one line per macrotask, counted as it is handed over. */
function pacedLines() {
  const lines: Array<{ l: string; t: number }> = []
  let wake: (() => void) | null = null
  let done = false
  let delivered = 0
  let clock = Date.now()
  return {
    push(l: string, t: number) { lines.push({ l, t }); wake?.(); wake = null },
    end() { done = true; wake?.(); wake = null },
    delivered: () => delivered,
    now: () => clock,
    setClock(t: number) { clock = t },
    async *iterate(before?: () => Promise<void>): AsyncGenerator<string> {
      if (before) await before()
      for (;;) {
        while (lines.length === 0 && !done) await new Promise<void>(r => { wake = r })
        if (lines.length === 0) return
        await immediate()
        const next = lines.shift()!
        delivered++
        clock = next.t
        yield `${next.l}\n`
      }
    },
  }
}

export interface DurableTransport extends StructuredTransport {
  /** Lines the driver has read so far (stamps a recorded call). */
  delivered(): number
  /** Record a call the host made on the session (sync: before any of its writes leave). */
  record(call: SessionCall): void
  /** Drop the relay connection, leaving the child running (a server going away; tests). */
  detach(): void
}

export interface ReplayTransport extends DurableTransport {
  /** Hand the re-created session over, so the recorded calls can be made on it. */
  bind(s: StructuredSession): void
  /** Settles once every recorded line and call has been replayed: faithful, or why not. */
  done: Promise<{ ok: true } | { ok: false; why: string }>
}

export interface DurableStore {
  root: string
  dirOf(id: string): string
  /** A new durable session: writes `spawn.json`, returns the transport the driver launches through. */
  create(id: string, saved: SavedSpawn): DurableTransport
  saved(id: string): SavedSpawn | null
  /** Managed ids whose relay is alive now. */
  alive(): string[]
  isAlive(id: string): boolean
  /** When the child last said something (its record's mtime), ms. */
  lastActivityMs(id: string): number
  /** Ids with a directory whose relay is gone (collected at boot). */
  dead(): string[]
  /** Say WHY the child is about to end, so its exit is not read as a failure to fall back from. */
  markEnding(id: string, why: string): void
  ending(id: string): string | null
  /** End the child through its relay (a TERM to the relay), and wait until it is gone. */
  terminate(id: string, timeoutMs?: number): Promise<boolean>
  remove(id: string): void
  /** Re-attach: a transport that replays this session's record, then continues live. */
  replay(id: string): ReplayTransport | null
}

/** `<data dir>/structured` — one directory per structured session whose child a relay holds. */
export const STRUCTURED_DIR = join(AGENTISTICS_DATA_DIR, 'structured')

export function defaultDurableStore(): DurableStore { return durableStore(STRUCTURED_DIR) }

export function durableStore(root: string, relay: RelayCommand = relayCommand()): DurableStore {
  const dirOf = (id: string) => path.join(root, id.replace(/[^A-Za-z0-9._-]/g, '_'))
  const read = (id: string, f: string): string | null => { try { return readFileSync(path.join(dirOf(id), f), 'utf8') } catch { return null } }
  const relayPid = (id: string): number | null => {
    const raw = read(id, FILES.pid)
    if (!raw) return null
    try { const p = (JSON.parse(raw) as { relay?: unknown }).relay; return typeof p === 'number' ? p : null } catch { return null }
  }
  const isAlive = (id: string): boolean => {
    const pid = relayPid(id)
    return pid !== null && pidAlive(pid) && read(id, FILES.exit) === null
  }
  const ids = (): string[] => { try { return readdirSync(root).filter(n => existsSync(path.join(root, n, FILES.saved))) } catch { return [] } }

  function recorder(id: string, delivered: () => number, now: () => number) {
    return (call: SessionCall) => {
      const rec: ReplayCall = { ...call, at: delivered(), t: now() }
      try { appendFileSync(path.join(dirOf(id), FILES.calls), `${JSON.stringify(rec)}\n`, { mode: 0o600 }) } catch { /* the call happened; only a re-attach can miss it, and that is checked */ }
    }
  }

  function startRelay(id: string, spec: RelayLaunchSpec): void {
    const dir = dirOf(id)
    writeFileSync(path.join(dir, FILES.launch), JSON.stringify(spec), { mode: 0o600 })
    const child = spawnChild(relay.command, [...relay.args, dir], { detached: true, stdio: 'ignore', cwd: dir })
    child.on('error', () => {})
    child.unref()
  }

  const store: DurableStore = {
    root,
    dirOf,
    create(id, saved) {
      const dir = dirOf(id)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, FILES.saved), JSON.stringify(saved), { mode: 0o600 })
      const lines = pacedLines()
      let conn: ReturnType<typeof relayConnection> | null = null
      return {
        delivered: lines.delivered,
        record: recorder(id, lines.delivered, () => Date.now()),
        // Like a server going away: the child runs on, and THIS side reads nothing more — not even
        // an end, which the driver would take for the child's exit.
        detach: () => { conn?.detach() },
        launch(bin, args, cwd, env): StructuredPipe {
          let exitResolve!: (c: number | null) => void
          const exited = new Promise<number | null>(r => { exitResolve = r })
          try { startRelay(id, { bin, args: [...args], cwd, ...(env ? { env: { ...env } } : {}) }) } catch { exitResolve(null); lines.end() }
          conn = relayConnection(path.join(dir, FILES.sock), 0, {
            line: (l, t) => { noteStructuredLine(l, t); noteComposingLine(id, saved.harness, l); lines.push(l, t) },
            exit: c => { clearComposing(id); lines.end(); exitResolve(c) },
            // Another server took the child over: this one goes quiet, and must not read the
            // silence as an exit (that would make it fall back and start a second copy).
            replaced: () => {},
          })
          return {
            source: { [Symbol.asyncIterator]: () => lines.iterate() },
            write: w => conn?.write(w),
            kill: () => conn?.kill(),
            exited,
            now: () => Date.now(),
          }
        },
      }
    },
    saved(id) {
      const raw = read(id, FILES.saved)
      if (!raw) return null
      try { const s = JSON.parse(raw) as SavedSpawn; return s && s.v === 1 ? s : null } catch { return null }
    },
    alive: () => ids().filter(isAlive),
    isAlive,
    lastActivityMs(id) { try { return statSync(path.join(dirOf(id), FILES.out)).mtimeMs } catch { return Date.now() } },
    dead: () => ids().filter(id => !isAlive(id)),
    markEnding(id, why) { try { writeFileSync(path.join(dirOf(id), FILES.ending), why, { mode: 0o600 }) } catch { /* no directory: nothing to end */ } },
    ending: id => read(id, FILES.ending),
    async terminate(id, timeoutMs = 6000) {
      const pid = relayPid(id)
      if (pid === null || !pidAlive(pid)) return true
      try { process.kill(pid, 'SIGTERM') } catch { return !pidAlive(pid) }
      const until = Date.now() + timeoutMs
      while (Date.now() < until) { if (!pidAlive(pid)) return true; await sleep(50) }
      return !pidAlive(pid)
    },
    remove(id) { rmSync(dirOf(id), { recursive: true, force: true }) },
    replay(id) {
      const dir = dirOf(id)
      if (!isAlive(id)) return null
      const out = parseJsonl<OutRecord>(read(id, FILES.out) ?? '', isOutRecord)
      const delivered = parseJsonl<InRecord>(read(id, FILES.in) ?? '', isInRecord)
      const calls = parseJsonl<ReplayCall>(read(id, FILES.calls) ?? '', isReplayCall)
      const check = writeCheck(delivered)
      const lines = pacedLines()
      let session: StructuredSession | null = null
      let bound: () => void = () => {}
      const sessionReady = new Promise<void>(r => { bound = r })
      let doneResolve!: (v: { ok: true } | { ok: false; why: string }) => void
      const done = new Promise<{ ok: true } | { ok: false; why: string }>(r => { doneResolve = r })
      let failed = false
      const fail = (why: string) => { if (failed) return; failed = true; doneResolve({ ok: false, why }) }
      let conn: ReturnType<typeof relayConnection> | null = null
      // Live output that arrives while the record is being replayed waits behind it.
      const pendingLive: Array<{ l: string; t: number }> = []
      let replaying = true
      let exitedEarly = false
      let exitCode: number | null = null

      const apply = async (c: ReplayCall): Promise<void> => {
        await Promise.race([sessionReady, sleep(5000)])
        if (!session) { fail('the session was not ready for a recorded call'); return }
        lines.setClock(c.t)
        if (c.op === 'prompt') session.prompt(c.text)
        else if (c.op === 'answer') session.answer({ ...(c.choice !== undefined ? { choice: c.choice } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.requestId !== undefined ? { requestId: c.requestId } : {}) })
        else session.cancel()
      }

      const before = async (): Promise<void> => {
        // The recorded lines, each followed by the calls made right after it was read.
        for (const c of callsAt(calls, 0)) { await immediate(); await apply(c) }
        for (let k = 0; k < out.length; k++) {
          lines.push(out[k]!.l, out[k]!.t)
          // Hand the line over and let the driver finish with it before the next call or line.
          await immediate()
          while (lines.delivered() < k + 1 && !failed) await immediate()
          await immediate()
          for (const c of callsAt(calls, k + 1)) { await apply(c); await immediate() }
          if (failed) return
        }
        await immediate()
        await immediate()
        replaying = false
        if (!check.complete()) { fail(`the re-created driver wrote ${check.remaining()} fewer bytes than the original`); return }
        for (const p of pendingLive.splice(0)) lines.push(p.l, p.t)
        doneResolve({ ok: true })
        if (exitedEarly) { lines.end(); exitResolve(exitCode) }
      }

      let exitResolve!: (c: number | null) => void
      const exited = new Promise<number | null>(r => { exitResolve = r })
      const t: ReplayTransport = {
        delivered: lines.delivered,
        record: recorder(id, lines.delivered, () => Date.now()),
        detach: () => { conn?.detach() },
        bind(s) { session = s; bound() },
        done,
        launch(bin, args, cwd, env): StructuredPipe {
          // The same child, or the replay is not of this session.
          const replayHarness = (() => { try { return (JSON.parse(read(id, FILES.saved) ?? '') as SavedSpawn).harness } catch { return '' } })()
          const was = (() => { try { return JSON.parse(read(id, FILES.launch) ?? '') as RelayLaunchSpec } catch { return null } })()
          const same = was && was.bin === bin && was.cwd === cwd && JSON.stringify(was.args) === JSON.stringify([...args])
            && JSON.stringify(was.env ?? {}) === JSON.stringify(env ?? {})
          if (!same) fail('the re-created driver launched a different command')
          conn = relayConnection(path.join(dir, FILES.sock), out.length, {
            line: (l, ts) => { noteStructuredLine(l, ts); noteComposingLine(id, replayHarness, l); if (replaying) pendingLive.push({ l, t: ts }); else lines.push(l, ts) },
            exit: c => {
              clearComposing(id)
              // Held until the record is replayed: the driver must see the session as it was first.
              if (replaying) { exitedEarly = true; exitCode = c; return }
              lines.end(); exitResolve(c)
            },
            replaced: () => {},
          })
          const iterate = lines.iterate(async () => { if (!failed) void before() })
          return {
            source: { [Symbol.asyncIterator]: () => iterate },
            write(w) {
              const r = check.take(w)
              if (r === 'diverged') fail('the re-created driver wrote something the original did not')
              else if (r === 'live' && !failed) conn?.write(w)
            },
            kill: () => conn?.kill(),
            exited,
            now: () => (replaying ? lines.now() : Date.now()),
          }
        },
      }
      return t
    },
  }
  return store
}
