/**
 * vault/service.ts — this process's view of the machine's vault: whether it is open, the one place
 * a secret is sealed to or opened from a file, and the migration pass that runs at every open.
 *
 * Rules (docs/security.md § "Secrets at rest"):
 *  - **Never plain text.** A write that cannot seal REFUSES with a sentence (`VaultRefusalError`);
 *    there is no code path that falls back to writing the value as it is.
 *  - **The vault is created on first NEED, not on install** — the first time something must be
 *    sealed (or a plaintext file from an earlier version is found), detection runs once: the first
 *    protector that completes a real round trip is recorded in `vault.json` and used for ever after.
 *    With none, a non-interactive process stays `uninitialized` (writes refused, old plaintext left
 *    exactly as it is and reported as `plaintext-pending`) until `agentop vault init` asks for a
 *    passphrase on a terminal.
 *  - **Opening runs the migration** of every legacy plaintext file, once per process per open.
 *  - **The DEK lives only in this process's memory**, is never logged, returned or put in an error.
 *
 * Under `bun test` the only protector is the in-memory one (see `memoryProtector`), so a test never
 * spawns `powershell.exe` or touches a keychain; `AGENTISTICS_VAULT_SMOKE=1` lifts that for the
 * real-protector smoke test.
 */
import { join } from 'node:path'
import { homedir, platform as osPlatform } from 'node:os'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { open as openFile, readFile as readFileP, stat as statP, unlink as unlinkP, mkdir as mkdirP } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  VaultRefusalError, bytesEqual, chooseProtector, checkedList, destroyVault, detectionOrder, initVault, isModeTooOpen,
  dpapiProtector, keychainProtector, libsecretProtector, systemdCredsProtector, passphraseProtector,
  memoryProtector, openRecord, openVault, refusalSentence, sealToBytes, writePrivateAtomic, initSentence,
  type Lang, type OpenState, type Platform, type Protector, type ProtectorId, type ProtectorIo,
  type SecretFs, type SentenceArgs, type VaultRefusal, type Checked, type VaultJson, type ScryptParams,
  makeHandle, parseVaultJson, RUNNER_VAULT_DIR, type RunnerHandle,
  helloProtector, fido2Protector, effectiveUnlockPolicy, unlockNeedsCode, finishRetirement, recoveryProtector, hasPresence, isPresenceId, presenceCode,
  presenceSentence, AutoLockClock, AUTO_LOCK_DEFAULT_MIN, WEBAUTHN_BRIDGE_VERIFIED,
} from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import { underTest } from '../data-dir'
import { realProtectorIo, realSecretFs } from './io'
import { applyHardening, loadLibc, readYamaFile, type HardeningPlatform, type HardeningReport } from './hardening'
import { omittedSecrets } from '../backup/backup-plan'

// ── where ─────────────────────────────────────────────────────────────────────────────────────

let _vaultDir = join(AGENTISTICS_DATA_DIR, 'vault')
export function vaultDir(): string { return _vaultDir }
/** SECRETS.4 §1.1: the runner scope's own vault, BESIDE the human one, never inside it. */
export function runnerVaultDir(): string { return join(_vaultDir, '..', RUNNER_VAULT_DIR) }
export function runDir(): string { return join(AGENTISTICS_DATA_DIR, 'run') }
export function vaultSocketPath(): string { return join(runDir(), 'vault.sock') }

/** `~/.agentistics/…` for a sentence: the path as the user would find it, never a bare tmp path. */
export function displayPath(p: string): string {
  const home = homedir()
  return home && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

// ── restore commands, from the backup plan's `secret` rows ─────────────────────────────────────

const RESTORE_ROW: Record<string, string> = {
  'github-backup': '.agentistics/github-backup.',
  'central-token': '.agentistics/preferences.json#team.token',
  'envelope-key': '.agentistics/machine-key',
  'central-env': '.agentistics/central',
  'engine/provider-key': '.agentistics/provider-keys',
}

/**
 * The command that re-establishes a secret of this purpose — read from `omittedSecrets()`, so the
 * command a refusal names and the one a restore prints are the same string.
 */
export function restoreWithFor(purpose: string): string {
  const pattern = RESTORE_ROW[purpose]
  const row = pattern ? omittedSecrets().find(r => r.pattern === pattern) : undefined
  return row?.restoreWith ?? 'the command that set it'
}

/** Every restore command a vault-wide refusal (protector-lost) names. */
export function allRestoreWith(): string {
  return [...new Set(Object.keys(RESTORE_ROW).map(restoreWithFor))].join('; ')
}

// ── who may hold the key (SECRETS.4 §5.2) ───────────────────────────────────────────────────────
//
// ONE process holds a human data key: the agentop service. Every other process — each `agentop …`
// CLI call, the control center — is a CLIENT: it never opens the vault, never unwraps the DEK, and
// never receives a human-scope plaintext. It SEALS through the service (`vault.sock` `seal`: the
// plaintext goes in, only ciphertext comes back), and anything that needs a secret's VALUE is done
// BY the service on its behalf (socket.ts). The default is `client`; the service claims `holder`
// at boot (`becomeVaultHolder`, from cli.ts's `server` branch and from index.ts), before anything
// reads a secret. A test process is the holder (it plays the service).

export type VaultRole = 'holder' | 'client'
let _role: VaultRole = underTest(process.env) ? 'holder' : 'client'
export function vaultRole(): VaultRole { return _role }
/** Called by the agentop SERVICE only, before anything reads a secret. Idempotent. */
export function becomeVaultHolder(): void { _role = 'holder' }

// ── process hardening (SECRETS.4 §5.3) ───────────────────────────────────────────────────────────
//
// Applied ONCE, before the first unwrap — `ensureVaultOpen` and `openRunnerVault` both wait for it,
// so no entry path can reach a DEK first. A `failed` report keeps BOTH scopes closed in this process
// (`hardening-failed`); `limited` (Windows, other OSes) is stated and does not block. Under `bun test`
// the test process is NOT hardened (it would make the runner itself non-dumpable) unless the smoke
// asks for it; tests drive the gate through `__setHardeningForTests`.

let _hardening: HardeningReport | null = null
let _hardeningRun: Promise<HardeningReport> | null = null

export async function hardenThisProcess(): Promise<HardeningReport> {
  if (_hardening) return _hardening
  _hardeningRun ??= (async () => {
    if (!realMode()) return { state: 'ok', private: null, coreDumps: null, yama: null, reason: 'not applied under test' } as HardeningReport
    const p = platform() as HardeningPlatform
    return applyHardening(p, await loadLibc(p), readYamaFile)
  })()
  _hardening = await _hardeningRun
  return _hardening
}

export function hardeningReport(): HardeningReport | null { return _hardening }

function hardened(): boolean { return _hardening !== null && _hardening.state !== 'failed' }

// ── language ──────────────────────────────────────────────────────────────────────────────────

let _lang: () => Lang = () => {
  // A cheap, dependency-free read of the stored language: the vault is reached from preferences.ts
  // itself, so it cannot import it back. `AGENTISTICS_LANG` / `--lang` set by cli.ts wins.
  const env = process.env.AGENTISTICS_LANG
  if (env === 'pt' || env === 'en') return env
  try {
    const p = JSON.parse(readFileSync(join(AGENTISTICS_DATA_DIR, 'preferences.json'), 'utf8')) as { lang?: string }
    return p.lang === 'pt' ? 'pt' : 'en'
  } catch { return 'en' }
}
export function vaultLang(): Lang { return _lang() }

export function sentence(code: VaultRefusal, args: SentenceArgs = {}): string {
  return refusalSentence(code, vaultLang(), args)
}

/** A refusal RESULT `{ok:false, code, sentence}` — a vault state, never a notification code. */
export function refused<C extends string>(code: C, text: string): { ok: false; code: C; sentence: string } {
  return { ok: false, code, sentence: text }
}

export function refusal(code: VaultRefusal, args: SentenceArgs = {}): VaultRefusalError {
  return new VaultRefusalError(code, sentence(code, args))
}

// ── protectors ────────────────────────────────────────────────────────────────────────────────

let _io: ProtectorIo | null = null
let _fs: SecretFs = realSecretFs
function io(): ProtectorIo { return (_io ??= realProtectorIo()) }
export function secretFs(): SecretFs { return _fs }

function platform(): Platform {
  const p = osPlatform()
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other'
}

function isWsl(): boolean {
  if (platform() !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME) return true
  try { return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')) } catch { return false }
}

function realMode(): boolean {
  return !underTest(process.env) || process.env.AGENTISTICS_VAULT_SMOKE === '1'
}

/** Test-only scrypt cost (production uses the stored/default parameters). */
let _scryptForTests: ScryptParams | undefined

/** Test seam: protectors that replace the real adapter of the same id. */
let _override: Protector[] | null = null
/** Test seam: how auto-init chooses (`strict` = one protector, retried; else the candidates). */
let _autoInit: { strict: Protector; delaysMs: number[] } | { candidates: Protector[] } | null = null

export function protectorById(id: ProtectorId, passphrase?: string, dir: string = vaultDir()): Protector | null {
  const o = id !== 'passphrase' ? _override?.find(p => p.id === id) : undefined
  if (o) return o
  switch (id) {
    case 'keychain': return keychainProtector(io())
    case 'dpapi': return dpapiProtector({ io: io(), vaultDir: dir, wsl: isWsl() })
    case 'libsecret': return libsecretProtector(io())
    case 'systemd-creds': return systemdCredsProtector(io(), dir)
    case 'passphrase': return passphraseProtector({ io: io(), vaultDir: dir, passphrase, params: _scryptForTests })
    case 'memory': return realMode() ? null : memoryProtector()
    case 'hello': return platform() === 'win32' || isWsl() ? helloProtector({ io: io(), vaultDir: dir, wsl: isWsl() }) : null
    case 'fido2': return fido2Protector({ io: io(), vaultDir: dir, transport: platform() === 'win32' || isWsl() ? 'webauthn' : 'cli', wsl: isWsl() })
    // Without the words in hand it can only be REMOVED (rotation); opening goes through `recover`.
    case 'recovery': return recoveryProtector({ io: io(), vaultDir: dir })
  }
}

/**
 * SECRETS.4 §3.4: the presence protectors to offer at ENROLMENT, in order. Never probed at service
 * start — a probe costs the user gestures. macOS gets FIDO2 only (Secure Enclave is deferred, Q1); a
 * headless box or a container gets none and stays on its OS protector (or passphrase).
 */
export function presenceCandidates(): Protector[] {
  const soon = presenceSoon()
  if (!realMode()) return _override?.filter(p => (p.id === 'hello' || p.id === 'fido2') && !soon.includes(p.id)) ?? []
  const ids: ProtectorId[] = platform() === 'win32' || isWsl() ? ['hello', 'fido2'] : platform() === 'linux' || platform() === 'darwin' ? ['fido2'] : []
  return ids.filter(id => !soon.includes(id)).map(id => protectorById(id)).filter((p): p is Protector => p !== null)
}

/**
 * v2.98.1 (the owner's machine): presence kinds this platform HAS but this build cannot offer yet. On
 * Windows / WSL a security key goes through the webauthn.dll bridge, whose struct layouts are not yet
 * verified on real hardware (fido2.ts `WEBAUTHN_BRIDGE_VERIFIED`), so it is never OFFERED there: the
 * page shows it as "coming soon" instead of letting it fail with an internal sentence.
 */
export function presenceSoon(): ProtectorId[] {
  if (!realMode()) return _soonForTests
  return (platform() === 'win32' || isWsl()) && !WEBAUTHN_BRIDGE_VERIFIED ? ['fido2'] : []
}
let _soonForTests: ProtectorId[] = []

/** The candidates detection probes on this machine, in order. */
export function candidateProtectors(): Protector[] {
  if (_autoInit && 'candidates' in _autoInit) return _autoInit.candidates
  if (!realMode()) return [memoryProtector()]
  return detectionOrder(platform(), isWsl()).map(id => protectorById(id)).filter((p): p is Protector => p !== null)
}

/** Interop can come up late at login: DPAPI is probed again after these pauses before giving up. */
const WSL_DPAPI_RETRY_MS = [1_500, 4_000]

export type AutoChoice =
  | { ok: true; protector: Protector }
  | { ok: false; kind: 'no-protector'; checked: Checked[] }
  /** The platform's protector did not answer; NO weaker one is taken on its own. */
  | { ok: false; kind: 'unavailable'; protector: Protector; reason: string }

/**
 * The protector an AUTOMATIC init may use. On WSL that is Windows DPAPI and nothing else: if it does
 * not answer — retried with backoff, since interop can come up late at login — the vault is NOT
 * created under libsecret or a TPM behind the user's back; another protector is chosen only with
 * `agentop vault init --protector`. Elsewhere the platform's detection order applies.
 */
export async function chooseAutoProtector(): Promise<AutoChoice> {
  const strict = _autoInit && 'strict' in _autoInit ? _autoInit
    : realMode() && isWsl() ? { strict: protectorById('dpapi')!, delaysMs: WSL_DPAPI_RETRY_MS } : null
  if (strict) {
    let reason = ''
    for (const wait of [0, ...strict.delaysMs]) {
      if (wait) await Bun.sleep(wait)
      const r = await strict.strict.probe().catch(() => ({ ok: false as const, reason: 'the probe failed to run' }))
      if (r.ok) return { ok: true, protector: strict.strict }
      reason = r.reason
    }
    return { ok: false, kind: 'unavailable', protector: strict.strict, reason }
  }
  const c = await chooseProtector(candidateProtectors())
  return c.ok ? c : { ok: false, kind: 'no-protector', checked: c.checked }
}

// ── locks (one process creates the vault; one process migrates at a time) ────────────────────

type Release = () => Promise<void>

async function tryLock(path: string, staleMs: number): Promise<Release | null> {
  await mkdirP(vaultDir(), { recursive: true, mode: 0o700 })
  const token = `${process.pid}:${randomBytes(8).toString('hex')}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await openFile(path, 'wx', 0o600)
      try { await fh.writeFile(token) } finally { await fh.close() }
      return async () => {
        try { if ((await readFileP(path, 'utf8')) === token) await unlinkP(path) } catch { /* gone */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      // A lock older than `staleMs` belongs to a process that died holding it.
      const st = await statP(path).catch(() => null)
      if (st && Date.now() - st.mtimeMs > staleMs) { await unlinkP(path).catch(() => {}); continue }
      return null
    }
  }
  return null
}

async function waitLock(path: string, staleMs: number, timeoutMs: number): Promise<Release | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await tryLock(path, staleMs)
    if (r || Date.now() > deadline) return r
    await Bun.sleep(100)
  }
}

export type CreateResult =
  | { ok: true; state: Extract<OpenState, { state: 'open' }> }
  | { ok: false; reason: string; state?: OpenState }

/**
 * Create the vault under `protector`, EXCLUSIVELY and VERIFIED:
 *  - under `vault/init.lock`, re-checking inside it, and with `vault.json` born O_EXCL — two
 *    processes initialising at once (the service and a CLI call) cannot mint two keys; the loser
 *    opens the winner's vault;
 *  - the wrapped key is then UNWRAPPED FROM DISK (a fresh read, through the protector) and compared
 *    with the key just generated, before anything is sealed or any plaintext is scrubbed. A mismatch
 *    destroys the half-made vault and leaves every plaintext file untouched.
 */
export async function createVault(protector: Protector, passphrase?: string): Promise<CreateResult> {
  const release = await waitLock(join(vaultDir(), 'init.lock'), 60_000, 30_000)
  if (!release) return { ok: false, reason: 'another agentop process is creating the vault' }
  try {
    const existing = await tryOpen(passphrase)
    if (existing.state !== 'uninitialized') return { ok: false, reason: 'exists', state: existing }
    const init = await initVault(io(), vaultDir(), protector)
    if (!init.ok) {
      return init.reason === 'exists'
        ? { ok: false, reason: 'exists', state: await tryOpen(passphrase) }
        : { ok: false, reason: init.detail ?? 'the protector could not wrap the key' }
    }
    const check = await openVault(io(), vaultDir(), [protector])
    if (check.state !== 'open' || !bytesEqual(check.dek, init.dek)) {
      await destroyVault(io(), vaultDir(), [protector])
      init.dek.fill(0)
      return { ok: false, reason: 'the new vault key did not read back from disk through the protector; nothing was migrated' }
    }
    init.dek.fill(0)
    return { ok: true, state: check }
  } finally {
    await release()
  }
}

/**
 * The protectors for a vault's RECORDED wrappers. Presence wrappers (Hello, a security key) are left
 * out unless `presence` is asked for: an AUTOMATIC open (a consumer needing a secret, the service
 * starting) must never raise a Windows Hello dialog nobody asked for — SECRETS.4 §1.2: the human
 * scope is LOCKED at every start and after every auto-lock, until somebody unlocks it on purpose.
 */
function protectorsFor(vault: VaultJson | null, passphrase?: string, dir: string = vaultDir(), opts: { presence?: boolean } = {}): Protector[] {
  const ids = vault ? vault.wrappers.map(w => w.type) : []
  return ids.filter(id => opts.presence || !isPresenceId(id)).map(id => protectorById(id, passphrase, dir)).filter((p): p is Protector => p !== null)
}

/** The user's word for their presence gesture (§3.5 `{presence}`). */
export function presenceWord(id: ProtectorId | null | undefined, lang: Lang = vaultLang()): string {
  if (id === 'hello') return 'Windows Hello'
  if (id === 'fido2') return lang === 'pt' ? 'sua chave de segurança' : 'your security key'
  return lang === 'pt' ? 'a sua confirmação pessoal' : 'your personal confirmation'
}

export function protectorLabel(id: ProtectorId | null): string | null {
  if (!id) return null
  return protectorById(id)?.label(vaultLang()) ?? id
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────

interface Opened { kid: string; dek: Uint8Array; vault: VaultJson; via: ProtectorId }

let _opened: Opened | null = null
let _last: OpenState | null = null
let _lastAttemptMs = 0
let _inflight: Promise<Opened | null> | null = null
let _lastChecked: Checked[] = []
/** Why the last automatic init did not happen, so the refusal names it (and it is not re-tried at once). */
let _initFailure: { kind: 'unavailable'; protector: ProtectorId; reason: string } | { kind: 'no-protector' } | null = null
/** Called once with the init sentence when this process creates a vault. */
let _onInit: (line: string) => void = (line) => { if (realMode()) process.stderr.write(`agentop: ${line}\n`) }
export function setVaultInitReporter(fn: (line: string) => void): void { _onInit = fn }

/** A locked vault whose protector did not answer is re-tried at most this often, on demand. */
const RETRY_MS = 30_000

export interface Migrator {
  /** A short id, for status output. */
  id: string
  /** How many plaintext secrets this migrator would still move. Never opens the vault. */
  pending(): Promise<number>
  /** Which files hold them, for `agentop vault status`. */
  pendingFiles?(): Promise<string[]>
  /** Move them. Runs only with the vault open. Never throws; reports in words. */
  run(): Promise<MigrationReport>
}
export interface MigrationReport {
  migrated: number
  lines: string[]
}

const _migrators = new Map<string, Migrator>()
/** Consumers register their legacy paths here; the service runs them at every open. */
export function registerVaultMigrator(m: Migrator): void { _migrators.set(m.id, m) }
export function vaultMigrators(): Migrator[] { return [..._migrators.values()] }

let _migratedThisOpen = false
let _migrating: Promise<MigrationReport> | null = null

/** Run every registered migration once for this open. Never throws. */
export async function runMigrations(force = false): Promise<MigrationReport> {
  if (!_opened) return { migrated: 0, lines: [] }
  if (_migratedThisOpen && !force) return { migrated: 0, lines: [] }
  if (_migrating) return _migrating
  _migratedThisOpen = true
  _migrating = (async () => {
    const out: MigrationReport = { migrated: 0, lines: [] }
    // One process migrates at a time. Non-blocking ON PURPOSE: this pass can be reached from inside
    // the preferences write chain, so a held lock means "someone else is doing it" and this process
    // simply tries again on its next open — it never waits.
    const release = await tryLock(join(vaultDir(), 'migrate.lock'), 5 * 60_000).catch(() => null)
    if (!release) { _migratedThisOpen = false; return out }
    try {
    for (const m of _migrators.values()) {
      try {
        const r = await m.run()
        out.migrated += r.migrated
        out.lines.push(...r.lines)
      } catch {
        out.lines.push(sentence('migration-failed', { file: m.id, reason: 'unexpected error' }))
      }
    }
    } finally {
      await release()
    }
    return out
  })()
  try { return await _migrating } finally { _migrating = null }
}

/** Every file still holding a plaintext secret. */
export async function pendingPlaintextFiles(): Promise<string[]> {
  const out: string[] = []
  for (const m of _migrators.values()) { try { out.push(...(await m.pendingFiles?.() ?? [])) } catch { /* skip */ } }
  return out
}

/** Sum of every migrator's pending count. Cheap: a few lstat/reads, never opens the vault. */
export async function pendingPlaintext(): Promise<number> {
  let n = 0
  for (const m of _migrators.values()) { try { n += await m.pending() } catch { /* unknown counts as 0 */ } }
  return n
}

/** Review S7: a data-key rotation a crash interrupted is completed (or rolled back) on the next open. */
async function finishPendingRekey(kid: string): Promise<void> {
  try { await (await import('./rekey')).finishRekeyIfPending(kid) } catch { /* retried at the next open */ }
}

async function tryOpen(passphrase?: string, opts: { presence?: boolean } = {}): Promise<OpenState> {
  const raw = await io().readFile(join(vaultDir(), 'vault.json'))
  let vault: VaultJson | null = null
  if (raw) { try { vault = JSON.parse(new TextDecoder().decode(raw)) } catch { vault = null } }
  return openVault(io(), vaultDir(), protectorsFor(vault, passphrase, vaultDir(), opts))
}

// ── SECRETS.4: why it is locked, the unlock in two phases, recovery mode, auto-lock ────────────────

export type LockedBy = 'start' | 'auto-lock' | 'user' | 'stepup-frozen' | 'presence-lost'
let _lockedBy: LockedBy = 'start'
export function lockedBy(): LockedBy { return _lockedBy }

/**
 * Review S5: who hears the vault change state (engine-api 1.6 `onStateChange`). Called with the REASON
 * on every lock and with nothing on every open, so an engine waits for an unlock instead of polling and
 * says why it is locked. A listener never breaks the vault.
 */
let _onState: (lockedBy?: LockedBy) => void = () => {}
export function setVaultStateListener(fn: (lockedBy?: LockedBy) => void): void { _onState = fn }
function announce(lockedBy?: LockedBy): void { try { _onState(lockedBy) } catch { /* never breaks the vault */ } }

/**
 * §2.2: after a gesture opened the DEK, and before the authenticator code was checked, the key sits
 * HERE — not in `_opened` — so no purpose can be opened and nothing is served. At most 120 s, then
 * zeroed. A wrong code zeroes it at once.
 */
export const PENDING_STEPUP_MS = 120_000

/**
 * The per-day unlock window (owner decision 2026-10-02, unlock-policy.ts): when the last gesture+code
 * unlock happened. MEMORY ONLY — a restart or reboot starts with none — and dropped on recovery, reset,
 * a protector change and any failed code. Holds a timestamp, never key material.
 */
let _unlockWindowAnchorMs: number | null = null
/** A gesture+code unlock just completed: the window starts now. */
export function noteCodeUnlock(): void { _unlockWindowAnchorMs = _now() }
/** Recovery, reset, a protector change, a failed code: the next unlock owes the code again. */
export function dropUnlockWindow(): void { _unlockWindowAnchorMs = null }
export function unlockWindowAnchor(): number | null { return _unlockWindowAnchorMs }

let _pending: { opened: Opened; expiresMs: number; timer: ReturnType<typeof setTimeout> | null } | null = null

/** §4.3: opened with the 24 words; until these three are re-done, every other gated action refuses. */
export type RecoveryStep = 'presence' | 'authenticator' | 'recovery'
let _recoveryTodo: Set<RecoveryStep> | null = null
export function recoveryTodo(): RecoveryStep[] | null { return _recoveryTodo ? [..._recoveryTodo] : null }
export function recoveryStepDone(step: RecoveryStep): void {
  if (!_recoveryTodo) return
  _recoveryTodo.delete(step)
  if (_recoveryTodo.size === 0) _recoveryTodo = null
}

let _now: () => number = () => Date.now()
let _autoClock: AutoLockClock | null = null
let _autoTimer: ReturnType<typeof setInterval> | null = null
let _onAutoLock: (minutes: number) => void = () => {}
/** The service's toast/notification hook for an auto-lock (SSE + desktop notification). */
export function setAutoLockNotifier(fn: (minutes: number) => void): void { _onAutoLock = fn }

function autoLockMinutes(v: VaultJson): number { return v.autoLock?.minutes ?? AUTO_LOCK_DEFAULT_MIN }

function startAutoLock(o: Opened): void {
  // Human scope only — the runner scope never auto-locks (it is never `_opened`).
  _autoClock = new AutoLockClock(autoLockMinutes(o.vault), _now())
  if (!_autoTimer && realMode()) {
    _autoTimer = setInterval(() => { autoLockTick(_now()) }, 15_000)
    ;(_autoTimer as { unref?: () => void }).unref?.()
  }
}

/** One look at the idle clock. Exported for tests (fake clock); the service calls it every 15 s. */
export function autoLockTick(nowMs: number): boolean {
  if (!_opened || !_autoClock || !_autoClock.due(nowMs)) return false
  const minutes = _autoClock.periodMinutes
  lockVault('auto-lock')
  vaultAudit({ type: 'vault.auto-locked' })
  try { _onAutoLock(minutes) } catch { /* a notification never breaks the lock */ }
  return true
}

/** Human interaction (dashboard/TUI heartbeat, an `agentop` verb): resets the idle clock. */
export function noteVaultActivity(): void { _autoClock?.use(_now()) }

/** Change the idle period of the OPEN vault (persisted by the caller in vault.json). */
export function setAutoLockPeriod(minutes: number): void { _autoClock?.setMinutes(minutes) }
export function autoLockRemainingMs(): number | null { return _opened && _autoClock ? _autoClock.remainingMs(_now()) : null }

function adopt(s: OpenState): Opened | null {
  _last = s
  if (s.state !== 'open') return null
  // An enrolment that crashed after recording presence left a silent key to delete: finish it now.
  if (s.vault.retired?.length) {
    const vault = s.vault
    void finishRetirement(io(), vaultDir(), vault, vault.retired!.map(w => protectorById(w.type)).filter((p): p is Protector => p !== null))
      .then(r => { if (_opened && _opened.kid === vault.kid) _opened.vault = r.vault })
      .catch(() => { /* retried at the next open */ })
  }
  _opened = { kid: s.kid, dek: s.dek, vault: s.vault, via: s.via }
  _migratedThisOpen = false
  startAutoLock(_opened)
  announce()
  return _opened
}

function presenceRefusal(s: Extract<OpenState, { state: 'locked' | 'protector-lost' }>): { ok: false; code: string; sentence: string } {
  const code = presenceCode(s.reason)
  const word = presenceWord(s.protector)
  if (code) return { ok: false, code, sentence: presenceSentence(code, vaultLang(), word, s.reason) }
  return s.state === 'protector-lost' ? refused('protector-lost', lostSentence(s)) : refused('locked', sentence('locked'))
}

export type GestureUnlock =
  | { ok: true; state: 'open' }
  | { ok: true; state: 'pending-stepup'; expiresInMs: number }
  | { ok: false; code: string; sentence: string }

/**
 * §2.2 phase 1: the explicit unlock. Raises the presence gesture (or uses the OS wrapper / passphrase
 * when the vault has no presence). When the authenticator is enrolled AND the vault has presence, the
 * DEK goes to the PENDING slot and `completeUnlock` (gate.ts) checks the code; otherwise it opens.
 */
export async function unlockWithGesture(passphrase?: string): Promise<GestureUnlock> {
  if (_opened) return { ok: true, state: 'open' }
  if (_role !== 'holder') return refused('service-only', sentence('service-only'))
  if ((await hardenThisProcess()).state === 'failed') return refused('hardening-failed', sentence('hardening-failed', { reason: _hardening?.reason ?? '' }))
  abandonPending()
  const s = await tryOpen(passphrase, { presence: true })
  if (s.state === 'open') {
    if (hasPresence(s.vault) && s.vault.stepup && unlockNeedsCode(effectiveUnlockPolicy(s.vault.unlockPolicy), _unlockWindowAnchorMs, _now())) {
      const opened: Opened = { kid: s.kid, dek: s.dek, vault: s.vault, via: s.via }
      const timer = setTimeout(() => abandonPending(), PENDING_STEPUP_MS)
      ;(timer as { unref?: () => void }).unref?.()
      _pending = { opened, expiresMs: _now() + PENDING_STEPUP_MS, timer }
      return { ok: true, state: 'pending-stepup', expiresInMs: PENDING_STEPUP_MS }
    }
    adopt(s)
    _lockedBy = 'start'
    await finishPendingRekey(s.kid)
    void runMigrations()
    // The gesture alone opened it under the unlock policy ("Hello only", or inside the per-day window).
    if (hasPresence(s.vault) && s.vault.stepup) vaultAudit({ type: 'vault.unlock' })
    return { ok: true, state: 'open' }
  }
  _last = s
  if (s.state === 'uninitialized') return refused('uninitialized', sentence('uninitialized'))
  if (s.state === 'corrupt') return refused('tampered', sentence('tampered', { file: displayPath(join(vaultDir(), 'vault.json')), restoreWith: 'agentop vault reset' }))
  if (s.state === 'protector-lost') _lockedBy = 'presence-lost'
  return presenceRefusal(s)
}

/** The DEK waiting for its code, or null (expired ones are zeroed here). */
export function pendingUnlock(): Opened | null {
  if (_pending && _now() > _pending.expiresMs) abandonPending()
  return _pending?.opened ?? null
}

/** §2.2: the code was right — the pending key becomes the open vault. */
export function adoptPending(): boolean {
  const p = pendingUnlock()
  if (!p) return false
  if (_pending?.timer) clearTimeout(_pending.timer)
  _pending = null
  adopt({ state: 'open', kid: p.kid, dek: p.dek, vault: p.vault, via: p.via })
  void runMigrations()
  return true
}

/** §2.2: a wrong code, an expiry, or a new attempt — the pending key is ZEROED. */
export function abandonPending(): void {
  if (!_pending) return
  if (_pending.timer) clearTimeout(_pending.timer)
  _pending.opened.dek.fill(0)
  _pending = null
}

/**
 * §4.3: open with the 24 words (the entropy, already checked against its checksum by the caller).
 * Puts the vault in RECOVERY mode: the three re-enrolment steps are owed before anything else gated.
 */
export async function openWithRecovery(entropy: Uint8Array): Promise<{ ok: true } | { ok: false; code: string; sentence: string }> {
  if (_role !== 'holder') return refused('service-only', sentence('service-only'))
  if ((await hardenThisProcess()).state === 'failed') return refused('hardening-failed', sentence('hardening-failed', { reason: _hardening?.reason ?? '' }))
  const raw = await io().readFile(join(vaultDir(), 'vault.json'))
  const { parseVaultJson: parse } = await import('@agentistics/vault')
  const vault = parse(raw)
  if (!vault) return refused('uninitialized', sentence('uninitialized'))
  const rec = vault.wrappers.find(w => w.type === 'recovery')
  if (!rec) return refused('no-recovery', vaultLang() === 'pt' ? 'Este cofre não tem chave de recuperação.' : 'This vault has no recovery key.')
  const u = await recoveryProtector({ io: io(), vaultDir: vaultDir(), entropy }).unwrap(rec, vault.kid)
  if (!u.ok) {
    vaultAudit({ type: 'vault.recover-failed' })
    return refused('recovery-denied', vaultLang() === 'pt' ? 'Essas palavras não abrem este cofre. Nada foi aberto.' : 'Those words do not open this vault. Nothing was opened.')
  }
  abandonPending()
  if (_opened) lockVault('user')
  adopt({ state: 'open', kid: vault.kid, dek: u.dek, vault, via: 'recovery' })
  await finishPendingRekey(vault.kid)
  dropUnlockWindow()
  _recoveryTodo = new Set<RecoveryStep>([...(hasPresence(vault) || vault.requirePresence ? ['presence' as const] : []), 'authenticator', 'recovery'])
  vaultAudit({ type: 'vault.recovered' })
  return { ok: true }
}

/**
 * Open the vault if it can be opened without asking anybody — creating it, when `create` is set and
 * none exists, under the first protector that completes a round trip. `null` = not open; read
 * `vaultStatus()` for why. Schedules the migration pass after an open (unless `migrate: false`).
 */
export async function ensureVaultOpen(opts: { create?: boolean; migrate?: boolean } = {}): Promise<Opened | null> {
  if (_opened) return _opened
  // A client never opens the vault (§5.2): no DEK outside the service, not even for a moment.
  if (_role !== 'holder') return null
  // §5.3: memory private BEFORE the first unwrap, or nothing opens here.
  if (!hardened() && (await hardenThisProcess()).state === 'failed') return null
  if (_inflight) return _inflight
  const create = opts.create ?? true
  _inflight = (async () => {
    const now = Date.now()
    const throttled = now - _lastAttemptMs < RETRY_MS
    if (_last && _last.state === 'locked' && throttled) return null
    let s = await tryOpen()
    if (s.state === 'uninitialized' && create && !(_initFailure && throttled)) {
      _lastAttemptMs = now
      const choice = await chooseAutoProtector()
      if (choice.ok) {
        const made = await createVault(choice.protector)
        if (made.ok) {
          _initFailure = null
          _onInit(initSentence(choice.protector.label(vaultLang()), vaultLang()))
          s = made.state
        } else if (made.state) {
          s = made.state
        } else {
          _initFailure = { kind: 'unavailable', protector: choice.protector.id, reason: made.reason }
        }
      } else if (choice.kind === 'unavailable') {
        _initFailure = { kind: 'unavailable', protector: choice.protector.id, reason: choice.reason }
      } else {
        _lastChecked = choice.checked
        _initFailure = { kind: 'no-protector' }
      }
    } else if (s.state !== 'uninitialized') {
      _lastAttemptMs = now
    }
    return adopt(s)
  })()
  try {
    const o = await _inflight
    if (o) await finishPendingRekey(o.kid)
    // SCHEDULED, never awaited here: a caller can be inside the preferences write chain (sealing a
    // token), and the preferences migrator queues on that same chain — awaiting it would deadlock.
    // A caller that needs the pass finished (`agentop vault …`, server boot, a test) awaits
    // `runMigrations()` itself.
    if (o && opts.migrate !== false) void runMigrations()
    return o
  } finally {
    _inflight = null
  }
}

/** Take a vault `createVault` just made as this process's open vault. */
export function adoptCreated(s: Extract<OpenState, { state: 'open' }>): void {
  _initFailure = null
  adopt(s)
}

/** Unlock with a passphrase (the per-service unlock). */
export async function unlockVault(passphrase: string): Promise<{ ok: true } | { ok: false; code: VaultRefusal; sentence: string }> {
  if (_opened) return { ok: true }
  if (_role !== 'holder') return refused('service-only', sentence('service-only'))
  if ((await hardenThisProcess()).state === 'failed') return refused('hardening-failed', sentence('hardening-failed', { reason: _hardening?.reason ?? '' }))
  const s = await tryOpen(passphrase)
  if (s.state === 'open') {
    adopt(s)
    void runMigrations()
    return { ok: true }
  }
  _last = s
  if (s.state === 'uninitialized') return refused('uninitialized', sentence('uninitialized'))
  if (s.state === 'protector-lost') return refused('protector-lost', lostSentence(s))
  return refused('locked', sentence('locked'))
}

/** Whatever else holds key material for the open vault (the gate's held presence key) drops it on lock. */
const _lockHooks: (() => void)[] = []
export function onVaultLock(fn: () => void): void { _lockHooks.push(fn) }

/** Drop the key from this process — the open one AND any pending one. */
export function lockVault(reason: LockedBy = 'user'): void {
  for (const h of _lockHooks) { try { h() } catch { /* a hook never keeps the vault open */ } }
  const was = _opened !== null
  if (_opened) _opened.dek.fill(0)
  _opened = null
  _last = null
  _autoClock = null
  _lockedBy = reason
  abandonPending()
  if (was || reason === 'stepup-frozen') announce(reason)
}

function lostSentence(s: Extract<OpenState, { state: 'protector-lost' }>): string {
  return sentence('protector-lost', { protector: protectorLabel(s.protector) ?? s.protector, reason: s.reason, restoreWith: allRestoreWith() })
}

export type VaultState = 'open' | 'locked' | 'uninitialized' | 'protector-lost' | 'corrupt'

export interface VaultStatus {
  state: VaultState
  protector: ProtectorId | null
  protectorLabel: string | null
  wrappers: ProtectorId[]
  kid: string | null
  /** The refusal sentence for any state but `open`. */
  sentence: string | null
  /** Plaintext secrets from an earlier version still waiting for the migration. */
  pending: number
  /** What detection checked when no protector answered (empty otherwise). */
  checked: string | null
  /** §5.3 / §7.1 "Hardening" line: null until the service has applied it (or in a client). */
  hardening?: HardeningReport | null
  /** SECRETS.4: why it is locked (engine-api 1.6 `lockedBy`). */
  lockedBy?: LockedBy | null
  /** ms until auto-lock while open; null when not open. */
  autoLockInMs?: number | null
  /** A gesture opened the key and the authenticator code is awaited (§2.2). */
  pendingStepup?: boolean
  /** §4.3: the re-enrolment steps still owed after a recovery; null when not in recovery mode. */
  recoveryTodo?: RecoveryStep[] | null
}

/** Never throws, never opens the vault. */
export async function vaultStatus(): Promise<VaultStatus> {
  const s = await vaultStatusInner()
  return {
    ...s, hardening: _hardening, lockedBy: s.state === 'open' ? null : _lockedBy, autoLockInMs: autoLockRemainingMs(),
    pendingStepup: pendingUnlock() !== null, recoveryTodo: recoveryTodo(),
  }
}

async function vaultStatusInner(): Promise<VaultStatus> {
  const pending = await pendingPlaintext()
  if (_opened) {
    const primary = _opened.vault.wrappers.find(w => w.type !== 'passphrase')?.type ?? _opened.via
    return {
      state: 'open', protector: primary, protectorLabel: protectorLabel(primary),
      wrappers: _opened.vault.wrappers.map(w => w.type), kid: _opened.kid,
      sentence: pending > 0 ? sentence('plaintext-pending', { n: pending }) : null, pending, checked: null,
    }
  }
  let vault: VaultJson | null = null
  try {
    const raw = await io().readFile(join(vaultDir(), 'vault.json'))
    vault = raw ? JSON.parse(new TextDecoder().decode(raw)) as VaultJson : null
  } catch { vault = null }
  const checked = _lastChecked.length ? checkedList(_lastChecked, vaultLang()) : null
  if (!vault) {
    const why = _initFailure?.kind === 'unavailable'
      ? sentence('protector-unavailable', { protector: protectorLabel(_initFailure.protector) ?? _initFailure.protector, reason: _initFailure.reason })
      : null
    return {
      state: 'uninitialized', protector: null, protectorLabel: null, wrappers: [], kid: null,
      sentence: [pending > 0 ? sentence('plaintext-pending', { n: pending }) : sentence('uninitialized'), why].filter(Boolean).join(' '),
      pending, checked,
    }
  }
  const primary = vault.wrappers?.find(w => w.type !== 'passphrase')?.type ?? vault.wrappers?.[0]?.type ?? null
  const wrappers = (vault.wrappers ?? []).map(w => w.type)
  if (_last?.state === 'protector-lost') {
    return { state: 'protector-lost', protector: primary, protectorLabel: protectorLabel(primary), wrappers, kid: vault.kid, sentence: lostSentence(_last), pending, checked }
  }
  if (_last?.state === 'corrupt') {
    return { state: 'corrupt', protector: primary, protectorLabel: protectorLabel(primary), wrappers, kid: null, sentence: sentence('tampered', { file: displayPath(join(vaultDir(), 'vault.json')), restoreWith: 'agentop vault reset' }), pending, checked }
  }
  if (vault.wrappers?.some(w => isPresenceId(w.type))) {
    const word = presenceWord(primary)
    const text = _lockedBy === 'auto-lock'
      ? sentence('auto-locked', { minutes: vault.autoLock?.minutes ?? AUTO_LOCK_DEFAULT_MIN, presence: word })
      : _pending ? sentence('stepup-required') : sentence('presence-required', { presence: word })
    return { state: 'locked', protector: primary, protectorLabel: protectorLabel(primary), wrappers, kid: vault.kid, sentence: text, pending, checked }
  }
  return { state: 'locked', protector: primary, protectorLabel: protectorLabel(primary), wrappers, kid: vault.kid, sentence: sentence('locked'), pending, checked }
}

/** The sentence for "this process could not open the vault", by why. */
export async function notOpenRefusal(): Promise<VaultRefusalError> {
  if (_role !== 'holder') return refusal('service-only')
  if (_hardening?.state === 'failed') return refusal('hardening-failed', { reason: _hardening.reason ?? '' })
  const s = _last
  if (s?.state === 'protector-lost') return new VaultRefusalError('protector-lost', lostSentence(s))
  if (s?.state === 'locked' && s.vault.wrappers.some(w => isPresenceId(w.type))) {
    return _lockedBy === 'auto-lock'
      ? refusal('auto-locked', { minutes: s.vault.autoLock?.minutes ?? AUTO_LOCK_DEFAULT_MIN, presence: presenceWord(s.protector) })
      : refusal('presence-required', { presence: presenceWord(s.protector) })
  }
  if (s?.state === 'locked') return refusal('locked')
  if (s?.state === 'corrupt') return refusal('tampered', { file: displayPath(join(vaultDir(), 'vault.json')), restoreWith: 'agentop vault reset' })
  if (_initFailure?.kind === 'unavailable') return new VaultRefusalError('protector-unavailable', sentence('protector-unavailable', { protector: protectorLabel(_initFailure.protector) ?? _initFailure.protector, reason: _initFailure.reason }))
  if (_lastChecked.length) return new VaultRefusalError('no-protector', sentence('no-protector', { checked: checkedList(_lastChecked, vaultLang()) }) + ' ' + sentence('uninitialized'))
  return refusal('uninitialized')
}

// ── seal / open to files — the one door ───────────────────────────────────────────────────────

/** Seal bytes with the open vault (for a caller that stores them itself, e.g. engine-api `secrets`). */
export async function sealBytes(purpose: string, name: string, plaintext: Uint8Array): Promise<Uint8Array> {
  // A client seals THROUGH the service: the plaintext goes in, only the sealed bytes come back.
  if (_role !== 'holder') return (await import('./client')).remoteSeal(purpose, name, plaintext)
  const o = await ensureVaultOpen()
  if (!o) throw await notOpenRefusal()
  return sealToBytes({ dek: o.dek, kid: o.kid, purpose, name, plaintext })
}

export type OpenBytesResult = { ok: true; plaintext: Uint8Array } | { ok: false; code: VaultRefusal; sentence: string }

/** Open bytes sealed by `sealBytes`. `file` names the source in a refusal sentence. */
export async function openBytes(purpose: string, name: string, sealed: Uint8Array, file?: string): Promise<OpenBytesResult> {
  const o = await ensureVaultOpen({ create: false })
  if (!o) {
    const e = await notOpenRefusal()
    return { ok: false, code: e.code, sentence: e.message }
  }
  const r = openRecord({ dek: o.dek, kid: o.kid, purpose, name, bytes: sealed })
  if (r.ok) { noteVaultUse(); return r }
  const args = { file: file ?? name, kid: r.kid, restoreWith: restoreWithFor(purpose) }
  return { ok: false, code: r.code, sentence: sentence(r.code, args) }
}

/**
 * SECRETS.4 §5.2 — PER-USE decrypt. Opens the sealed bytes, hands the plaintext to `use`, and ZEROES
 * it when `use` returns or throws. There is no cache: the next use opens again. `use` must not keep
 * the buffer (or a copy) past its return; a value that has to become a string (an HTTP header) is
 * made one inside `use` and dropped there — JS strings cannot be zeroed, which docs/security.md
 * states as best-effort.
 */
export async function withSecret<T>(
  purpose: string, name: string, sealedPath: string, use: (plaintext: Uint8Array) => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false; absent: boolean; code?: VaultRefusal; sentence?: string }> {
  const r = await openFromFile(sealedPath, purpose, name)
  if (!r.ok) return r.absent ? { ok: false, absent: true } : { ok: false, absent: false, code: r.code, sentence: r.sentence }
  try {
    return { ok: true, value: await use(r.plaintext) }
  } finally {
    r.plaintext.fill(0)
  }
}

/** Activity hook for auto-lock (S4.7): every human-scope open counts as use. */
let _onUse: () => void = () => {}
export function setVaultUseListener(fn: () => void): void { _onUse = fn }
function noteVaultUse(): void { _autoClock?.use(_now()); try { _onUse() } catch { /* never breaks an open */ } }

/**
 * Seal `plaintext` into `path` (tmp + fsync + rename + chmod 0600 + fsync dir). THROWS a
 * `VaultRefusalError` — with its sentence — when the vault cannot seal; it never writes the value
 * any other way.
 */
export async function sealToFile(path: string, purpose: string, name: string, plaintext: Uint8Array): Promise<void> {
  const bytes = await sealBytes(purpose, name, plaintext)
  const r = await writePrivateAtomic(secretFs(), path, bytes)
  if (r.chmodFailed) process.stderr.write(`agentop: could not set ${displayPath(path)} to mode 600 (${r.chmodFailed}) — it is encrypted, but check the directory's permissions.\n`)
}

export type ReadSecretResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; absent: true }
  | { ok: false; absent: false; code: VaultRefusal; sentence: string }

/**
 * Read a sealed file. Absent → `{absent: true}`. A group/other-readable sealed file is refused
 * (the mode is a tripwire now, not the protection: an open mode is evidence something else is
 * wrong).
 */
export async function openFromFile(path: string, purpose: string, name: string): Promise<ReadSecretResult> {
  const st = await secretFs().lstat(path)
  if (!st) return { ok: false, absent: true }
  if (isModeTooOpen(st.mode)) {
    return { ...refused('tampered', sentence('tampered', { file: displayPath(path) + ` (mode ${st.mode.toString(8)})`, restoreWith: restoreWithFor(purpose) })), absent: false }
  }
  const bytes = await secretFs().readFile(path)
  if (!bytes) return { ok: false, absent: true }
  const r = await openBytes(purpose, name, bytes, displayPath(path))
  if (!r.ok && r.code === 'wrong-machine') {
    // Review S7: between a data-key rotation's commit and its finish, the re-sealed copy sits beside
    // the old one (`<file>.rekey`); a reader in that window takes it rather than failing.
    const staged = await secretFs().readFile(path + '.rekey')
    if (staged) { const s2 = await openBytes(purpose, name, staged, displayPath(path)); if (s2.ok) return s2 }
  }
  return r.ok ? r : { ok: false, absent: false, code: r.code, sentence: r.sentence }
}

/**
 * The vault's own audit trail: `vault/audit.jsonl`, 0600, one line per event — `{at, type, purpose,
 * name}` and never a value, a length or a fragment of one. Local, because a solo or member machine
 * has no central audit store, and a migration is a fact about THIS machine.
 */
export type VaultAuditType =
  | 'vault.migrated' | 'vault.plaintext-pending' | 'vault.migration-failed'
  | 'vault.init' | 'vault.rekey' | 'vault.reset' | 'vault.add-passphrase'
  | 'vault.stepup-failed' | 'vault.stepup-frozen' | 'vault.auto-locked' | 'vault.recovered' | 'vault.recover-failed'
  | 'vault.disable-presence' | 'vault.require-presence' | 'vault.enroll-authenticator' | 'vault.rotate-recovery' | 'vault.enroll-presence' | 'vault.presence-held' | 'vault.local-proof' | 'vault.recover-page' | 'vault.set-auto-lock' | 'vault.set-unlock-policy' | 'vault.unlock' | 'vault.personal-create' | 'vault.personal-edit' | 'vault.personal-reveal' | 'vault.personal-trash' | 'vault.personal-restore' | 'vault.personal-restore-version' | 'vault.personal-purge' | 'vault.personal-group' | 'vault.personal-import'

export function vaultAudit(e: { type: VaultAuditType; purpose?: string; name?: string; protector?: string; source?: 'host' | 'engine' }): void {
  try {
    mkdirSync(vaultDir(), { recursive: true, mode: 0o700 })
    const file = join(vaultDir(), 'audit.jsonl')
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* reported nowhere: the line holds no secret */ }
  } catch { /* an audit write never breaks the operation it describes */ }
}

/** The synchronous view (engine-api `secrets.status()`): what THIS process knows, no IO but a stat. */
export function vaultStatusSync(): { state: 'open' | 'locked' | 'uninitialized' | 'unavailable'; protector: string | null; sentence: string | null } {
  if (_opened) {
    const primary = _opened.vault.wrappers.find(w => w.type !== 'passphrase')?.type ?? _opened.via
    return { state: 'open', protector: protectorLabel(primary), sentence: null }
  }
  if (_last?.state === 'protector-lost') return { state: 'unavailable', protector: protectorLabel(_last.protector), sentence: lostSentence(_last) }
  if (!vaultExists()) return { state: 'uninitialized', protector: null, sentence: sentence('uninitialized') }
  return { state: 'locked', protector: null, sentence: sentence('locked') }
}

/** Is the vault open in this process right now (without trying to open it)? */
export function vaultIsOpen(): boolean { return _opened !== null }

// ── the runner scope (SECRETS.4 §1.1, §6) ──────────────────────────────────────────────────────
//
// A separate vault with a separate DEK. The runner code path receives ONLY a `RunnerHandle` —
// nothing in it can name a human purpose — and nothing here ever reads the human vault's files.
// Unlock, enrolment and the unattended order are S4.9; this is the storage half (S4.2).

export type RunnerOpen =
  | { ok: true; handle: RunnerHandle; machineId: string }
  | { ok: false; state: Exclude<OpenState['state'], 'open'> }

/** Create the runner vault for `machineId` under `protector` — built with `protectorById(id, _, runnerVaultDir())`
 *  so a file-backed wrapper lands in the runner's directory, never the human one. */
export async function initRunnerVault(protector: Protector, machineId: string): Promise<RunnerOpen> {
  const dir = runnerVaultDir()
  await mkdirP(dir, { recursive: true, mode: 0o700 })
  const r = await initVault(io(), dir, protector, [], new Date(), { scope: 'cloud-runner', machineId })
  if (!r.ok) return { ok: false, state: r.reason === 'exists' ? 'locked' : 'uninitialized' }
  try { return { ok: true, handle: makeHandle('cloud-runner', r.dek, r.kid), machineId } } finally { r.dek.fill(0) }
}

/** Open the runner vault. The DEK goes into the handle and the local copy is zeroed. */
export async function openRunnerVault(): Promise<RunnerOpen> {
  // §5.3: the runner scope follows the same rule — no hardening, no open.
  if ((await hardenThisProcess()).state === 'failed') return { ok: false, state: 'locked' }
  const dir = runnerVaultDir()
  const raw = await io().readFile(join(dir, 'vault.json'))
  const v = parseVaultJson(raw)
  const s = await openVault(io(), dir, protectorsFor(v, undefined, dir), 'cloud-runner')
  if (s.state !== 'open') return { ok: false, state: s.state }
  try { return { ok: true, handle: makeHandle('cloud-runner', s.dek, s.kid), machineId: s.vault.machineId ?? '' } } finally { s.dek.fill(0) }
}

/** "Deletes the runner scope" (§6.2): every runner wrapper and its vault.json. The human scope is untouched. */
export async function destroyRunnerVault(): Promise<void> {
  const dir = runnerVaultDir()
  const v = parseVaultJson(await io().readFile(join(dir, 'vault.json')))
  await destroyVault(io(), dir, protectorsFor(v, undefined, dir))
}

// ── test seams ────────────────────────────────────────────────────────────────────────────────

export function __resetVaultForTests(opts: {
  dir?: string; io?: ProtectorIo; fs?: SecretFs; scrypt?: ScryptParams; lang?: Lang
  protectors?: Protector[]; autoInit?: { strict: Protector; delaysMs: number[] } | { candidates: Protector[] }
  /** Presence kinds to report as "coming soon" (never offered). */
  presenceSoon?: ProtectorId[]
} = {}): void {
  lockVault()
  _soonForTests = opts.presenceSoon ?? []
  _unlockWindowAnchorMs = null // a fresh service: no per-day window survives a restart
  _last = null
  _lastAttemptMs = 0
  _lastChecked = []
  _initFailure = null
  _override = opts.protectors ?? null
  _autoInit = opts.autoInit ?? null
  _migratedThisOpen = false
  _hardening = null
  _hardeningRun = null
  _lockedBy = 'start'
  _recoveryTodo = null
  _now = () => Date.now()
  if (opts.dir) _vaultDir = opts.dir
  _io = opts.io ?? null
  _fs = opts.fs ?? realSecretFs
  _scryptForTests = opts.scrypt
  if (opts.lang) { const l = opts.lang; _lang = () => l }
}

/** Test seam: the clock auto-lock and the pending-stepup expiry read. */
export function __setVaultClockForTests(now: () => number): void { _now = now }

/** Test seam: pretend this process's hardening came out as `r` (null = not yet applied). */
export function __setHardeningForTests(r: HardeningReport | null): void {
  _hardening = r
  _hardeningRun = r ? Promise.resolve(r) : null
}

/** Does a vault exist on disk (without opening it)? */
export function vaultExists(): boolean {
  return existsSync(join(vaultDir(), 'vault.json'))
}
