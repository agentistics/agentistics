/**
 * The browser's door onto `/api/vault/*` (SECRETS.4 §7.1) and the few pure rules the screen needs.
 *
 * What is NOT here: any decision about what an action asks. The server sends its own table
 * (`gates`, from `VAULT_ACTION_ROWS`) and every route enforces it again — this module only reads it to
 * draw the 🔑 / 👆 icons and to know whether a code field has to appear BEFORE the request rather than
 * after a 401. It is deliberately not `lib/stepup.ts`: that is the IAM step-up (a different grant, a
 * different route set); the vault's grant is bound to the vault service and travels in its own header.
 *
 * The 5-minute 'read' grant lives in MEMORY only — never localStorage, never a cookie — so closing the
 * tab ends it, and a script on another origin cannot read it.
 */
export type VaultLang = 'en' | 'pt'

export interface GateRow { code: boolean; gesture: boolean; grant: boolean }
export interface VaultItem {
  kind: string; state: 'sealed' | 'pending' | 'unreadable'; reason?: string; sealedAt?: string; file: string; restoreWith?: string
}
export interface Hardening { state: 'ok' | 'limited' | 'failed'; private: boolean | null; coreDumps: 'off' | 'on' | null; yama: string | null; lines: string[] }
export interface VaultView {
  state: string
  protector: string | null
  protectorLabel: string | null
  kid: string | null
  createdAt: string | null
  sentence: string | null
  pending: number
  canLock: boolean
  items: VaultItem[]
  locked?: boolean
  wrappers: string[]
  presence: boolean
  presenceAvailable: string[]
  /**
   * COFRE.DESBLOQUEIO (owner, 2026-11-07): the ways this machine offers to confirm "it is you", best
   * first — `advanced` for a security key (offered only where its tools exist). Absent on an older server.
   */
  unlockMethods?: { id: UnlockMethodId; advanced: boolean; gestures: { enroll: number; unlock: number } }[]
  /** The way(s) this vault confirms with today; empty = none chosen yet. Absent on an older server. */
  methods?: string[]
  /** The vault still records an app code from before 2026-11-07 (asked by nothing; dropped when a way is set up). */
  legacyAppCode?: boolean
  recoveryCreatedAt: string | null
  requirePresence: boolean
  autoLockMinutes: number
  /** VAULT.V4: confirm each use of a sensitive secret. Absent on an older server = off. */
  confirmEachUse?: boolean
  autoLockInMs: number | null
  pendingStepup: boolean
  lockedBy: string | null
  recoveryTodo: string[] | null
  hardening: Hardening | null
  gates: Record<string, GateRow>
  /** A page's FIRST enrolment owes the setup code (asked as the wizard's first step); the exact command and where to run it. Absent on an older server. */
  setupCode?: { owed: boolean; command: string; where: string }
  /** How many prompts the device check / the enrolment raise — stated by the server. Absent on an older one. */
  gestures?: { probe: number; enroll: number }
  /** Owner decision 2026-10-02: what an unlock asks besides the gesture. Absent on an older server. */
  unlockPolicy?: UnlockPolicyView
  /** v2.98.1: this page is open ON this computer (loopback). Absent on an older server = false. */
  loopback?: boolean
  /** v2.98.1: the kind whose ONE gesture stands for the setup code here (loopback only), or null. */
  localProofKind?: string | null
  /** v2.98.1: kinds this platform has but this build does not offer yet ("coming soon"). */
  presenceSoon?: string[]
  /** Owner decision 2026-10-06: which proof each kind of action asks. Absent on an older server. */
  authPolicy?: AuthPolicyView
}
export type UnlockMode = 'always' | 'hello-only' | 'daily'
/** The ways to confirm "it is you" (the server's `unlockMethodsFor`). */
export type UnlockMethodId = 'touchid' | 'hello' | 'password' | 'fido2'
/** PURE. Does this vault confirm with its own password only (no gesture to raise)? Then the page asks for it inline. */
export function confirmsWithPasswordOnly(v: Pick<VaultView, 'wrappers'>): boolean {
  return v.wrappers.includes('password') && !v.wrappers.some(w => w === 'hello' || w === 'touchid' || w === 'fido2')
}
/** Owner decision 2026-10-06 — the per-action policy. The SERVER decides (and refuses "none" on a critical kind); this only draws it. */
export type ProofChoice = 'code' | 'gesture' | 'both' | 'none'
export type ActionKind = 'reveal' | 'use' | 'edit' | 'delete-secret' | 'delete-device' | 'wipe' | 'settings' | 'recovery'
export interface AuthPolicyRow { kind: ActionKind; choice: ProofChoice; choices: ProofChoice[]; critical: boolean; read: boolean; default: ProofChoice }
export interface AuthPolicyView { state: 'default' | 'stored' | 'unreadable' | 'locked'; rows: AuthPolicyRow[] }
/** PURE. The editable draft: each kind's choice in force. */
export function authPolicyDraft(rows: readonly AuthPolicyRow[]): Partial<Record<ActionKind, ProofChoice>> {
  return Object.fromEntries(rows.map(r => [r.kind, r.choice])) as Partial<Record<ActionKind, ProofChoice>>
}
/** PURE. How many rows the draft changes against the rows' choices (an absent draft entry changes nothing). */
export function authPolicyDiff(rows: readonly AuthPolicyRow[], draft: Partial<Record<ActionKind, ProofChoice>>): number {
  return rows.filter(r => draft[r.kind] !== undefined && draft[r.kind] !== r.choice).length
}
/** PURE. How many kinds are NOT at their default — what the settings row states. */
export function authPolicyChanged(rows: readonly AuthPolicyRow[]): number {
  return rows.filter(r => r.choice !== r.default).length
}
export interface UnlockPolicyView { mode: UnlockMode; hours: number; chosen: boolean; codeNextUnlock: boolean; windowEndsAt: string | null }
export const UNLOCK_MODES: readonly UnlockMode[] = ['daily', 'always', 'hello-only']
export const UNLOCK_HOURS_MIN = 1
export const UNLOCK_HOURS_MAX = 24

/** A refusal, exactly as the server words it (already in the user's language). */
export interface Refusal { ok: false; code: string; sentence: string; status: number; action?: UiAction }
/** v2.98.1: the page control a refusal points at (the server swapped the terminal command for it). */
export type UiAction = 'recover' | 'unlock' | 'enroll' | 'disable-presence'
export type Reply<T = Record<string, never>> = ({ ok: true } & T) | Refusal

export type LoadResult =
  | { kind: 'view'; view: VaultView }
  | { kind: 'needs-stepup'; view: VaultView; sentence: string; code: string }
  | { kind: 'failed' }

// ── the grant (memory only) ──────────────────────────────────────────────────────────────────

const GRANT_MARGIN_MS = 5_000
let _grant: { token: string; until: number } | null = null

export function rememberGrant(token: string | undefined, now = Date.now()): void {
  _grant = token ? { token, until: now + 5 * 60_000 - GRANT_MARGIN_MS } : _grant
}
export function forgetGrant(): void { _grant = null }
export function grantAlive(now = Date.now()): boolean { return _grant !== null && now < _grant.until }

// ── review H2: the unlock's single-use proof, for the ONE action it was declared for (memory only) ──

const FRESH_MS = 90_000 - GRANT_MARGIN_MS
let _fresh: { token: string; until: number } | null = null
let _unlockFor: string | null = null
/** The action the NEXT unlock is for (`personal-grant:<sid>`), so its Hello also covers that one action. */
export function unlockFor(binding: string | null): void { _unlockFor = binding }
function freshAlive(now = Date.now()): boolean { return _fresh !== null && now < _fresh.until }

// ── COFRE.DESBLOQUEIO: the vault password, asked where a gesture would be raised ───────────────
//
// A vault that confirms with its OWN password asks for it at the unlock and at every confirmed action.
// Rather than every dialog growing a field, the server answers `password-required` (or `password-wrong`)
// and the ONE prompt the app mounts (VaultPasswordPrompt) asks the person; the request is then sent again
// with the password in its own header. The password lives in that request only: never stored, never
// logged, never in a URL — and dropped right after.

/** What the prompt is asked: is this a retry after a wrong password, and the server's sentence. */
export interface PasswordAsk { retry: boolean; sentence: string }
type PasswordPrompt = (ask: PasswordAsk) => Promise<string | null>
let _askPassword: PasswordPrompt | null = null
/** The app's one prompt registers here (null to detach). */
export function setVaultPasswordPrompt(fn: PasswordPrompt | null): void { _askPassword = fn }
const PASSWORD_CODES = new Set(['password-required', 'password-wrong'])
/** PURE. Should this reply be answered by asking the person for the vault password? */
export function wantsVaultPassword(r: { json: Record<string, unknown> } | null): boolean {
  return r !== null && r.json.ok !== true && PASSWORD_CODES.has(String(r.json.code ?? ''))
}

async function send(method: 'GET' | 'POST', path: string, sent: unknown, password?: string): Promise<{ status: number; json: Record<string, unknown> } | null> {
  try {
    const headers: Record<string, string> = {}
    if (sent !== undefined) headers['Content-Type'] = 'application/json'
    if (grantAlive()) headers['x-vault-grant'] = _grant!.token
    if (freshAlive()) headers['x-vault-fresh'] = _fresh!.token
    if (password !== undefined) headers['x-vault-password'] = password
    const r = await fetch(path, { method, headers, ...(sent !== undefined ? { body: JSON.stringify(sent) } : {}) })
    const json = await r.json().catch(() => ({})) as Record<string, unknown>
    if (typeof json.grant === 'string') rememberGrant(json.grant)
    if (typeof json.fresh === 'string') _fresh = { token: json.fresh, until: Date.now() + FRESH_MS }
    if (r.status === 401 && json.code === 'stepup-required') forgetGrant()
    return { status: r.status, json }
  } catch { return null }
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown, opts: { password?: string } = {}): Promise<{ status: number; json: Record<string, unknown> } | null> {
  // Every POST is JSON, even an empty one: the server refuses a vault POST of any other type (a
  // cross-site page could send text/plain without a preflight — review M1).
  const sent = method === 'POST' ? (body ?? {}) : body
  let r = await send(method, path, sent, opts.password)
  // The server wants the vault password: ask the person (at most three times) and send it again.
  for (let i = 0; i < 3 && method === 'POST' && _askPassword && wantsVaultPassword(r); i++) {
    const pw = await _askPassword({ retry: r!.json.code === 'password-wrong', sentence: String(r!.json.sentence ?? '') })
    if (pw === null) break
    r = await send(method, path, sent, pw)
  }
  return r
}

const reply = <T,>(r: { status: number; json: Record<string, unknown> } | null): Reply<T> => {
  if (!r) return { ok: false, code: 'network', sentence: '', status: 0 }
  if (r.json.ok === true) return r.json as unknown as Reply<T>
  const a = r.json.action
  const action = a === 'recover' || a === 'unlock' || a === 'enroll' || a === 'disable-presence' ? a : undefined
  return { ok: false, code: String(r.json.code ?? 'failed'), sentence: String(r.json.sentence ?? r.json.error ?? ''), status: r.status, ...(action ? { action } : {}) }
}

// ── the calls ────────────────────────────────────────────────────────────────────────────────

/** VAULT.PERSONAL: the same door (grant header, JSON, refusal shape) for `lib/vaultPersonal.ts`. */
export const vaultGet = <T,>(path: string) => call('GET', path).then(r => reply<T>(r))
export const vaultPost = <T,>(path: string, body: unknown) => call('POST', path, body).then(r => reply<T>(r))

export async function loadVault(): Promise<LoadResult> {
  const r = await call('GET', '/api/vault')
  if (!r) return { kind: 'failed' }
  if (r.status === 401 || r.status === 403) {
    if (r.json.needsStepUp === true && r.json.view) return { kind: 'needs-stepup', view: r.json.view as VaultView, sentence: String(r.json.sentence ?? ''), code: String(r.json.code ?? '') }
    return { kind: 'failed' }
  }
  return r.status === 200 && typeof r.json.state === 'string' ? { kind: 'view', view: r.json as unknown as VaultView } : { kind: 'failed' }
}

/** The 5-minute 'read' grant, earned by the person's proof (a gesture, or the vault password via the prompt). */
export const stepUp = () => call('POST', '/api/vault/stepup', {}).then(r => reply<{ grant: string }>(r))
export const lockNow = () => call('POST', '/api/vault/lock', {}).then(r => reply(r))
/**
 * The unlock: the SERVICE raises the gesture (Touch ID / the Mac password, Windows Hello, a key). A vault
 * that confirms with its own password is opened with `password` (typed inline on the unlock), or asks
 * for it through the prompt. There is no second step: no code is owed after it (COFRE.DESBLOQUEIO).
 */
export const unlockGesture = (password?: string) => call('POST', '/api/vault/unlock', _unlockFor ? { for: _unlockFor } : {}, password !== undefined ? { password } : {}).then(r => reply<{ state: string }>(r))
export interface VaultUseRequest { id: string; sessionTitle: string; harness: string; name: string; field: string; command: string | null; flags: string[]; count: number; expiresAt: number }
export const pendingVaultUseRequests = () => vaultGet<{ requests: VaultUseRequest[] }>('/api/vault/personal/use-requests')
const onThisComputer = (): boolean => { try { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname) } catch { return true } }
/**
 * Approve or deny ONE use request. Denying only closes, so it asks no gesture (spec §3.5); approving opens a
 * value, so it carries the presence gesture — raised by the service on this computer, a passkey token off it.
 */
export async function decideVaultUse(id: string, approve: boolean, phone: (action: string, target: string) => Promise<Reply<{ gestureToken: string }>> = async () => ({ ok: false, code: 'passkey-cancelled', sentence: '', status: 0 })): Promise<Reply<Record<string, unknown>>> {
  const path = `/api/vault/personal/use/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`
  if (!approve) return vaultPost(path, {})
  // On this computer the card's own Approve click raises the gesture, bound to THIS request; the proof rides x-vault-fresh.
  if (onThisComputer()) {
    const p = await vaultPost(`/api/vault/personal/use/${encodeURIComponent(id)}/prove`, {})
    if (!p.ok) return p as Reply<Record<string, unknown>>
    return vaultPost(path, {})
  }
  const g = await phone('use-approve', id)
  if (!g.ok) return g as Reply<Record<string, unknown>>
  return vaultPost(path, { gestureToken: g.gestureToken })
}
/** Create the vault from the page (the same code path as `agentop vault init`). `passphrase` only when no keychain answered. */
export const createVault = (passphrase?: string) => call('POST', '/api/vault/init', passphrase ? { passphrase } : {}).then(r => reply<{ existed?: boolean; said?: string }>(r))
/** Which proof each kind of action asks: gated by the CURRENT 'settings' choice (the server's `set-auth-policy` row). */
export const setAuthPolicy = (policy: Partial<Record<ActionKind, ProofChoice>>) => call('POST', '/api/vault/auth-policy', { policy }).then(r => reply(r))
/**
 * PURE. The words for step 2 of "how your vault works": the vault's own proof once one is chosen
 * (Touch ID / the Mac password, Windows Hello, a key, the vault password), else "nothing yet".
 */
export function howStep2(v: Pick<VaultView, 'presence'>): { key: 'how2_proof' | 'how2_nothing'; hours?: number } {
  return { key: v.presence ? 'how2_proof' : 'how2_nothing' }
}
export const setAutoLock = (minutes: number) => call('POST', '/api/vault/auto-lock', { minutes }).then(r => reply(r))
export const armHeartbeat = () => call('POST', '/api/vault/activity/arm', { gesture: true })
export const setConfirmEachUse = (enabled: boolean) => call('POST', '/api/vault/confirm-each-use', { enabled }).then(r => reply(r))
export const heartbeat = () => call('POST', '/api/vault/activity', {})

/** The wizard's first step: spend the setup code BEFORE any gesture; the proof stands for the rest of this wizard. */
export const setupCodeAccept = (setupCode: string) => call('POST', '/api/vault/setup-code', { setupCode }).then(r => reply(r))
export interface GestureProgress { kind: string; done: number; total: number }
/** Polled while a probe / enrolment request is in flight. `null` = nothing in flight for this session. */
export const presenceProgress = () => call('GET', '/api/vault/presence/progress').then(r => reply<{ progress: GestureProgress | null }>(r))
/** PURE. "Confirmation i of n": the one being asked now (done + 1), never past n. */
export function gestureStep(p: GestureProgress | null): { i: number; n: number } | null {
  if (!p || p.total <= 0) return null
  return { i: Math.min(p.total, p.done + 1), n: p.total }
}
export const presenceProbe = (protector: UnlockMethodId, setupCode?: string) => call('POST', '/api/vault/presence/probe', { protector, ...(setupCode ? { setupCode } : {}) }).then(r => reply(r))
export const recoveryBegin = (setupCode?: string) => call('POST', '/api/vault/recovery/begin', { ...(setupCode ? { setupCode } : {}) }).then(r => reply<{ words: string[]; positions: number[] }>(r))
export const recoveryConfirm = (typed: string[]) => call('POST', '/api/vault/recovery/confirm', { typed }).then(r => reply(r))
/**
 * Set up a way to confirm. `password`: the NEW vault password (the server checks the same rules), sent
 * in its own header for this one request. `replaceRecovery`: no words at hand — make NEW words after it.
 */
export const presenceEnrol = (protector: UnlockMethodId, opts: { password?: string; replaceRecovery?: boolean; setupCode?: string } = {}) =>
  call('POST', '/api/vault/presence/enroll', { protector, ...(opts.replaceRecovery ? { replaceRecovery: true } : {}), ...(opts.setupCode ? { setupCode: opts.setupCode } : {}) }, opts.password !== undefined ? { password: opts.password } : {})
    .then(r => reply<{ removed: string[]; recoveryOwed: boolean }>(r))
export const presenceDisable = (words?: string) => call('POST', '/api/vault/presence/disable', { ...(words ? { words } : {}) }).then(r => reply(r))
/** v2.98.1: ONE presence gesture on a loopback page stands for the setup code of a FIRST enrolment. */
export const localProof = () => call('POST', '/api/vault/local-proof').then(r => reply<{ kind: string | null }>(r))
/** v2.98.1: recovery with the 24 words, from a loopback page only. The caller drops the words right after. */
export const recoverWithWords = (words: string) => call('POST', '/api/vault/recover', { words }).then(r => reply<{ todo: string[] }>(r))

/** PURE. 24 boxes from whatever was pasted or typed: lower-cased, split on any whitespace/comma/number. */
export function splitWords(s: string): string[] {
  return s.toLowerCase().replace(/\d+[.)]/g, ' ').split(/[\s,;]+/).filter(Boolean).slice(0, 24)
}
/** PURE. The ways a vault that already confirms may still ADD: offered here, and not already set up. */
export function addableKinds(v: Pick<VaultView, 'presenceAvailable' | 'wrappers'>): UnlockMethodId[] {
  return (['touchid', 'hello', 'password', 'fido2'] as const).filter(k => v.presenceAvailable.includes(k) && !v.wrappers.includes(k))
}
export interface Credential { type: string; label: string; createdAt: string }
export const credentials = () => call('GET', '/api/vault/credentials').then(r => reply<{ credentials: Credential[]; recoveryCreatedAt: string | null; requirePresence: boolean }>(r))

// ── pure rules ───────────────────────────────────────────────────────────────────────────────

export const AUTO_LOCK_MIN = 5
export const AUTO_LOCK_MAX = 480

/** PURE. The idle period as typed: whole minutes only; anything else is "not a number yet" (null). */
export function parseAutoLockInput(s: string): number | null {
  const t = s.trim()
  return /^\d{1,4}$/.test(t) ? Number(t) : null
}
/** PURE. 5–480, never "never" (§5.1). */
export function clampAutoLock(n: number): number {
  return Number.isFinite(n) ? Math.min(AUTO_LOCK_MAX, Math.max(AUTO_LOCK_MIN, Math.round(n))) : 30
}

/** PURE. Milliseconds left on the idle clock, counted from when the server reported it. */
export function remainingMs(reportedInMs: number | null, reportedAt: number, now: number): number | null {
  return reportedInMs === null ? null : Math.max(0, reportedInMs - (now - reportedAt))
}
/** PURE. Whole minutes for a countdown, rounded UP so "0 min" never shows while it is still open. */
export function minutesLeft(ms: number): number { return Math.max(0, Math.ceil(ms / 60_000)) }

/**
 * PURE. Whether an action asks the person's proof on THIS vault right now: only once a way to confirm
 * exists (the server's own rule — `requireVaultStepUp`). COFRE.DESBLOQUEIO: `code` is always false — no
 * row asks a code any more; the field is kept so an older server's table still reads.
 */
export function gateFor(view: Pick<VaultView, 'gates' | 'presence'>, action: string): { code: boolean; gesture: boolean; grant: boolean } {
  const row = view.gates[action]
  if (!row) return { code: false, gesture: false, grant: false }
  return { code: false, gesture: (row.gesture || row.code) && view.presence, grant: row.grant }
}

/**
 * COFRE.DESBLOQUEIO (owner, 2026-11-07): two steps protect the vault — HOW it confirms it is you
 * (`presence`: Touch ID / the Mac password, Windows Hello, a vault password, or a security key), then the
 * 24 words. There is no app-code step any more.
 */
export type WizardStep = 'recovery' | 'presence'
/** What the wizard runs: the first-enrolment proof leads whenever the server says a page owes it. */
export type WizardPhaseStep = 'setup' | 'local' | WizardStep

/**
 * PURE. The whole flow for what is missing: [proof] → presence → recovery. The proof is FIRST, before
 * any gesture (owner, 2026-10-02: it used to surface only after the dialogs, as a red failure).
 */
export function wizardPlan(missing: readonly WizardStep[], setupOwed = false, localProof = false): WizardPhaseStep[] {
  const steps: WizardPhaseStep[] = [...missing]
  // v2.98.1: on a page ON this computer with a gesture method (Touch ID, Hello), ONE gesture replaces the setup code.
  return setupOwed && steps.length > 0 ? [localProof ? 'local' : 'setup', ...steps] : steps
}

/** PURE. After a page recovery: the re-enrolment the server still owes, in the wizard's safe order. */
export function recoverySteps(todo: readonly string[] | null | undefined): WizardStep[] {
  if (!todo) return []
  return (['presence', 'recovery'] as const).filter(s => todo.includes(s))
}

/** PURE. What an action will ask, as words for a tooltip — from the gate row, narrowed by this vault. */
export function askWords(g: { code: boolean; gesture: boolean }, words: { code: string; presence: string; and: string; asks: string; nothing: string }): string {
  if (!g.code && !g.gesture) return words.nothing
  const parts = [g.code ? words.code : null, g.gesture ? words.presence : null].filter(Boolean).join(words.and)
  return words.asks.replace('{what}', parts)
}
/** PURE. What the protected setup still lacks, in the one safe order (presence first — it retires the silent wrapper). */
export function missingSteps(v: Pick<VaultView, 'recoveryCreatedAt' | 'presence' | 'presenceAvailable'>): WizardStep[] {
  const out: WizardStep[] = []
  // Leader decision 2: presence BEFORE the recovery key (presence replaces the data key; the words made
  // last wrap the final one and are never kept in memory across steps). The vault password is offered
  // on every machine, so presence is always available.
  if (!v.presence && v.presenceAvailable.length > 0) out.push('presence')
  if (!v.recoveryCreatedAt) out.push('recovery')
  return out
}

/** PURE. The 24 words as 6 rows × 4 columns, numbered (the order a person copies them onto paper). */
export function wordRows(words: readonly string[], perRow = 4): { n: number; word: string }[][] {
  const rows: { n: number; word: string }[][] = []
  for (let i = 0; i < words.length; i += perRow) rows.push(words.slice(i, i + perRow).map((word, j) => ({ n: i + j + 1, word })))
  return rows
}

/** The 8-digit setup code (`agentop vault setup-code`), spaces and dashes ignored. */
export function cleanSetupCode(s: string): string { return s.replace(/\D/g, '').slice(0, 8) }
export const setupCodeComplete = (s: string): boolean => /^\d{8}$/.test(s)

// ── what a glance should say (VAULT.UX2) ─────────────────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'rec' | 'off'
export type BadgeKey =
  | 'badge_configured' | 'badge_missing' | 'badge_recommended' | 'badge_on' | 'badge_na' | 'badge_attention'
  | 'badge_active' | 'badge_limited' | 'badge_minutes' | 'badge_sealed' | 'badge_pending'
export type SectionId = 'presence' | 'recovery' | 'autolock' | 'memory' | 'secrets'

/**
 * PURE. The badge each section wears: a tone (colour AND a glyph in the words, never colour alone) and
 * the text key. "missing" is only said for what the setup can still add; a thing this machine cannot
 * have is "not available here", which is a fact and not a to-do.
 */
export function sectionBadge(
  v: Pick<VaultView, 'presence' | 'presenceAvailable' | 'recoveryCreatedAt' | 'hardening'>,
  id: SectionId, counts: { sealed: number; pending: number } = { sealed: 0, pending: 0 },
): { tone: Tone; key: BadgeKey } {
  switch (id) {
    case 'presence':
      // COFRE.DESBLOQUEIO: the way to confirm is not optional any more — it is what protects the vault.
      if (v.presence) return { tone: 'ok', key: 'badge_on' }
      return v.presenceAvailable.length === 0 ? { tone: 'off', key: 'badge_na' } : { tone: 'warn', key: 'badge_missing' }
    case 'recovery': return v.recoveryCreatedAt ? { tone: 'ok', key: 'badge_configured' } : { tone: 'warn', key: 'badge_missing' }
    case 'autolock': return { tone: 'ok', key: 'badge_minutes' }
    case 'memory': {
      const h = v.hardening
      if (!h) return { tone: 'off', key: 'badge_limited' }
      if (h.state === 'failed' || h.private === false || h.coreDumps === 'on') return { tone: 'warn', key: 'badge_attention' }
      return h.private === true && h.coreDumps === 'off' ? { tone: 'ok', key: 'badge_active' } : { tone: 'off', key: 'badge_limited' }
    }
    case 'secrets': return counts.pending > 0 ? { tone: 'warn', key: 'badge_pending' } : { tone: 'ok', key: 'badge_sealed' }
  }
}

/** PURE. Which of the three steps of "how your vault works" the person is on NOW: 0 locked, 1 confirming, 2 open. */
export function howNow(v: Pick<VaultView, 'state' | 'pendingStepup'>): 0 | 1 | 2 {
  return v.state === 'open' ? 2 : v.pendingStepup ? 1 : 0
}

/** PURE. What step 2 asks of THIS vault: nothing yet, or the person's proof (one gesture or the vault password). */
export function howConfirms(v: Pick<VaultView, 'presence'>): 'nothing' | 'proof' {
  return v.presence ? 'proof' : 'nothing'
}

/**
 * PURE. The ONE primary action of the page: the first thing the setup still lacks, and only when the
 * banner (which carries its own primary) is not showing. Everything else that is missing keeps a
 * quiet button — two loud buttons for one flow is how a person stops knowing where to start.
 */
export function primarySection(missing: readonly WizardStep[], bannerShowing: boolean): WizardStep | null {
  return bannerShowing ? null : (missing[0] ?? null)
}

/** One idle window after a fresh confirmation here / the phone's passkey there — never a code. */
export const extendVaultOpen = (gestureToken?: string) => vaultPost<{ autoLockInMs: number }>('/api/vault/extend', gestureToken ? { gestureToken } : {})
export const lockVaultFromCard = () => lockNow()
