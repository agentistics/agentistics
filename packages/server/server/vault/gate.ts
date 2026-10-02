/**
 * vault/gate.ts — the authenticator gate on the vault's own actions (SECRETS.4 §2), the recovery
 * key's life (§4) and the presence enrolment flow (§1.2, §7.3), in the SERVICE.
 *
 * `requireVaultStepUp(action, ctx)` is THE one gate (VAULT.UI routed every action through it; this is
 * where it becomes real). Its table is §2.4, exactly, and `VAULT_ACTION_ROWS` cannot be extended without
 * choosing a row for the new action:
 *
 *   action                                    code  gesture  grant reuse
 *   unlock                                    yes   yes      —            (two-phase, completeUnlock)
 *   list / lock (HTTP) / set-auto-lock        yes   no       5-min 'read' grant
 *   lock-local (TTY, auto-lock, SIGTERM)      no    no       —            (reducing exposure is never gated)
 *   change-protector / rekey / enroll-presence / disable-presence / reset / rotate-recovery /
 *   enroll-runner / rotate-runner / enroll-authenticator / add-passphrase
 *                                             yes   yes      none — fresh each time
 *
 * "yes" applies once there is something to ask: the code only once an authenticator is ENROLLED, the
 * gesture only once the vault HAS a presence wrapper (a machine with presence off keeps the SECRETS.2
 * behaviour plus the code — §1.2). A FROZEN gate refuses everything gated; RECOVERY mode refuses
 * everything but the three re-enrolment steps (§4.3), which it allows without the lost factors.
 *
 * The TOTP seed is sealed IN the vault (`vault/totp-seed`); it is opened per check and zeroed. A code is
 * never logged or audited; failures are audited as `vault.stepup-failed` / `vault.stepup-frozen`.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import {
  FRESH_STEPUP, base32Encode, confirmPositions, confirmWords, durationWords, enrollPresence, entropyToWords, hasPresence,
  isPresenceId, judgeCode, matchTotp, mergeStepUpState, newRecoveryEntropy, openRecord, otpauthUri, parseAutoLockMinutes,
  parseStepUpState, recoveryProtector, serializeVaultJson, skewWords, wordsToEntropy, writePrivateAtomic,
  type Protector, type ProtectorId, type StepUpState, type VaultJson,
} from '@agentistics/vault'
import {
  abandonPending, adoptPending, ensureVaultOpen, lockVault, noteVaultActivity, openWithRecovery, pendingUnlock, protectorById,
  recoveryStepDone, recoveryTodo, refused, sealToFile, secretFs, sentence, setAutoLockPeriod, vaultAudit, vaultDir, vaultLang,
  presenceWord, presenceCandidates,
} from './service'
import { realProtectorIo } from './io'

// ── the table ────────────────────────────────────────────────────────────────────────────────

export type VaultAction =
  | 'unlock' | 'list' | 'lock' | 'lock-local' | 'set-auto-lock'
  | 'change-protector' | 'rekey' | 'enroll-presence' | 'disable-presence' | 'reset' | 'rotate-recovery'
  | 'enroll-runner' | 'rotate-runner' | 'enroll-authenticator' | 'add-passphrase'

export interface ActionRow { code: boolean; gesture: boolean; grant: 'read' | null }

/** §2.4, exactly. A `Record` so a new action does not compile until its row is chosen. */
export const VAULT_ACTION_ROWS: Readonly<Record<VaultAction, ActionRow>> = {
  unlock: { code: true, gesture: true, grant: null },
  list: { code: true, gesture: false, grant: 'read' },
  lock: { code: true, gesture: false, grant: 'read' },
  'set-auto-lock': { code: true, gesture: false, grant: 'read' },
  'lock-local': { code: false, gesture: false, grant: null },
  'change-protector': { code: true, gesture: true, grant: null },
  rekey: { code: true, gesture: true, grant: null },
  'enroll-presence': { code: true, gesture: true, grant: null },
  'disable-presence': { code: true, gesture: true, grant: null },
  reset: { code: true, gesture: true, grant: null },
  'rotate-recovery': { code: true, gesture: true, grant: null },
  'enroll-runner': { code: true, gesture: true, grant: null },
  'rotate-runner': { code: true, gesture: true, grant: null },
  'enroll-authenticator': { code: true, gesture: true, grant: null },
  'add-passphrase': { code: true, gesture: true, grant: null },
}

/** §4.3: what RECOVERY mode still lets through (without the lost code / gesture). */
const RECOVERY_ALLOWED: ReadonlySet<VaultAction> = new Set(['enroll-presence', 'enroll-authenticator', 'rotate-recovery', 'lock-local', 'lock'])

// ── the step-up state: stepup.json (integrity, not secret) AND memory, the larger wins ──────────

const SEED_PURPOSE = 'vault/totp-seed'
const SEED_NAME = 'totp-seed'
export function seedFile(): string { return join(vaultDir(), 'totp-seed.sealed') }
function stateFile(): string { return join(vaultDir(), 'stepup.json') }

let _mem: StepUpState = FRESH_STEPUP
let _now: () => number = () => Date.now()

async function loadState(): Promise<StepUpState> {
  const raw = await secretFs().readFile(stateFile()).catch(() => null)
  _mem = mergeStepUpState(parseStepUpState(raw ? new TextDecoder().decode(raw) : null), _mem)
  return _mem
}
async function saveState(s: StepUpState): Promise<void> {
  // Memory follows the DECISION just made (a success lowers the counter on purpose); the larger-wins
  // merge applies when READING, so an older file never lowers what memory holds.
  _mem = s
  await writePrivateAtomic(secretFs(), stateFile(), new TextEncoder().encode(JSON.stringify(s) + '\n')).catch(() => {})
}

export async function stepUpState(): Promise<StepUpState> { return loadState() }

// ── grants: an HMAC key minted at start, never on disk; bound to the session and the class ────────

const GRANT_TTL_MS = 5 * 60_000
const GRANT_DOMAIN = 'agentistics-vault-grant/v1'
let _grantKey = randomBytes(32)

function sessionTag(session: string): string { return createHash('sha256').update(session).digest('hex').slice(0, 32) }

export function mintGrant(session: string, cls: 'read', nowMs = _now()): string {
  const payload = `${nowMs + GRANT_TTL_MS}.${cls}.${sessionTag(session)}`
  return `${payload}.${createHmac('sha256', _grantKey).update(`${GRANT_DOMAIN}.${payload}`).digest('hex')}`
}

export function grantValid(token: string | null | undefined, session: string, cls: 'read', nowMs = _now()): boolean {
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot === -1) return false
  const payload = token.slice(0, dot)
  const mac = Buffer.from(token.slice(dot + 1))
  const want = Buffer.from(createHmac('sha256', _grantKey).update(`${GRANT_DOMAIN}.${payload}`).digest('hex'))
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return false
  const [exp, c, tag] = payload.split('.')
  return Number(exp) > nowMs && c === cls && tag === sessionTag(session)
}

// ── checking a code ─────────────────────────────────────────────────────────────────────────

export type Refusal = { ok: false; code: string; sentence: string }

function stepupRefusal(v: Exclude<ReturnType<typeof judgeCode>, { ok: true }>): Refusal {
  const lang = vaultLang()
  switch (v.code) {
    case 'stepup-frozen': return refused('stepup-frozen', sentence('stepup-frozen'))
    case 'stepup-paused': return refused('stepup-paused', sentence('stepup-paused', { duration: durationWords(v.untilMs - _now(), lang) }))
    case 'stepup-replayed': return refused('stepup-replayed', sentence('stepup-replayed'))
    case 'stepup-clock': { const w = skewWords(v.skewSteps, lang); return refused('stepup-clock', sentence('stepup-clock', { n: w.n, direction: w.direction })) }
    case 'stepup-wrong': return refused('stepup-wrong', sentence('stepup-wrong', { left: v.left }))
  }
}

/** Judge `code` against the seed sealed under `dek`/`kid`; persist the outcome; audit failures. */
async function checkCodeWith(dek: Uint8Array, kid: string, code: string): Promise<{ ok: true } | Refusal> {
  const sealed = await secretFs().readFile(seedFile())
  if (!sealed) return refused('stepup-not-enrolled', vaultLang() === 'pt' ? 'Nenhum autenticador está configurado neste cofre.' : 'No authenticator is set up for this vault.')
  const o = openRecord({ dek, kid, purpose: SEED_PURPOSE, name: SEED_NAME, bytes: sealed })
  if (!o.ok) return refused(o.code, sentence(o.code === 'purpose' ? 'purpose' : 'tampered', { file: '~/.agentistics/vault/totp-seed.sealed', restoreWith: 'agentop vault recover' }))
  const before = await loadState()
  let v: ReturnType<typeof judgeCode>
  try { v = judgeCode(o.plaintext, code, _now(), before) } finally { o.plaintext.fill(0) }
  await saveState(v.state)
  if (v.ok) return { ok: true }
  if (v.code !== 'stepup-paused') vaultAudit({ type: v.state.frozen ? 'vault.stepup-frozen' : 'vault.stepup-failed' })
  if (v.state.frozen) lockVault('stepup-frozen')
  return stepupRefusal(v)
}

function enrolled(v: VaultJson): boolean { return Boolean(v.stepup) }

/** §2.4: prove a human gesture NOW, against the open key (a presence unwrap must give the same DEK). */
async function proveGesture(open: { dek: Uint8Array; kid: string; vault: VaultJson }): Promise<{ ok: true } | Refusal> {
  for (const w of open.vault.wrappers.filter(x => isPresenceId(x.type))) {
    const p = protectorById(w.type)
    if (!p) continue
    const u = await p.unwrap(w, open.kid)
    if (u.ok) {
      const same = u.dek.length === open.dek.length && timingSafeEqual(Buffer.from(u.dek), Buffer.from(open.dek))
      u.dek.fill(0)
      if (same) return { ok: true }
      return refused('presence-lost', sentence('presence-required', { presence: presenceWord(w.type) }))
    }
    if (u.kind === 'denied') return refused('presence-cancelled', sentence('presence-required', { presence: presenceWord(w.type) }))
  }
  return refused('presence-required', sentence('presence-required', { presence: presenceWord(open.vault.wrappers.find(x => isPresenceId(x.type))?.type) }))
}

export interface GateContext {
  /** The authenticator code, when the caller has one. */
  code?: string
  /** A 'read' grant from an earlier step-up (HTTP). */
  grant?: string | null
  /** What a grant is bound to: the HTTP session, or 'socket' for the local CLI. */
  session: string
}

export type GateResult = { ok: true; grant?: string } | Refusal

/**
 * THE gate. Every vault action goes through here; `ctx.code` is checked fresh, a grant is accepted
 * only for its class, the gesture is proven by a real presence unwrap. `unlock` is not decided here
 * (it is the two-phase flow) — asking for it is a programming error and refuses.
 */
export async function requireVaultStepUp(action: VaultAction, ctx: GateContext): Promise<GateResult> {
  const row = VAULT_ACTION_ROWS[action]
  if (!row) return refused('bad-request', 'unknown vault action')
  if (action === 'unlock') return refused('bad-request', 'unlock is the two-phase flow (completeUnlock)')
  if (!row.code && !row.gesture) return { ok: true }
  const todo = recoveryTodo()
  if (todo) {
    if (!RECOVERY_ALLOWED.has(action)) return refused('recovery-mode', sentence('recovery-mode'))
    return { ok: true }
  }
  const state = await loadState()
  if (state.frozen) return refused('stepup-frozen', sentence('stepup-frozen'))
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) {
    // A locked vault: only what reduces exposure needs no proof — everything else needs the vault open.
    if (action === 'lock') return { ok: true }
    return refused('locked', sentence('locked'))
  }
  if (row.code && enrolled(o.vault)) {
    if (row.grant && grantValid(ctx.grant, ctx.session, row.grant)) { /* reused */ }
    else {
      if (!ctx.code) return refused('stepup-required', sentence('stepup-required'))
      const c = await checkCodeWith(o.dek, o.kid, ctx.code)
      if (!c.ok) return c
      if (row.grant) {
        if (row.gesture && hasPresence(o.vault)) { const g = await proveGesture(o); if (!g.ok) return g }
        noteVaultActivity()
        return { ok: true, grant: mintGrant(ctx.session, row.grant) }
      }
    }
  }
  if (row.gesture && hasPresence(o.vault)) {
    const g = await proveGesture(o)
    if (!g.ok) return g
  }
  noteVaultActivity()
  return { ok: true }
}

/** HTTP `POST /api/vault/stepup`: a code in, a 'read' grant out (5 min, this session only). */
export async function stepUpForRead(code: string, session: string): Promise<GateResult> {
  return requireVaultStepUp('list', { code, session })
}

// ── §2.2 phase 2: the code that completes an unlock ─────────────────────────────────────────────

export async function completeUnlock(code: string): Promise<{ ok: true } | Refusal> {
  const p = pendingUnlock()
  if (!p) return refused('no-pending-unlock', vaultLang() === 'pt' ? 'Nenhum desbloqueio está esperando um código (passaram-se 120 segundos?). Rode `agentop vault unlock` de novo.' : 'No unlock is waiting for a code (did 120 seconds pass?). Run `agentop vault unlock` again.')
  const c = await checkCodeWith(p.dek, p.kid, code)
  if (!c.ok) {
    abandonPending() // §2.2: a wrong code zeroes the key at once
    return c
  }
  adoptPending()
  vaultAudit({ type: 'vault.unlock' })
  return { ok: true }
}

// ── §2.5 enrolling the authenticator ────────────────────────────────────────────────────────

/** The seed of an enrolment in progress — in memory only, ≤ 10 min, served ONCE. */
let _enrolSeed: { seed: Uint8Array; served: boolean; expiresMs: number } | null = null
const ENROL_TTL_MS = 10 * 60_000

function dropEnrolSeed(): void { _enrolSeed?.seed.fill(0); _enrolSeed = null }

/**
 * Begin: a fresh 160-bit seed in memory and its otpauth URI, served EXACTLY ONCE (a second ask is
 * refused). The URI is the one secret that leaves the service on purpose — it must be scanned. The
 * caller (route / socket op) sends it with `Cache-Control: no-store` and never logs it.
 */
export async function beginAuthenticator(ctx: GateContext, machineLabel: string): Promise<{ ok: true; uri: string; secret: string } | Refusal> {
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  if (enrolled(o.vault)) {
    const g = await requireVaultStepUp('enroll-authenticator', ctx)
    if (!g.ok) return g
  }
  if (_enrolSeed && _enrolSeed.served && _now() < _enrolSeed.expiresMs) {
    return refused('already-served', vaultLang() === 'pt' ? 'O código QR desta configuração já foi mostrado uma vez. Comece de novo.' : 'This setup\'s QR code was already shown once. Start over.')
  }
  dropEnrolSeed()
  const seed = new Uint8Array(randomBytes(20))
  _enrolSeed = { seed, served: true, expiresMs: _now() + ENROL_TTL_MS }
  const secret = base32Encode(seed).replace(/=+$/, '')
  return { ok: true, uri: otpauthUri(secret, machineLabel, 'Agentistics'), secret }
}

/** Confirm with TWO CONSECUTIVE codes (the app holds the seed AND the clock is right), then seal it. */
export async function confirmAuthenticator(code1: string, code2: string): Promise<{ ok: true } | Refusal> {
  const e = _enrolSeed
  if (!e || _now() > e.expiresMs) { dropEnrolSeed(); return refused('no-enrolment', vaultLang() === 'pt' ? 'Nenhuma configuração do autenticador em andamento.' : 'No authenticator setup is in progress.') }
  const nowSec = Math.floor(_now() / 1000)
  // Wide enough to cover the user typing two codes in a row; the pair must be ADJACENT steps.
  const s1 = matchTotp(e.seed, code1, nowSec, 3)
  const s2 = matchTotp(e.seed, code2, nowSec, 3)
  if (s1 === null || s2 === null || s2 !== s1 + 1) {
    return refused('stepup-wrong', vaultLang() === 'pt' ? 'Esses dois códigos não são dois códigos seguidos deste autenticador. Tente de novo com os dois próximos.' : 'Those are not two consecutive codes from this authenticator. Try again with the next two.')
  }
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  try {
    await sealToFile(seedFile(), SEED_PURPOSE, SEED_NAME, e.seed)
  } finally { dropEnrolSeed() }
  const vault: VaultJson = { ...o.vault, v: 2, stepup: { enrolledAt: new Date(_now()).toISOString(), digits: 6, period: 30 } }
  await writeVaultJson(vault)
  o.vault = vault
  // A fresh authenticator starts a fresh counter; the replay floor is the second code's step.
  await saveState({ v: 1, failures: 0, lastStep: s2, pausedUntilMs: null, frozen: false })
  recoveryStepDone('authenticator')
  vaultAudit({ type: 'vault.enroll-authenticator' })
  return { ok: true }
}

async function writeVaultJson(v: VaultJson): Promise<void> {
  await realProtectorIo().writeFile(join(vaultDir(), 'vault.json'), serializeVaultJson(v))
}

// ── §4.2 the recovery key: shown once, confirmed by three words, then written ─────────────────────

let _recovery: { entropy: Uint8Array; words: string[]; positions: number[]; expiresMs: number } | null = null
function dropRecovery(): void { _recovery?.entropy.fill(0); _recovery = null }

/** Generate the 24 words. The FIRST recovery key needs only the open vault; a rotation is gated. */
export async function beginRecoveryKey(ctx: GateContext): Promise<{ ok: true; words: string[]; positions: number[] } | Refusal> {
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  if (o.vault.wrappers.some(w => w.type === 'recovery')) {
    const g = await requireVaultStepUp('rotate-recovery', ctx)
    if (!g.ok) return g
  }
  dropRecovery()
  const entropy = newRecoveryEntropy()
  const words = entropyToWords(entropy)
  _recovery = { entropy, words, positions: confirmPositions(), expiresMs: _now() + ENROL_TTL_MS }
  return { ok: true, words, positions: _recovery.positions }
}

/** The three typed words; only then is `dek.recovery` written and the previous one replaced. */
export async function confirmRecoveryKey(typed: readonly string[]): Promise<{ ok: true } | Refusal> {
  const r = _recovery
  if (!r || _now() > r.expiresMs) { dropRecovery(); return refused('no-recovery-pending', vaultLang() === 'pt' ? 'Nenhuma chave de recuperação está esperando confirmação.' : 'No recovery key is waiting to be confirmed.') }
  if (!confirmWords(r.words, r.positions, typed)) return refused('recovery-confirm-wrong', vaultLang() === 'pt' ? 'Essas não são as palavras daquelas posições. Confira o papel e tente de novo.' : 'Those are not the words at those positions. Check your copy and try again.')
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  try {
    const p = recoveryProtector({ io: realProtectorIo(), vaultDir: vaultDir(), entropy: r.entropy })
    const w = await p.wrap(o.dek, o.kid)
    if (!w.ok) return refused('recovery-write-failed', w.reason)
    // Verify from disk before recording it (the old wrapper file was replaced in place by `wrap`).
    const back = await p.unwrap(w.record, o.kid)
    const same = back.ok && timingSafeEqual(Buffer.from(back.dek), Buffer.from(o.dek))
    if (back.ok) back.dek.fill(0)
    if (!same) return refused('recovery-write-failed', 'the recovery key did not read back')
    const vault: VaultJson = { ...o.vault, v: 2, wrappers: [...o.vault.wrappers.filter(x => x.type !== 'recovery'), w.record] }
    await writeVaultJson(vault)
    o.vault = vault
  } finally { dropRecovery() }
  recoveryStepDone('recovery')
  vaultAudit({ type: 'vault.rotate-recovery' })
  return { ok: true }
}

/** §4.3 `agentop vault recover`: 24 words (TTY only — the CLI enforces it) → recovery mode. */
export async function recoverWithWords(words: string): Promise<{ ok: true; todo: string[] } | Refusal> {
  const e = wordsToEntropy(words)
  if (!e.ok) {
    const lang = vaultLang()
    const why = e.reason === 'count' ? (lang === 'pt' ? `São 24 palavras; chegaram ${e.got}.` : `It is 24 words; ${e.got} arrived.`)
      : e.reason === 'unknown-word' ? (lang === 'pt' ? `A palavra ${e.position} não está na lista.` : `Word ${e.position} is not in the list.`)
        : (lang === 'pt' ? 'Uma das palavras está errada (a soma de verificação não fecha).' : 'One of the words is wrong (the checksum does not match).')
    return refused('recovery-words', why)
  }
  try {
    const r = await openWithRecovery(e.entropy)
    if (!r.ok) return r
  } finally { e.entropy.fill(0) }
  // The old words were just typed: they are considered exposed, and rotated (§4.3 c). A frozen gate is
  // lifted only by re-enrolling the authenticator, which recovery mode now allows.
  _mem = { ...FRESH_STEPUP }
  await saveState(_mem)
  return { ok: true, todo: recoveryTodo() ?? [] }
}

// ── §1.2 / §7.3 step 4: enrolling presence ──────────────────────────────────────────────────

/**
 * Presence becomes the primary and the silent OS wrapper is retired — only after the authenticator and
 * a recovery key exist (otherwise a lost device would lose the vault), and through `enrollPresence`,
 * which verifies the new wrapper by a real unwrap before anything is removed.
 */
export async function enrolPresence(id: ProtectorId, ctx: GateContext): Promise<{ ok: true; removed: ProtectorId[] } | Refusal> {
  const lang = vaultLang()
  if (!isPresenceId(id)) return refused('bad-request', 'not a presence protector')
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  if (!recoveryTodo()) {
    if (!o.vault.stepup) return refused('needs-authenticator', lang === 'pt' ? 'Configure o autenticador antes da presença (`agentop vault enroll --authenticator`).' : 'Set up the authenticator before presence (`agentop vault enroll --authenticator`).')
    if (!o.vault.wrappers.some(w => w.type === 'recovery')) return refused('needs-recovery', lang === 'pt' ? 'Crie a chave de recuperação antes da presença (`agentop vault enroll --recovery`).' : 'Create the recovery key before presence (`agentop vault enroll --recovery`).')
    const g = await requireVaultStepUp('enroll-presence', ctx)
    if (!g.ok) return g
  }
  const presence = presenceCandidates().find(p => p.id === id) ?? protectorById(id)
  if (!presence) return refused('presence-unavailable', lang === 'pt' ? 'Esse tipo de presença não existe nesta plataforma.' : 'That kind of presence does not exist on this platform.')
  const all: Protector[] = [presence, ...o.vault.wrappers.map(w => protectorById(w.type)).filter((p): p is Protector => p !== null)]
  const r = await enrollPresence(realProtectorIo(), vaultDir(), { state: 'open', kid: o.kid, dek: o.dek, vault: o.vault, via: 'memory' }, presence, all)
  if (!r.ok) return refused('presence-enrol-failed', r.reason)
  o.vault = r.vault
  recoveryStepDone('presence')
  vaultAudit({ type: 'vault.enroll-presence', protector: id })
  return { ok: true, removed: r.removed }
}

// ── §5.1 the idle period ────────────────────────────────────────────────────────────────────

export async function setAutoLockMinutes(minutes: unknown, ctx: GateContext): Promise<GateResult> {
  const m = parseAutoLockMinutes(minutes)
  if (m === null) return refused('bad-request', vaultLang() === 'pt' ? 'O bloqueio automático vai de 5 a 480 minutos; não existe "nunca".' : 'Auto-lock is 5 to 480 minutes; there is no "never".')
  const g = await requireVaultStepUp('set-auto-lock', ctx)
  if (!g.ok) return g
  const o = await ensureVaultOpen({ create: false, migrate: false })
  if (!o) return refused('locked', sentence('locked'))
  const vault: VaultJson = { ...o.vault, v: 2, autoLock: { minutes: m } }
  await writeVaultJson(vault)
  o.vault = vault
  setAutoLockPeriod(m)
  vaultAudit({ type: 'vault.set-auto-lock' })
  return g
}

/** §4.3: a passphrase wrapper only where the vault has no protector of its own. */
export function addPassphraseAllowed(v: VaultJson): { ok: true } | Refusal {
  const other = v.wrappers.find(w => w.type !== 'passphrase' && w.type !== 'recovery' && w.type !== 'memory')
  if (!other) return { ok: true }
  return refused('passphrase-replaced', sentence('passphrase-replaced', { protector: protectorById(other.type)?.label(vaultLang()) ?? other.type }))
}

// ── test seams ───────────────────────────────────────────────────────────────────────────────

export function __resetGateForTests(now?: () => number): void {
  _mem = { ...FRESH_STEPUP }
  _now = now ?? (() => Date.now())
  _grantKey = randomBytes(32)
  dropEnrolSeed()
  dropRecovery()
}

