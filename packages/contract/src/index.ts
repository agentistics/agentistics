/**
 * @agentistics/contract — the wire contract between a machine running agentistics and Agentistics
 * Cloud (E9/E15). The source of truth is `openapi/machine-v1.yaml`; this module is its typed mirror
 * for TypeScript callers (agentop's cloud client), and `contract.test.ts` holds the two together.
 *
 * The files under `openapi/`, `fixtures/` and `CONTRACT.lock` are byte-identical copies of the
 * Cloud's `docs/specs/contract/`; their digest is locked per version and checked on both sides.
 * Change them only by applying the Cloud leader's patch, never by hand here.
 *
 * Tolerant reader: ignore response fields you do not know; treat an unknown `error` by its HTTP
 * status class. Response types below list what v1.1.0 sends; a MINOR may add fields.
 */

export const CONTRACT_VERSION = '1.1.0'

// ── pairing and tokens ──────────────────────────────────────────────────────────────────────

export const MACHINE_CLIENT_ID = 'agentop'
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** RFC 9449 proofs signed with the machine's Ed25519 key. `htu` = the Cloud's public URL + path. */
export const DPOP = {
  header: 'DPoP',
  typ: 'dpop+jwt',
  alg: 'EdDSA',
  crv: 'Ed25519',
  proofSkewS: 60,
  maxProofBytes: 2048,
  jtiPattern: '^[A-Za-z0-9_-]{16,64}$',
} as const

export const PATHS = {
  deviceAuthorization: '/oauth/device_authorization',
  token: '/oauth/token',
  machine: '/v1/machine',
  disconnect: '/v1/machine/disconnect',
  metrics: '/v1/machine/metrics',
  sharing: '/v1/machine/metrics/sharing',
  backupKey: '/v1/machine/keys/backup',
  recoveryWrap: '/v1/machine/keys/backup/recovery-wrap',
  senderCerts: '/v1/machine/keys/backup/sender-certs',
  backups: '/v1/machine/backups',
  backup: '/v1/machine/backups/{snapshotId}',
  backupCommit: '/v1/machine/backups/{snapshotId}/commit',
} as const

export const PAIRING = {
  deviceCodeExpiresInS: 600,
  pollIntervalS: 5,
  /** RFC 8628 §3.5: add this to the interval after each `slow_down` (and after a 429). */
  slowDownIncrementS: 5,
  accessTokenExpiresInS: 900,
  /** A machine that has not refreshed for this long must pair again. */
  refreshIdleDays: 90,
  userCodeAlphabet: 'BCDFGHJKLMNPQRSTVWXZ',
  maxFormBytes: 4096,
} as const

export const MACHINE_KINDS = ['device', 'server', 'onprem'] as const
export type MachineKind = (typeof MACHINE_KINDS)[number]

/** The C15 switches shown at pairing, each its own consent. */
export const FLOW_NAMES = ['metrics', 'sessionTitles', 'sessionSync', 'remoteAccess', 'backup'] as const
export type PairingFlows = Record<(typeof FLOW_NAMES)[number], boolean>
export const DEFAULT_FLOWS: PairingFlows = { metrics: true, sessionTitles: true, sessionSync: true, remoteAccess: true, backup: true }

export interface DeviceAuthorizationForm {
  client_id: typeof MACHINE_CLIENT_ID
  /** X25519 envelope public key, standard base64 SPKI DER (the envelope-crypto.ts format). */
  envelope_key: string
  name: string
  kind?: MachineKind
}

export interface DeviceAuthorizationResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export interface PairedTokenResponse {
  access_token: string
  token_type: 'DPoP'
  expires_in: number
  /** Bound to the machine key; not rotated. Returned once, at pairing. */
  refresh_token: string
  machine_id: string
  workspace_id: string
  flows: PairingFlows
}

export type RefreshedTokenResponse = Omit<PairedTokenResponse, 'refresh_token'>

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_dpop_proof'
  | 'unsupported_grant_type'
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'

export interface MachineSelf {
  id: string
  name: string
  kind: MachineKind
  ownerUserId: string
  signingFingerprint: string
  envelopeFingerprint: string
  flows: PairingFlows
  pairedAt: string
  lastRefreshAt: string
  revokedAt: null
  workspaceId: string
}

// ── encrypted backup (1.1) ──────────────────────────────────────────────────────────────────
// Everything is sealed on the device; the Cloud stores and returns these values and opens none.

export const BACKUP = {
  maxChunks: 6000,
  chunkBytes: 4 * 1024 * 1024,
  tagBytes: 16,
  maxPartBytes: 4 * 1024 * 1024 + 16,
  maxWrapBytes: 4096,
  maxSenders: 100,
  maxBodyBytes: 8192,
  maxCommitBodyBytes: 1024 * 1024,
  urlExpiresInS: 900,
  pendingUploadExpiresInH: 6,
  purgeWithinDays: 30,
  manifestPart: 'manifest',
  snapshotIdPattern: '^[A-Za-z0-9_-]{16,64}$',
} as const

/** A snapshot's data key wrapped to the backup key. All byte fields are standard base64. */
export interface DekWrap {
  v: 1
  senderPublicKey: string
  ephemeralPublicKey: string
  nonce: string
  ct: string
}

/** The backup private key wrapped under the recovery words. */
export interface RecoveryWrap {
  v: 1
  nonce: string
  ct: string
}

export interface SenderCert {
  v: 1
  senderPublicKey: string
  cert: string
}

export interface SenderCertRequest {
  senderCert: SenderCert
}

export interface BackupKeyRequest {
  publicKey: string
  fingerprint: string
  recoveryWrap: RecoveryWrap
}

export interface BackupKeySet {
  fingerprint: string
  wrapVersion: 1
}

export interface RecoveryWrapRequest {
  recoveryWrap: RecoveryWrap
  expectedVersion: number
}

export interface RecoveryWrapSet {
  wrapVersion: number
}

export interface BackupStart {
  snapshotId: string
  chunks: number
  /** PLAINTEXT size of the object. */
  totalBytes: number
  manifestBytes: number
}

export interface SignedPart {
  /** Chunk index ("0", "1", …) or "manifest". */
  part: string
  url: string
  /** Send these with the request, exactly. */
  headers: Record<string, string>
  expiresIn: number
}

export interface BackupUpload {
  snapshotId: string
  upload: SignedPart[]
}

export interface BackupCommit {
  dekWrap: DekWrap
  chunkDigests: string[]
}

export interface BackupCommitted {
  id: string
  state: 'committed'
  committedAt: string
}

export interface BackupSummary {
  id: string
  machineId: string
  state: 'committed'
  chunks: number
  totalBytes: number
  manifestBytes: number
  createdAt: string
  committedAt: string
}

export interface BackupList {
  backups: BackupSummary[]
}

export interface BackupDetail extends BackupSummary {
  dekWrap: DekWrap
  chunkDigests: string[]
  download: SignedPart[]
}

// ── metrics ingest ──────────────────────────────────────────────────────────────────────────

export const METRICS = {
  bodyVersion: 1,
  maxBodyBytes: 2 * 1024 * 1024,
  maxDecodedBytes: 8 * 1024 * 1024,
  maxRulesBytes: 256 * 1024,
  maxBatch: 50,
  minPushIntervalS: 60,
  clockSkewFlagMs: 5 * 60_000,
  maxSamples: 120,
  maxText: 1024,
  maxLabel: 500,
  maxSources: 1000,
} as const

export const SAMPLE_METRICS = ['cpu', 'ram', 'gpu', 'vram', 'disk', 'net_rx', 'net_tx'] as const
export const T2_FIELDS = ['title', 'first_prompt', 'user_label', 'user_note'] as const
/** CLOSED: every status is durable progress — advance the cursor past each session in `results`. */
export const SESSION_STATUSES = ['applied', 'unchanged', 'stale', 'not_shared'] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** A key with one of these names on a session, on the body or on `operational` refuses the push (422). Never send content. */
export const CONTENT_FIELDS = [
  'content', 'contents', 'message', 'messages', 'transcript', 'prompt', 'prompts', 'response', 'responses', 'completion',
  'code', 'output', 'outputs', 'tool_input', 'tool_inputs', 'tool_result', 'tool_results', 'diff', 'patch', 'attachments',
  'events', 'journal', 'agentMetrics',
] as const

type Counts = Record<string, number>
type Tree = Record<string, Record<string, number | Record<string, number>>>

/** One session: identity, T1 usage metadata, T2 labels. `null` on an optional field = absent. */
export interface SessionMetrics {
  session_id: string
  harness: string
  /** The journal position the metrics were computed at; the highest wins. */
  seq: number
  project_path: string
  start_time: string
  git_remote?: string | null
  model?: string | null
  end_time?: string | null
  duration_minutes?: number | null
  active_minutes?: number | null
  user_message_count?: number | null
  assistant_message_count?: number | null
  user_chars?: number | null
  user_char_messages?: number | null
  assistant_chars?: number | null
  assistant_char_messages?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation_1h_input_tokens?: number | null
  cache_creation_5m_input_tokens?: number | null
  context_tokens?: number | null
  context_window?: number | null
  compact_count?: number | null
  compact_ms?: number | null
  compact_dropped_tokens?: number | null
  cost_usd?: number | null
  tool_counts?: Counts | null
  tool_output_tokens?: Counts | null
  tool_errors?: number | null
  tool_error_categories?: Counts | null
  skill_uses?: Counts | null
  mcp_tool_call_count?: number | null
  mcp_tool_names?: string[] | null
  languages?: string[] | null
  git_commits?: number | null
  git_pushes?: number | null
  lines_added?: number | null
  lines_removed?: number | null
  files_modified?: number | null
  user_interruptions?: number | null
  user_response_times?: number[] | null
  message_hours?: number[] | null
  user_message_timestamps?: string[] | null
  uses_task_agent?: boolean | null
  uses_mcp?: boolean | null
  uses_web_search?: boolean | null
  uses_web_fetch?: boolean | null
  daily?: Tree | null
  model_usage?: Tree | null
  title?: string | null
  first_prompt?: string | null
  user_label?: string | null
  user_note?: string | null
}

export type MinAvgMax = { min: number; avg: number; max: number }
export type HardwareSample = { minute: string } & Partial<Record<(typeof SAMPLE_METRICS)[number], MinAvgMax>>

export interface OperationalReport {
  agent_version?: string | null
  platform?: string | null
  arch?: string | null
  counts?: Counts | null
  samples?: HardwareSample[] | null
}

export interface IngestRequest {
  v: typeof METRICS.bodyVersion
  sent_at: string
  operational?: OperationalReport | null
  sessions?: SessionMetrics[]
}

export interface IngestResult {
  results: { session_id: string; harness: string; seq: number; status: SessionStatus }[]
  t0: 'full' | 'online_only'
  titles: 'kept' | 'stripped'
  redacted: number
  droppedFields: number
  clockSkewMs: number
  clockSkewFlagged: boolean
  cadence: { minIntervalS: number; maxBatch: number }
}

export interface ShareSource {
  type: 'repo' | 'project' | 'none'
  value: string
}

export interface SharingRules {
  mode: 'denylist' | 'allowlist'
  sources: ShareSource[]
}

export interface ContractError {
  error: string
  field?: string
  index?: number
  maxBatch?: number
  flow?: string
  reason?: string
  retryAfterSec?: number
  requestId?: string
  missing?: string[]
  quotaBytes?: number
  usedBytes?: number
  fingerprint?: string
  wrapVersion?: number
}
