/** Stable IO owners use replaceable workers. Never retire a worker until its replacement is ready
 * AND all requests (including flushed replies) have finished. A failed preparation leaves it live. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export class IdleSwap<T> {
  private retryVersion?: string
  private retryAt = 0
  private failures = 0
  private recovery?: Promise<void>
  private now(): number { return this.d.now?.() ?? Date.now() }
  private failed(version: string, error: unknown): void {
    this.retryVersion = version
    this.retryAt = this.now() + Math.min(600_000, 5000 * 2 ** Math.min(this.failures++, 7))
    this.d.log(error)
  }
  private busy = 0
  private preparing = false
  private stopped = false
  private candidate?: { worker: T; version: string }
  constructor(public current: T, private version: string, private readonly d: {
    now?(): number
    version(): string
    prepare(): Promise<T>
    close(worker: T): void
    usable?(worker: T): boolean
    log(error: unknown): void
  }) {}
  enter(): () => void {
    this.busy++
    let left = false
    return () => { if (!left) { left = true; this.busy--; this.commit() } }
  }
  async check(): Promise<void> {
    if (this.stopped || this.preparing || this.candidate) return
    this.preparing = true
    let version = this.version
    try {
      version = this.d.version()
      if (version !== this.retryVersion) { this.failures = 0; this.retryAt = 0; this.retryVersion = version }
      if (this.now() < this.retryAt) return
      if (version === this.version && this.d.usable?.(this.current) !== false) return
      const worker = await this.d.prepare()
      if (this.stopped) { this.d.close(worker); return }
      this.candidate = { worker, version }
      this.commit()
    } catch (error) { this.failed(version, error) }
    finally { this.preparing = false }
  }
  private commit(): void {
    if (!this.candidate || (this.busy && this.d.usable?.(this.current) !== false)) return
    if (this.d.usable && !this.d.usable(this.candidate.worker)) {
      this.d.close(this.candidate.worker)
      this.failed(this.candidate.version, new Error('replacement exited before idle'))
      this.candidate = undefined
      return
    }
    const old = this.current
    this.current = this.candidate.worker
    this.failures = 0; this.retryAt = 0
    this.version = this.candidate.version
    this.candidate = undefined
    this.d.close(old)
  }
  /** Recovery ignores the idle barrier only when the active worker has died. */
  recover(): Promise<void> {
    if (this.recovery) return this.recovery
    this.recovery = (async () => {
      while (!this.stopped && this.d.usable?.(this.current) === false) {
        this.commit()
        await this.check()
        if (this.d.usable?.(this.current) === false) await new Promise(resolve => setTimeout(resolve, 100))
      }
    })().finally(() => { this.recovery = undefined })
    return this.recovery
  }
  close(): void {
    this.stopped = true
    this.d.close(this.current)
    if (this.candidate) this.d.close(this.candidate.worker)
    this.candidate = undefined
  }
}

export function executableVersion(file = process.execPath): string {
  const s = statSync(file, { bigint: true })
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}`
}

/** Linux can identify the image actually loaded, even if an upgrade raced helper startup. */
export function runningExecutableVersion(): string {
  return executableVersion(process.platform === 'linux' ? '/proc/self/exe' : process.execPath)
}

/** A checkout starts its own source; an installation always starts the current on-disk binary. */
export function helperCommand(command: string): string[] {
  const cli = resolve(import.meta.dir, '../bin/cli.ts')
  return existsSync(cli) ? [process.execPath, 'run', cli, command] : [process.execPath, command]
}

export type Message = Record<string, any>

/** One newline JSON channel. Candidate workers have no access to the external connection. */
export class JsonWorker {
  readonly child: ChildProcessWithoutNullStreams
  onmessage: (message: Message) => void = () => {}
  onerror: (error: Error) => void = () => {}
  private pending = new Map<string | number, { resolve(m: Message): void; reject(e: Error): void }>()
  private sequence = 0
  private dead?: Error
  get healthy(): boolean { return !this.dead }
  constructor(command: string[], env: NodeJS.ProcessEnv = process.env) {
    this.child = spawn(command[0]!, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env })
    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        try {
          const msg = JSON.parse(line) as Message
          const wait = this.pending.get(msg.id)
          if (wait && !msg.method) { this.pending.delete(msg.id); wait.resolve(msg) }
          else this.onmessage(msg)
        } catch { this.fail(new Error('invalid helper worker response')) }
      }
    })
    // Workers must never put diagnostics on the protocol stream.
    this.child.stderr.resume()
    this.child.stdin.on('error', error => this.fail(error))
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', () => this.fail(new Error('helper worker exited')))
  }
  private fail(error: Error): void {
    if (this.dead) return
    this.dead = error
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
    this.onerror(error)
  }
  send(message: Message): void {
    if (this.dead) throw this.dead
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  async request(method: string, params?: unknown): Promise<Message> {
    const id = `agentop-hotswap-${++this.sequence}`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<Message>((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
        timer = setTimeout(() => { this.pending.delete(id); reject(new Error('helper preparation timed out')) }, 10_000)
        try { this.send({ jsonrpc: '2.0', id, method, params }) }
        catch (error) { this.pending.delete(id); reject(error) }
      })
    } finally { if (timer) clearTimeout(timer) }
  }
  close(): void { this.child.kill(); this.child.stdin.destroy() }
}

export const swapLog = (error: unknown): void => { console.error('[agentop helper] hot-swap failed; keeping current worker:', error instanceof Error ? error.message : 'worker unavailable') }

/** Only request lifetimes hold idle; cancellation and a bounded lease release them too. */
export class RequestLeases {
  private requests = new Map<string, { leave(): void; at: number }>()
  constructor(private enter: () => () => void, private now = Date.now, private ceilingMs = 300_000) {}
  start(key: string): void { this.finish(key); this.requests.set(key, { leave: this.enter(), at: this.now() }) }
  finish(key: string): void { const r = this.requests.get(key); this.requests.delete(key); r?.leave() }
  expire(): void { for (const [key, r] of this.requests) if (this.now() - r.at >= this.ceilingMs) this.finish(key) }
  clear(): string[] { const keys = [...this.requests.keys()]; for (const key of keys) this.finish(key); return keys }
}
