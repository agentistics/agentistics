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
 * records from index n, then follow), `{w: string}` (write to the child), `{k: 1}` (end the child).
 * Relay → client: `{o: line, t: ms}`, `{x: code|null}`, `{bye: 'replaced'}`.
 *
 * Dependency-free on purpose (node built-ins only): it runs as its own process, from a checkout
 * (`bun run <this file> <dir>`) or from the binary (`agentop __structured-relay <dir>`).
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'

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

export function runRelay(dir: string): void {
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
  writeFileSync(join(dir, RELAY_FILES.pid), JSON.stringify({ relay: process.pid, child: child.pid ?? null }), { mode: 0o600 })

  let client: Socket | null = null
  const send = (s: Socket | null, msg: unknown): void => { if (s && !s.destroyed) s.write(`${JSON.stringify(msg)}\n`) }

  let partial = ''
  const record = (line: string): void => {
    const t = Date.now()
    appendFileSync(outPath, `${JSON.stringify({ t, l: line })}\n`)
    send(client, { o: line, t })
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
  const killChild = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    const pid = child.pid
    if (pid === undefined) return
    try { process.kill(-pid, signal) } catch { try { child.kill(signal) } catch { /* already dead */ } }
  }
  const endChild = (): void => {
    // A SIGTERM can arrive after the child exit event has already marked the relay ended. The relay
    // itself still owns a listening socket, so explicitly leave too; otherwise it survives until SIGKILL.
    if (ended) { process.exit(0); return }
    if (child.exitCode !== null || child.signalCode !== null) return
    termAt ||= Date.now()
    killChild('SIGTERM')
    killTimer ??= setTimeout(() => { if (child.exitCode === null) killChild('SIGKILL') }, KILL_GRACE_MS)
  }

  const server = createServer(sock => {
    if (client && !client.destroyed) { send(client, { bye: 'replaced' }); client.end() }
    client = null
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
        if (!hello && msg.hello && typeof msg.hello === 'object') {
          hello = true
          const from = Math.max(0, Number((msg.hello as { from?: unknown }).from) || 0)
          // Synchronous read and registration in ONE tick: a line recorded after this read is sent
          // live, one recorded before it is in the file — never both, never neither.
          const recs = readFileSync(outPath, 'utf8').split('\n').filter(Boolean)
          for (const r of recs.slice(from)) {
            try { const { t, l } = JSON.parse(r) as { t: number; l: string }; send(sock, { o: l, t }) } catch { /* a torn record cannot exist: appends are whole */ }
          }
          client = sock
          if (ended) { send(sock, { x: child.exitCode }); sock.end() }
          continue
        }
        if (typeof msg.w === 'string') {
          if (child.stdin && !child.stdin.destroyed) child.stdin.write(msg.w)
          appendFileSync(inPath, `${JSON.stringify({ t: Date.now(), w: msg.w })}\n`)
          continue
        }
        if (msg.k) endChild()
      }
    })
    sock.on('close', () => { if (client === sock) client = null })
  })
  try { unlinkSync(sockPath) } catch { /* none left over */ }
  server.listen(sockPath)

  child.on('exit', code => {
    if (partial !== '') { record(partial); partial = '' }
    ended = true
    if (killTimer) clearTimeout(killTimer)
    // The direct child may have obeyed TERM while a descendant in its group ignored it: the group is
    // still killed once the grace is over, and the relay stays until then.
    const groupGrace = termAt ? Math.max(0, termAt + KILL_GRACE_MS - Date.now()) : 0
    writeFileSync(join(dir, RELAY_FILES.exit), JSON.stringify({ code, at: Date.now() }), { mode: 0o600 })
    send(client, { x: code })
    client?.end()
    server.close()
    try { unlinkSync(sockPath) } catch { /* already gone */ }
    if (termAt) setTimeout(() => { killChild('SIGKILL'); process.exit(0) }, groupGrace + 50)
    else setTimeout(() => process.exit(0), 200).unref?.()
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
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: structured-relay <dir>'); process.exit(2) }
  runRelay(dir)
}
