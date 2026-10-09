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
}

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
  /** The first prompt, sent once the session is open. */
  initialPrompt?: string
  /**
   * The opening context (QUAL.8), through `declares(h).instructions`: `text` for an official channel
   * (protocol field / system-prompt flag), `block` — the fenced form — for the first-message fallback,
   * where the driver sends it ahead of `initialPrompt` (or alone) and the chat hides it as context.
   * Ignored beside `resumeId`: a reopened conversation already has it.
   */
  instructions?: { text: string; block: string }
  mcp?: readonly StructuredMcpServer[]
  /** Extra environment for the child, over the host's. */
  env?: Readonly<Record<string, string>>
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
}

/**
 * The person's answer. `choice` is 1-based over `StructuredAttention.options`; `text` rides with a
 * `freeText` option, or alone when the request accepts free text. `requestId`, when given, must match
 * the open request — an answer to a request that has since changed is refused, never re-targeted.
 */
export interface StructuredAnswer {
  requestId?: string
  choice?: number
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
  /** Queues a prompt. False when not running or the queue is full. */
  prompt(text: string): boolean
  /** Answers the open request. False when none is open, the id is stale, or the answer does not fit it. */
  answer(a: StructuredAnswer): boolean
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

export type StructuredStart = { ok: true; session: StructuredSession } | { ok: false; reason: string }

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
export function answerFits(open: StructuredAttention | null, a: StructuredAnswer): { ok: true; option?: StructuredOption } | { ok: false; why: 'none-open' | 'stale' | 'no-such-option' | 'text-not-accepted' | 'empty' } {
  if (!open) return { ok: false, why: 'none-open' }
  if (a.requestId !== undefined && a.requestId !== open.requestId) return { ok: false, why: 'stale' }
  if (a.choice === undefined) {
    if (a.text === undefined || a.text.trim() === '') return { ok: false, why: 'empty' }
    return open.freeText ? { ok: true } : { ok: false, why: 'text-not-accepted' }
  }
  if (!Number.isInteger(a.choice) || a.choice < 1 || a.choice > open.options.length) return { ok: false, why: 'no-such-option' }
  const option = open.options[a.choice - 1]!
  if (a.text !== undefined && !option.freeText) return { ok: false, why: 'text-not-accepted' }
  return { ok: true, option }
}
