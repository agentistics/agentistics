/**
 * host.ts — what the host gives an engine.
 *
 * **Everything machine-specific arrives through `EngineHostServices`.** An engine reads no path, no
 * credential and no environment of this machine on its own, and imports nothing from the public
 * tree but this package (and the core vocabulary): whatever else it needs is handed over here as a
 * value.
 *
 * **Nothing in this object is a secret.** A provider key belongs to the engine's own store; the host
 * passes only the floor that protects such stores (`protectedPaths`).
 */
import type { CapabilityName, EngineEvent, HarnessId } from './mirrors'

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

/** Mirrors the host's audit input. The host's builder still redacts secret-shaped fields. */
export interface EngineAuditEvent {
  action: string
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

/** The part of the host's admission-control budget an engine reads. */
export interface EngineSpawnBudget {
  budget: { max: number; used: number; left: number; percent: number }
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
 * The public functions an engine may reuse, handed over as VALUES so it never deep-imports the
 * public tree. Its TYPE lives here and the host builds the value, so a public refactor that changes
 * a signature fails the public build where it happens. Growing it is a minor version bump; changing
 * a member is a major one. It starts empty: members join as the integrations move.
 */
export interface ReuseSurface {}

export interface EngineHostServices<E extends EngineEvent = EngineEvent> {
  /** Where things live. The engine reads no config of its own. */
  paths: {
    dataDir: string
    defaultDataDir: string
    contentDir: string
    home: string
    /** The env-override-resolved roots the host owns. */
    harnessRoots: Partial<Record<HarnessId, string>>
  }
  /** The public journal. `null` = journal off or unwritable — the engine must cope. */
  journal: { sink(): Promise<ProviderJournalSink<E> | null>; status(): JournalStatus }
  /** The machine's policy floor: paths no engine tool may touch. */
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
  readers: ReuseSurface
  now(): Date
}
