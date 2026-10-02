/**
 * host.ts — what the host gives an engine.
 *
 * **Everything machine-specific arrives through `EngineHostServices`.** An engine reads no path, no
 * credential and no environment of this machine on its own, and imports nothing from the public
 * tree but this package (and the core vocabulary): whatever else it needs is handed over here as a
 * value.
 *
 * **Nothing in this object is a secret.** A provider key belongs to the engine's own store; the host
 * passes only the floor that protects such stores (`protectedGlobs`) and — since 1.5 — the vault that
 * SEALS it (`secrets`), which takes and returns bytes and never hands over the key.
 */
import type { CapabilityName, EngineEvent, EngineSessionActivity, HarnessId } from './mirrors'
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

/**
 * Flags an engine honours, read by the host. `live` (1.4): the file-tail and the attention producer
 * — `AGENTISTICS_JOURNAL` AND `AGENTISTICS_JOURNAL_LIVE`. A host older than 1.4 does not know the
 * name, so an engine asks it only of a host whose `apiVersion` says 1.4 or later.
 */
export type EngineFlag = 'provider' | 'ingest' | 'live'

/** What the screen showed when a session started waiting on a person (1.4). Counts and kinds, NO text. */
export interface FleetDialog {
  kind: 'approval' | 'question' | 'select' | 'confirm' | 'unknown'
  optionCount?: number
  hasFreeText?: boolean
}

/**
 * One CONFIRMED change of a managed session's activity (1.4). The host applies the event channel's
 * rule (`events/event-plan.ts`) before delivering it: a state counts only once seen on two consecutive
 * polls, and a first sighting is never a transition — so a one-frame repaint never reaches an engine.
 * Carries no screen text.
 */
export interface FleetTransition {
  managedId: string
  harness: HarnessId
  /** The EXACT conversation link, or absent. Never the harness-and-directory guess. */
  conversationId?: string
  from: EngineSessionActivity
  to: EngineSessionActivity
  /** ISO time of the poll that confirmed it. */
  at: string
  /** Present on a transition INTO `waiting-approval` when the dialog could be read. */
  dialog?: FleetDialog
  /** Set when the host's own answer route sent the choice (1-based option index). */
  answeredHere?: { choice: number }
}

/** The host's fleet, as an engine may follow it (1.4). */
export interface EngineFleet {
  /** Confirmed transitions only. Returns unsubscribe. A callback that throws is logged, never fatal. */
  subscribe(cb: (t: FleetTransition) => void): () => void
}

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
  // The vault (engine-api 1.5): a plaintext secret sealed, one still waiting because the vault could
  // not open, and one whose migration failed. meta names the purpose and the logical name ONLY —
  // never a value, a length or a fragment. Written to the machine's own `vault/audit.jsonl`.
  | 'vault.migrated' | 'vault.plaintext-pending' | 'vault.migration-failed'

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

/**
 * One answer of the board (1.7). `body` is what the matching `/api/tasks` route answers with; a
 * refusal carries the route's own `reason` and its HTTP-equivalent `status` (404 for a thing that
 * does not exist, 409 for a claim someone else holds, 422/400 for a request the board will not do).
 * Never thrown.
 */
export type EngineBoardAnswer =
  | { ok: true; body: unknown }
  | { ok: false; status: number; reason: string; body?: unknown }

/** The board's operations an engine may call (1.7). Every write names its actor and session. */
export interface EngineBoard {
  list(): Promise<EngineBoardAnswer>
  get(ref: string): Promise<EngineBoardAnswer>
  next(q: { actor?: string; limit?: number }): Promise<EngineBoardAnswer>
  activity(q: { ref?: string; limit?: number }): Promise<EngineBoardAnswer>
  create(t: { title: string; detail?: string; actor: string; sessionId: string }): Promise<EngineBoardAnswer>
  /** Add (`title`, `isGroup`) or edit (`id` + columns) a subtask — the `/subtasks` route's body. */
  subtask(ref: string, payload: Record<string, unknown>, by: { actor: string; sessionId: string }): Promise<EngineBoardAnswer>
  comment(ref: string, c: { body: string; author: string; sessionId: string; subtaskId?: string }): Promise<EngineBoardAnswer>
  status(ref: string, s: { status: string; actor: string; sessionId: string; reason?: string; blockedBy?: string[] }): Promise<EngineBoardAnswer>
  claim(ref: string, c: { by: string; sessionId: string; leaseMs?: number; note?: string; takeover?: boolean; release?: boolean }): Promise<EngineBoardAnswer>
  /**
   * Files the session produced (verification screenshots, EVID.1), stored in the host's attachment
   * store and posted as ONE comment. The engine has read the bytes under its own policy; the host
   * checks kind and size again and never reads a path.
   */
  attach(ref: string, a: { files: Array<{ name: string; bytes: Uint8Array }>; author: string; sessionId: string; subtaskId?: string; note?: string }): Promise<EngineBoardAnswer>
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
 * Why the vault would not seal or open. `purpose` — the engine asked for a purpose outside
 * `engine/…`; the others are the vault's own states (docs/security.md § "Secrets at rest").
 */
export type VaultRefusal = 'uninitialized' | 'locked' | 'protector-lost' | 'wrong-machine' | 'tampered' | 'purpose'

export type SealResult = { ok: true; sealed: Uint8Array } | { ok: false; code: VaultRefusal; sentence: string }
export type OpenResult = { ok: true; plaintext: Uint8Array } | { ok: false; code: VaultRefusal; sentence: string }

/**
 * 1.5 — the machine's vault, as an engine may use it. The engine keeps owning its file layout (names,
 * atomic writes, the mode check); the host owns the key. AES-256-GCM under a per-purpose HKDF subkey
 * of the machine's data key, so a blob sealed for `engine/provider-key` cannot be opened as the
 * host's GitHub token even before the AAD check.
 *
 * 1.6 — `open()` returns a fresh `Uint8Array` per call and the engine MUST `fill(0)` it after use and
 * never cache it (per-use decrypt, SECRETS.4 §5.2). The new locked causes come back as
 * `code: 'locked'` + `lockedBy`; `VaultRefusal` is deliberately NOT widened.
 */
export interface EngineSecretsStatus {
  state: 'open' | 'locked' | 'uninitialized' | 'unavailable'
  protector: string | null
  sentence: string | null
  /** 1.6 — why it is locked (only while `state === 'locked'`). Absent on a 1.5 host. */
  lockedBy?: 'start' | 'auto-lock' | 'user' | 'stepup-frozen' | 'presence-lost'
  /** 1.6 — ms until auto-lock while open; `null` when there is no auto-lock. Absent on a 1.5 host. */
  autoLockInMs?: number | null
}

export interface EngineSecrets {
  /** Never throws. `sentence` is the refusal for any state but `open`. */
  status(): EngineSecretsStatus
  /**
   * 1.6 — called on every state change; returns an unsubscribe. Absent on a 1.5 host: an engine that
   * wants to wait for an unlock then falls back to asking `status()` when it next needs a secret.
   */
  onStateChange?(cb: (state: EngineSecretsStatus) => void): () => void
  /** `purpose` MUST start with `engine/` — the host refuses any other (`code: 'purpose'`). */
  seal(purpose: `engine/${string}`, name: string, plaintext: Uint8Array): Promise<SealResult>
  open(purpose: `engine/${string}`, name: string, sealed: Uint8Array): Promise<OpenResult>
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
    /**
     * The task board's own operations, in process (1.7, B6.5): what a native session's `board.*`
     * tools call. OPTIONAL: absent on an older host, and a 1.7 engine then offers no board tools.
     * The host runs each operation through the SAME functions its `/api/tasks` routes use, so a
     * refusal is the route's own `reason`; the engine's policy has already judged the call (reads
     * free, writes under the session's grant), and every write lands in the board's own activity log under its actor.
     */
    board?: EngineBoard
  }
  /**
   * The public functions an engine reuses (1.2: the full `ReuseSurface`). A 1.1 host passed `{}`;
   * an engine built against 1.2 never loads on one (`apiCompatible`), and still checks completeness
   * (`missingReuseMembers`) rather than trusting a value it did not type-check.
   */
  readers: ReuseSurface
  /** The host's browser-provenance policy (1.2). */
  originPolicy(): EngineOriginPolicy
  /**
   * The machine's vault (1.5). OPTIONAL: a host before 1.5 has none, and an engine that finds it
   * absent REFUSES to store a secret ("This agentop is too old to store keys encrypted — update it
   * (agentop upgrade).") and may only read a legacy plaintext one it already has, read-only. It never
   * writes a new plaintext secret.
   */
  secrets?: EngineSecrets
  now(): Date
  /**
   * The contract version THIS host speaks (1.4) — `ENGINE_API_VERSION` of the engine-api it was built
   * with. Absent on an older host, which is how an engine knows not to read a 1.4 member or ask a 1.4
   * flag. Optional: an engine built against 1.3 never reads it.
   */
  apiVersion?: string
  /** The fleet's confirmed transitions (1.4). Absent = the host offers none (an engine copes). */
  fleet?: EngineFleet
}
