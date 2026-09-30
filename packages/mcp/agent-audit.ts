/**
 * The LOCAL agent audit sink — what an agent did through the MCP, on a machine with no Mongo.
 *
 * Spec: docs/superpowers/specs/2026-09-29-mcp-coverage-design.md §4.6 (audit) and §6 P1.2. It
 * exists because `packages/server/server/audit.ts` writes to Mongo, and a solo machine — the
 * normal install — has no audit sink at all: an agent could move every card on the board and
 * nothing would say which agent did it, or when.
 *
 * Two halves, and only the second touches a disk:
 *  - `buildToolAuditRecord` / `readCountRecord` are PURE. They decide what a line may carry, and
 *    the answer is: who, which tool, which ids, how it ended — NEVER an argument VALUE. A title, a
 *    comment body, a prompt, a file's content or a pasted credential cannot reach the file, because
 *    the builder never copies a value out of the arguments except through `targetsOf`, which admits
 *    only id-shaped strings under a closed list of id-named keys. The arguments are represented by
 *    `argsHash` alone: enough to tell two calls apart or match a call to a report, and nothing more.
 *  - `createAgentAuditSink` appends those records to `~/.agentistics/agent-audit.jsonl` (0600,
 *    `AGENTISTICS_DIR` honoured like every other path the product writes), rotating at
 *    `AUDIT_ROTATE_BYTES` and keeping `AUDIT_KEEP_FILES` files in all.
 *
 * Logging by class (§4.6):
 *  - `R` calls are COUNTED per tool per hour — one line per hour that saw reads, not one per read.
 *  - `W` calls are logged, one line each.
 *  - `D` calls are logged too. Until P2's intents exist a `D` tool still executes directly
 *    (`D_DIRECT_UNTIL_P2`), so its only lifecycle step today is `executed`, which is this line.
 *
 * A write that fails NEVER fails the tool call — the audit records what an agent did, it is not a
 * gate on doing it. It is COUNTED instead, and the count rides on the next line that does land
 * (`dropped`), so a gap in the file is visible in the file rather than silent.
 *
 * Attribution is best-effort and the record says where each part came from: `client` is what the
 * MCP client declared in `initialize`, `declared` is the optional `actor`/`by` argument the agent
 * chose to send. One registered MCP serves every Claude session on a machine, so neither can tell
 * two sessions apart (decision D-4 adds per-session identity).
 */
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { AGENT_TOOL_POLICY, redactSecrets, type AgentToolName, type AgentToolRisk } from '@agentistics/core'

/** Rotate once the live file would pass this size (§4.6: 10 MB). */
export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024
/** Files kept in all, the live one included: `agent-audit.jsonl`, `.1`, `.2` (§4.6: 3). */
export const AUDIT_KEEP_FILES = 3

export function defaultAuditPath(env: Record<string, string | undefined> = process.env): string {
  return join(env.AGENTISTICS_DIR ?? join(homedir(), '.agentistics'), 'agent-audit.jsonl')
}

// ------------------------------------------------------------------ the pure half

/**
 * Argument keys whose value NAMES something (a task, a session, a folder, a link) rather than
 * saying something. Closed on purpose: a key not listed here never reaches the file, so a new tool
 * argument is excluded until somebody decides it is an id. `name` is deliberately absent — it is a
 * layout's or a folder's free-text name, and for `session_group_edit` it is the NEW name, a value.
 */
export const TARGET_KEYS = [
  'ref', 'id', 'taskId', 'subtaskId', 'sessionId', 'session', 'sessions', 'group',
  'parentGroupId', 'blockedBy', 'componentId', 'instanceId', 'tag', 'remove',
] as const

/** An id: no spaces, no path separators, bounded. Anything else is a value and is not recorded. */
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,79}$/
const MAX_TARGETS = 20

/** A string that may stand in the file as an identifier — and is not a credential in disguise. */
function asId(v: unknown): string | null {
  if (typeof v !== 'string' || !ID_SHAPE.test(v)) return null
  // A token has an id's shape. `redactSecrets` recognises the shapes that are credentials; any
  // change it makes means this "id" is one, and it is dropped whole rather than stored redacted.
  return redactSecrets(v) === v ? v : null
}

export interface TargetsResult {
  targets: string[]
  /** Values under an id key that were not id-shaped, so were left out. Counted, never shown. */
  omitted: number
}

export function targetsOf(args: unknown): TargetsResult {
  const out: string[] = []
  let omitted = 0
  if (!args || typeof args !== 'object') return { targets: out, omitted }
  const a = args as Record<string, unknown>
  for (const key of TARGET_KEYS) {
    const raw = a[key]
    if (raw === undefined || raw === null || typeof raw === 'boolean') continue
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      const id = asId(v)
      if (id === null) { omitted++; continue }
      if (out.length >= MAX_TARGETS) { omitted++; continue }
      if (!out.includes(id)) out.push(id)
    }
  }
  return { targets: out, omitted }
}

/** Canonical JSON (sorted keys) so the same arguments hash the same whatever order they came in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

/**
 * A correlation handle for the arguments, not a secret: a low-entropy argument (a status name) can
 * be recovered from it by guessing, which is why nothing secret-bearing is ever sent as one.
 */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(canonical(args ?? {})).digest('hex').slice(0, 16)
}

export interface AuditClient {
  name?: string
  version?: string
}

export interface AuditActor {
  /** The MCP client's own `clientInfo`, as it declared it in `initialize`. */
  client: string | null
  clientVersion: string | null
  /** The optional `actor` (or `by`) argument the agent chose to send. Unverified. */
  declared?: string
  /** The Nay chat's session id, when the chat passes it to the MCP. */
  naySession?: string
}

/** A bounded, identifier-shaped reading of a caller-supplied label, or absent. */
function label(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, 64)
  if (!/^[\w.:@/ -]{1,64}$/.test(t)) return undefined
  return redactSecrets(t) === t ? t : undefined
}

export function actorOf(client: AuditClient | undefined, args: unknown, naySession?: string): AuditActor {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const declared = label(a.actor) ?? label(a.by)
  const nay = naySession !== undefined ? asId(naySession) ?? undefined : undefined
  return {
    client: label(client?.name) ?? null,
    clientVersion: label(client?.version) ?? null,
    ...(declared !== undefined ? { declared } : {}),
    ...(nay !== undefined ? { naySession: nay } : {}),
  }
}

/**
 * How a call ended, as a CODE. An error's text is never kept: it routinely quotes the request
 * (`POST /api/tasks/<ref> → HTTP 422 {"error":"…<the title>…"}`). Only its HTTP status survives.
 */
export type AuditOutcome = 'ok' | 'error' | 'unknown_tool' | `http_${number}`

export function outcomeOf(result: { isError?: boolean; errorText?: string } | 'unknown_tool'): AuditOutcome {
  if (result === 'unknown_tool') return 'unknown_tool'
  if (!result.isError) return 'ok'
  const m = /→ HTTP (\d{3})\b/.exec(result.errorText ?? '')
  return m ? (`http_${Number(m[1])}` as AuditOutcome) : 'error'
}

export interface ToolAuditRecord {
  v: 1
  kind: 'tool'
  at: string
  actor: AuditActor
  /** `null` when the name was not a known tool — a caller-chosen string is not written verbatim. */
  tool: AgentToolName | null
  risk: AgentToolRisk | null
  targets: string[]
  targetsOmitted?: number
  argsHash: string
  outcome: AuditOutcome
  /** Records lost to a failed write since the last line that landed. */
  dropped?: number
}

export interface ReadCountRecord {
  v: 1
  kind: 'reads'
  /** The UTC hour the counts cover, `YYYY-MM-DDTHH`. */
  hour: string
  counts: Record<string, number>
  dropped?: number
}

export type AgentAuditRecord = ToolAuditRecord | ReadCountRecord

export function isKnownTool(name: string): name is AgentToolName {
  return Object.prototype.hasOwnProperty.call(AGENT_TOOL_POLICY, name)
}

export function riskOf(name: string): AgentToolRisk | null {
  return isKnownTool(name) ? AGENT_TOOL_POLICY[name].risk : null
}

export interface ToolCallInput {
  at: Date
  name: string
  args: unknown
  client?: AuditClient
  naySession?: string
  result: { isError?: boolean; errorText?: string } | 'unknown_tool'
}

export function buildToolAuditRecord(input: ToolCallInput): ToolAuditRecord {
  const known = isKnownTool(input.name)
  const { targets, omitted } = targetsOf(input.args)
  return {
    v: 1,
    kind: 'tool',
    at: input.at.toISOString(),
    actor: actorOf(input.client, input.args, input.naySession),
    tool: known ? (input.name as AgentToolName) : null,
    risk: riskOf(input.name),
    targets,
    ...(omitted > 0 ? { targetsOmitted: omitted } : {}),
    argsHash: argsHash(input.args),
    outcome: known ? outcomeOf(input.result) : 'unknown_tool',
  }
}

export function hourOf(at: Date): string {
  return at.toISOString().slice(0, 13)
}

export function readCountRecord(hour: string, counts: Record<string, number>): ReadCountRecord {
  return { v: 1, kind: 'reads', hour, counts: { ...counts } }
}

/** Which rotated file a slot is: 0 is the live file, `n` is `<path>.n`. */
export function rotatedPath(path: string, n: number): string {
  return n === 0 ? path : `${path}.${n}`
}

// ------------------------------------------------------------------ the writer

export type AuditFs = Pick<
  typeof nodeFs,
  'appendFileSync' | 'statSync' | 'renameSync' | 'chmodSync' | 'mkdirSync' | 'rmSync'
>

export interface AgentAuditSinkOptions {
  path?: string
  maxBytes?: number
  keep?: number
  fs?: AuditFs
  now?: () => Date
}

export interface AgentAuditStats {
  written: number
  /** Every write that failed since the sink was made. Cumulative. */
  writeFailures: number
  /** Failures not yet reported on a line in the file. */
  pendingDropped: number
}

export interface AgentAuditSink {
  /** W and D calls get a line; R calls are counted; an unknown name gets a line (it is a probe). */
  recordCall(input: Omit<ToolCallInput, 'at'>): void
  /** Write the current hour's read counts now (process exit). */
  flush(): void
  stats(): AgentAuditStats
}

export function createAgentAuditSink(opts: AgentAuditSinkOptions = {}): AgentAuditSink {
  const path = opts.path ?? defaultAuditPath()
  const maxBytes = opts.maxBytes ?? AUDIT_ROTATE_BYTES
  const keep = Math.max(1, opts.keep ?? AUDIT_KEEP_FILES)
  const fs = opts.fs ?? nodeFs
  const now = opts.now ?? (() => new Date())

  let written = 0
  let writeFailures = 0
  let pendingDropped = 0
  let modeChecked = false
  let readHour: string | null = null
  let readCounts: Record<string, number> = {}

  function sizeOf(p: string): number {
    try { return fs.statSync(p).size } catch { return 0 }
  }

  function rotate(): void {
    fs.rmSync(rotatedPath(path, keep - 1), { force: true })
    for (let n = keep - 2; n >= 0; n--) {
      const from = rotatedPath(path, n)
      try { fs.renameSync(from, rotatedPath(path, n + 1)) } catch (e: any) {
        if (e?.code !== 'ENOENT') throw e
      }
    }
    modeChecked = false
  }

  function write(rec: AgentAuditRecord): void {
    try {
      const line = `${JSON.stringify(pendingDropped > 0 ? { ...rec, dropped: pendingDropped } : rec)}\n`
      if (!modeChecked) fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      if (keep > 1 && sizeOf(path) + Buffer.byteLength(line) > maxBytes && sizeOf(path) > 0) rotate()
      else if (keep === 1 && sizeOf(path) + Buffer.byteLength(line) > maxBytes) fs.rmSync(path, { force: true })
      fs.appendFileSync(path, line, { mode: 0o600 })
      // `mode` applies only when the file is CREATED; a file that already existed wider (made by
      // hand, or by an older build) is narrowed once per process and after each rotation.
      if (!modeChecked) { fs.chmodSync(path, 0o600); modeChecked = true }
      written++
      pendingDropped = 0
    } catch {
      writeFailures++
      pendingDropped++
    }
  }

  function flushReads(): void {
    if (readHour === null || Object.keys(readCounts).length === 0) return
    const rec = readCountRecord(readHour, readCounts)
    readHour = null
    readCounts = {}
    write(rec)
  }

  return {
    recordCall(input) {
      try {
        const at = now()
        const hour = hourOf(at)
        // A finished hour is written by the first call of ANY class after it, not only a read.
        if (readHour !== null && readHour !== hour) flushReads()
        if (riskOf(input.name) === 'R') {
          readHour = hour
          readCounts[input.name] = (readCounts[input.name] ?? 0) + 1
          return
        }
        write(buildToolAuditRecord({ ...input, at }))
      } catch {
        // Nothing the audit does may reach the tool call. `write` already counts its own failures;
        // this is the builder throwing on an input nobody anticipated, and it is counted the same.
        writeFailures++
        pendingDropped++
      }
    },
    flush() {
      flushReads()
    },
    stats() {
      return { written, writeFailures, pendingDropped }
    },
  }
}
