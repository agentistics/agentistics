/**
 * cdp-client.ts — the Chrome DevTools Protocol over `--remote-debugging-pipe` (no TCP port).
 *
 * The browser reads commands on its fd 3 and writes replies/events on its fd 4, each message JSON
 * terminated by a NUL byte (probe P1). The child must be spawned with `node:child_process.spawn` and
 * `stdio: ['ignore','ignore','ignore','pipe','pipe']`, which gives a Writable at `stdio[3]` and a
 * Readable at `stdio[4]` — `Bun.spawn` returns bare fd numbers there.
 *
 * No dependency (no playwright-core in the single binary, spec D3). `NulFramer` is PURE and tested;
 * `CdpClient` is the thin IO around it: request/response by id, events by listener, a timeout per
 * command, and every pending command rejected the moment the pipe closes — a browser that died must
 * never leave a caller waiting forever.
 */

import type { Readable, Writable } from 'node:stream'

/** PURE: splits a byte stream into NUL-terminated messages, keeping a partial tail for the next chunk.
 *  Works on bytes, not strings, so a multi-byte UTF-8 character split across two chunks survives. */
export class NulFramer {
  private parts: Buffer[] = []
  private size = 0
  /** Largest message accepted; above it the framer throws (a runaway peer must not grow memory). */
  constructor(private readonly maxBytes = 64 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    const out: string[] = []
    let start = 0
    for (;;) {
      const nul = chunk.indexOf(0, start)
      if (nul < 0) break
      const piece = chunk.subarray(start, nul)
      const whole = this.size ? Buffer.concat([...this.parts, piece]) : piece
      out.push(whole.toString('utf8'))
      this.parts = []
      this.size = 0
      start = nul + 1
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      this.size += rest.length
      if (this.size > this.maxBytes) {
        this.parts = []
        this.size = 0
        throw new Error('cdp message too large')
      }
      this.parts.push(Buffer.from(rest))
    }
    return out
  }
}

export interface CdpEvent { method: string; params: any; sessionId?: string }

export class CdpError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`${method}: ${message}`)
  }
}

export class CdpClient {
  private nextId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>()
  private listeners = new Set<(e: CdpEvent) => void>()
  private closeListeners = new Set<(why: string) => void>()
  private framer = new NulFramer()
  private closedWhy: string | null = null

  constructor(private readonly out: Writable, inp: Readable, private readonly defaultTimeoutMs = 15_000) {
    inp.on('data', (chunk: Buffer) => {
      let msgs: string[]
      try { msgs = this.framer.push(chunk) } catch (e) { this.close(String(e)); return }
      for (const raw of msgs) this.dispatch(raw)
    })
    inp.on('end', () => this.close('pipe closed'))
    inp.on('error', (e) => this.close(`pipe error: ${e.message}`))
    out.on('error', (e) => this.close(`pipe error: ${e.message}`))
  }

  get closed(): boolean { return this.closedWhy !== null }

  private dispatch(raw: string): void {
    let m: any
    try { m = JSON.parse(raw) } catch { return }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new CdpError(p.method, m.error.code, String(m.error.message ?? 'error')))
      else p.resolve(m.result ?? {})
      return
    }
    if (typeof m.method === 'string') {
      const ev: CdpEvent = { method: m.method, params: m.params ?? {}, ...(m.sessionId ? { sessionId: m.sessionId } : {}) }
      for (const l of this.listeners) { try { l(ev) } catch { /* a listener's bug is not the pipe's */ } }
    }
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    if (this.closedWhy) return Promise.reject(new CdpError(method, undefined, `browser connection closed (${this.closedWhy})`))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(method, undefined, `timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError(method, undefined, String(e)))
      }
    })
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onClose(listener: (why: string) => void): () => void {
    if (this.closedWhy) { listener(this.closedWhy); return () => {} }
    this.closeListeners.add(listener)
    return () => { this.closeListeners.delete(listener) }
  }

  /** Reject everything pending and stop. Idempotent. Does NOT kill the process — that is the host's,
   *  by saved PID. */
  close(why = 'closed'): void {
    if (this.closedWhy) return
    this.closedWhy = why
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new CdpError(p.method, undefined, `browser connection closed (${why})`))
    }
    this.pending.clear()
    try { this.out.end() } catch { /* already gone */ }
    for (const l of this.closeListeners) { try { l(why) } catch { /* ignore */ } }
    this.closeListeners.clear()
    this.listeners.clear()
  }
}
