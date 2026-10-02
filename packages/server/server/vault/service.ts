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
  helloProtector, fido2Protector, finishRetirement,
} from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import { underTest } from '../data-dir'
import { realProtectorIo, realSecretFs } from './io'
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
  }
}

/**
 * SECRETS.4 §3.4: the presence protectors to offer at ENROLMENT, in order. Never probed at service
 * start — a probe costs the user gestures. macOS gets FIDO2 only (Secure Enclave is deferred, Q1); a
 * headless box or a container gets none and stays on its OS protector (or passphrase).
 */
export function presenceCandidates(): Protector[] {
  if (!realMode()) return _override?.filter(p => p.id === 'hello' || p.id === 'fido2') ?? []
  const ids: ProtectorId[] = platform() === 'win32' || isWsl() ? ['hello', 'fido2'] : platform() === 'linux' || platform() === 'darwin' ? ['fido2'] : []
  return ids.map(id => protectorById(id)).filter((p): p is Protector => p !== null)
}

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

function protectorsFor(vault: VaultJson | null, passphrase?: string, dir: string = vaultDir()): Protector[] {
  const ids = vault ? vault.wrappers.map(w => w.type) : []
  return ids.map(id => protectorById(id, passphrase, dir)).filter((p): p is Protector => p !== null)
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

async function tryOpen(passphrase?: string): Promise<OpenState> {
  const raw = await io().readFile(join(vaultDir(), 'vault.json'))
  let vault: VaultJson | null = null
  if (raw) { try { vault = JSON.parse(new TextDecoder().decode(raw)) } catch { vault = null } }
  return openVault(io(), vaultDir(), protectorsFor(vault, passphrase))
}

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
  return _opened
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

/** Drop the key from this process. */
export function lockVault(): void {
  if (_opened) _opened.dek.fill(0)
  _opened = null
  _last = null
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
}

/** Never throws, never opens the vault. */
export async function vaultStatus(): Promise<VaultStatus> {
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
  return { state: 'locked', protector: primary, protectorLabel: protectorLabel(primary), wrappers, kid: vault.kid, sentence: sentence('locked'), pending, checked }
}

/** The sentence for "this process could not open the vault", by why. */
export async function notOpenRefusal(): Promise<VaultRefusalError> {
  if (_role !== 'holder') return refusal('service-only')
  const s = _last
  if (s?.state === 'protector-lost') return new VaultRefusalError('protector-lost', lostSentence(s))
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
function noteVaultUse(): void { try { _onUse() } catch { /* never breaks an open */ } }

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
} = {}): void {
  lockVault()
  _last = null
  _lastAttemptMs = 0
  _lastChecked = []
  _initFailure = null
  _override = opts.protectors ?? null
  _autoInit = opts.autoInit ?? null
  _migratedThisOpen = false
  if (opts.dir) _vaultDir = opts.dir
  _io = opts.io ?? null
  _fs = opts.fs ?? realSecretFs
  _scryptForTests = opts.scrypt
  if (opts.lang) { const l = opts.lang; _lang = () => l }
}

/** Does a vault exist on disk (without opening it)? */
export function vaultExists(): boolean {
  return existsSync(join(vaultDir(), 'vault.json'))
}
