/**
 * tools/shell/process.ts — the processes behind the shell tools: the persistent PIPE session and the
 * one-shot PTY run, plus the `Job` a call (or a yielded handle) reads from.
 *
 * ## Every process is its own process GROUP
 *
 * Spawned `detached` (setsid), so its pid is its pgid, and a non-interactive bash has no job control,
 * so everything a command starts — `sleep 100 &`, the test runner's workers — stays in that group.
 * Stopping is therefore `kill(-pgid)`, which takes the children with it; killing only the pid would
 * leave an orphaned build running with nothing left to name it. The stated limit: a command that
 * calls `setsid` itself (a daemon) leaves the group on purpose and survives. With a container
 * launcher the group is the `docker run` client, and the container's own lifetime is the launcher's.
 *
 * ## Bun.Terminal (verified on the installed Bun 1.3.14, 2026-09-27)
 *
 * `new Bun.Terminal({cols, rows, data})` passed as `Bun.spawn({ terminal })` gives the child a real
 * tty (`[ -t 1 ]` is true, `stty size` reports the dimensions). Measured: WITHOUT `detached` the PTY
 * child is NOT a group leader (its pgid was the parent's), so `detached: true` is required for the
 * group kill above; with it the child is session + group leader and still has the tty.
 */

import { writeSync } from 'node:fs'
import type { SpawnPlan } from '../contract.ts'
import { MarkerScanner, SESSION_SCRIPT, type MarkerEnd } from './protocol.ts'
import { OutputWindow } from './output.ts'

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Signal a whole process group; a group that is already gone is not an error. */
export function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // ESRCH: nobody left in the group.
  }
}

export function ttyAvailable(): boolean {
  return typeof (Bun as unknown as { Terminal?: unknown }).Terminal === 'function'
}

/** One command's life as the tools see it: its output window and how it ended. */
export class Job {
  readonly window: OutputWindow
  readonly startedMs = performance.now()
  done = false
  exitCode?: number
  /** Ended by a signal (ours or anyone's) rather than by exiting. */
  killed = false
  /** Set when we asked it to stop — `stop`, an abort, `dispose`. */
  stopRequested = false
  endedMs?: number
  private waiters = new Set<() => void>()
  /** Lets the process hand over output it was holding back before a read (see `MarkerScanner.release`). */
  beforeTake?: () => void

  constructor(
    readonly command: string,
    readonly tty: boolean,
    readonly pgid: number,
    capacity: number,
    readonly startedAt: string,
  ) {
    this.window = new OutputWindow(capacity)
  }

  append(text: string): void {
    this.window.push(text)
  }

  finish(exitCode: number | undefined, killed: boolean): void {
    if (this.done) return
    this.done = true
    this.exitCode = exitCode
    this.killed = killed
    this.endedMs = performance.now()
    for (const w of this.waiters) w()
    this.waiters.clear()
  }

  /** Everything since the last take, cut to `max`. */
  take(max?: number) {
    if (!this.done) this.beforeTake?.()
    return this.window.drain(max)
  }

  wallMs(): number {
    return Math.round((this.endedMs ?? performance.now()) - this.startedMs)
  }

  /** Resolves when the job ends, `ms` passes, or `signal` aborts — whichever is first. */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.done || ms <= 0 || signal?.aborted) return Promise.resolve()
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        this.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      signal?.addEventListener('abort', done, { once: true })
      this.waiters.add(done)
    })
  }
}

export interface Spawned {
  pgid: number
  exited: Promise<void>
}

async function pump(stream: ReadableStream<Uint8Array> | null | undefined, onText: (s: string) => void): Promise<void> {
  if (!stream) return
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) onText(decoder.decode(value, { stream: true }))
    }
    const rest = decoder.decode()
    if (rest) onText(rest)
  } catch {
    // The stream was torn down with the process; what arrived has been delivered.
  }
}

/** Waits for the pumps to reach EOF, but never longer than `ms`: a background child can hold a pipe open forever. */
async function drain(pumps: Promise<void>[], ms: number): Promise<void> {
  await Promise.race([Promise.all(pumps), sleep(ms)])
}

// ── The persistent pipe session ───────────────────────────────────────────────────────────────────

/**
 * A long-lived bash reading control lines on fd 3 (see `./protocol.ts`). It runs one job at a time;
 * after a job yields, the tool-set stops using this session for new calls and it belongs to that
 * job until the job ends.
 */
export class PipeSession implements Spawned {
  readonly pgid: number
  readonly exited: Promise<void>
  private readonly proc: ReturnType<typeof Bun.spawn>
  private readonly ctl: number
  private job: Job | null = null
  private scanner: MarkerScanner | null = null
  private onEnd: ((end: MarkerEnd) => void) | null = null
  private closed = false
  alive = true

  /** Throws when the program cannot be spawned (missing shell, bad cwd). */
  constructor(plan: SpawnPlan) {
    const proc = Bun.spawn({
      cmd: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.proc = proc
    this.pgid = proc.pid
    this.ctl = proc.stdio[3] as unknown as number
    const onText = (s: string) => this.onText(s)
    const pumps = [
      pump(proc.stdout as ReadableStream<Uint8Array>, onText),
      pump(proc.stderr as ReadableStream<Uint8Array>, onText),
    ]
    this.exited = proc.exited.then(async () => {
      this.alive = false
      this.closed = true
      await drain(pumps, 100)
      const job = this.job
      if (job && !job.done) {
        job.append(this.scanner?.flush() ?? '')
        const signalled = proc.signalCode !== null && proc.signalCode !== undefined
        job.finish(signalled ? undefined : (proc.exitCode ?? undefined), signalled)
      }
      this.job = null
    })
  }

  /** The argv of a session, before the launcher wraps it. */
  static argv(shell: string): string[] {
    return [shell, '--noprofile', '--norc', '-c', SESSION_SCRIPT]
  }

  get busy(): boolean {
    return this.job !== null && !this.job.done
  }

  /** Hand one call to the session. `onEnd` hears the marker (status + the session's new PWD). */
  async run(job: Job, line: string, nonce: string, onEnd: (end: MarkerEnd) => void): Promise<void> {
    this.job = job
    const scanner = new MarkerScanner(nonce)
    this.scanner = scanner
    this.onEnd = onEnd
    job.beforeTake = () => {
      if (this.scanner === scanner) job.append(scanner.release())
    }
    if (this.closed) throw new Error('session closed')
    await writeAll(this.ctl, Buffer.from(line + '\0', 'utf8'))
  }

  /** Bytes for the running command's stdin. */
  writeInput(text: string): void {
    const sink = this.proc.stdin as unknown as { write(s: string): number; flush(): unknown }
    sink.write(text)
    sink.flush()
  }

  /**
   * Ask bash to leave once the current command is done: an `exit` on the control channel (and EOF on
   * stdin). The control fd itself is NEVER closed here — Bun owns it and closes it when the
   * subprocess is collected, so closing it ourselves would later close whatever fd reused the number
   * (measured: EBADF in an unrelated spawn).
   */
  endInput(): void {
    if (!this.closed) {
      this.closed = true
      try {
        writeSync(this.ctl, 'exit\0')
      } catch {
        // the shell is already gone
      }
    }
    try {
      ;(this.proc.stdin as unknown as { end(): unknown }).end()
    } catch {
      // already closed with the process
    }
  }

  private onText(s: string): void {
    const job = this.job
    if (!job || job.done || !this.scanner) return // idle: a background job's chatter belongs to no call
    const { output, end } = this.scanner.push(s)
    if (output) job.append(output)
    if (end) {
      this.job = null
      job.finish(end.status, false)
      const cb = this.onEnd
      this.onEnd = null
      cb?.(end)
    }
  }
}

/** Writes all of `buf` to a (possibly non-blocking) fd, waiting out EAGAIN. */
async function writeAll(fd: number, buf: Buffer): Promise<void> {
  let off = 0
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EAGAIN') {
        await sleep(5)
        continue
      }
      throw e
    }
  }
}

// ── The one-shot PTY run ──────────────────────────────────────────────────────────────────────────

interface BunTerminal {
  write(data: string): number
  close(): void
}

export class TtyRun implements Spawned {
  readonly pgid: number
  readonly exited: Promise<void>
  private readonly term: BunTerminal

  constructor(plan: SpawnPlan, job: (pgid: number) => Job, size: { cols: number; rows: number }) {
    const Terminal = (Bun as unknown as { Terminal: new (o: object) => BunTerminal }).Terminal
    let target: Job | null = null
    const early: string[] = []
    let eof!: () => void
    const eofSeen = new Promise<void>(r => { eof = r })
    const decoder = new TextDecoder()
    const term = new Terminal({
      cols: size.cols,
      rows: size.rows,
      data: (_t: unknown, d: Uint8Array) => {
        const s = decoder.decode(d, { stream: true })
        if (target) target.append(s)
        else early.push(s)
      },
      exit: () => eof(),
    })
    this.term = term
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn({ cmd: plan.argv, cwd: plan.cwd, env: plan.env, terminal: term as never, detached: true })
    } catch (e) {
      term.close()
      throw e
    }
    this.pgid = proc.pid
    const j = job(proc.pid)
    target = j
    for (const s of early) j.append(s)
    this.exited = proc.exited.then(async () => {
      // The PTY can still hold output the child wrote just before exiting.
      await Promise.race([eofSeen, sleep(200)])
      const signalled = proc.signalCode !== null && proc.signalCode !== undefined
      j.finish(signalled ? undefined : (proc.exitCode ?? undefined), signalled)
      try {
        term.close()
      } catch {
        // already closed
      }
    })
  }

  writeInput(text: string): void {
    this.term.write(text)
  }
}
