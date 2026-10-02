/**
 * host.ts — what the host gives an engine.
 *
 * **Everything machine-specific arrives through `EngineHostServices`.** An engine reads no path, no
 * credential and no environment of this machine on its own, and imports nothing from the public
 * tree but this package (and the core vocabulary): whatever else it needs is handed over here as a
 * value.
 *
 * **Nothing in this object is a secret.** A provider key belongs to the engine's own store; the host
 * passes only the floor that protects such stores (`protectedGlobs`).
 */
import type { CapabilityName, EngineEvent, HarnessId } from './mirrors'
import type { ReuseSurface } from './reuse'

/** Where an append's answer is read. A host's richer result is assignable to it. */
export interface ProviderAppendResult {
  /** Rows actually inserted. */
  written: number
  /** Events whose id was already there — a duplicate is NOT a loss. */
  duplicates: number
}

/** Where engine events go. Implemented by the host; the engine never opens a journal itself. */
export interface ProviderJournalSink<E extends EngineEvent = EngineEvent> {
  append(events: readonly E[]): Promise<ProviderAppendResult>
}

/** The part of the host's journal status an engine reads. */
export interface JournalStatus {
  state: 'open' | 'disabled' | 'closed'
  /** Present exactly when `state === 'disabled'`. */
  reason?: string
}

/** A question to a person. The engine never answers one for them. */
export interface PersonQuestion {
  id: string
  kind: 'permission' | 'question'
  text: string
  options: { label: string; description?: string }[]
  allowFreeText?: boolean
}

export type PersonAnswer =
  | { answered: true; choice?: number; text?: string }
  /** Nobody answered. A permission question left unanswered is a DENIAL, never an approval. */
  | { answered: false; reason: 'cancelled' | 'timeout' | 'unavailable' }

/** Implemented by the host (the cockpit, the web, a test). */
export interface PersonAsker {
  ask(q: PersonQuestion, signal?: AbortSignal): Promise<PersonAnswer>
}

/** Flags an engine honours, read by the host. */
export type EngineFlag = 'provider' | 'ingest'

/**
 * Mirrors the host's `AuditAction` — must stay EQUAL (1.2; it was `string` before, which let an
 * engine write an action no audit reader knows). An engine audits only through `audit()`, so the
 * whole union is named: a narrower one would have to be widened every time the engine learns a
 * verb, which is a contract bump for no change of meaning.
 */
export type EngineAuditAction =
  | 'login.success' | 'login.failure' | 'login.mfa_challenge' | 'login.mfa_failure'
  | 'logout' | 'password.change' | 'password.reset_cli'
  | 'mfa.enable' | 'mfa.disable' | 'mfa.disable_refused' | 'mfa.recovery_used' | 'mfa.recovery_regenerated'
  | 'password.recover' | 'password.recover_failure' | 'password.reset_requested'
  | 'account.create' | 'account.update' | 'account.delete'
  | 'password.reset_admin'
  | 'team.create' | 'team.update' | 'team.delete'
  | 'token.mint' | 'token.rotate' | 'token.revoke'
  | 'machine.update'
  | 'machine.session_action'
  | 'repo.register' | 'repo.unregister'
  | 'config.update' | 'bootstrap.consume'
  | 'capability.denied' | 'authz.denied' | 'rate.blocked'
  | 'host.misdirected'
  | 'stepup.granted' | 'stepup.failure' | 'stepup.missing'
  | 'fleet.input.open' | 'fleet.input.denied'
  | 'shell.input.open' | 'shell.input.denied'
  | 'shell.override.enabled'
  | 'upgrade.started' | 'upgrade.denied'
  | 'provider.set' | 'provider.remove'

/** Mirrors the host's audit input. The host's builder still redacts secret-shaped fields. */
export interface EngineAuditEvent {
  action: EngineAuditAction
  actorId?: string
  targetId?: string
  ip: string
  meta?: Record<string, unknown>
}

/** Mirrors the host's notification payload. */
export interface EngineNotification {
  type: 'error' | 'warning' | 'info' | 'success'
  code?: string
  meta?: Record<string, unknown>
  title?: string
  message?: string
}

/**
 * The part of the host's admission-control budget an engine reads — the SAME measurement the host's
 * own spawn gate (`admitSpawn`) decides from, so an engine and the host can never disagree about
 * whether this machine has room.
 *
 * 1.3: `unmeasured` and `budget.alarm`. Up to 1.2 an unmeasurable machine was reported as
 * `{ max: 0, used: 0, left: 0, percent: 0 }` — indistinguishable from a MEASURED machine with no
 * room — and the swap alarm was not carried at all, although it is the rule that refuses first: the
 * freeze admission control exists for happened with RAM reading free and swap at 97%.
 *
 * An engine starting a session applies the host's rule, in this order:
 * 1. `unmeasured: true` → admit, and SAY memory could not be checked (never a silent pass, never a
 *    refusal: `/proc` is Linux-only). `budget` is all zeros then and carries no meaning.
 * 2. `budget.alarm === 'swap'` → refuse, whatever `left` says.
 * 3. more sessions asked for than `left` → refuse, and say how many would fit.
 */
export interface EngineSpawnBudget {
  budget: {
    max: number
    used: number
    left: number
    percent: number
    /**
     * Why the budget is alarming, absent when it is not (1.3). `swap` — the machine is already
     * thrashing, and refuses a spawn regardless of `left`; `sessions` — `left` is nearly spent.
     */
    alarm?: 'sessions' | 'swap'
  }
  /**
   * `true` when this machine could not be measured (1.3). Explicit, because a measured `max: 0` is a
   * real answer ("nothing fits") and must never read as "not measured".
   */
  unmeasured: boolean
}

/** A native session filed on the task board. */
export interface NativeSessionLink {
  id: string
  sessionId: string
  taskId: string
  subtaskId?: string
  linkedAt: string
}

export type FileResult = { ok: true; id: string } | { ok: false; reason: string }

/** Mirrors the host's bounded body reader — an engine never calls `req.json()`. */
export type ReadJsonLimited = <T>(
  req: Request,
  maxBytes: number,
) => Promise<{ ok: true; value: T } | { ok: false; error: 'too_large' | 'invalid_json' }>

/** Mirrors the host's error sanitiser — a client gets a code and a ref, never the message. */
export type SafeError = (
  err: unknown,
  opts: { verbose: boolean },
) => { body: { error: string; ref: string }; logLine: string }

/**
 * The host's browser-provenance policy: the extra origins it allows (`AGENTISTICS_ALLOWED_ORIGINS`)
 * and whether it runs as a dev server (no embedded dashboard — Vite's origin is then same-site). An
 * engine route that runs a provenance check STRICTER than the host's CSRF gate reads both here
 * rather than re-deriving them from the environment.
 */
export interface EngineOriginPolicy {
  allowedOrigins: string[]
  dev: boolean
}

/**
 * An answer the host already holds for a model call, by its deterministic invocation id (INV.1).
 * Only what the loop needs to carry on; never a raw body or a credential.
 */
export interface EngineCachedInvocation {
  messageId: string
  servedModel: string
  /** The provider's usage as the runtime's own `ProviderUsage` (`@agentistics/core`). */
  usage: unknown
  usageAnomalies?: unknown[]
  stopReason: unknown
  content: ReadonlyArray<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'other'; rawType: string }>
  requestId?: string
}

export interface EngineInvocationCache {
  /** `null`/`undefined` = nothing held. A hint: a throw is a miss and the call is simply made. */
  get(invocationId: string): Promise<EngineCachedInvocation | null | undefined>
}

export interface EngineHostServices<E extends EngineEvent = EngineEvent> {
  /** Where things live. The engine reads no config of its own. */
  paths: {
    dataDir: string
    defaultDataDir: string
    contentDir: string
    home: string
    /** The env-override-resolved roots the host owns. */
    harnessRoots: Partial<Record<HarnessId, string>>
    /**
     * OpenCode's database FILE, as the host resolved it (1.2). `OPENCODE_DB_PATH` may point it
     * outside `harnessRoots.opencode`, so `<root>/opencode.db` is not the same answer.
     */
    opencodeDbPath: string
  }
  /** The public journal. `null` = journal off or unwritable — the engine must cope. */
  journal: { sink(): Promise<ProviderJournalSink<E> | null>; status(): JournalStatus }
  /**
   * The machine's policy floor as GLOBS (1.3): `protectedGlobs(rules)` over the backup plan's
   * `secret` rows, in the dialect `floor.ts` defines (`~/`, `*`, `**`). This is the floor an engine
   * must enforce — a `contains` row (`.key`) has no single path, only a glob.
   */
  protectedGlobs: readonly string[]
  /**
   * 1.2 — DEPRECATED, kept for an engine built against 1.2: the same floor as ABSOLUTE paths
   * (`$HOME` joined with each row), plus, since 1.3, the absolute form of every glob in
   * `protectedGlobs` — so an engine that widens each entry into `<p>`, `<p>*`, `<p>*\/**` globs gets
   * the `contains` rows too. An engine built against 1.3 reads `protectedGlobs` instead.
   */
  protectedPaths: readonly string[]
  /** The host's exposure capabilities, read — never re-derived. */
  caps: Readonly<Record<CapabilityName, boolean>>
  /** A central never runs the runtime. */
  isCentral(): boolean
  flag(name: EngineFlag): boolean
  audit(event: EngineAuditEvent): void
  readJsonLimited: ReadJsonLimited
  safeError: SafeError
  spawnBudget(): Promise<EngineSpawnBudget>
  notify(n: EngineNotification): void
  lang(): 'en' | 'pt'
  /** The board, for filing native sessions. The ONLY write into a public store an engine gets. */
  tasks: {
    fileNative(link: Omit<NativeSessionLink, 'id' | 'linkedAt'>): Promise<FileResult>
    unfileNative(sessionId: string): Promise<void>
  }
  /**
   * The public functions an engine reuses (1.2: the full `ReuseSurface`). A 1.1 host passed `{}`;
   * an engine built against 1.2 never loads on one (`apiCompatible`), and still checks completeness
   * (`missingReuseMembers`) rather than trusting a value it did not type-check.
   */
  readers: ReuseSurface
  /** The host's browser-provenance policy (1.2). */
  originPolicy(): EngineOriginPolicy
  now(): Date
  /**
   * INV.1 (additive, optional, no version bump): the host's held answers by invocation id — the
   * Cloud's egress proxy. Absent on every host today. Asked before a RESUMED run re-sends a call;
   * a hit is journaled `model.completed {replayed: true}`.
   */
  invocationCache?: EngineInvocationCache
}
