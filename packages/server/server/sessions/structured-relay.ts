/**
 * structured-relay.ts — F2.0b: the process that HOLDS a structured session's child, so the session
 * survives `agentop server` restarting (IO; the relay's own entry point).
 *
 * A structured driver speaks to its harness over the child's stdin/stdout. Spawned by the server, those
 * pipes die with the server and the child with them — while every tmux session survives a restart
 * (the unit's `KillMode=process`). So the child is spawned by THIS process instead, started DETACHED
 * (its own session, `setsid`) by the server, and the server talks to it over a unix socket:
 *
 * - every complete stdout line is appended to `out.jsonl` (`{t, l}`) BEFORE it is forwarded, so a line
 *   the server was not there to read is never lost — it is read back from the file on re-attach;
 * - every write the server sends is written to the child and appended to `in.jsonl` (`{t, w}`), which
 *   is what the server's REPLAY checks the re-created driver's writes against (`structured-replay.ts`);
 * - ONE client at a time: a newer connection replaces the older one (`{bye: 'replaced'}`), so two
 *   servers can never both drive one child;
 * - the child's exit is written to `exit.json` and sent (`{x: code}`), then the relay exits.
 *
 * Socket protocol, one JSON value per line. Client → relay: `{hello: {from: n}}` (send the stdout
 * records from index n, then follow), `{w: string, replayAt?: number}` (write, or verify an input
 * offset during recovery), `{k: 1}` (end the child).
 * Relay → client: `{o: line, t: ms}`, `{x: code|null}`, `{bye: 'replaced'}`, `{replayError: reason}`, `{replayAck: true}`.
 *
 * Dependency-free on purpose (node built-ins only): it runs as its own process, from a checkout
 * (`bun run <this file> <dir>`) or from the binary (`agentop __structured-relay <dir>`).
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { IdleSwap, JsonWorker, executableVersion, runningExecutableVersion, helperCommand, swapLog } from '../helper-hotswap'
import type { RelayDecision } from './relay-worker'

export const RELAY_FILES = {
  launch: 'launch.json',
  out: 'out.jsonl',
  in: 'in.jsonl',
  pid: 'relay.pid',
  exit: 'exit.json',
  sock: 'relay.sock',
} as const

export interface RelayLaunchSpec {
  bin: string
  args: string[]
  cwd: string
  env?: Record<string, string>
}

const KILL_GRACE_MS = 3000
export const RELAY_DRAIN_GRACE_MS = 1000

/** TERM must finish even when an escaped descendant holds stdout open forever. */
export function drainTerminatedRelay(end: number, d: {
  now(): number
  groupAlive(): boolean
  stdoutClosed(): boolean
  kill(): void
  finish(): void
  exit(): void
  schedule(tick: () => void, ms: number): void
}): void {
  const tick = (): void => {
    const now = d.now()
    if (!d.groupAlive() && d.stdoutClosed()) { d.exit(); return }
    if (now >= end) {
      d.kill()
      if (d.stdoutClosed() || now >= end + RELAY_DRAIN_GRACE_MS) {
        d.finish()
        d.exit()
        return
      }
    }
    d.schedule(tick, 50)
  }
  tick()
}

export function runRelay(dir: string, pollMs = 5000): void {
  const spec = JSON.parse(readFileSync(join(dir, RELAY_FILES.launch), 'utf8')) as RelayLaunchSpec
  const outPath = join(dir, RELAY_FILES.out)
  const inPath = join(dir, RELAY_FILES.in)
  const sockPath = join(dir, RELAY_FILES.sock)
  if (!existsSync(outPath)) writeFileSync(outPath, '', { mode: 0o600 })
  if (!existsSync(inPath)) writeFileSync(inPath, '', { mode: 0o600 })

  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) extra[k] = v
  // `node:child_process`, not `Bun.spawn`: piped stdin delivered nothing to these CLIs under Bun's own
  // spawn (the engine's acp/launch.ts records the 2026-10-02 probe). stderr is discarded — it can carry
  // conversation text and nothing reads it.
  // The ACP CLI may fork helpers of its own. Keeping the child in a detached process group lets the
  // relay terminate the whole tree, rather than leaving a helper behind when the CLI ignores TERM.
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...extra } })

  const makeWorker = (): JsonWorker => {
    const worker = new JsonWorker(helperCommand('__relay-worker'))
    worker.onerror = error => {
      if (worker !== swap.current) return
      swapLog(error)
      void swap.recover()
    }
    return worker
  }
  const firstWorker = makeWorker()
  const swap = new IdleSwap(firstWorker, runningExecutableVersion(), {
    version: executableVersion,
    prepare: async () => {
      const worker = makeWorker()
      try {
        const response = await worker.request('ready')
        if (response.error || response.result !== true) throw new Error('relay worker not ready')
        return worker
      } catch (error) { worker.close(); throw error }
    },
    close: worker => worker.close(), usable: worker => worker.healthy, log: swapLog,
  })
  const swapTimer = setInterval(() => { void swap.check() }, pollMs)
  process.on('exit', () => { clearInterval(swapTimer); swap.close() })
  // Serialize protocol decisions through their effects. The worker cannot change while an input
  // write/replay is in flight; journal writes remain with the keeper and happen exactly once.
  let queue = Promise.resolve()
  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch(error => { swapLog(error); send(writer, { replayError: 'relay decision failed; retry the request' }) })
  }
  let replayOutput: unknown[] | null = null
  let client: Socket | null = null
  let writer: Socket | null = null
  const send = (s: Socket | null, msg: unknown): void => { if (s && !s.destroyed) s.write(`${JSON.stringify(msg)}\n`) }

  let partial = ''
  const record = (line: string): void => {
    const t = Date.now()
    appendFileSync(outPath, `${JSON.stringify({ t, l: line })}\n`)
    const message = { o: line, t }
    send(client, message)
    replayOutput?.push(message)
  }
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    partial += chunk
    let nl: number
    while ((nl = partial.indexOf('\n')) !== -1) {
      record(partial.slice(0, nl))
      partial = partial.slice(nl + 1)
    }
  })
  child.stdin!.on('error', () => { /* the child closed its stdin: its exit says the rest */ })

  let ended = false
  let killTimer: ReturnType<typeof setTimeout> | null = null
  let termAt = 0
  let stdoutClosed = false
  let childExited = false
  const finishOutput = (force = false): void => {
    if (ended || (!force && (!stdoutClosed || !childExited))) return
    if (partial !== '') { record(partial); partial = '' }
    ended = true
    writeFileSync(join(dir, RELAY_FILES.exit), JSON.stringify({ code: child.exitCode, at: Date.now() }), { mode: 0o600 })
    send(client, { x: child.exitCode })
    client?.end()
    server.close()
    try { unlinkSync(sockPath) } catch { /* already gone */ }
    // A child may exit while hello is awaiting its worker. Let that replay send its buffered tail
    // and exit record before leaving; the former synchronous replay could not hit this race.
    if (!termAt) void queue.finally(() => { setTimeout(() => process.exit(0), 200).unref?.() })
  }
  child.stdout!.on('close', () => { stdoutClosed = true; finishOutput() })

  const killChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    const pid = child.pid
    if (pid === undefined) return
    try { process.kill(-pid, signal) } catch { try { child.kill(signal) } catch { /* already dead */ } }
  }
  /** Is anything left in the child's process group (it was started detached: its pid is the pgid)? */
  const groupAlive = (): boolean => {
    const pid = child.pid
    if (pid === undefined) return false
    try { process.kill(-pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
  }
  let draining = false
  const startTermDrain = (): void => {
    if (draining) return
    draining = true
    drainTerminatedRelay(termAt + KILL_GRACE_MS + 50, {
      now: () => Date.now(), groupAlive, stdoutClosed: () => stdoutClosed,
      kill: () => killChild('SIGKILL'), finish: () => finishOutput(true),
      exit: () => { process.exit(0) }, schedule: (tick, ms) => { setTimeout(tick, ms) },
    })
  }
  const endChild = (): void => {
    // A SIGTERM can arrive after the child exit event has already marked the relay ended. The relay
    // itself still owns a listening socket, so explicitly leave too; otherwise it survives until SIGKILL.
    if (ended) { process.exit(0); return }
    termAt ||= Date.now()
    if (childExited) { startTermDrain(); return }
    killChild('SIGTERM')
    killTimer ??= setTimeout(() => { if (child.exitCode === null) killChild('SIGKILL') }, KILL_GRACE_MS)
  }

  const server = createServer(sock => {
    // A previous hello may still be waiting for its worker; it owns a socket even before `client`.
    if (writer && writer !== client && !writer.destroyed) { send(writer, { bye: 'replaced' }); writer.end() }
    if (client && !client.destroyed) { send(client, { bye: 'replaced' }); client.end() }
    client = null
    writer = sock
    let buf = ''
    let hello = false
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
        enqueue(async () => {
          // A replaced client's buffered input must not race the new driver's replay.
          if (writer !== sock) return
          if (msg.k) { endChild(); return }
          const isHello = !hello && msg.hello && typeof msg.hello === 'object'
          if (!isHello && typeof msg.w !== 'string') return
          const leave = swap.enter()
          try {
            // Snapshot and collect live output in the same tick, then replay it before attaching.
            // A worker round trip must not create a gap or duplicate at the durable/live boundary.
            const out = isHello ? readFileSync(outPath, 'utf8') : undefined
            if (isHello) replayOutput = []
            // Decisions have no effects in the worker: retrying after a crash is safe. Only the
            // keeper applies the eventual decision and appends its journal record once.
            let response
            for (;;) {
              await swap.recover()
              const worker = swap.current
              try { response = await worker.request('decide', { dir, message: msg, out }); break }
              catch (error) {
                if (worker.healthy) throw error
              }
            }
            if (response.error) throw new Error('relay worker rejected protocol decision')
            if (writer !== sock || sock.destroyed) return
            const decision = response.result as RelayDecision
            if (decision.write !== undefined) {
              if (child.stdin && !child.stdin.destroyed) child.stdin.write(decision.write)
              if (decision.record) appendFileSync(inPath, `${JSON.stringify({ t: Date.now(), w: decision.write })}\n`)
            }
            for (const message of decision.messages) send(sock, message)
            if (isHello) {
              hello = true
              for (const message of replayOutput ?? []) send(sock, message)
              client = sock
              if (ended) { send(sock, { x: child.exitCode }); sock.end() }
            }
          } finally {
            if (isHello) replayOutput = null
            leave()
          }
        })
      }
    })
    sock.on('close', () => { if (client === sock) client = null })
  })
  try { unlinkSync(sockPath) } catch { /* none left over */ }
  server.listen(sockPath)

  child.on('exit', () => {
    childExited = true
    finishOutput()
    if (killTimer) clearTimeout(killTimer)
    // Keep draining after child exit, but cap it if stdout belongs to an escaped descendant.
    if (termAt) startTermDrain()
  })
  child.on('error', () => {
    if (ended) return
    ended = true
    writeFileSync(join(dir, RELAY_FILES.exit), JSON.stringify({ code: null, at: Date.now(), error: 'spawn failed' }), { mode: 0o600 })
    send(client, { x: null })
    client?.end()
    server.close()
    try { unlinkSync(sockPath) } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 200).unref?.()
  })
  // Detached already; a hangup of whatever started us is not ours. A TERM ends the child first.
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', endChild)
  process.on('SIGINT', endChild)
  // Published LAST, after the signal handlers exist: whoever reads this file may TERM the relay at once,
  // and a TERM before the handler is the default action — the relay dies and its child, in a process
  // group of its own, is orphaned.
  writeFileSync(join(dir, RELAY_FILES.pid), JSON.stringify({ relay: process.pid, child: child.pid ?? null, replayOffsets: true }), { mode: 0o600 })
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: structured-relay <dir>'); process.exit(2) }
  runRelay(dir)
}
