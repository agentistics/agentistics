/**
 * audit.ts — append-only security event log in the `audit` collection.
 *
 * OWASP A09: authentication, authorization and administrative events must be recorded with
 * enough context to reconstruct an incident. Without this, a successful takeover leaves no
 * trace at all.
 *
 * The pure builder redacts secret-shaped fields BEFORE anything reaches the database — an audit
 * log that stores credentials is a liability, not a control — and truncates long values so one
 * call cannot bloat the collection.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getMongoDb } from './mongo'

export type AuditAction =
  | 'login.success' | 'login.failure' | 'login.mfa_challenge' | 'login.mfa_failure'
  | 'logout' | 'password.change' | 'password.reset_cli'
  | 'mfa.enable' | 'mfa.disable' | 'mfa.disable_refused' | 'mfa.recovery_used' | 'mfa.recovery_regenerated'
  | 'password.recover' | 'password.recover_failure' | 'password.reset_requested'
  | 'account.create' | 'account.update' | 'account.delete'
  // An admin (owner OR manager) resetting SOMEONE ELSE's password — kept distinct from
  // 'password.change' (self-service) so an incident review can tell them apart at a glance.
  | 'password.reset_admin'
  | 'team.create' | 'team.update' | 'team.delete'
  | 'token.mint' | 'token.rotate' | 'token.revoke'
  // A machine's name, owner accounts, or team links changed — distinct from mint/rotate/revoke,
  // which touch the credential itself.
  | 'machine.update'
  // A verb performed on one of ANOTHER machine's live sessions, relayed from this central. Its own
  // action rather than a flavour of `machine.update`, which means the token document changed:
  // renaming a session and re-assigning a machine's owner account are not the same event, and an
  // audit that cannot tell them apart cannot answer "who killed my session".
  | 'machine.session_action'
  | 'repo.register' | 'repo.unregister'
  | 'config.update' | 'bootstrap.consume'
  | 'capability.denied' | 'authz.denied' | 'rate.blocked'
  // A `localShell` route reached by a Host that does not name this machine — the signature of a DNS
  // rebinding attempt (host-allow.ts). Carries the path and the refused Host, never a credential.
  | 'host.misdirected'
  | 'stepup.granted' | 'stepup.failure' | 'stepup.missing'
  // A live-terminal WRITE channel was opened (a keyboard attached to a session) or refused — ONE
  // entry per channel, never per keystroke. `fleet.input.denied` records a rejected WS upgrade
  // (e.g. a cross-origin attempt); the capability refusal is already `capability.denied`.
  | 'fleet.input.open' | 'fleet.input.denied'
  // The same two, for the per-session UTILITY SHELL's write channel. Its own pair rather than a
  // reuse of the fleet's: a shell is a raw PTY on this host and a session is a named assistant CLI,
  // so a reader of the log must be able to tell which of the two a keyboard was attached to.
  | 'shell.input.open' | 'shell.input.denied'
  // The disabled-shell empty state's temporary "Enable now" button — the in-memory override
  // (`shell-override-store.ts`) was set. Its own action, distinct from `shell.input.open`: this
  // one widens what the shell routes will answer for the rest of the process, not one channel.
  | 'shell.override.enabled'
  | 'upgrade.started' | 'upgrade.denied'
  // The native runtime's provider settings (provider-web.ts). meta carries the provider id and
  // key FINGERPRINTS only — never the key, never more of it than `sha256:xxxxxxxx`.
  | 'provider.set' | 'provider.remove'
  // A NATIVE runtime session created or driven (H8) — the `/api/runtime/*` routes, `agentop code`
  // and the TUI code tab, all through `runtime-host.ts`'s `RuntimeHost.audit`. One action per verb,
  // built ONLY by `buildRuntimeSessionAudit` below: who, what, which session, from which surface —
  // never a prompt, a tool input, a file's content or a credential.
  | 'runtime.session.create' | 'runtime.session.send' | 'runtime.session.approve'
  | 'runtime.session.cancel' | 'runtime.session.resume'

export interface AuditEvent {
  action: AuditAction
  actorId?: string
  targetId?: string
  ip: string
  /** BSON Date, NOT an ISO string. The retention index below is a TTL index, and MongoDB's TTL
   *  monitor only expires documents whose indexed field is a Date — with a string here the index
   *  is created happily, reports no error, and nothing is ever deleted. See mongo-dates.ts. */
  at: Date
  meta?: Record<string, unknown>
}

export interface AuditInput {
  action: AuditAction
  actorId?: string
  targetId?: string
  ip: string
  meta?: Record<string, unknown>
}

/** Field names whose values must never be persisted, whatever the caller passes. */
const REDACT = new Set([
  'password', 'newPassword', 'currentPassword', 'confirm',
  'token', 'secret', 'code', 'challenge', 'hash', 'passwordHash', 'recoveryCodes',
])
const MAX_VALUE_LENGTH = 512

export function buildAuditEvent(input: AuditInput, now: Date): AuditEvent {
  let meta: Record<string, unknown> | undefined
  if (input.meta) {
    meta = {}
    for (const [k, v] of Object.entries(input.meta)) {
      if (REDACT.has(k)) continue
      meta[k] = typeof v === 'string' && v.length > MAX_VALUE_LENGTH ? v.slice(0, MAX_VALUE_LENGTH) : v
    }
  }
  return {
    action: input.action,
    actorId: input.actorId,
    targetId: input.targetId,
    ip: input.ip,
    at: now,
    meta,
  }
}

let auditFailures = 0

/** How many audit events this process could not write (the sink failed, or a caller counted a drop
 *  through `noteAuditFailure`). An audit that is lost must at least be COUNTED — "nothing was
 *  recorded" and "nothing happened" are different facts. */
export function auditFailureCount(): number {
  return auditFailures
}

/** Count one audit event that could not be written by a path that does not go through `writeAudit`. */
export function noteAuditFailure(): void {
  auditFailures += 1
}

/** Tests only. */
export function _resetAuditFailures(): void {
  auditFailures = 0
}

/** Fire-and-forget: an audit write must never break the request it is describing. Resolves `true`
 *  when the event was stored, `false` when it was lost (and counted). Never rejects. */
export async function writeAudit(input: AuditInput): Promise<boolean> {
  try {
    const db = await getMongoDb()
    await db.collection<AuditEvent>('audit').insertOne(buildAuditEvent(input, new Date()))
    return true
  } catch {
    // Swallowed on purpose. A failing audit sink is an operational problem, not a reason to
    // deny a legitimate login — but it is counted.
    auditFailures += 1
    return false
  }
}

/** Rotation threshold for a local audit log: past it the file becomes `<path>.1` (one generation). */
export const LOCAL_AUDIT_MAX_BYTES = 5 * 1024 * 1024

/**
 * The same event `writeAudit` stores, appended as ONE JSON line to a local file (0600, parent 0700) —
 * for a machine with no audit collection. The native runtime refuses to run on a central, which is the
 * only machine that has one, so its acts are recorded here instead of being attempted against a Mongo
 * that is not there (and that a solo machine would wait 30 s per act to find absent). Built by the same
 * `buildAuditEvent`, so the same fields are redacted. Resolves `false` (and counts) on any failure;
 * never rejects.
 */
export async function appendAuditLine(
  path: string,
  input: AuditInput,
  opts: { now?: Date; maxBytes?: number } = {},
): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const size = await stat(path).then(st => st.size, () => 0)
    if (size >= (opts.maxBytes ?? LOCAL_AUDIT_MAX_BYTES)) await rename(path, `${path}.1`).catch(() => {})
    await appendFile(path, `${JSON.stringify(buildAuditEvent(input, opts.now ?? new Date()))}\n`, { mode: 0o600 })
    return true
  } catch {
    auditFailures += 1
    return false
  }
}

// ── Native runtime sessions (H8) ─────────────────────────────────────────────────────────────────

export type RuntimeSessionVerb = 'create' | 'send' | 'approve' | 'cancel' | 'resume'

/** Which front door the act came through. `tui` is the control center's code tab. */
export type RuntimeSessionSurface = 'web' | 'cli' | 'tui'

/**
 * One act on a native session. Every field is an IDENTIFIER, a count or a closed word — there is
 * deliberately no field that could carry a prompt, a tool input, a question's text, a free-text
 * answer, a title, a path or a credential. A caller holding one of those has nowhere to put it.
 */
export interface RuntimeSessionAct {
  verb: RuntimeSessionVerb
  surface: RuntimeSessionSurface
  /** Absent only for a cancel whose run could not be traced back to a session. */
  sessionId?: string
  /** `cancel`: the run asked to stop. */
  runId?: string
  /** `approve`: the question answered (an id, never its text). */
  questionId?: string
  /** `approve`: the picked option's 0-based index; a free-text answer is recorded as `answer: 'text'`
   *  and its words are never kept. */
  choice?: number
  /** `approve`: which kind of answer was given — `denied` when the person answered nothing. */
  answer?: 'choice' | 'text' | 'denied'
  /** `create`: the model id (an identifier, not content). */
  model?: string
  /** What came of the act: `ok`, or the refusal code the caller was given. */
  outcome: string
  /** `resume`: whether a run a dead process left `running` was repaired. */
  repaired?: boolean
}

export const RUNTIME_SESSION_ACTIONS: Record<RuntimeSessionVerb, AuditAction> = {
  create: 'runtime.session.create',
  send: 'runtime.session.send',
  approve: 'runtime.session.approve',
  cancel: 'runtime.session.cancel',
  resume: 'runtime.session.resume',
}

const SHORT = 128
function clip(v: string): string {
  return v.length > SHORT ? v.slice(0, SHORT) : v
}

/**
 * PURE: the `AuditInput` for one native-session act. `meta` is built from an ALLOWLIST, field by
 * field — never a spread of what the caller passed — so a field added to `RuntimeSessionAct` does not
 * reach the log until somebody adds it here on purpose.
 */
export function buildRuntimeSessionAudit(act: RuntimeSessionAct, who: { actorId: string; ip: string }): AuditInput {
  const meta: Record<string, unknown> = { surface: act.surface, outcome: clip(act.outcome) }
  if (act.runId !== undefined) meta.runId = clip(act.runId)
  if (act.questionId !== undefined) meta.questionId = clip(act.questionId)
  if (act.answer !== undefined) meta.answer = act.answer
  if (act.choice !== undefined && Number.isInteger(act.choice) && act.choice >= 0) meta.choice = act.choice
  if (act.model !== undefined) meta.model = clip(act.model)
  if (act.repaired !== undefined) meta.repaired = act.repaired === true
  return {
    action: RUNTIME_SESSION_ACTIONS[act.verb],
    actorId: clip(who.actorId),
    ...(act.sessionId !== undefined ? { targetId: clip(act.sessionId) } : {}),
    ip: who.ip,
    meta,
  }
}

/** Owner-only reader, newest first. */
export async function listAudit(opts: { limit?: number; action?: AuditAction } = {}): Promise<AuditEvent[]> {
  const db = await getMongoDb()
  const filter = opts.action ? { action: opts.action } : {}
  return db
    .collection<AuditEvent>('audit')
    .find(filter)
    .sort({ at: -1 })
    .limit(Math.min(opts.limit ?? 200, 1000))
    .toArray()
}

/** Index + a 180-day TTL. Idempotent; called at boot next to ensureAccountIndexes. */
export async function ensureAuditIndexes(): Promise<void> {
  const db = await getMongoDb()
  const col = db.collection<AuditEvent>('audit')
  await col.createIndex({ at: -1 })
  await col.createIndex({ at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 })
}
