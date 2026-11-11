/**
 * vault/inventory.ts — what Settings → Vault shows: the vault's state, and WHICH secrets are
 * registered in it. METADATA ONLY.
 *
 * It never decrypts anything. A sealed file carries its own plain header (`kid`, `purpose`, `name`,
 * `sealedAt`), which is enough to say what it is, when it was sealed and whether it belongs to this
 * vault — so this module never holds a secret value, and the response cannot leak one by accident.
 * The shape is a closed list of named fields rather than a spread of anything read from disk.
 */
import { basename } from 'node:path'
import { hasPresence, isKid, isPresenceId, parseSealed, parseVaultJson, PRESENCE_GESTURES, setupCodeCommand, setupCodeWhere } from '@agentistics/vault'
import { VAULT_PASSWORD_MIN_LENGTH, VAULT_PASSWORD_MIN_SPECIAL, VAULT_PASSWORD_RULES } from '@agentistics/core'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR } from '../config'
import { sealedFiles } from './boot'
import { VAULT_ACTION_ROWS, asProof, authPolicyView, policyRow, proofsOf, requireVaultStepUp, rowFor, type VaultAction, setupCodeOwed, localProofKind, unlockPolicyView, type GateContext } from './gate'
import { readAuthPolicy, type AuthPolicyRead } from './auth-policy'
import { DEFAULT_AUTH_POLICY } from '@agentistics/vault'
import { hardeningLines } from './hardening'
import {
  displayPath, lockVault, pendingPlaintextFiles, presenceCandidates, presenceSoon, unlockMethodOffers, restoreWithFor, secretFs, unlockWindowHint, vaultDir, vaultLang, vaultStatus,
  type LockedBy, type RecoveryStep, type VaultState,
} from './service'

export type VaultItemState = 'sealed' | 'pending' | 'unreadable'
/** Why an item is not plainly "sealed". Codes, rendered by the web in the user's language. */
export type VaultItemReason = 'plaintext' | 'wrong-machine' | 'unparseable' | 'mode-open'

export interface VaultItem {
  /** What the secret IS — a stable code the web maps to words. */
  kind: 'github-backup' | 'other'
  state: VaultItemState
  reason?: VaultItemReason
  /** ISO instant the file was sealed (from its own header). Absent for a pending item. */
  sealedAt?: string
  /** A path under the data dir, for display. Never a value. */
  file: string
  /** How to enter it again — present for an unreadable item only. */
  restoreWith?: string
}

export interface VaultView {
  state: VaultState
  protector: string | null
  protectorLabel: string | null
  kid: string | null
  createdAt: string | null
  /** The vault's own sentence for any state but `open` (already localized). */
  sentence: string | null
  pending: number
  canLock: boolean
  items: VaultItem[]
  /** §7.1 — what the sections need. Facts about the vault, never a secret and never a value. */
  wrappers: string[]
  presence: boolean
  /** The presence kinds this machine could enrol (§3.4); empty on a headless box. */
  presenceAvailable: string[]
  authenticator: { enrolledAt: string; lastUsedAt: string | null; failures: number; pausedUntil: string | null; frozen: boolean } | null
  recoveryCreatedAt: string | null
  /** The owner's machine (§7.4): enrolment is the default path and presence cannot be turned off lightly. */
  requirePresence: boolean
  autoLockMinutes: number
  /** VAULT.V4: confirm each use of a sensitive secret (absent on an older server = off). */
  confirmEachUse?: boolean
  autoLockInMs: number | null
  pendingStepup: boolean
  lockedBy: LockedBy | null
  recoveryTodo: RecoveryStep[] | null
  /** §5.3 / §7.1 "Hardening": the report plus its already-localized lines (empty = nothing to say). */
  /** The server's own §2.4 table, so the screen draws 🔑 / 👆 from the rule instead of a second copy of it. */
  gates: Record<string, { code: boolean; gesture: boolean; grant: boolean }>
  hardening: { state: 'ok' | 'limited' | 'failed'; private: boolean | null; coreDumps: 'off' | 'on' | null; yama: string | null; lines: string[] } | null
  /**
   * Review S2, owner 2026-10-02: a page's FIRST enrolment owes the setup code, and the page asks for it
   * as its first step — before any gesture. `command` is the exact line that reaches THIS service (with
   * `AGENTISTICS_DIR=` when it runs on a non-default data dir); `where` says, in words, that it must be a
   * real terminal. `owed` is false once this session has spent one.
   */
  setupCode: { owed: boolean; command: string; where: string }
  /**
   * v2.98.1: is THIS page open on this computer (loopback — http.ts `loopbackRequest`)? Only then does
   * the page offer the local gesture in place of the setup code, and the recovery with the 24 words.
   */
  loopback: boolean
  /** v2.98.1: the presence kind whose ONE gesture can stand for the setup code here, or null. */
  localProofKind: string | null
  /** v2.98.1: presence kinds this platform has but this build does not offer yet ("coming soon"). */
  presenceSoon: string[]
  /** How many prompts the device check / the enrolment raise (presence.ts `PRESENCE_GESTURES`) — the page states these numbers, never its own. */
  gestures: { probe: number; enroll: number }
  /** Owner decision 2026-10-02: what an unlock asks besides the gesture, and whether the NEXT one owes the code. */
  unlockPolicy: { mode: 'always' | 'hello-only' | 'daily'; hours: number; chosen: boolean; codeNextUnlock: boolean; windowEndsAt: string | null }
  /** Owner decision 2026-10-06: which proof each kind of action asks — one row per kind (gate.ts `authPolicyView`). */
  authPolicy: Awaited<ReturnType<typeof authPolicyView>>
  /**
   * COFRE.DESBLOQUEIO (owner, 2026-11-07): the ways of confirming this machine offers, best first —
   * `advanced` for a FIDO2 key, which appears ONLY where its tools are present.
   */
  unlockMethods: { id: string; advanced: boolean; gestures: { enroll: number; unlock: number } }[]
  /** The way(s) this vault confirms with today (its presence wrappers), best first; empty = none chosen yet. */
  methods: string[]
  /** The vault still RECORDS an app code (authenticator) from before 2026-11-07 (asked by nothing; dropped when a method is set up). */
  legacyAppCode: boolean
  /** The vault password's rules (the same ones the server enforces), for a client that cannot import them. */
  passwordRules: { minLength: number; minSpecial: number; rules: string[] }
}

/** How many dialogs each method raises to enrol / to unlock (the page states these numbers, never its own). */
export function methodGestures(id: string): { enroll: number; unlock: number } {
  if (id === 'password') return { enroll: 0, unlock: 0 }
  if (id === 'touchid') return { enroll: 1, unlock: 1 }
  return { enroll: PRESENCE_GESTURES.enroll, unlock: PRESENCE_GESTURES.unlock }
}

const KIND_OF_PURPOSE: Record<string, VaultItem['kind']> = {
  'github-backup': 'github-backup',
}

/** PURE. Which secret a plaintext file still holds, from its name. */
export function kindOfPendingFile(file: string): VaultItem['kind'] {
  const b = basename(file)
  if (b.startsWith('github-backup')) return 'github-backup'
  return 'other'
}

/** `files` / `pendingFiles` are seams for tests; production reads the host's own lists. */
export async function readVaultView(files: string[] = sealedFiles(), pendingFiles?: () => Promise<string[]>, session = '', loopback = false): Promise<VaultView> {
  const s = await vaultStatus()
  let createdAt: string | null = null
  let kid = s.kid
  let stored: ReturnType<typeof parseVaultJson> = null
  try {
    const raw = await secretFs().readFile(`${vaultDir()}/vault.json`)
    stored = parseVaultJson(raw ? new TextDecoder().decode(raw) : null)
    if (stored) { createdAt = stored.createdAt; kid = kid ?? stored.kid }
  } catch { /* the view says "unknown" rather than failing */ }

  const items: VaultItem[] = []
  for (const f of files) {
    const st = await secretFs().lstat(f)
    const bytes = st ? await secretFs().readFile(f) : null
    const head = bytes ? parseSealed(new TextDecoder().decode(bytes)) : null
    if (!head) {
      items.push({ kind: 'other', state: 'unreadable', reason: 'unparseable', file: displayPath(f), restoreWith: restoreWithFor('') })
      continue
    }
    const kind = KIND_OF_PURPOSE[head.purpose] ?? 'other'
    const base: VaultItem = { kind, state: 'sealed', sealedAt: head.sealedAt, file: displayPath(f) }
    if (kid && isKid(kid) && head.kid !== kid) {
      items.push({ ...base, state: 'unreadable', reason: 'wrong-machine', restoreWith: restoreWithFor(head.purpose) })
    } else if (st && (st.mode & 0o077) !== 0) {
      items.push({ ...base, state: 'unreadable', reason: 'mode-open', restoreWith: restoreWithFor(head.purpose) })
    } else items.push(base)
  }
  for (const f of await (pendingFiles ?? pendingPlaintextFiles)()) {
    items.push({ kind: kindOfPendingFile(f), state: 'pending', reason: 'plaintext', file: displayPath(f) })
  }
  // Only an OPEN vault's record can be read; a locked one draws the defaults and says it is locked.
  const authPolicy: AuthPolicyRead = s.state === 'open' ? await readAuthPolicy() : { policy: DEFAULT_AUTH_POLICY, state: 'locked' }
  const authRows = await authPolicyView(authPolicy)
  return {
    state: s.state, protector: s.protector, protectorLabel: s.protectorLabel, kid, createdAt,
    sentence: s.sentence, pending: s.pending, canLock: s.state === 'open', items,
    wrappers: s.wrappers, presence: s.wrappers.some(w => isPresenceId(w)), presenceAvailable: presenceCandidates().map(p => p.id),
    // COFRE.DESBLOQUEIO: no authenticator is ever reported as enrolled — the code is asked by nothing.
    // A legacy record is reported as a fact (`legacyAuthenticator`) for the migration note only.
    authenticator: null,
    legacyAppCode: Boolean(stored?.stepup),
    unlockMethods: unlockMethodOffers().map(m => ({ ...m, gestures: methodGestures(m.id) })),
    methods: s.wrappers.filter(w => isPresenceId(w)),
    passwordRules: { minLength: VAULT_PASSWORD_MIN_LENGTH, minSpecial: VAULT_PASSWORD_MIN_SPECIAL, rules: [...VAULT_PASSWORD_RULES] },
    recoveryCreatedAt: stored?.wrappers.find(w => w.type === 'recovery')?.createdAt ?? null,
    requirePresence: stored?.requirePresence === true,
    autoLockMinutes: stored?.autoLock?.minutes ?? 30,
    confirmEachUse: stored?.confirmEachUse === true,
    autoLockInMs: s.autoLockInMs ?? null, pendingStepup: s.pendingStepup === true, lockedBy: s.lockedBy ?? null,
    recoveryTodo: s.recoveryTodo ?? null,
    // Owner decision 2026-10-06: the rows the person's per-action policy makes of the table, so the icons
    // the page draws are what the gate will ask.
    // COFRE.DESBLOQUEIO: as the person's ONE proof (`asProof`) — no row asks a code any more.
    gates: Object.fromEntries((Object.keys(VAULT_ACTION_ROWS) as VaultAction[]).map(k => { const r = asProof(stored ? policyRow(k, { session, loopback }, authPolicy.policy, proofsOf(stored)) : rowFor(k, { session, loopback })); return [k, { code: r.code, gesture: r.gesture, grant: r.grant !== null }] })),
    authPolicy: { state: authPolicy.state, rows: authRows.rows },
    gestures: { probe: PRESENCE_GESTURES.probe, enroll: PRESENCE_GESTURES.enroll },
    unlockPolicy: unlockPolicyView(stored, await unlockWindowHint(typeof kid === 'string' ? kid : null)),
    setupCode: {
      owed: setupCodeOwed(stored ? hasPresence(stored) : false, { session, loopback }),
      command: setupCodeCommand(AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR),
      where: setupCodeWhere(vaultLang()),
    },
    loopback,
    localProofKind: loopback ? localProofKind() : null,
    presenceSoon: presenceSoon(),
    hardening: s.hardening ? { state: s.hardening.state, private: s.hardening.private, coreDumps: s.hardening.coreDumps, yama: s.hardening.yama, lines: hardeningLines(s.hardening, vaultLang()) } : null,
  }
}

/**
 * THE gate every vault ACTION goes through — implemented in gate.ts (SECRETS.4 §2.4) and re-exported
 * here, where VAULT.UI first routed every action, so a caller cannot reach an action without it.
 */
export { requireVaultStepUp } from './gate'

/** "Lock now" from the dashboard: gated (§2.4 — a stolen session cannot even toggle the vault). */
export async function lockVaultNow(ctx: GateContext): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const gate = await requireVaultStepUp('lock', ctx)
  if (!gate.ok) return { ok: false, code: gate.code, error: gate.sentence }
  lockVault('user')
  return { ok: true }
}
