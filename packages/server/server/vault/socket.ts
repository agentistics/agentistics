/**
 * vault/socket.ts — the per-service unlock channel: `~/.agentistics/run/vault.sock`.
 *
 * A passphrase vault (or one whose protector the service cannot reach) starts LOCKED.
 * `agentop vault unlock` reads the passphrase on the terminal with no echo and hands it to the
 * running service HERE — never over the HTTP server, which binds every interface. The service derives
 * the key-encryption key, opens the data key, and keeps only the data key.
 *
 * Who may connect: the directory is 0700 and the socket 0600, so only this OS account can open it
 * (connecting to a Unix socket needs write permission on it). Bun exposes no peer-credential call
 * (`SO_PEERCRED`), so the uid check the spec asks for is the filesystem's, stated here rather than
 * claimed.
 *
 * Protocol: one JSON line in, one JSON line out. `{op:'status'}`, `{op:'unlock', passphrase}`,
 * `{op:'lock'}`. A reply never carries the passphrase, the key, or anything derived from either.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { lockVault, refused, runDir, unlockVault, vaultSocketPath, vaultStatus } from './service'

export type SocketRequest = { op: 'status' } | { op: 'unlock'; passphrase: string } | { op: 'lock' }
export type SocketReply =
  | { ok: true; status?: Awaited<ReturnType<typeof vaultStatus>> }
  | { ok: false; code: string; sentence: string }

const MAX_LINE = 4096

async function handle(req: unknown): Promise<SocketReply> {
  if (!req || typeof req !== 'object') return refused('bad-request', 'bad request')
  const r = req as Record<string, unknown>
  if (r.op === 'status') return { ok: true, status: await vaultStatus() }
  if (r.op === 'lock') { lockVault(); return { ok: true, status: await vaultStatus() } }
  if (r.op === 'unlock' && typeof r.passphrase === 'string') {
    const u = await unlockVault(r.passphrase)
    return u.ok ? { ok: true, status: await vaultStatus() } : { ok: false, code: u.code, sentence: u.sentence }
  }
  return refused('bad-request', 'bad request')
}

let _server: { stop(): void } | null = null

/**
 * Start listening. Idempotent; a failure is returned, not thrown. A socket file that ANSWERS belongs
 * to a live service and is never stolen (`in-use`) — only a stale one, which refuses the connection,
 * is removed and replaced.
 */
export async function startVaultSocket(path = vaultSocketPath()): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (_server) return { ok: true }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { chmodSync(runDir(), 0o700) } catch { /* not ours to fix if it fails */ }
    if (existsSync(path)) {
      if (await socketAnswers(path)) return { ok: false, reason: 'in-use' }
      unlinkSync(path)
    }
    const server = Bun.listen<{ buf: string }>({
      unix: path,
      socket: {
        open(s) { s.data = { buf: '' } },
        async data(s, chunk) {
          s.data.buf += new TextDecoder().decode(chunk)
          if (s.data.buf.length > MAX_LINE) { s.end(); return }
          const nl = s.data.buf.indexOf('\n')
          if (nl === -1) return
          const line = s.data.buf.slice(0, nl)
          s.data.buf = ''
          let req: unknown
          try { req = JSON.parse(line) } catch { req = null }
          const reply = await handle(req)
          s.write(JSON.stringify(reply) + '\n')
          s.end()
        },
      },
    })
    chmodSync(path, 0o600)
    _server = server
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException)?.code ?? 'listen failed' }
  }
}

export function stopVaultSocket(): void {
  try { _server?.stop() } catch { /* already gone */ }
  _server = null
}

/** Does something accept a connection on `path` right now? */
export function socketAnswers(path: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => finish(false), timeoutMs)
    Bun.connect({
      unix: path,
      socket: {
        open(s) { finish(true); s.end() },
        data() {},
        error() { finish(false) },
        connectError() { finish(false) },
      },
    }).catch(() => finish(false))
  })
}

/** Ask the running service. `null` when nothing answers (no service, or a stale socket). */
export async function askVaultSocket(req: SocketRequest, path = vaultSocketPath(), timeoutMs = 10_000): Promise<SocketReply | null> {
  if (!existsSync(path)) return null
  return new Promise<SocketReply | null>((resolve) => {
    let buf = ''
    let done = false
    const finish = (v: SocketReply | null) => { if (!done) { done = true; resolve(v) } }
    const timer = setTimeout(() => finish(null), timeoutMs)
    Bun.connect({
      unix: path,
      socket: {
        open(s) { s.write(JSON.stringify(req) + '\n') },
        data(_s, chunk) { buf += new TextDecoder().decode(chunk) },
        close() {
          clearTimeout(timer)
          try { finish(JSON.parse(buf.trim()) as SocketReply) } catch { finish(null) }
        },
        error() { clearTimeout(timer); finish(null) },
        connectError() { clearTimeout(timer); finish(null) },
      },
    }).catch(() => { clearTimeout(timer); finish(null) })
  })
}
