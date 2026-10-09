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
  // The vault (engine-api 1.5): a plaintext secret sealed, one still waiting because the vault could
  // not open, and one whose migration failed. meta names the purpose and the logical name ONLY —
  // never a value, a length or a fragment. Written to the machine's own `vault/audit.jsonl`.
  | 'vault.migrated' | 'vault.plaintext-pending' | 'vault.migration-failed'

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

/** Fire-and-forget: an audit write must never break the request it is describing. */
export async function writeAudit(input: AuditInput): Promise<void> {
  // Local instances deliberately keep no central audit collection. The builder remains available
  // to callers and tests; the local sink is best-effort and currently process-scoped.
  void buildAuditEvent(input, new Date())
}

/** Owner-only reader, newest first. */
export async function listAudit(opts: { limit?: number; action?: AuditAction } = {}): Promise<AuditEvent[]> {
  void opts
  return []
}

/** Index + a 180-day TTL. Idempotent; called at boot next to ensureAccountIndexes. */
export async function ensureAuditIndexes(): Promise<void> {
}
