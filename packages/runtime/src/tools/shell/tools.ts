/**
 * tools/shell/tools.ts — `shell.start` / `shell.read` / `shell.write` / `shell.stop` (spec §2 D-T2,
 * §3, §4). Bash is 76,5 % of every tool call measured on this machine, so this is the tool whose
 * contract decides the harness's quality.
 *
 * ## One persistent session per tool-set
 *
 * `createShellTools` owns ONE long-lived bash. `shell.start` runs its command INSIDE it, so `cd`,
 * `export` and shell functions survive into the next call — the model does not have to re-derive its
 * environment every turn. The protocol that makes that safe (commands on fd 3, a per-call nonce end
 * marker, per-call `cwd` with the session's own directory restored) is in `./protocol.ts`.
 *
 * ## Yield, never block and never kill (D-T2)
 *
 * A command still running after `yieldMs` returns a HANDLE (`sessionId`) and the output so far. The
 * bash it runs in now BELONGS to that command — `shell.read` / `shell.write` / `shell.stop` address it
 * by handle — and the next `shell.start` transparently gets a FRESH session, started in the last
 * directory the old one reported. What the fresh session cannot inherit is said here once: exports,
 * functions and aliases defined in the yielded session stay with it.
 *
 * ## `tty: true` is a one-shot PTY, not the persistent session
 *
 * A PTY echoes input, draws prompts and rewrites line endings, and none of that belongs in the marker
 * protocol. So a `tty` call runs `bash -c <command>` on its own `Bun.Terminal`, in the same directory
 * the session would have used, with the same yield/read/write/stop contract — but it neither sees nor
 * changes the session's exports or directory. Pipes stay the default: most calls do not need a tty.
 *
 * ## Every spawn asks the launcher (D-T5)
 *
 * The persistent session and every PTY run go through `launcher.wrap(plan)`. A `{refused}` answer is
 * a failure `unavailable` carrying that sentence, and nothing is spawned. The default launcher is a
 * PASSTHROUGH whose state is `none` — and says so, because a sandbox advertised and absent is worse
 * than none.
 *
 * ## The shell dies with the tool-set
 *
 * `dispose()` signals every process GROUP this tool-set started (SIGTERM, a grace, then SIGKILL), so
 * a yielded `bun test --watch` does not outlive the session that started it. An aborted `ctx.signal`
 * does the same to the call in flight.
 */

import { MINIMAL_TOOL_ENV, type ToolEnv } from '../env.ts'
import { stat } from 'node:fs/promises'
import type { SandboxLauncher, SpawnPlan, Tool, ToolContext, ToolOutcome } from '../contract.ts'
import { defineTool } from '../define.ts'
import { resolveToolPath } from '../paths.ts'
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES_CEILING, type TakenOutput } from './output.ts'
import { Job, PipeSession, TtyRun, killGroup, sleep, ttyAvailable, type Spawned } from './process.ts'
import { controlLine, mintNonce } from './protocol.ts'

// ── The contract (§4) ───────────────────────────────────────────────────────────────────────────

export interface ShellStart {
  command: string
  cwd?: string
  tty?: boolean
  yieldMs?: number
  maxOutputBytes?: number
}

export interface ShellRead {
  sessionId: string
  /** How long to wait for the process to finish before answering with what there is. Default 1000. */
  yieldMs?: number
  maxOutputBytes?: number
}

export interface ShellWrite {
  sessionId: string
  /** Bytes for the process's stdin, verbatim — include the `\n` a line-reading program waits for. */
  input: string
  yieldMs?: number
  maxOutputBytes?: number
}

export interface ShellStop {
  sessionId: string
}

export type ShellErrorClass = 'not-found' | 'permission' | 'timeout' | 'killed' | 'nonzero' | 'internal'

export interface ShellResult {
  /** Present while the process is still alive. */
  sessionId?: string
  exitCode?: number
  output: string
  outputTruncated: boolean
  originalBytes: number
  wallMs: number
  error?: { class: ShellErrorClass; detail?: string }
}

export interface ShellSessionInfo {
  sessionId: string
  command: string
  tty: boolean
  pid: number
  running: boolean
  startedAt: string
}

export interface ShellTools {
  start: Tool<ShellStart>
  read: Tool<ShellRead>
  write: Tool<ShellWrite>
  stop: Tool<ShellStop>
  /** Kill every process group this tool-set started. Idempotent. */
  dispose(): Promise<void>
  /** The handles of yielded commands (running, or finished and not yet read). */
  sessions(): ShellSessionInfo[]
}

export interface ShellToolsOptions {
  launcher?: SandboxLauncher
  /** Default `/bin/bash`. The protocol uses bash features (`read -d ""`, `[`), so a POSIX sh will not do. */
  shell?: string
  /** What the shell's processes see. Default `MINIMAL_TOOL_ENV` (`../env.ts`): nothing from the host. */
  env?: ToolEnv
  now?: () => Date
  /** SIGTERM → SIGKILL grace for stop / abort / dispose. Default 2000 ms. */
  graceMs?: number
  /** PTY size for `tty: true`. Default 120×40. */
  ttySize?: { cols: number; rows: number }
}

export const DEFAULT_YIELD_MS = 10_000
export const DEFAULT_POLL_YIELD_MS = 1_000
export const MAX_YIELD_MS = 600_000
const MAX_COMMAND_BYTES = 256 * 1024
const MAX_INPUT_BYTES = 256 * 1024

export const PASSTHROUGH_LAUNCHER: SandboxLauncher = Object.freeze({
  state: 'none' as const,
  sentence:
    'No sandbox: commands run with this account\'s full access — they can read anything it can read, reach the network and run arbitrary code. Every command still goes through the permission policy.',
  wrap: (plan: SpawnPlan) => plan,
})

// ── Input checks ────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optMs(o: Obj, key: string, tool: string): number | undefined | string {
  const v = o[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `${tool}: "${key}" must be a non-negative number of milliseconds.`
  return Math.min(v, MAX_YIELD_MS)
}

function optMax(o: Obj, tool: string): number | undefined | string {
  const v = o.maxOutputBytes
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return `${tool}: "maxOutputBytes" must be a positive integer.`
  return Math.min(v, MAX_OUTPUT_BYTES_CEILING)
}

function reqSessionId(input: unknown, tool: string): Obj | string {
  if (!isObj(input) || typeof input.sessionId !== 'string' || input.sessionId === '') {
    return `${tool} needs an object with a "sessionId" string (the handle shell.start returned).`
  }
  return input
}

export function parseStart(input: unknown): ShellStart | string {
  if (!isObj(input) || typeof input.command !== 'string' || input.command.trim() === '') {
    return 'shell.start needs an object with a non-empty "command" string.'
  }
  if (input.command.includes('\0')) return 'shell.start: "command" may not contain a NUL byte.'
  if (Buffer.byteLength(input.command) > MAX_COMMAND_BYTES) {
    return `shell.start: "command" is larger than ${MAX_COMMAND_BYTES} bytes; write a script file and run that instead.`
  }
  const out: ShellStart = { command: input.command }
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== 'string' || input.cwd === '' || input.cwd.includes('\0')) return 'shell.start: "cwd" must be a non-empty path.'
    out.cwd = input.cwd
  }
  if (input.tty !== undefined) {
    if (typeof input.tty !== 'boolean') return 'shell.start: "tty" must be true or false.'
    out.tty = input.tty
  }
  const y = optMs(input, 'yieldMs', 'shell.start')
  if (typeof y === 'string') return y
  if (y !== undefined) out.yieldMs = y
  const m = optMax(input, 'shell.start')
  if (typeof m === 'string') return m
  if (m !== undefined) out.maxOutputBytes = m
  return out
}

function parsePoll(input: unknown, tool: string): ShellRead | string {
  const o = reqSessionId(input, tool)
  if (typeof o === 'string') return o
  const out: ShellRead = { sessionId: o.sessionId as string }
  const y = optMs(o, 'yieldMs', tool)
  if (typeof y === 'string') return y
  if (y !== undefined) out.yieldMs = y
  const m = optMax(o, tool)
  if (typeof m === 'string') return m
  if (m !== undefined) out.maxOutputBytes = m
  return out
}

export function parseWrite(input: unknown): ShellWrite | string {
  const base = parsePoll(input, 'shell.write')
  if (typeof base === 'string') return base
  const raw = (input as Obj).input
  if (typeof raw !== 'string') return 'shell.write needs an "input" string (the bytes to send to the process\'s stdin).'
  if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) return `shell.write: "input" is larger than ${MAX_INPUT_BYTES} bytes.`
  return { ...base, input: raw }
}

// ── Results in words ────────────────────────────────────────────────────────────────────────────

function classify(job: Job): ShellResult['error'] | undefined {
  if (!job.done) return undefined
  if (job.killed) return { class: 'killed', detail: 'The process was terminated by a signal.' }
  const c = job.exitCode
  if (c === undefined || c === 0) return undefined
  if (c === 127) return { class: 'not-found', detail: 'Exit code 127: the command was not found.' }
  if (c === 126) return { class: 'permission', detail: 'Exit code 126: the command could not be executed (permission denied or not executable).' }
  return { class: 'nonzero', detail: `The command exited with code ${c}.` }
}

function buildResult(job: Job, taken: TakenOutput, handle: string | undefined): ShellResult {
  const r: ShellResult = {
    output: taken.output,
    outputTruncated: taken.outputTruncated,
    originalBytes: taken.originalBytes,
    wallMs: job.wallMs(),
  }
  if (handle !== undefined && !job.done) r.sessionId = handle
  if (job.done && job.exitCode !== undefined && !job.killed) r.exitCode = job.exitCode
  const err = classify(job)
  if (err) r.error = err
  return r
}

function secs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function statusLine(r: ShellResult, stopped = false): string {
  if (r.sessionId !== undefined) {
    return `[still running after ${secs(r.wallMs)} — handle ${r.sessionId}. shell.read shows more output and the exit status, shell.write sends it input, shell.stop ends it.]`
  }
  if (r.error?.class === 'killed') {
    return stopped
      ? `[stopped after ${secs(r.wallMs)} — the process and everything it started were terminated.]`
      : `[killed after ${secs(r.wallMs)} — the process group was terminated.]`
  }
  if (r.error) return `[exit code ${r.exitCode ?? '?'} after ${secs(r.wallMs)} — ${r.error.detail}]`
  return `[exit code ${r.exitCode ?? 0} · ${secs(r.wallMs)}]`
}

function modelText(r: ShellResult, stopped = false): string {
  const body = r.output === '' ? '(no output)' : r.output.replace(/\n$/, '')
  return `${body}\n\n${statusLine(r, stopped)}`
}

function outcomeOf(r: ShellResult, opts: { forceOk?: boolean; stopped?: boolean } = {}): ToolOutcome {
  const text = modelText(r, opts.stopped)
  const facts = r.exitCode !== undefined ? { exitCode: r.exitCode } : {}
  if (r.error && !opts.forceOk) {
    return { ok: false, modelText: text, error: { class: r.error.class, detail: statusLine(r) }, facts, result: r }
  }
  return { ok: true, modelText: text, facts, result: r }
}

function refusal(cls: 'not-found' | 'unavailable' | 'internal', sentence: string, result?: ShellResult): ToolOutcome {
  return { ok: false, modelText: sentence, error: { class: cls, detail: sentence }, ...(result ? { result } : {}) }
}

// ── The tool-set ────────────────────────────────────────────────────────────────────────────────

interface Handle {
  id: string
  job: Job
  proc: Spawned
  write(text: string): void
}

function cleanEnv(src: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) if (typeof v === 'string') env[k] = v
  // A non-interactive bash sources $BASH_ENV (and sh sources $ENV) before our first line: a user
  // rc that prints or reads stdin would corrupt the protocol.
  delete env.BASH_ENV
  delete env.ENV
  // A pager waiting for a keypress on a pipe is a command that never ends.
  env.PAGER = 'cat'
  env.GIT_PAGER = 'cat'
  return env
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

export function createShellTools(opts: ShellToolsOptions = {}): ShellTools {
  const launcher = opts.launcher ?? PASSTHROUGH_LAUNCHER
  const shell = opts.shell ?? '/bin/bash'
  const baseEnv = cleanEnv(opts.env ?? MINIMAL_TOOL_ENV)
  const now = opts.now ?? (() => new Date())
  const graceMs = opts.graceMs ?? 2_000
  const ttySize = opts.ttySize ?? { cols: 120, rows: 40 }

  let session: PipeSession | null = null
  /** The persistent session's directory as last reported by a marker (or where it was spawned). */
  let sessionCwd: string | undefined
  const handles = new Map<string, Handle>()
  const spawned = new Set<Spawned>()
  const groups = new Set<number>()
  let counter = 0
  let disposed = false
  let chain: Promise<unknown> = Promise.resolve()

  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  const register = (p: Spawned) => {
    spawned.add(p)
    groups.add(p.pgid)
    void p.exited.then(() => spawned.delete(p))
  }

  /** TERM the group, wait out the grace, KILL it, and make sure the job reads as ended. */
  const terminate = async (proc: Spawned, job: Job | null): Promise<void> => {
    if (job) job.stopRequested = true
    killGroup(proc.pgid, 'SIGTERM')
    await Promise.race([proc.exited, sleep(graceMs)])
    killGroup(proc.pgid, 'SIGKILL')
    await Promise.race([proc.exited, sleep(1_000)])
    if (job && !job.done) job.finish(undefined, true)
  }

  const baseCwd = async (ctx: ToolContext): Promise<string> =>
    sessionCwd !== undefined && (await isDir(sessionCwd)) ? sessionCwd : resolveToolPath(ctx.cwd, '.')

  /** Where the command will START — what the policy is asked about. */
  const startCwd = async (input: ShellStart, ctx: ToolContext): Promise<string> =>
    input.cwd !== undefined ? resolveToolPath(ctx.cwd, input.cwd) : baseCwd(ctx)

  const yieldHandle = (job: Job, proc: Spawned, write: (t: string) => void): string => {
    const id = `sh_${++counter}`
    handles.set(id, { id, job, proc, write })
    return id
  }

  const runPipe = async (input: ShellStart, cwd: string, ctx: ToolContext, yieldMs: number, maxOut: number): Promise<ToolOutcome> => {
    let s = session
    if (!s || !s.alive || s.busy) {
      session = null
      const base = await baseCwd(ctx)
      const plan = launcher.wrap({ argv: PipeSession.argv(shell), cwd: base, env: { ...baseEnv, TERM: 'dumb' } })
      if ('refused' in plan) return refusal('unavailable', plan.refused)
      try {
        s = new PipeSession(plan)
      } catch {
        return refusal('unavailable', `The shell ${shell} could not be started here, so the command did not run.`)
      }
      register(s)
      session = s
      sessionCwd = base
    }
    const sess = s
    const nonce = mintNonce()
    const job = new Job(input.command, false, sess.pgid, maxOut, now().toISOString())
    const line = controlLine(input.command, nonce, input.cwd !== undefined ? cwd : undefined)
    try {
      await sess.run(job, line, nonce, end => {
        if (session === sess) {
          if (end.pwd !== undefined) sessionCwd = end.pwd
        } else {
          // A yielded command finished: its shell is nobody's session any more, so let it exit.
          sess.endInput()
        }
      })
    } catch {
      session = null
      await terminate(sess, job)
      return refusal('internal', 'The command could not be handed to the shell session (it had exited). Nothing ran; the next call starts a fresh session.')
    }

    await job.wait(yieldMs, ctx.signal)
    if (!job.done && ctx.signal.aborted) {
      session = null
      await terminate(sess, job)
      return outcomeOf(buildResult(job, job.take(), undefined))
    }
    if (job.done) {
      if (!sess.alive) session = null // the command ended the shell itself (`exit`, a signal)
      return outcomeOf(buildResult(job, job.take(), undefined))
    }
    // Yield: this shell now belongs to the command; the next start gets a fresh one.
    session = null
    const id = yieldHandle(job, sess, t => sess.writeInput(t))
    return outcomeOf(buildResult(job, job.take(), id))
  }

  const runTty = async (input: ShellStart, cwd: string, ctx: ToolContext, yieldMs: number, maxOut: number): Promise<ToolOutcome> => {
    if (!ttyAvailable()) {
      return refusal('unavailable', 'A terminal (tty: true) is not available in this runtime: Bun.Terminal is missing. Run the command without tty.')
    }
    const plan = launcher.wrap({
      argv: [shell, '--noprofile', '--norc', '-c', input.command],
      cwd,
      env: { ...baseEnv, TERM: 'xterm-256color' },
    })
    if ('refused' in plan) return refusal('unavailable', plan.refused)
    let job: Job | undefined
    let run: TtyRun
    try {
      run = new TtyRun(plan, pgid => (job = new Job(input.command, true, pgid, maxOut, now().toISOString())), ttySize)
    } catch {
      return refusal('unavailable', `The shell ${shell} could not be started on a terminal here, so the command did not run.`)
    }
    register(run)
    const j = job!
    await j.wait(yieldMs, ctx.signal)
    if (!j.done && ctx.signal.aborted) {
      await terminate(run, j)
      return outcomeOf(buildResult(j, j.take(), undefined))
    }
    if (j.done) return outcomeOf(buildResult(j, j.take(), undefined))
    const id = yieldHandle(j, run, t => run.writeInput(t))
    return outcomeOf(buildResult(j, j.take(), id))
  }

  const unknownHandle = (id: string) =>
    refusal('not-found', `There is no shell session "${id}" in this run (it may have finished and been read already, or been stopped).`)

  const start = defineTool<ShellStart>({
    name: 'shell.start',
    description:
      'Run a shell command in a persistent bash session (cd, export and functions carry over to the next call). ' +
      '"cwd" runs this one call in that directory and returns the session to where it was, unless the command itself cds. ' +
      'A command still running after "yieldMs" (default 10000) returns a sessionId handle and the output so far; use shell.read, shell.write and shell.stop with it. ' +
      '"tty": true runs the command alone on a terminal (it does not share the session\'s exports or directory).',
    kind: 'shell',
    permission: 'ask',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command; may be a chain or a pipeline.' },
        cwd: { type: 'string', description: 'Directory for this call only. Defaults to the session\'s current directory.' },
        tty: { type: 'boolean', description: 'Run on a pseudo-terminal. Default false (pipes).' },
        yieldMs: { type: 'number', description: 'How long to wait before returning a handle. Default 10000.' },
        maxOutputBytes: { type: 'number', description: `Output budget; the middle is cut beyond it. Default ${DEFAULT_MAX_OUTPUT_BYTES}.` },
      },
      required: ['command'],
      additionalProperties: false,
    },
    parse: parseStart,
    subjects: async (input, ctx) => [{ action: 'shell', command: input.command, cwd: await startCwd(input, ctx), tty: input.tty === true }],
    run: async (input, ctx) => {
      if (disposed) return refusal('unavailable', 'This shell tool-set has been disposed with its session; nothing ran.')
      const cwd = await startCwd(input, ctx)
      if (!(await isDir(cwd))) return refusal('not-found', `The directory ${cwd} does not exist, so the command did not run.`)
      const yieldMs = input.yieldMs ?? DEFAULT_YIELD_MS
      const maxOut = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
      if (input.tty === true) return runTty(input, cwd, ctx, yieldMs, maxOut)
      return withLock(() => runPipe(input, cwd, ctx, yieldMs, maxOut))
    },
  })

  const read = defineTool<ShellRead>({
    name: 'shell.read',
    description: 'Read new output from a running shell handle; waits up to "yieldMs" (default 1000) for it to finish. Reports the exit status once it has.',
    kind: 'shell',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        yieldMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    parse: i => parsePoll(i, 'shell.read'),
    subjects: async i => [{ action: 'shell-control', shellId: i.sessionId, verb: 'read' }],
    run: async (input, ctx) => {
      const h = handles.get(input.sessionId)
      if (!h) return unknownHandle(input.sessionId)
      await h.job.wait(input.yieldMs ?? DEFAULT_POLL_YIELD_MS, ctx.signal)
      const r = buildResult(h.job, h.job.take(input.maxOutputBytes), h.id)
      if (h.job.done) handles.delete(h.id)
      return outcomeOf(r)
    },
  })

  const write = defineTool<ShellWrite>({
    name: 'shell.write',
    description: 'Write to the stdin of a running shell handle (include "\\n" to end a line), then return new output, waiting up to "yieldMs" (default 1000).',
    kind: 'shell',
    permission: 'ask',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        input: { type: 'string' },
        yieldMs: { type: 'number' },
        maxOutputBytes: { type: 'number' },
      },
      required: ['sessionId', 'input'],
      additionalProperties: false,
    },
    parse: parseWrite,
    subjects: async i => [{ action: 'shell-input', shellId: i.sessionId, bytes: Buffer.byteLength(i.input) }],
    run: async (input, ctx) => {
      const h = handles.get(input.sessionId)
      if (!h) return unknownHandle(input.sessionId)
      if (h.job.done) {
        handles.delete(h.id)
        const r = buildResult(h.job, h.job.take(input.maxOutputBytes), h.id)
        return refusal('not-found', `The process behind ${h.id} has already ended, so the input was not delivered.\n\n${modelText(r)}`, r)
      }
      try {
        h.write(input.input)
      } catch {
        return refusal('internal', `The input could not be written to ${h.id}; its process may be closing.`)
      }
      await h.job.wait(input.yieldMs ?? DEFAULT_POLL_YIELD_MS, ctx.signal)
      const r = buildResult(h.job, h.job.take(input.maxOutputBytes), h.id)
      if (h.job.done) handles.delete(h.id)
      return outcomeOf(r)
    },
  })

  const stop = defineTool<ShellStop>({
    name: 'shell.stop',
    description: 'Terminate a running shell handle and everything it started (SIGTERM, then SIGKILL after a grace period).',
    kind: 'shell',
    permission: 'auto',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    parse: i => {
      const o = reqSessionId(i, 'shell.stop')
      return typeof o === 'string' ? o : { sessionId: o.sessionId as string }
    },
    subjects: async i => [{ action: 'shell-control', shellId: i.sessionId, verb: 'stop' }],
    run: async input => {
      const h = handles.get(input.sessionId)
      if (!h) return unknownHandle(input.sessionId)
      const wasRunning = !h.job.done
      if (wasRunning) await terminate(h.proc, h.job)
      handles.delete(h.id)
      const r = buildResult(h.job, h.job.take(), undefined)
      return outcomeOf(r, { forceOk: true, stopped: wasRunning })
    },
  })

  return {
    start,
    read,
    write,
    stop,
    async dispose() {
      disposed = true
      session?.endInput()
      session = null
      const procs = [...spawned]
      for (const pg of groups) killGroup(pg, 'SIGTERM')
      await Promise.race([Promise.all(procs.map(p => p.exited)), sleep(graceMs)])
      // Signal every group again, leader alive or not: a background child outlives its bash.
      for (const pg of groups) killGroup(pg, 'SIGKILL')
      await Promise.race([Promise.all(procs.map(p => p.exited)), sleep(1_000)])
      for (const h of handles.values()) if (!h.job.done) h.job.finish(undefined, true)
      handles.clear()
      groups.clear()
    },
    sessions() {
      return [...handles.values()].map(h => ({
        sessionId: h.id,
        command: h.job.command,
        tty: h.job.tty,
        pid: h.job.pgid,
        running: !h.job.done,
        startedAt: h.job.startedAt,
      }))
    },
  }
}
