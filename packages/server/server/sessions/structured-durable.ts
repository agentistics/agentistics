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
 * GENERATIONS (AGY.MULTICHILD): a driver may end its child and start another on the same transport
 * (Antigravity has no interrupt: a cancel ends the child, the next prompt resumes the conversation in a
 * new one). Each `launch()` is a generation with its own relay and record — generation 0 at the session
 * root (so every directory written before generations is one), generation k in `g<k>/`. A child the
 * driver ended on purpose is marked `killed`; a session whose last child was is alive BETWEEN children.
 * Calls carry the generation they were made on, and a re-attach replays generation after generation.
 *
 * Lines are delivered ONE PER MACROTASK, live and in replay alike: that is what makes a call land
 * between the same two lines in both, and so what makes the replay reproduce the original exactly.
 *
 * Everything lives in `<data dir>/structured/<managed id>/`, 0700, files 0600. It holds the
 * conversation's protocol traffic — the same text the harness's own transcript holds — and no secret
 * (`StructuredSpawn.env` never carries one). It is deleted when the session ends.
 */
import { noteStructuredLine, sessionAccountOf } from '../plan-limits'
import { clearComposing, noteComposingLine } from './structured-composing'
import { spawn as spawnChild } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import path, { join } from 'node:path'
import type { HarnessId, StructuredPipe, StructuredSession, StructuredSpawn, StructuredTransport } from '@agentistics/engine-api'
import { AGENTISTICS_DATA_DIR } from '../config'
import { RELAY_FILES, type RelayLaunchSpec } from './structured-relay'
import {
  isInRecord, isOutRecord, isReplayCall, parseJsonl, writeCheck,
  type InRecord, type OutRecord, type ReplayCall, type SessionCall,
} from './structured-replay'

/** What re-attach needs to start the same driver again. JSON, no secret. */
export interface SavedSpawn {
  v: 1
  harness: HarnessId
  /** Exactly what the driver was given, minus the transport. */
  spawn: Omit<StructuredSpawn, 'transport'>
  /** The bits of the host's `BackendSpawn` the fallback needs (`resumeSpawn`). */
  backend: { id: string; cwd: string; env?: Record<string, string>; unsetEnv?: string[]; structured?: unknown }
}

/** How the relay process is started: a checkout runs the source, a binary runs itself. */
export interface RelayCommand { command: string; args: string[] }

const RELAY_SCRIPT = path.resolve(import.meta.dir, 'structured-relay.ts')

export function relayCommand(): RelayCommand {
  return existsSync(RELAY_SCRIPT)
    ? { command: process.execPath, args: ['run', RELAY_SCRIPT] }
    : { command: process.execPath, args: ['__structured-relay'] }
}

const FILES = { ...RELAY_FILES, saved: 'spawn.json', owner: 'owner.json', calls: 'calls.jsonl', ending: 'ending', killed: 'killed' } as const
const CONNECT_TRIES = 200
const CONNECT_STEP_MS = 25

const immediate = (): Promise<void> => new Promise(r => setImmediate(r))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Does `/proc/<pid>/cmdline` name one of `dirs`? The relay is started as `<runtime> … <generation dir>`,
 * so a live relay carries the directory it records into. `null` = cannot tell (no /proc: not Linux, or
 * the process is gone). A COPY of a store has the same PIDs in the same PID namespace but a different
 * directory, so a PID that does not name this store's directory belongs to another server.
 */
export function cmdlineNames(pid: number, dirs: readonly string[]): boolean | null {
  let raw: string
  try { raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return null }
  const argv = raw.split('\0')
  return dirs.some(d => argv.includes(d))
}

/** A connection to one relay: line-framed JSON both ways, reconnect-free (one attempt sequence). */
function relayConnection(sockPath: string, from: number, on: {
  line(l: string, t: number): void
  exit(code: number | null): void
  replaced(): void
  replayError?(why: string): void
  replayAck?(): void
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
        else if (typeof msg.replayError === 'string') on.replayError?.(msg.replayError)
        else if (msg.replayAck === true) on.replayAck?.()
      }
    })
    s.on('error', () => {})
    s.on('close', () => { if (!replaced && !closed) finish(null) })
    s.write(`${JSON.stringify({ hello: { from } })}\n`)
    flush()
  })()
  return {
    write(w: string, replayAt?: number) { queue.push(`${JSON.stringify({ w, ...(replayAt !== undefined ? { replayAt } : {}) })}\n`); flush() },
    kill() { queue.push(`${JSON.stringify({ k: 1 })}\n`); flush() },
    /** Drop the connection without touching the child (what a dying server does, and the tests). */
    detach() { closed = true; sock?.destroy() },
  }
}

/** A line-paced source: one line per macrotask, counted as it is handed over. */
function pacedLines(clock0?: number) {
  const lines: Array<{ l: string; t: number }> = []
  let wake: (() => void) | null = null
  let done = false
  let delivered = 0
  let clock = clock0 ?? Date.now()
  let closed = false
  return {
    push(l: string, t: number) { lines.push({ l, t }); wake?.(); wake = null },
    end() { done = true; wake?.(); wake = null },
    delivered: () => delivered,
    now: () => clock,
    setClock(t: number) { clock = t },
    /** The reader stopped (it returned, or the source ended): nothing more will be read from it. */
    closed: () => closed,
    async *iterate(before?: () => Promise<void>): AsyncGenerator<string> {
      try {
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
      } finally { closed = true }
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
  /** Managed ids whose relay is alive now, or that are between two children the driver started. */
  alive(): string[]
  isAlive(id: string): boolean
  /** When the child last said something (its record's mtime), ms. */
  lastActivityMs(id: string): number
  /** Ids with a directory whose relay is gone (collected at boot). */
  dead(): string[]
  /** A relay-recorded child exit, distinct from a relay lost in a reboot. */
  endedAt?(id: string): string | null
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
  /** Generation k's directory: 0 is the session root (every pre-generation directory is one), k ≥ 1 is `g<k>/`. */
  const genDir = (id: string, k: number) => (k === 0 ? dirOf(id) : path.join(dirOf(id), `g${k}`))
  const readGen = (id: string, k: number, f: string): string | null => { try { return readFileSync(path.join(genDir(id, k), f), 'utf8') } catch { return null } }
  /** How many generations were launched: 0 … n-1 each have a `launch.json` (written before their relay starts). */
  const generations = (id: string): number => { let n = 0; while (existsSync(path.join(genDir(id, n), FILES.launch))) n++; return n }
  const lastGen = (id: string) => Math.max(0, generations(id) - 1)
  const realRoot = (): string => { try { return realpathSync(root) } catch { return path.resolve(root) } }
  /**
   * STRUCTURED.OWNER: whose record is this? A session directory is stamped at creation with the real
   * path of the store that made it. A record copied to another data dir (`cp -a ~/.agentistics`) keeps the
   * stamp, so it reads FOREIGN there: nothing in it may be signalled, re-attached or reported alive. A
   * record with no stamp predates this guard; it is judged by its relay PID instead (see `relayPid`).
   */
  const foreign = (id: string): boolean => {
    const raw = read(id, FILES.owner)
    if (!raw) return false
    try { const o = (JSON.parse(raw) as { root?: unknown }).root; return typeof o === 'string' && o !== realRoot() } catch { return true }
  }
  const relayPid = (id: string, k: number): number | null => {
    if (foreign(id)) return null
    const raw = readGen(id, k, FILES.pid)
    if (!raw) return null
    let pid: number
    try { const p = (JSON.parse(raw) as { relay?: unknown }).relay; if (typeof p !== 'number') return null; pid = p } catch { return null }
    // A live process must name THIS record's directory (also protects against a recycled PID). Where
    // /proc cannot say, the stamp above is the only guard, and an unstamped legacy record is trusted.
    const dir = genDir(id, k)
    const named = cmdlineNames(pid, [dir, (() => { try { return realpathSync(dir) } catch { return dir } })()])
    return named === false ? null : pid
  }
  const relayLive = (id: string, k: number): boolean => {
    const pid = relayPid(id, k)
    return pid !== null && pidAlive(pid) && readGen(id, k, FILES.exit) === null
  }
  const isAlive = (id: string): boolean => {
    if (foreign(id)) return false
    const k = lastGen(id)
    if (relayLive(id, k)) return true
    // Between children: the driver ended its last child ON PURPOSE (agy's cancel) and starts the next
    // one with the next prompt. No process runs, and the session is alive all the same.
    return readGen(id, k, FILES.exit) !== null && existsSync(path.join(genDir(id, k), FILES.killed)) && read(id, FILES.ending) === null
  }
  const ids = (): string[] => { try { return readdirSync(root).filter(n => existsSync(path.join(root, n, FILES.saved))) } catch { return [] } }

  function recorder(id: string, gen: () => number, delivered: () => number, now: () => number) {
    return (call: SessionCall) => {
      const rec: ReplayCall = { ...call, g: gen(), at: delivered(), t: now() }
      try { appendFileSync(path.join(dirOf(id), FILES.calls), `${JSON.stringify(rec)}\n`, { mode: 0o600 }) } catch { /* the call happened; only a re-attach can miss it, and that is checked */ }
    }
  }

  function startRelay(dir: string, spec: RelayLaunchSpec): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(dir, FILES.launch), JSON.stringify(spec), { mode: 0o600 })
    const child = spawnChild(relay.command, [...relay.args, dir], { detached: true, stdio: 'ignore', cwd: dir })
    child.on('error', () => {})
    child.unref()
  }

  const markKilled = (dir: string) => { try { writeFileSync(path.join(dir, FILES.killed), '', { mode: 0o600 }) } catch { /* not started yet: written when it is */ } }

  /** Refuses what the contract forbids: a second child while the first runs and was not ended by the driver. */
  const mayLaunch = (prev: Generation | undefined) => {
    if (prev && !prev.killed && !prev.ended) throw new Error('a structured driver launched a new child while its previous one runs (it must kill() it first)')
  }

  /**
   * A NEW child: generation k gets its own relay, record and line source. One started right after the
   * driver killed the previous child waits for that child's exit — two children never run on one
   * conversation — and its writes (and a kill) are held until it has started.
   */
  function liveGeneration(id: string, k: number, harness: string, spec: RelayLaunchSpec, prev: Generation | undefined, clock?: number): { gen: Generation; pipe: StructuredPipe } {
    const dir = genDir(id, k)
    const lines = pacedLines(clock)
    let exitResolve!: (c: number | null) => void
    const exited = new Promise<number | null>(r => { exitResolve = r })
    let goneResolve!: () => void
    const gone = new Promise<void>(r => { goneResolve = r })
    let conn: ReturnType<typeof relayConnection> | null = null
    let detached = false
    const held: Array<(c: ReturnType<typeof relayConnection>) => void> = []
    const gen: Generation = {
      lines, killed: false, ended: false, gone, killedByDriver: false,
      detach() { detached = true; conn?.detach() },
    }
    const end = (c: number | null) => { clearComposing(id); gen.ended = true; lines.end(); exitResolve(c); goneResolve() }
    // The account this session runs on (ManagedSession.accountId): looked up once, and only
    // when a rate-limit line actually arrives — no registry read for a session that never says one.
    const accountOf = sessionAccountOf(id)
    const start = () => {
      // The server went away before it started: nothing was launched, nothing is on disk for it.
      if (detached) return
      try { startRelay(dir, spec) } catch { end(null); return }
      if (gen.killed) markKilled(dir)
      conn = relayConnection(path.join(dir, FILES.sock), 0, {
        line: (l, t) => { noteStructuredLine(l, t, accountOf); noteComposingLine(id, harness, l); lines.push(l, t) },
        exit: end,
        // Another server took the child over: this one goes quiet, and must not read the
        // silence as an exit (that would make it fall back and start a second copy).
        replaced: () => {},
      })
      for (const h of held.splice(0)) h(conn)
    }
    if (prev && !prev.ended) void prev.gone.then(start)
    else start()
    return {
      gen,
      pipe: {
        source: { [Symbol.asyncIterator]: () => lines.iterate() },
        write: w => { if (conn) conn.write(w); else held.push(c => c.write(w)) },
        kill: () => {
          gen.killed = true
          gen.killedByDriver = true
          markKilled(dir)
          if (conn) conn.kill(); else held.push(c => c.kill())
        },
        exited,
        now: () => Date.now(),
      },
    }
  }

  const specOf = (bin: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>, unsetEnv?: readonly string[]): RelayLaunchSpec =>
    ({ bin, args: [...args], cwd, ...(env ? { env: { ...env } } : {}), ...(unsetEnv ? { unsetEnv: [...unsetEnv] } : {}) })

  const store: DurableStore = {
    root,
    dirOf,
    endedAt(id) {
      const k = lastGen(id)
      // A child the driver ended on purpose is not the session's end (unless the host is ending it).
      if (existsSync(path.join(genDir(id, k), FILES.killed)) && read(id, FILES.ending) === null) return null
      try {
        const exit = JSON.parse(readGen(id, k, FILES.exit) ?? 'null')
        return typeof exit?.at === 'number' && Number.isFinite(exit.at)
          ? new Date(exit.at).toISOString() : null
      } catch { return null }
    },
    create(id, saved) {
      const dir = dirOf(id)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileSync(path.join(dir, FILES.saved), JSON.stringify(saved), { mode: 0o600 })
      writeFileSync(path.join(dir, FILES.owner), JSON.stringify({ root: realRoot() }), { mode: 0o600 })
      const gens: Generation[] = []
      const cur = () => gens[gens.length - 1]
      const delivered = () => cur()?.lines.delivered() ?? 0
      return {
        delivered,
        record: recorder(id, () => Math.max(0, gens.length - 1), delivered, () => Date.now()),
        // Like a server going away: the child runs on, and THIS side reads nothing more — not even
        // an end, which the driver would take for the child's exit.
        detach: () => { for (const g of gens) g.detach() },
        launch(bin, args, cwd, env): StructuredPipe {
          mayLaunch(cur())
          const { gen, pipe } = liveGeneration(id, gens.length, saved.harness, specOf(bin, args, cwd, env, saved.backend.unsetEnv), cur())
          gens.push(gen)
          return pipe
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
    lastActivityMs(id) {
      for (let k = lastGen(id); k >= 0; k--) { try { return statSync(path.join(genDir(id, k), FILES.out)).mtimeMs } catch { /* none yet */ } }
      return Date.now()
    },
    dead: () => ids().filter(id => !isAlive(id)),
    markEnding(id, why) { try { writeFileSync(path.join(dirOf(id), FILES.ending), why, { mode: 0o600 }) } catch { /* no directory: nothing to end */ } },
    ending: id => read(id, FILES.ending),
    async terminate(id, timeoutMs = 6000) {
      // Every generation's relay, though only the last can still be running: nothing is left behind.
      const pids: number[] = []
      for (let k = 0, n = generations(id); k < n; k++) { const p = relayPid(id, k); if (p !== null && pidAlive(p)) pids.push(p) }
      for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
      const until = Date.now() + timeoutMs
      while (Date.now() < until) { if (pids.every(p => !pidAlive(p))) return true; await sleep(50) }
      return pids.every(p => !pidAlive(p))
    },
    remove(id) { rmSync(dirOf(id), { recursive: true, force: true }) },
    replay(id) {
      const n = generations(id)
      if (n === 0 || !isAlive(id)) return null
      const savedSpawn = (() => { try { return JSON.parse(read(id, FILES.saved) ?? '') as SavedSpawn } catch { return null } })()
      const harness = savedSpawn?.harness ?? ''
      /** What each generation recorded. Only the LAST can still have a running child. */
      const recs = Array.from({ length: n }, (_, k) => {
        const exit = (() => { try { const e = JSON.parse(readGen(id, k, FILES.exit) ?? 'null') as { code?: unknown } | null; return e ? { code: typeof e.code === 'number' ? e.code : null } : null } catch { return null } })()
        return {
          out: parseJsonl<OutRecord>(readGen(id, k, FILES.out) ?? '', isOutRecord),
          check: writeCheck(parseJsonl<InRecord>(readGen(id, k, FILES.in) ?? '', isInRecord)),
          launch: (() => { try { return JSON.parse(readGen(id, k, FILES.launch) ?? '') as RelayLaunchSpec } catch { return null } })(),
          exit,
          killed: existsSync(path.join(genDir(id, k), FILES.killed)),
          live: k === n - 1 && relayLive(id, k),
          // Old relays may survive an upgrade; do not send an extension they would silently ignore.
          replayOffsets: (() => { try { return JSON.parse(readGen(id, k, FILES.pid) ?? '{}').replayOffsets === true } catch { return false } })(),
        }
      })
      const calls = parseJsonl<ReplayCall>(read(id, FILES.calls) ?? '', isReplayCall)
      const lastG = Math.max(n - 1, ...calls.map(genOf))
      let session: StructuredSession | null = null
      let bound: () => void = () => {}
      const sessionReady = new Promise<void>(r => { bound = r })
      let doneResolve!: (v: { ok: true } | { ok: false; why: string }) => void
      const done = new Promise<{ ok: true } | { ok: false; why: string }>(r => { doneResolve = r })
      let failed = false
      const fail = (why: string) => { if (failed) return; failed = true; doneResolve({ ok: false, why }) }
      let replaying = true
      /** The time of the call being replayed: a child launched BY that call reads it as its clock. */
      let callClock: number | undefined
      /** The generations the re-created driver launched, in order, and how each one's exit is handed over. */
      const launched: Array<Generation & { resolveExit?: (c: number | null) => void }> = []
      // The live generation's connection state (the last one, when its child still runs).
      let pendingWrites = 0
      let afterReplay: () => void = () => {}

      const apply = async (c: ReplayCall): Promise<void> => {
        await Promise.race([sessionReady, sleep(5000)])
        if (!session) { fail('the session was not ready for a recorded call'); return }
        callClock = c.t
        launched[launched.length - 1]?.lines.setClock(c.t)
        if (c.op === 'prompt') session.prompt(c.text)
        else if (c.op === 'answer') session.answer({ ...(c.choice !== undefined ? { choice: c.choice } : {}), ...(c.text !== undefined ? { text: c.text } : {}), ...(c.requestId !== undefined ? { requestId: c.requestId } : {}) })
        // Not awaited: its answer is a recorded line still to be replayed after this call.
        else if (c.op === 'setMode') void session.setMode?.(c.id)
        else if (c.op === 'setModel') void session.setModel?.(c.id)
        else session.cancel()
      }

      const before = async (): Promise<void> => {
        for (let g = 0; g <= lastG; g++) {
          const mine = calls.filter(c => genOf(c) === g)
          let applied = 0
          const applyAt = async (k: number) => { for (const c of mine) if (c.at === k) { applied++; await apply(c); await immediate() } }
          // Generation 0 is running when the replay starts; a later one is launched BY one of the calls
          // made with nothing yet read from it (the prompt after a cancel), so those come first.
          if (g === 0) await immediate()
          await applyAt(0)
          if (failed) return
          const gen = launched[g]
          if (g >= n) continue // past the record: launched live, nothing to replay
          if (!gen) { fail(`the re-created driver did not start child ${g + 1} where the original did`); return }
          const out = recs[g]!.out
          // The recorded lines, each followed by the calls made right after it was read. A driver that
          // stops reading a child it replaced closes its source — exactly where it did the first time.
          for (let k = 0; k < out.length && !gen.lines.closed(); k++) {
            gen.lines.push(out[k]!.l, out[k]!.t)
            // Hand the line over and let the driver finish with it before the next call or line.
            await immediate()
            while (gen.lines.delivered() < k + 1 && !gen.lines.closed() && !failed) await immediate()
            await immediate()
            await applyAt(k + 1)
            if (failed) return
          }
          if (applied < mine.length) { fail(`a call recorded on child ${g + 1} was made after lines the re-created driver never read`); return }
          // A child that is gone ends here, with its recorded code: the driver sees it as it did first.
          if (!recs[g]!.live) { gen.lines.end(); gen.resolveExit?.(recs[g]!.exit?.code ?? null) }
        }
        await immediate()
        await immediate()
        // A relay acknowledgement is the delivery check for writes beyond our stale snapshot.
        const deadline = Date.now() + 5000
        while (pendingWrites > 0 && !failed && Date.now() < deadline) await sleep(5)
        if (failed) return
        if (pendingWrites > 0) { fail('the relay did not acknowledge replayed input'); return }
        replaying = false
        for (let k = 0; k < n; k++) {
          const r = recs[k]!
          if (!r.check.complete()) { fail(`the re-created driver wrote ${r.check.remaining()} fewer bytes than the original${n > 1 ? ` to child ${k + 1}` : ''}`); return }
          // The children the original ended on purpose, and only those (a kill is a write too).
          if (r.killed !== (launched[k]?.killedByDriver ?? false) && !(r.live && !r.killed)) { fail(`the re-created driver ${r.killed ? 'did not end' : 'ended'} child ${k + 1} unlike the original`); return }
        }
        doneResolve({ ok: true })
        afterReplay()
      }

      const replayGeneration = (k: number, spec: RelayLaunchSpec): { gen: Generation & { resolveExit?: (c: number | null) => void }; pipe: StructuredPipe } => {
        const r = recs[k]!
        const same = r.launch && r.launch.bin === spec.bin && r.launch.cwd === spec.cwd && JSON.stringify(r.launch.args) === JSON.stringify(spec.args)
          && JSON.stringify(r.launch.env ?? {}) === JSON.stringify(spec.env ?? {})
        // The same child, or the replay is not of this session.
        if (!same) fail(`the re-created driver launched a different command${n > 1 ? ` for child ${k + 1}` : ''}`)
        const lines = pacedLines(callClock)
        let exitResolve!: (c: number | null) => void
        const exited = new Promise<number | null>(res => { exitResolve = res })
        let goneResolve!: () => void
        const gone = new Promise<void>(res => { goneResolve = res })
        let conn: ReturnType<typeof relayConnection> | null = null
        const gen: Generation & { resolveExit?: (c: number | null) => void } = {
          lines, killed: r.killed, ended: !r.live, gone, killedByDriver: false,
          detach() { conn?.detach() },
        }
        if (!r.live) {
          goneResolve()
          gen.resolveExit = exitResolve
        } else {
          // Live output that arrives while the record is being replayed waits behind it.
          const pendingLive: Array<{ l: string; t: number }> = []
          let exitedEarly = false
          let exitCode: number | null = null
          const accountOf = sessionAccountOf(id)
          afterReplay = () => {
            for (const p of pendingLive.splice(0)) lines.push(p.l, p.t)
            if (exitedEarly) { lines.end(); exitResolve(exitCode) }
          }
          conn = relayConnection(path.join(genDir(id, k), FILES.sock), r.out.length, {
            line: (l, ts) => { noteStructuredLine(l, ts, accountOf); noteComposingLine(id, harness, l); if (replaying) pendingLive.push({ l, t: ts }); else lines.push(l, ts) },
            exit: c => {
              clearComposing(id)
              gen.ended = true
              goneResolve()
              // Held until the record is replayed: the driver must see the session as it was first.
              if (replaying) { exitedEarly = true; exitCode = c; return }
              lines.end(); exitResolve(c)
            },
            replaced: () => {},
            replayError: fail,
            replayAck: () => { pendingWrites-- },
          })
        }
        let writeOffset = 0
        const iterate = k === 0 ? lines.iterate(async () => { if (!failed) void before() }) : lines.iterate()
        return { gen, pipe: {
          source: { [Symbol.asyncIterator]: () => iterate },
          write(w) {
            const at = writeOffset
            writeOffset += w.length
            const res = r.check.take(w)
            if (res === 'diverged') fail('the re-created driver wrote something the original did not')
            else if (res === 'live' && !failed && conn) {
              // The original writer may have reached the relay AFTER our file snapshot. Check
              // the offset there, atomically with delivery, rather than re-send those bytes.
              if (replaying && !r.replayOffsets) { fail('the surviving relay cannot verify late replay input'); return }
              if (replaying) pendingWrites++
              conn.write(w, replaying ? at : undefined)
            }
            // A write past the record of a child that is gone reached nobody the first time either.
          },
          kill: () => {
            gen.killedByDriver = true
            if (!conn) return // that child is gone: the original's kill already ended it
            gen.killed = true
            markKilled(genDir(id, k))
            conn.kill()
          },
          exited,
          now: () => (replaying ? lines.now() : Date.now()),
        } }
      }

      const t: ReplayTransport = {
        delivered: () => launched[launched.length - 1]?.lines.delivered() ?? 0,
        record: recorder(id, () => Math.max(0, launched.length - 1), () => launched[launched.length - 1]?.lines.delivered() ?? 0, () => Date.now()),
        detach: () => { for (const g of launched) g.detach() },
        bind(s) { session = s; bound() },
        done,
        launch(bin, args, cwd, env): StructuredPipe {
          const k = launched.length
          const spec = specOf(bin, args, cwd, env, savedSpawn?.backend?.unsetEnv)
          if (k < n) {
            const { gen, pipe } = replayGeneration(k, spec)
            launched.push(gen)
            return pipe
          }
          // Past the record: a NEW child (the session was between children, or the server died after
          // the call that launched it and before its relay started) — live, exactly as `create` does.
          mayLaunch(launched[k - 1])
          const { gen, pipe } = liveGeneration(id, k, harness, spec, launched[k - 1], callClock)
          launched.push(gen)
          return pipe
        },
      }
      return t
    },
  }
  return store
}

/** One child of a session, as the transport holds it. */
interface Generation {
  lines: ReturnType<typeof pacedLines>
  /** The driver ended it on purpose (`pipe.kill()`), now or in the record. */
  killed: boolean
  /** The re-created driver's own kill (replay checks it against the record). */
  killedByDriver: boolean
  /** Its child has exited (or, in a replay, was already gone). */
  ended: boolean
  /** Settles once its child is gone: the next child starts only then. */
  gone: Promise<void>
  detach(): void
}

/** The generation a recorded call was made on (calls recorded before generations carry none: 0). */
const genOf = (c: ReplayCall): number => c.g ?? 0
