/**
 * cli-code.ts — `agentop code` (D24, B4.4): the terminal front door onto a native session.
 *
 * Spec: docs/superpowers/specs/2026-09-27-runtime-b4-sessions.md §6. `agentop code [prompt]`
 * starts a NEW session in the workspace of the current (or `--cwd`) directory; `agentop code
 * --resume <id> [prompt]` repairs and continues one already on disk; `agentop code ls` lists them.
 *
 * ## Why this module builds its own `content`/`journal`, not only a `RuntimeHost`
 *
 * `--resume` needs `openSession` / `repairInterruptedRun` (`session/resume.ts`), whose deps are
 * `{store, content, journal, runtimeVersion}` — the host's OWN instances (`RuntimeHost.content` /
 * `.journal` / `.runtimeVersion`), so a repair reads and writes through the very objects the runtime
 * uses. `CodeRuntimeHost` keeps them as separate fields only so a test can inject its own.
 *
 * ## TerminalAsker
 *
 * A plain `PersonAsker` (never a `HubAsker`): `runtime.run()`'s `asker` is called DIRECTLY by the
 * policy/loop, not through the hub's `ask`/`ask-closed` frames (those exist for a HubAsker's own
 * `ask()` implementation, which this module does not use) — so the terminal is asked without any
 * frame ever crossing the hub. `createRuntimeHost({ askerFor })` is given a factory that always
 * returns this same asker, because there is exactly one person at one terminal for the life of one
 * `agentop code` process.
 *
 * ## Streaming
 *
 * The hub IS used for reading: one `host.hub.watch(sessionId)` per submitted prompt prints `delta`
 * text as it arrives and one line per tool call (from the `tool.requested`/`tool.completed`/
 * `tool.failed`/`tool.denied` events) — never the tool's own text. It is safe to read the watcher
 * only up to the moment `runtime.run()` resolves and then `close()` it: `hub.publish()` is called
 * SYNCHRONOUSLY inside `emit()`'s `journal.append()` (see `runtime.ts`'s `createTeeJournal`),
 * before `run()`'s own `await emit(runEndedEvent(...))` resolves — so every frame of a run is
 * already delivered to (or queued on) the watcher by the time `run()` returns, and `next()` drains
 * anything still queued before honouring a `close()` (`hub.ts`'s `deliverOrQueue`/`detach`). A
 * fresh watcher is opened per prompt rather than kept open across the whole CLI session, which is
 * simpler than reconciling a long-lived watcher with the driver loop's own read of `runtime.run()`.
 */
import type {
  AnyAgentisticsEvent,
} from '@agentistics/core'
import {
  openSession,
  repairInterruptedRun,
  type PersonAnswer,
  type PersonAsker,
  type PersonQuestion,
  type PolicySubject,
  type ProviderJournalSink,
  type ProviderMessage,
  type RunOutcome,
  type SessionContentStore,
  type SessionWatcher,
} from '@agentistics/runtime'
import { PROVIDER_FLAG_ENV, providerFlagOn } from './config.ts'
import { createRuntimeHost, workspaceRootFor, type RuntimeHost } from './runtime-host.ts'

// ── The host seam this module needs beyond `RuntimeHost` (module doc) ──────────────────────────

export interface CodeRuntimeHost {
  host: RuntimeHost
  content: SessionContentStore
  /** `null` when no journal could be opened — repairs/runs are then counted lost, never thrown. */
  journal: ProviderJournalSink | null
  runtimeVersion: string
  /** Closes whatever this factory opened beyond what `host.dispose()` already closes — a journal
   *  `createRuntimeHost` did not open itself never gets closed by its own `dispose()` (it only
   *  closes a journal it opened via its own `opts.journal === undefined` branch). Absent: nothing
   *  extra to close (the default case for a test's in-memory recorder). */
  close?: () => void
}

export type CodeHostFactory = (askerFor: (sessionId: string) => PersonAsker) => Promise<CodeRuntimeHost>

async function defaultHost(askerFor: (sessionId: string) => PersonAsker): Promise<CodeRuntimeHost> {
  const host = await createRuntimeHost({ askerFor })
  return { host, content: host.content, journal: host.journal, runtimeVersion: host.runtimeVersion }
}

// ── CLI deps (every side effect injectable — offline tests drive the whole surface) ────────────

export interface CodeCliDeps {
  /** Builds the runtime host for this invocation, wired with the given per-session asker. */
  host: CodeHostFactory
  /** A whole line, newline appended. */
  stdout: (line: string) => void
  stderr: (line: string) => void
  /** Raw streamed text — no newline added (model deltas, the "> " prompt). */
  write: (chunk: string) => void
  /** Whether the terminal can be read from AND is a real interactive tty — never re-read from
   *  `process.stdin` more than once per call, so a test can simulate "piped"/"driven" without a
   *  real terminal (same rule `cli-provider.ts`'s `stdinIsTTY` states). */
  isTty: boolean
  cwd: string
  now: () => Date
  /** One line of stdin, trailing `\n`/`\r\n` stripped, or `null` on EOF. Shared by the interactive
   *  prompt loop and by every `TerminalAsker.ask()` — a real terminal has exactly one stdin. */
  readLine: () => Promise<string | null>
  /** How long `TerminalAsker` waits for an answer before treating it as unanswered. Default 5 min. */
  askTimeoutMs: number
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (h: ReturnType<typeof setTimeout>) => void
  /** Subscribes a SIGINT handler for the life of one drive loop; returns the unsubscribe. Default
   *  wires the real `process`. Injected so nothing here ever has to raise a real signal. */
  onInterrupt: (handler: () => void) => () => void
  /** `providerFlagOn()` — the native runtime's BETA flag (`AGENTISTICS_PROVIDER`). Absent reads OFF. */
  flagOn: () => boolean
}

const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000

let sharedStdinLines: { next(): Promise<string | null> } | null = null

/** The real stdin reader, built once and shared for the life of the process — a second
 *  `readline.Interface` over the same `process.stdin` would race the first for every line. */
function defaultReadLine(): Promise<string | null> {
  if (!sharedStdinLines) {
    // Loaded lazily so a test that never touches the default never pays for `node:readline`.
    const { createInterface } = require('node:readline') as typeof import('node:readline')
    const rl = createInterface({ input: process.stdin, terminal: false })
    const pending: Array<(line: string | null) => void> = []
    const buffered: string[] = []
    let closed = false
    rl.on('line', (line: string) => {
      const waiter = pending.shift()
      if (waiter) waiter(line)
      else buffered.push(line)
    })
    rl.on('close', () => {
      closed = true
      for (const waiter of pending.splice(0)) waiter(null)
    })
    sharedStdinLines = {
      next(): Promise<string | null> {
        if (buffered.length > 0) return Promise.resolve(buffered.shift() as string)
        if (closed) return Promise.resolve(null)
        return new Promise((resolve) => pending.push(resolve))
      },
    }
  }
  return sharedStdinLines.next()
}

function defaultDeps(): CodeCliDeps {
  return {
    flagOn: () => providerFlagOn(),
    host: defaultHost,
    stdout: (line) => { process.stdout.write(`${line}\n`) },
    stderr: (line) => { process.stderr.write(`${line}\n`) },
    write: (chunk) => { process.stdout.write(chunk) },
    isTty: Boolean(process.stdin.isTTY),
    cwd: process.cwd(),
    now: () => new Date(),
    readLine: defaultReadLine,
    askTimeoutMs: DEFAULT_ASK_TIMEOUT_MS,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    onInterrupt: (handler) => {
      process.on('SIGINT', handler)
      return () => { process.off('SIGINT', handler) }
    },
  }
}

// ── TerminalAsker: print the question, read ONE line, never auto-approve ───────────────────────

function subjectLine(s: PolicySubject): string {
  switch (s.action) {
    case 'read': return `read ${s.path}`
    case 'write': return `write (${s.op}) ${s.path}`
    case 'shell': return `run in ${s.cwd}: ${s.command}`
    case 'shell-input': return `send input to a running shell (${s.bytes} bytes)`
    case 'shell-control': return `${s.verb} a shell this run started`
    case 'git-read': return `git ${s.verb} in ${s.repo}`
    case 'plan': return 'update the plan'
    case 'ask-user': return 'ask you a question'
  }
}

type ReadOutcome =
  | { kind: 'line'; text: string }
  | { kind: 'eof' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }

/** Races one `readLine()` against the ask timeout and (if given) the run's own cancellation —
 *  whichever settles first wins; the loser's eventual resolution is silently ignored. */
function raceReadLine(d: CodeCliDeps, signal?: AbortSignal): Promise<ReadOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof d.setTimeout> | undefined
    let onAbort: (() => void) | undefined

    function finish(o: ReadOutcome): void {
      if (settled) return
      settled = true
      if (timer !== undefined) d.clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      resolve(o)
    }

    d.readLine().then((line) => finish(line === null ? { kind: 'eof' } : { kind: 'line', text: line }))
    timer = d.setTimeout(() => finish({ kind: 'timeout' }), d.askTimeoutMs)
    if (signal) {
      onAbort = () => finish({ kind: 'aborted' })
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * A `PersonAsker` that prints the question, its subjects and its numbered options, reads ONE line
 * from `d.readLine()`, and answers `{answered:true, choice}` only for a valid 1-based number.
 * EOF, no tty, an empty line, a non-numeric or out-of-range answer, an abort, or the ask timeout
 * are all `answered:false` — never option 0 by default, never a guess.
 */
export function createTerminalAsker(d: CodeCliDeps): PersonAsker {
  return {
    async ask(question: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer> {
      d.stdout('')
      for (const line of question.text.split('\n')) d.stdout(line)
      if (question.subjects) for (const s of question.subjects) d.stdout(`  · ${subjectLine(s)}`)
      question.options.forEach((opt, i) => {
        d.stdout(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
      })

      if (!d.isTty) {
        d.stdout('(no terminal attached to answer this — denying)')
        return { answered: false, reason: 'unavailable' }
      }
      if (signal?.aborted) return { answered: false, reason: 'cancelled' }

      d.write('> ')
      const outcome = await raceReadLine(d, signal)
      if (outcome.kind === 'aborted') {
        d.stdout('(cancelled — denying)')
        return { answered: false, reason: 'cancelled' }
      }
      if (outcome.kind === 'eof') {
        d.stdout('(no answer — denying)')
        return { answered: false, reason: 'unavailable' }
      }
      if (outcome.kind === 'timeout') {
        d.stdout('(timed out — denying)')
        return { answered: false, reason: 'timeout' }
      }
      const trimmed = outcome.text.trim()
      const n = Number(trimmed)
      if (trimmed === '' || !Number.isInteger(n) || n < 1 || n > question.options.length) {
        d.stdout('(not a valid option — denying)')
        return { answered: false, reason: 'cancelled' }
      }
      return { answered: true, choice: n - 1 }
    },
  }
}

// ── Streaming a run: delta text + one line per tool call, never the tool content ────────────────

function eventLine(toolNames: Map<string, string>, ev: AnyAgentisticsEvent): string | null {
  switch (ev.type) {
    case 'tool.completed': {
      const name = toolNames.get(ev.data.toolExecutionId) ?? ev.data.toolExecutionId
      return `  ✓ ${name}`
    }
    case 'tool.failed': {
      const name = toolNames.get(ev.data.toolExecutionId) ?? ev.data.toolExecutionId
      return `  ✗ ${name} (${ev.data.status})`
    }
    case 'tool.denied': {
      const name = toolNames.get(ev.data.toolExecutionId) ?? ev.data.toolExecutionId
      return `  ✗ ${name} (denied)`
    }
    default:
      return null
  }
}

interface PumpState {
  sawText: boolean
}

async function pumpFrames(watcher: SessionWatcher, d: CodeCliDeps, toolNames: Map<string, string>, state: PumpState): Promise<void> {
  for await (const frame of watcher) {
    if (frame.kind === 'delta') {
      d.write(frame.text)
      state.sawText = true
      continue
    }
    if (frame.kind === 'event') {
      const ev = frame.event as AnyAgentisticsEvent
      if (ev.type === 'tool.requested') toolNames.set(ev.data.toolExecutionId, ev.data.name)
      const line = eventLine(toolNames, ev)
      if (line !== null) {
        if (state.sawText) { d.write('\n'); state.sawText = false }
        d.stdout(line)
      }
      continue
    }
    if (frame.kind === 'closed') return
    // ack / ask / ask-closed / gap / hello: nothing this module prints here — `ask` is answered
    // directly by `createTerminalAsker`, never read off the hub (module doc).
  }
}

/** Runs one prompt to completion, printing as it goes, and returns the loop's outcome. */
async function runOnePrompt(
  host: RuntimeHost,
  sessionId: string,
  promptText: string,
  d: CodeCliDeps,
  activeAbort: { current: AbortController | null },
): Promise<RunOutcome> {
  const watcher = host.hub.watch(sessionId)
  const toolNames = new Map<string, string>()
  const state: PumpState = { sawText: false }
  const pumpPromise = pumpFrames(watcher, d, toolNames, state)

  const ac = new AbortController()
  activeAbort.current = ac
  let outcome: RunOutcome
  try {
    outcome = await host.runtime.run(sessionId, promptText, { signal: ac.signal })
  } finally {
    activeAbort.current = null
    watcher.close()
    await pumpPromise
  }
  if (state.sawText) d.write('\n')
  return outcome
}

function reportOutcome(d: CodeCliDeps, outcome: RunOutcome): number {
  if (!outcome.ok) {
    d.stderr(outcome.sentence)
    return 1
  }
  if (outcome.status === 'failed') {
    d.stderr(outcome.sentence)
    return 1
  }
  if (outcome.status === 'abandoned') {
    d.stdout(`(cancelled: ${outcome.sentence})`)
    return 0
  }
  return 0
}

// ── The banner (B3-SEC F5) + a resumed session's recent turns ──────────────────────────────────

function printBanner(d: CodeCliDeps, workspaceRoot: string, sessionId: string): void {
  d.stdout(`no sandbox: tools run as you, in ${workspaceRoot}. Everything not allowlisted asks you first.`)
  d.stdout(`session ${sessionId} — resume with \`agentop code --resume ${sessionId}\``)
}

const RECENT_TURNS_SHOWN = 6
const TURN_LINE_MAX = 160

function textOfPart(content: ProviderMessage['content']): string {
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const p of content) {
    if (p.type === 'text') parts.push(p.text)
    else if (p.type === 'tool_use') parts.push(`[used ${p.name}]`)
    else if (p.type === 'tool_result') parts.push('[tool result]')
  }
  return parts.join(' ')
}

function truncateOneLine(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > TURN_LINE_MAX ? `${oneLine.slice(0, TURN_LINE_MAX - 3)}...` : oneLine
}

function printRecentTurns(d: CodeCliDeps, messages: readonly { seq: number; message: ProviderMessage }[]): void {
  if (messages.length === 0) return
  const tail = messages.slice(-RECENT_TURNS_SHOWN)
  d.stdout('')
  d.stdout(`— last ${tail.length} turn${tail.length === 1 ? '' : 's'} —`)
  for (const { message } of tail) {
    const who = message.role === 'user' ? 'you' : 'assistant'
    const text = truncateOneLine(textOfPart(message.content)) || '(no text)'
    d.stdout(`${who}: ${text}`)
  }
  d.stdout('—')
}

// ── The drive loop: single-shot off a tty, interactive on one ──────────────────────────────────

async function drive(host: RuntimeHost, sessionId: string, initialPrompt: string | undefined, d: CodeCliDeps): Promise<number> {
  const activeAbort: { current: AbortController | null } = { current: null }
  let pressCount = 0
  const stop = d.onInterrupt(() => {
    pressCount += 1
    if (activeAbort.current) activeAbort.current.abort()
  })

  try {
    if (!d.isTty) {
      if (initialPrompt === undefined) {
        d.stderr('agentop code: no prompt given and stdin is not a terminal.')
        return 2
      }
      const outcome = await runOnePrompt(host, sessionId, initialPrompt, d, activeAbort)
      return reportOutcome(d, outcome)
    }

    let pending = initialPrompt
    let lastCode = 0
    for (;;) {
      let prompt: string
      if (pending !== undefined) {
        prompt = pending
        pending = undefined
      } else {
        if (pressCount >= 2) break
        d.write('> ')
        const line = await d.readLine()
        if (line === null) { d.stdout(''); break }
        const trimmed = line.trim()
        if (trimmed === '') continue
        if (trimmed === '/exit') break
        prompt = trimmed
      }
      pressCount = 0
      const outcome = await runOnePrompt(host, sessionId, prompt, d, activeAbort)
      lastCode = reportOutcome(d, outcome)
      if (pressCount >= 2) break
    }
    return lastCode
  } finally {
    stop()
  }
}

// ── Argument parsing ─────────────────────────────────────────────────────────────────────────

interface CodeArgsNew { kind: 'new'; model?: string; cwd?: string; prompt?: string }
interface CodeArgsResume { kind: 'resume'; sessionId: string; prompt?: string }
type CodeArgs = CodeArgsNew | CodeArgsResume

type ParseResult = { ok: true; args: CodeArgs } | { ok: false; message: string }

function parseCodeArgs(args: string[]): ParseResult {
  let model: string | undefined
  let cwd: string | undefined
  let resume: string | undefined
  const promptParts: string[] = []

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!
    if (tok === '--model') {
      const v = args[++i]
      if (v === undefined) return { ok: false, message: 'agentop code: --model needs a value.' }
      model = v
    } else if (tok === '--cwd') {
      const v = args[++i]
      if (v === undefined) return { ok: false, message: 'agentop code: --cwd needs a directory.' }
      cwd = v
    } else if (tok === '--resume') {
      const v = args[++i]
      if (v === undefined) return { ok: false, message: 'agentop code: --resume needs a session id.' }
      resume = v
    } else if (tok.startsWith('--')) {
      return { ok: false, message: `agentop code: unknown flag "${tok}".` }
    } else {
      promptParts.push(tok)
    }
  }
  const prompt = promptParts.length > 0 ? promptParts.join(' ') : undefined

  if (resume !== undefined) {
    if (model !== undefined) return { ok: false, message: 'agentop code --resume: --model is not accepted when resuming — the session keeps its own model.' }
    if (cwd !== undefined) return { ok: false, message: 'agentop code --resume: --cwd is not accepted when resuming — the session keeps its own workspace.' }
    return { ok: true, args: { kind: 'resume', sessionId: resume, prompt } }
  }
  const out: CodeArgsNew = { kind: 'new' }
  if (model !== undefined) out.model = model
  if (cwd !== undefined) out.cwd = cwd
  if (prompt !== undefined) out.prompt = prompt
  return { ok: true, args: out }
}

// ── `agentop code` (new session) ────────────────────────────────────────────────────────────

async function runNewSession(args: CodeArgsNew, d: CodeCliDeps): Promise<number> {
  if (args.model === undefined) {
    // No default model is registered in `@agentistics/runtime`'s Anthropic provider module today
    // (checked at B4.4 time) — the task instructs: require `--model` rather than guess one.
    d.stderr('agentop code: no default model is registered for anthropic yet — pass --model <id> (e.g. --model claude-sonnet-5).')
    return 2
  }
  const cwd = args.cwd ?? d.cwd
  const workspaceRoot = workspaceRootFor(cwd)

  const terminalAsker = createTerminalAsker(d)
  const built = await d.host(() => terminalAsker)
  const { host } = built
  let leased = false
  let sessionId: string | undefined
  try {
    const session = await host.runtime.create({
      workspaceRoot,
      cwd,
      provider: 'anthropic',
      model: args.model,
      credential: { provider: 'anthropic', id: 'default' },
    })
    sessionId = session.sessionId

    const acquire = await host.acquire(sessionId)
    if (!acquire.ok) {
      d.stderr(acquire.sentence)
      return 1
    }
    leased = true

    printBanner(d, workspaceRoot, sessionId)
    return await drive(host, sessionId, args.prompt, d)
  } finally {
    if (sessionId !== undefined && leased) await host.release(sessionId).catch(() => {})
    await host.dispose().catch(() => {})
    built.close?.()
  }
}

// ── `agentop code --resume` ─────────────────────────────────────────────────────────────────

async function runResume(args: CodeArgsResume, d: CodeCliDeps): Promise<number> {
  const terminalAsker = createTerminalAsker(d)
  const built = await d.host(() => terminalAsker)
  const { host, content, journal, runtimeVersion } = built
  let leased = false
  try {
    const acquire = await host.acquire(args.sessionId)
    if (!acquire.ok) {
      d.stderr(acquire.sentence)
      return 1
    }
    leased = true

    const repair = await repairInterruptedRun({ store: host.store, content, journal, runtimeVersion, now: d.now }, args.sessionId)
    if (repair.repaired) d.stdout(repair.sentence)

    const opened = await openSession({ store: host.store, content }, args.sessionId)
    if (opened === null) {
      d.stderr(`No such session: ${args.sessionId}.`)
      return 1
    }

    printBanner(d, opened.session.workspaceRoot, args.sessionId)
    printRecentTurns(d, opened.messages)

    return await drive(host, args.sessionId, args.prompt, d)
  } finally {
    if (leased) await host.release(args.sessionId).catch(() => {})
    await host.dispose().catch(() => {})
    built.close?.()
  }
}

// ── `agentop code ls` ───────────────────────────────────────────────────────────────────────

const DEFAULT_LS_LIMIT = 20

async function runLs(rawArgs: string[], d: CodeCliDeps): Promise<number> {
  let limit: number | undefined
  for (let i = 0; i < rawArgs.length; i++) {
    const tok = rawArgs[i]!
    if (tok === '--limit') {
      const v = rawArgs[++i]
      const n = v === undefined ? Number.NaN : Number(v)
      if (!Number.isFinite(n) || n <= 0) {
        d.stderr('agentop code ls: --limit needs a positive number.')
        return 2
      }
      limit = Math.floor(n)
    } else if (tok === '--help' || tok === '-h') {
      d.stdout(LS_HELP)
      return 0
    } else {
      d.stderr(`agentop code ls: unknown argument "${tok}".`)
      return 2
    }
  }

  // `ls` never asks anything — a refusing asker makes that fact loud if it is ever reached anyway,
  // rather than a no-op that could silently auto-approve.
  const noAsker: PersonAsker = { ask: async () => ({ answered: false, reason: 'unavailable' }) }
  const built = await d.host(() => noAsker)
  try {
    const page = await built.host.store.listSessions({ limit: limit ?? DEFAULT_LS_LIMIT })
    if (page.sessions.length === 0) {
      d.stdout('No native sessions yet — start one with `agentop code`.')
      return 0
    }
    for (const s of page.sessions) {
      const label = s.title ?? s.model
      d.stdout(`${s.sessionId}  ${s.status.padEnd(6)}  ${s.updatedAt}  ${label}`)
    }
    if (page.nextBefore !== undefined) d.stdout('… more — pass a larger --limit to see further back.')
    return 0
  } finally {
    await built.host.dispose().catch(() => {})
    built.close?.()
  }
}

// ── Help + entry ─────────────────────────────────────────────────────────────────────────────

const HELP = `
Usage: agentop code [--model <id>] [--cwd <dir>] [prompt...]
       agentop code --resume <sessionId> [prompt...]
       agentop code ls [--limit <n>]

The terminal front door onto a native Agentistics session (BETA). Runs a conversation against the
Anthropic API using this machine's own stored key (see \`agentop provider key set\`), with every
tool call gated by the session's policy — a call that is not allowed outright ASKS you, right
here in the terminal (never auto-approved; no tty/no answer/timeout all deny).

  --model <id>   The model for a NEW session (required — there is no default yet).
  --cwd <dir>    Where the session works (default: the current directory). The session's
                 WORKSPACE is the git toplevel of this directory, or the directory itself
                 outside a repository.
  --resume <id>  Continue a session started earlier. Repairs a run a killed process left
                 unfinished, then shows the last few turns before continuing.

With a prompt and no terminal attached, runs once and exits. On a terminal, drops into an
interactive loop after any given prompt — type \`/exit\` or press Ctrl-D to leave; Ctrl-C
cancels a run in progress, a second Ctrl-C leaves.

agentop code ls        List native sessions (id, status, last update, title/model).
  --limit <n>          At most this many (default 20).
`.trim()

const LS_HELP = 'Usage: agentop code ls [--limit <n>]'

export async function runCode(args: string[], deps: Partial<CodeCliDeps> = {}): Promise<number> {
  const d: CodeCliDeps = { ...defaultDeps(), ...deps }

  if (args[0] === '--help' || args[0] === '-h') {
    d.stdout(HELP)
    return 0
  }
  if (args[0] === 'ls') return runLs(args.slice(1), d)
  // Refused BEFORE any session is created: with the flag off the key store answers "off" to every
  // credential lookup, and a session that exists only to fail its first model call is a lie on disk.
  if (!d.flagOn()) {
    d.stderr(`agentop code: the native runtime is off (BETA) — set ${PROVIDER_FLAG_ENV}=1 to use it.`)
    return 1
  }

  const parsed = parseCodeArgs(args)
  if (!parsed.ok) {
    d.stderr(parsed.message)
    return 2
  }
  if (parsed.args.kind === 'resume') return runResume(parsed.args, d)
  return runNewSession(parsed.args, d)
}
