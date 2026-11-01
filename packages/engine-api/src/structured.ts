/**
 * structured.ts — STRUCTURED sessions (1.10, ENGINE.MAP F2.0): ONE backend for every harness that has
 * an official machine protocol, driven by a per-harness DRIVER.
 *
 * Owner decisions this encodes (ENGINE.MAP 11 Q1, 09/10):
 * - a session agentistics starts FROM THE WEB runs structured when its harness has a driver and the
 *   `adapter-chat` flag is on; a terminal-born session stays a TUI in tmux, and "open in terminal" is a
 *   TUI resume of the SAME conversation id;
 * - the official protocol is the PRIMARY source for every session agentistics starts (turns, in-flight
 *   text, state, permission requests, questions); files and the screen are the fallback, for history
 *   and for sessions started outside agentistics;
 * - equal depth for every harness, no harness first: every member below is total over the harnesses a
 *   driver serves, and every capability is DECLARED — a source, or a sentence saying why not.
 *
 * Four drivers: `acp` (gemini, kimi, copilot; opencode stays a declared absence until F5),
 * `claude-stream-json`, `codex-app-server` and `agy-stream-json`. A driver that is not written yet is a
 * `stub`: it keeps the exact interface and refuses every start in a sentence, so the host falls back to
 * tmux exactly as it does for a failed start.
 *
 * Nothing here is journaled (D5): the deltas are the chat seam's (`HarnessChatDelta`, chat.ts), held in
 * memory while somebody follows the session.
 */
import type { HarnessChatDelta } from './chat'
import type { HarnessId } from './mirrors'

/** The protocol a driver speaks. */
export type StructuredDriverId = 'acp' | 'claude-stream-json' | 'codex-app-server' | 'agy-stream-json'

export const STRUCTURED_DRIVER_IDS: readonly StructuredDriverId[] = ['acp', 'claude-stream-json', 'codex-app-server', 'agy-stream-json']

/**
 * One capability of a driver for one harness: where the protocol carries it (`via`), or why not
 * (`absent`, one sentence citing the harness's own `--help` / protocol doc). Same "declared absence"
 * rule as `ChatFeature`; never assumed by the host.
 */
export type StructuredFeature = { via: string; absent?: undefined } | { via?: undefined; absent: string }

/**
 * The opening context (QUAL.8: the agentistics block injected at spawn). The official channel first —
 * a protocol field (`developerInstructions` on codex app-server's `thread/start`), a system-prompt flag
 * (`--append-system-prompt` on claude stream-json) — and ONLY when the harness has none, the hidden
 * first message, declared as a fallback with the reason cited.
 */
export type StructuredInstructions =
  | { channel: 'protocol' | 'flag'; via: string }
  | { channel: 'first-message'; reason: string }

/** What a driver can do for ONE harness. Declared once, per harness; the host reads it, never guesses. */
export interface StructuredDeclaration {
  /** The conversation id is chosen by agentistics at spawn (exact link from the first second). */
  assignId: StructuredFeature
  /** Resume an existing conversation by its id. */
  resume: StructuredFeature
  model: StructuredFeature
  effort: StructuredFeature
  /** MCP servers handed to the session at start (the agentistics MCP above all). */
  mcp: StructuredFeature
  /** The opening context channel (see `StructuredInstructions`). */
  instructions: StructuredInstructions
  /** `live` deltas: in-flight text chunks. */
  live: StructuredFeature
  /** Permission requests stated by the protocol (options + the person's choice back). */
  permissions: StructuredFeature
  /** Interactive questions with options and/or free text, stated by the protocol. */
  questions: StructuredFeature
  /** Cancel the turn in flight. */
  cancel: StructuredFeature
  /** 1.18 (optional) — `StructuredSpawn.forkOf`: how the protocol forks a conversation, or why it cannot. Absent = the driver says nothing (no fork offered). */
  fork?: StructuredFeature
  /**
   * Token usage the PROTOCOL states per turn (F2.1, additive and optional: a driver that says nothing
   * leaves the files / the harness's own store as the source of tokens, exactly as before).
   */
  usage?: StructuredFeature
  /**
   * F4.D (additive, optional) — the PERMISSION MODE: how the protocol states it and sets it (`via`), or
   * why it cannot. Absent = the driver says nothing about modes (the row keeps no chip, as before).
   */
  mode?: StructuredFeature
  /**
   * F4.D — the canonical modes a session can START in (`StructuredSpawn.mode`). A requested mode this
   * list lacks is not a structured session: the host starts the TUI, whose flags carry it (Antigravity's
   * print mode, for one, has no permission request at all, so it lists only `no-questions`).
   */
  startModes?: readonly CanonicalMode[]
  /** 1.21 — directed update, per phase. `replace`/`steer` cite the protocol call; absent = the fallback (`appended`). */
  amend?: { queued: StructuredFeature; running: StructuredFeature }
  /** 1.21 — what proves a cancel took, and how sure it is. */
  cancelReceipt?: StructuredFeature & { confidence?: 'exact' | 'inferred'; deadlineMs?: number }
  /** 1.21 — the protocol id that survives a crash (a message uuid, a client id), or why there is none. */
  reconcile?: StructuredFeature
}

/**
 * F4.D — the four modes the owner named for EVERY harness (New session's "Mode" field): ask before
 * acting, accept edits, plan, and no questions. Each harness's own modes map onto these where they mean
 * the same thing (`StructuredMode.canonical`); a harness mode that matches none (claude's `auto`) keeps
 * its own id and no canonical.
 */
export type CanonicalMode = 'default' | 'accept-edits' | 'plan' | 'no-questions'
export const CANONICAL_MODES: readonly CanonicalMode[] = ['default', 'accept-edits', 'plan', 'no-questions']

/** F4.D — one permission mode a session can be in, in the harness's OWN words. */
export interface StructuredMode {
  /** The id `setMode` takes (the protocol's own, or a short form of it). */
  id: string
  /** The harness's own name for it ("Auto Edit", "plan mode", "YOLO"). */
  label: string
  /** The canonical mode it means, when it means one exactly enough to be chosen for it. */
  canonical?: CanonicalMode
}

/**
 * Cumulative token usage a session's protocol has stated so far (F2.1). Counters a protocol does not
 * state are ABSENT, never 0 — the harness's store stays the source of the full breakdown.
 */
export interface StructuredUsage {
  /** Prompt turns whose end carried a usage statement. */
  turns: number
  input: number
  output: number
  /** Per model, when the protocol names it. */
  byModel?: Record<string, { input: number; output: number }>
}

/**
 * 1.21 — ADAPTER.LIMITES. A caller-chosen id for ONE ACTION (submit, amend, cancel, answer, set-mode, set-model);
 * a retry of the same action reuses it. ≤128 characters of `[A-Za-z0-9._:-]` — it is journaled verbatim, so it
 * carries no text and no secret. A request (`requestId`) and an action (`idempotencyKey`) are different things: one
 * request can have many actions.
 */
export type IdempotencyKey = string

export const IDEMPOTENCY_KEY_MAX = 128
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]+$/

/** PURE. Whether a string may be used as an `IdempotencyKey`. */
export function validIdempotencyKey(k: unknown): k is IdempotencyKey {
  return typeof k === 'string' && k.length > 0 && k.length <= IDEMPOTENCY_KEY_MAX && IDEMPOTENCY_KEY_RE.test(k)
}

/** 1.21 — where a request is now (`requestState`). */
export type StructuredRequestState = 'queued' | 'running' | 'finished' | 'cancelled' | 'unknown'

/** 1.21 — one request the caller names. */
export interface StructuredSubmit {
  /** Unique in the session (the voice's commit `requestId`). */
  requestId: string
  idempotencyKey: IdempotencyKey
  text: string
}

/** Why a submit is refused: a CLOSED list, never free text. */
export const SUBMIT_REFUSED_REASONS = ['session-ended', 'queue-full', 'attention-open', 'key-conflict', 'empty'] as const
export type SubmitRefusedReason = typeof SUBMIT_REFUSED_REASONS[number]
/** Why an amend is refused: a CLOSED list. */
export const AMEND_REFUSED_REASONS = ['finished', 'unknown-request', 'session-ended', 'key-conflict'] as const
export type AmendRefusedReason = typeof AMEND_REFUSED_REASONS[number]

/**
 * Shared by every receipt. `replayed`: this is the recorded answer to an earlier call with the same key. `durable`:
 * the key is journaled, so a repeat after a crash is recognised; `false` (journal off) means a crash makes the
 * acceptance UNCERTAIN, and the caller must treat it so.
 */
interface ReceiptBase { requestId: string; at: string; replayed?: true }

export type StructuredSubmitReceipt =
  | (ReceiptBase & { state: 'queued' | 'started'; durable: boolean })
  | (ReceiptBase & { state: 'refused'; reason: SubmitRefusedReason; durable: boolean })
  /** A claimed key with no evidence either way after a crash. Never re-run by itself; the caller decides. */
  | (ReceiptBase & { state: 'in-doubt'; durable: true })

export type StructuredAmendResult =
  /** `replaced`: the queued request's text was swapped before the model saw it. `steered`: the model gets it mid-turn. */
  | (ReceiptBase & { result: 'amended'; how: 'replaced' | 'steered'; durable: boolean })
  /** No replace/steer here: the correction is queued as the carrier request (framed as a correction), after the running turn. */
  | (ReceiptBase & { result: 'appended'; carrierRequestId: string; reason: string; durable: boolean })
  | (ReceiptBase & { result: 'refused'; reason: AmendRefusedReason; durable: boolean })
  | (ReceiptBase & { result: 'in-doubt'; durable: true })

export type StructuredCancelReceipt =
  | (ReceiptBase & {
      state: 'cancelled' | 'already-finished' | 'unconfirmed'
      /** `queued`: withdrawn before the model saw it. `running`: stopped mid-turn. */
      phase?: 'queued' | 'running'
      confidence: 'exact' | 'inferred'
      /** `turn`: the stop ended more than this request (claude merges queued prompts into one turn). */
      scope: 'request' | 'turn'
      /** The other requests that same stop ended. */
      alsoEnded?: readonly string[]
      /** `possible`: tools ran before the stop and their effects are NOT undone. */
      effects: 'none' | 'possible'
      durable: boolean
    })
  | (ReceiptBase & { state: 'in-doubt'; durable: true })

/** A driver's state in this build. `stub` = the interface exists, every start is refused in a sentence. */
export type StructuredDriverStatus = 'ready' | 'stub'

export interface StructuredDriverInfo {
  id: StructuredDriverId
  status: StructuredDriverStatus
  /** The harnesses this driver serves (a harness is served by at most ONE driver). */
  harnesses: readonly HarnessId[]
  /** Why it is a stub, or what it was verified against. */
  note: string
}

/** One MCP server for the session (ACP `mcpServers`, claude `--mcp-config`, codex `mcp_servers`, …). */
export interface StructuredMcpServer {
  name: string
  command: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
}

/** What the host asks a driver to start. The driver applies what its declaration says it can. */
export interface StructuredSpawn {
  /** The host's managed session id. */
  id: string
  harness: HarnessId
  cwd: string
  model?: string
  effort?: string
  /** A conversation id to ASSIGN (a fresh session; ignored beside `resumeId` and where `assignId` is absent). */
  conversationId?: string
  /** Resume this conversation instead of starting a fresh one. */
  resumeId?: string
  /**
   * 1.18 — FORK this conversation: the session that opens is a NEW conversation carrying `forkOf`'s history
   * (ACP `session/fork`), and its id is the one the driver states. Only a driver whose declaration offers it
   * (`forks`) takes it; any other refuses in a sentence. Beside `resumeId`, the fork wins.
   */
  forkOf?: string
  /** The first prompt, sent once the session is open. */
  initialPrompt?: string
  /**
   * The opening context (QUAL.8), through `declares(h).instructions`: `text` for an official channel
   * (protocol field / system-prompt flag), `block` — the fenced form — for the first-message fallback,
   * where the driver sends it ahead of the person's FIRST words — never as a message of its own, which the
   * model would answer (F2.1) — and the chat hides it as context.
   * Ignored beside `resumeId`: a reopened conversation already has it.
   */
  instructions?: { text: string; block: string }
  mcp?: readonly StructuredMcpServer[]
  /**
   * Extra environment for the child, over the inherited one (a context-file directory, …). It may be
   * passed on the child's command line (`env(1)`: the engine reads no environment of its own), so it
   * NEVER carries a secret — those reach a session through the vault's references.
   */
  env?: Readonly<Record<string, string>>
  /**
   * F4.D — the canonical mode to START in. Absent = the harness's own default (its config decides). A
   * driver honours only what `declares(h).startModes` lists; the host never sends anything else.
   */
  mode?: CanonicalMode
  /** 1.20 — the language of the person's screen, for the few sentences a driver writes into the chat itself. Absent = English. */
  lang?: 'en' | 'pt'
  /**
   * F2.0b — WHERE the child process runs. When present, the driver starts its protocol peer through
   * `transport.launch(...)` instead of spawning it itself, and speaks to it only through the returned
   * pipe. The host uses it to keep the child alive across a server restart (a detached relay that holds
   * the child's stdio) and to re-attach to it afterwards by REPLAYING what the pipe carried — so the
   * driver must be deterministic over its pipe: the same lines read and the same calls made produce
   * the same lines written (no timers, no randomness in what it writes). Absent: the driver spawns as
   * before. Every driver honours it the same way; it is never a per-harness choice.
   */
  transport?: StructuredTransport
}

/**
 * F2.0b — one child process's stdio, as a driver speaks to it. Newline-delimited: every protocol a
 * driver speaks here (ACP, claude stream-json, codex app-server, agy stream-json) is one JSON value per
 * line. Structurally the engine's own `AcpLaunch`.
 */
export interface StructuredPipe {
  /** Text from the child's stdout. */
  source: AsyncIterable<string>
  /** One write to the child's stdin (a whole line, `\n` included). */
  write(line: string): void
  kill(): void
  /** The child's exit code; null when it could not be read (the relay went away). */
  exited: Promise<number | null>
  /**
   * The instant the line being read ARRIVED, in ms. During a replay it is the original arrival time,
   * so a turn rebuilt on re-attach keeps its real timestamp; absent (or live) it is now. A driver that
   * stamps turns reads it instead of its own clock.
   */
  now?(): number
}

/** F2.0b — the host's way of starting a driver's child (see `StructuredSpawn.transport`). */
export interface StructuredTransport {
  /**
   * Start the driver's child. 1.14 — may be called AGAIN once the driver has `kill()`ed the previous
   * pipe (a cancel that has to end the child): each call is a generation, sequential, never concurrent.
   * The host starts the new child only after the old one exited (writes made meanwhile are held and
   * delivered in order), keeps the session alive between children, and on re-attach hands the
   * re-created driver the same sequence of generations. A launch while the previous child runs and was
   * not killed by the driver THROWS.
   */
  launch(bin: string, args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>): StructuredPipe
}

export type StructuredActivity = 'starting' | 'working' | 'waiting' | 'waiting-approval' | 'exited'

/** One option of a pending request, in the protocol's order (answered by its 1-based number). */
export interface StructuredOption {
  /** The protocol's own id (`allow_once`, `approve_always`, an option index, …). */
  id: string
  label: string
  /** The protocol's kind when it states one (`allow_once`, `reject_once`, …) — never a guess. */
  kind?: string
  /** Picking this option means typing an answer (claude's "Type something", a codex free-form reply). */
  freeText?: boolean
}

/** A request waiting on a person, stated by the protocol. */
export interface StructuredAttention {
  /** The protocol's request id (a JSON-RPC id, a tool-use id): an answer names it. */
  requestId: string
  kind: 'permission' | 'question'
  /** The line the protocol shows the person (a tool title, the question). */
  prompt?: string
  options: StructuredOption[]
  /** The request accepts a typed answer with no option (a question with free text). */
  freeText?: boolean
  /**
   * 1.13 — the question takes SEVERAL options at once (claude's `AskUserQuestion` `multiSelect`). Its
   * answer is `StructuredAnswer.choices`. Absent: one option, as before.
   */
  multiSelect?: true
  /**
   * 1.13 — this question's place in a FORM of several (claude's `AskUserQuestion` with N questions,
   * asked one at a time): `{ at: 2, of: 3 }`. Absent on a lone question.
   */
  step?: { at: number; of: number }
}

/**
 * The person's answer. `choice` is 1-based over `StructuredAttention.options`; `text` rides with a
 * `freeText` option, or alone when the request accepts free text. `requestId`, when given, must match
 * the open request — an answer to a request that has since changed is refused, never re-targeted.
 */
export interface StructuredAnswer {
  requestId?: string
  choice?: number
  /**
   * 1.13 — every option picked on a `multiSelect` request, 1-based, in any order, no repeats. `text`
   * rides with a picked `freeText` option. A single-select request refuses it; a host older than 1.13
   * never sends it, and a `multiSelect` request still accepts a lone `choice`.
   */
  choices?: number[]
  text?: string
}

/** Why a session ended, as far as the driver knows. `failed` makes the host fall back to tmux. */
export type StructuredExit = { kind: 'disposed' } | { kind: 'ended' } | { kind: 'failed'; reason: string }

/** One running structured session. Every method is total: it never throws. */
export interface StructuredSession {
  readonly id: string
  readonly driver: StructuredDriverId
  readonly harness: HarnessId
  /**
   * The conversation id in the form the harness's STORE keys on (what `harness-transcript.ts` and the
   * metrics adapters read) — so the row links exactly and "open in terminal" resumes it. `null` until
   * the protocol has said it.
   */
  conversationId(): string | null
  activity(): StructuredActivity
  /** The open request, or null. */
  attention(): StructuredAttention | null
  /** A bounded rendered view for the Terminal tab and the fleet tail (never journaled). */
  screen(lines: number): string[]
  lastActivityMs(): number
  /** The usage the protocol has stated so far, or null (F2.1, optional: absent = this driver states none). */
  usage?(): StructuredUsage | null
  /** F4.D — the modes this session can be set to, in the protocol's order (absent = none stated). */
  modes?(): readonly StructuredMode[]
  /** F4.D — the mode the PROTOCOL last stated (or the one just set and acknowledged), or null. */
  mode?(): StructuredMode | null
  /**
   * F4.D — sets the mode by `StructuredMode.id`, through the protocol (never a keystroke). Resolves
   * false when the id is not listed, the session ended, or the harness refused it — the mode then stays
   * whatever the protocol last stated.
   */
  setMode?(id: string, idempotencyKey?: IdempotencyKey): Promise<boolean>
  /** 1.20 — the models this session can switch to mid-conversation, as the protocol lists them (absent = none stated). */
  models?(): readonly StructuredModelOption[]
  /** 1.20 — the model the PROTOCOL says this session runs (or the one just set and acknowledged), or null. */
  model?(): string | null
  /**
   * 1.20 — switches the model through the protocol (never a typed line). A refusal says why in a sentence, and
   * carries `blocked` when the harness's own version is the wall (opencode < 1.18.0 on its free tier).
   */
  setModel?(id: string, idempotencyKey?: IdempotencyKey): Promise<StructuredSetModel>
  /**
   * 1.20 — the turn in flight cannot finish on its own (the harness retries a provider that is not answering,
   * forever), in the harness's own words, or null. A READ: the driver never acts on it (a durable session's
   * writes must replay exactly) — the HOST cancels the turn through `cancel()`, as the person would.
   */
  stalled?(): string | null
  /** Queues a prompt. False when not running or the queue is full. */
  prompt(text: string): boolean
  /**
   * 1.21 — queues a prompt the CALLER names, so `amend` and `cancelRequest` have something to point at. `prompt()`
   * stays (it is `submit()` with a minted id). A repeat with the same `idempotencyKey` answers the recorded
   * receipt and never reaches the harness twice.
   */
  submit?(r: StructuredSubmit): Promise<StructuredSubmitReceipt>
  /** 1.21 — corrects a request already sent (`how` says whether the model sees it before or during its work). */
  amend?(requestId: string, text: string, idempotencyKey: IdempotencyKey): Promise<StructuredAmendResult>
  /** 1.21 — stops ONE request and says what happened. `cancel()` (no target, no receipt) stays. */
  cancelRequest?(requestId: string, idempotencyKey: IdempotencyKey): Promise<StructuredCancelReceipt>
  /** 1.21 — where a request is now. A READ: no side effect, never a resend. */
  requestState?(requestId: string): StructuredRequestState
  /** Answers the open request. False when none is open, the id is stale, or the answer does not fit it. `idempotencyKey` (1.21) makes a retry a no-op. */
  answer(a: StructuredAnswer, idempotencyKey?: IdempotencyKey): boolean
  /** Cancels the turn in flight (and answers an open request `cancelled`). */
  cancel(): void
  /**
   * Follow the session on the chat seam: first a `window` of the last `max` turns and a `state`, then
   * `append` / `grow` / `live` / `state` as it runs. Returns the unsubscribe; `on` is never called after.
   */
  follow(max: number, on: (d: HarnessChatDelta) => void): () => void
  /** Called once when the session ends, with why. */
  onExit(cb: (e: StructuredExit) => void): () => void
  dispose(): void
}

/**
 * 1.18 — why a start was REFUSED when the harness itself is the blocker and no other route will do better
 * (the TUI hits the same wall): the host tells the person in plain words instead of falling back silently.
 * `harness-version`: the installed build is older than `need` (and is `found`, when it said so).
 */
export type StructuredBlocked = { kind: 'harness-version'; need: string; found?: string }

export type StructuredStart = { ok: true; session: StructuredSession } | { ok: false; reason: string; blocked?: StructuredBlocked }

/** 1.20 — one model a session can switch to: the id the protocol takes and its own display name. */
export interface StructuredModelOption { id: string; label: string }

/** 1.20 — what `setModel` answered. */
export type StructuredSetModel = { ok: true } | { ok: false; reason: string; blocked?: StructuredBlocked }

/** One protocol, for the harnesses it serves. */
export interface StructuredDriver {
  readonly id: StructuredDriverId
  readonly status: StructuredDriverStatus
  readonly harnesses: readonly HarnessId[]
  readonly note: string
  /** Total over `harnesses`. */
  declares(h: HarnessId): StructuredDeclaration
  /** Never throws: a refusal is `{ ok: false, reason }`, and the host starts the session in tmux. */
  start(req: StructuredSpawn): Promise<StructuredStart>
}

/** `Engine.structured` (1.10, optional). */
export interface EngineStructured {
  /** Every driver this build knows, stubs included. */
  drivers(): readonly StructuredDriverInfo[]
  /** The READY driver for a harness, or null (no driver, or only a stub). */
  driverFor(h: HarnessId): StructuredDriverId | null
  declares(h: HarnessId): StructuredDeclaration | null
  start(req: StructuredSpawn): Promise<StructuredStart>
}

/**
 * PURE. The engine side of the registry: drivers in, `EngineStructured` out. A harness served by two
 * drivers is a build error the caller sees (`conflicts`), never resolved by order.
 */
export function structuredRegistry(drivers: readonly StructuredDriver[]): EngineStructured & { conflicts: HarnessId[] } {
  const owner = new Map<HarnessId, StructuredDriver>()
  const conflicts: HarnessId[] = []
  for (const d of drivers) for (const h of d.harnesses) {
    if (owner.has(h)) conflicts.push(h)
    else owner.set(h, d)
  }
  const ready = (h: HarnessId): StructuredDriver | null => {
    const d = owner.get(h)
    return d && d.status === 'ready' ? d : null
  }
  return {
    conflicts,
    drivers: () => drivers.map(d => ({ id: d.id, status: d.status, harnesses: d.harnesses, note: d.note })),
    driverFor: h => ready(h)?.id ?? null,
    declares: h => owner.get(h)?.declares(h) ?? null,
    async start(req) {
      const d = owner.get(req.harness)
      if (!d) return { ok: false, reason: `${req.harness} has no structured driver here.` }
      if (d.status !== 'ready') return { ok: false, reason: `${req.harness}: the ${d.id} driver is not written yet (${d.note}).` }
      try { return await d.start(req) } catch (e) {
        return { ok: false, reason: `the ${d.id} driver failed to start ${req.harness} (${e instanceof Error ? e.message : 'unknown'}).` }
      }
    },
  }
}

/** PURE. A stub driver: the exact interface, every start refused in a sentence (F3 workers replace it). */
export function stubDriver(id: StructuredDriverId, harnesses: readonly HarnessId[], note: string, declares: (h: HarnessId) => StructuredDeclaration): StructuredDriver {
  return {
    id, status: 'stub', harnesses, note, declares,
    start: async req => ({ ok: false, reason: `${req.harness}: the ${id} driver is not written yet (${note}).` }),
  }
}

/** PURE. Whether an answer fits the open request (the one rule every driver applies before acting). */
export function answerFits(open: StructuredAttention | null, a: StructuredAnswer): { ok: true; option?: StructuredOption; options?: StructuredOption[] } | { ok: false; why: 'none-open' | 'stale' | 'no-such-option' | 'text-not-accepted' | 'empty' | 'not-multi' } {
  if (!open) return { ok: false, why: 'none-open' }
  if (a.requestId !== undefined && a.requestId !== open.requestId) return { ok: false, why: 'stale' }
  if (a.choices !== undefined) {
    if (!open.multiSelect) return { ok: false, why: 'not-multi' }
    if (a.choice !== undefined) return { ok: false, why: 'no-such-option' }
    if (!Array.isArray(a.choices) || a.choices.length === 0) return { ok: false, why: 'empty' }
    const seen = new Set<number>()
    for (const c of a.choices) {
      if (!Number.isInteger(c) || c < 1 || c > open.options.length || seen.has(c)) return { ok: false, why: 'no-such-option' }
      seen.add(c)
    }
    const options = [...seen].sort((x, y) => x - y).map(c => open.options[c - 1]!)
    const field = options.some(o => o.freeText)
    if (a.text !== undefined && !field) return { ok: false, why: 'text-not-accepted' }
    if (field && (a.text === undefined || a.text.trim() === '')) return { ok: false, why: 'empty' }
    return { ok: true, options }
  }
  if (a.choice === undefined) {
    if (a.text === undefined || a.text.trim() === '') return { ok: false, why: 'empty' }
    return open.freeText ? { ok: true } : { ok: false, why: 'text-not-accepted' }
  }
  if (!Number.isInteger(a.choice) || a.choice < 1 || a.choice > open.options.length) return { ok: false, why: 'no-such-option' }
  const option = open.options[a.choice - 1]!
  if (a.text !== undefined && !option.freeText) return { ok: false, why: 'text-not-accepted' }
  return { ok: true, option }
}

/**
 * 1.17 — the narrow door an engine surface uses to act on ONE session. It can follow the conversation,
 * add a turn and cancel the turn in flight; it cannot answer a request, change a mode, list anything or
 * reach any other session. Every method is total: it never throws, and once the handle is no longer
 * valid (`live` is false) it does nothing.
 */
export interface StructuredSessionHandle {
  /** False once the surface that asked was unmounted, or the session ended. A dead handle stays dead. */
  readonly live: boolean
  /**
   * The chat seam for this session: first a `window` of the last `max` turns, then deltas. Returns the
   * unsubscribe; an invalid handle returns a no-op and never calls `on`.
   */
  follow(max: number, on: (d: HarnessChatDelta) => void): () => void
  /**
   * Adds a turn. The host types it with an `[from agentistics · surface]` header, so the conversation
   * never shows it as something the owner wrote. False when the handle is invalid, the session cannot
   * take input, or a request is open.
   */
  send(text: string): Promise<boolean>
  /** Cancels the turn in flight, and nothing else. False when the handle is invalid or nothing was running. */
  cancel(): Promise<boolean>
}

/** `EngineHostServices.structuredSessions` (1.17, optional). */
export interface EngineStructuredSessions {
  /**
   * A handle for a session THIS ENGINE started itself (`fleet.delegateSpawn`), or `null`. Any other id —
   * unknown, or somebody else's — answers `null`, indistinguishably. There is no way to enumerate sessions
   * through this. The session a surface was opened from is reached through that surface's own socket
   * (`EngineSocket.structured`), never through an id the engine supplies.
   */
  get(id: string): StructuredSessionHandle | null
}
