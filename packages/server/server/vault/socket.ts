/**
 * vault/socket.ts — `~/.agentistics/run/vault.sock`: how every OTHER process reaches the vault.
 *
 * SECRETS.4 §5.2: only the agentop service holds a human data key. A CLI call does not open the vault
 * itself; it asks the service here. The ops (ops.ts) unlock, lock, report status, SEAL (plaintext in,
 * ciphertext out), and perform the few actions that need a secret's VALUE on the caller's behalf — and
 * there is NO `open`: no op returns a human-scope plaintext to another process.
 *
 * Who may connect: the directory is 0700 and the socket 0600, so only this OS account can open it
 * (connecting to a Unix socket needs write permission on it). Bun exposes no peer-credential call
 * (`SO_PEERCRED`), so the uid check is the filesystem's, stated here rather than claimed.
 *
 * Framing: wire.ts. One request per connection. A reply never carries a passphrase, a key, or
 * anything derived from either.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { refused, runDir, vaultSocketPath, type vaultStatus } from './service'
import { FrameReader, encodeFrame, type Frame } from './wire'

/** What a reply's final header looks like to a caller. */
export type SocketReply =
  | ({ ok: true; status?: Awaited<ReturnType<typeof vaultStatus>> } & Record<string, unknown>)
  | ({ ok: false; code: string; sentence: string } & Record<string, unknown>)

/** The legacy request shapes (kept typed for the verbs that use them). */
export type SocketRequest =
  | { op: 'status' }
  | { op: 'unlock'; passphrase: string }
  | { op: 'lock' }
  | ({ op: string } & Record<string, unknown>)

/** What an op handler gets: the request, its body, and a way to stream output lines back. */
export interface OpContext {
  header: Record<string, unknown>
  body: Uint8Array | null
  emit(stream: 'out' | 'err', data: string): void
  /** Resolves when the caller hung up (a streamed command is then stopped). */
  closed: Promise<void>
}
export interface OpResult {
  reply: SocketReply
  body?: Uint8Array
}
export type OpHandler = (ctx: OpContext) => Promise<OpResult>

let _handler: OpHandler = async () => ({ reply: refused('bad-request', 'bad request') })
/** ops.ts installs the dispatcher (kept apart so this file stays the transport only). */
export function setVaultOpHandler(h: OpHandler): void { _handler = h }

let _server: { stop(): void } | null = null

interface ConnState { reader: FrameReader; handled: boolean; hangup: () => void; closed: Promise<void> }

/**
 * Start listening. Idempotent; a failure is returned, not thrown. A socket file that ANSWERS belongs
 * to a live service and is never stolen (`in-use`) — only a stale one, which refuses the connection,
 * is removed and replaced.
 */
export async function startVaultSocket(path = vaultSocketPath()): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (_server) return { ok: true }
  try {
    if (!(await import('./ops')).opsInstalled()) throw new Error('ops not installed')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { chmodSync(runDir(), 0o700) } catch { /* not ours to fix if it fails */ }
    if (existsSync(path)) {
      if (await socketAnswers(path)) return { ok: false, reason: 'in-use' }
      unlinkSync(path)
    }
    const server = Bun.listen<ConnState>({
      unix: path,
      socket: {
        open(s) {
          let hangup = () => {}
          const closed = new Promise<void>(r => { hangup = r })
          s.data = { reader: new FrameReader(), handled: false, hangup, closed }
        },
        close(s) { s.data.reader.wipe(); s.data.hangup() },
        error(s) { s.data.reader.wipe(); s.data.hangup() },
        async data(s, chunk) {
          if (s.data.handled) return
          const r = s.data.reader.feed(new Uint8Array(chunk))
          if (r.kind === 'need-more') return
          s.data.handled = true
          if (r.kind === 'error') {
            s.write(encodeFrame({ final: true, ...refused(r.reason === 'body-too-large' ? 'too-large' : 'bad-request', r.reason === 'body-too-large' ? 'that request is too large for the vault socket' : 'bad request') }))
            s.end()
            return
          }
          await serve(s, r.frame)
        },
      },
    })
    chmodSync(path, 0o600)
    _server = server
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? 'listen failed' }
  }
}

async function serve(s: { write(b: Uint8Array): number; end(): void; data: ConnState }, frame: Frame): Promise<void> {
  const emit = (stream: 'out' | 'err', data: string) => { try { s.write(encodeFrame({ s: stream, d: data })) } catch { /* gone */ } }
  let out: OpResult
  try {
    out = await _handler({ header: frame.header, body: frame.body, emit, closed: s.data.closed })
  } catch {
    out = { reply: refused('failed', 'the vault service could not complete that request') }
  } finally {
    // The request body may be a caller's plaintext (a value to seal): zero it whatever happened.
    frame.body?.fill(0)
  }
  try { s.write(encodeFrame({ final: true, ...out.reply }, out.body ?? null)) } catch { /* gone */ }
  s.end()
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

export interface AskOptions {
  path?: string
  timeoutMs?: number
  /** Raw bytes sent after the header (a value to seal, an upload). */
  body?: Uint8Array
  /** Output lines of a command the service runs for this caller. */
  onStream?: (stream: 'out' | 'err', data: string) => void
  /** Abort: hang up, which stops a streamed command in the service. */
  signal?: AbortSignal
}

/** Ask the running service. `null` when nothing answers (no service, or a stale socket). */
export async function askVault(req: SocketRequest, o: AskOptions = {}): Promise<{ reply: SocketReply; body: Uint8Array | null } | null> {
  const path = o.path ?? vaultSocketPath()
  if (!existsSync(path)) return null
  return new Promise((resolve) => {
    const reader = new FrameReader()
    let done = false
    let sock: { end(): void } | null = null
    const finish = (v: { reply: SocketReply; body: Uint8Array | null } | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reader.wipe()
      try { sock?.end() } catch { /* gone */ }
      resolve(v)
    }
    // `timeoutMs: 0` = no deadline (a command the service runs for us, e.g. `docker compose logs -f`).
    const timer = o.timeoutMs === 0 ? undefined : setTimeout(() => finish(null), o.timeoutMs ?? 10_000)
    o.signal?.addEventListener('abort', () => finish(null))
    const drain = (chunk: Uint8Array) => {
      let r = reader.feed(chunk)
      for (;;) {
        if (r.kind !== 'frame') { if (r.kind === 'error') finish(null); return }
        const h = r.frame.header
        if (h.final === true) {
          const { final: _f, bodyBytes: _b, ...reply } = h
          finish({ reply: reply as SocketReply, body: r.frame.body })
          return
        }
        if ((h.s === 'out' || h.s === 'err') && typeof h.d === 'string') {
          o.onStream?.(h.s, h.d)
        }
        r = reader.feed(r.rest)
      }
    }
    Bun.connect({
      unix: path,
      socket: {
        open(s) { sock = s; s.write(encodeFrame(req as Record<string, unknown>, o.body ?? null)) },
        data(_s, chunk) { drain(new Uint8Array(chunk)) },
        close() { finish(null) },
        error() { finish(null) },
        connectError() { finish(null) },
      },
    }).catch(() => finish(null))
  })
}

/** The reply alone — the shape the status/unlock/lock verbs always used. */
export async function askVaultSocket(req: SocketRequest, path = vaultSocketPath(), timeoutMs = 10_000): Promise<SocketReply | null> {
  const r = await askVault(req, { path, timeoutMs })
  return r ? r.reply : null
}
