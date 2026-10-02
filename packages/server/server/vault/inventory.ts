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
import { isKid, isPresenceId, parseSealed, parseVaultJson, PRESENCE_GESTURES, setupCodeCommand, setupCodeWhere } from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR } from '../config'
import { sealedFiles } from './boot'
import { VAULT_ACTION_ROWS, requireVaultStepUp, setupCodeOwed, stepUpState, type GateContext } from './gate'
import { hardeningLines } from './hardening'
import {
  displayPath, lockVault, pendingPlaintextFiles, presenceCandidates, restoreWithFor, secretFs, vaultDir, vaultLang, vaultStatus,
  type LockedBy, type RecoveryStep, type VaultState,
} from './service'

export type VaultItemState = 'sealed' | 'pending' | 'unreadable'
/** Why an item is not plainly "sealed". Codes, rendered by the web in the user's language. */
export type VaultItemReason = 'plaintext' | 'wrong-machine' | 'unparseable' | 'mode-open'

export interface VaultItem {
  /** What the secret IS — a stable code the web maps to words. */
  kind: 'github-backup' | 'central-token' | 'envelope-key' | 'central-env' | 'other'
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
  /** How many prompts the device check / the enrolment raise (presence.ts `PRESENCE_GESTURES`) — the page states these numbers, never its own. */
  gestures: { probe: number; enroll: number }
}

const KIND_OF_PURPOSE: Record<string, VaultItem['kind']> = {
  'github-backup': 'github-backup', 'central-token': 'central-token',
  'envelope-key': 'envelope-key', 'central-env': 'central-env',
}

/** PURE. Which secret a plaintext file still holds, from its name. */
export function kindOfPendingFile(file: string): VaultItem['kind'] {
  const b = basename(file)
  if (b.startsWith('github-backup')) return 'github-backup'
  if (b === 'preferences.json' || b === '.claude.json') return 'central-token'
  if (b.startsWith('machine-key') || b.startsWith('envelope-key')) return 'envelope-key'
  if (b.endsWith('.env')) return 'central-env'
  return 'other'
}

/** `files` / `pendingFiles` are seams for tests; production reads the host's own lists. */
export async function readVaultView(files: string[] = sealedFiles(), pendingFiles?: () => Promise<string[]>, session = ''): Promise<VaultView> {
  const s = await vaultStatus()
  let createdAt: string | null = null
  let kid = s.kid
  let stored: ReturnType<typeof parseVaultJson> = null
  try {
    const raw = await secretFs().readFile(`${vaultDir()}/vault.json`)
    stored = parseVaultJson(raw ? new TextDecoder().decode(raw) : null)
    if (stored) { createdAt = stored.createdAt; kid = kid ?? stored.kid }
  } catch { /* the view says "unknown" rather than failing */ }
  const su = await stepUpState()
  const STEP_MS = 30_000

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
  return {
    state: s.state, protector: s.protector, protectorLabel: s.protectorLabel, kid, createdAt,
    sentence: s.sentence, pending: s.pending, canLock: s.state === 'open', items,
    wrappers: s.wrappers, presence: s.wrappers.some(w => isPresenceId(w)), presenceAvailable: presenceCandidates().map(p => p.id),
    authenticator: stored?.stepup ? {
      enrolledAt: stored.stepup.enrolledAt, lastUsedAt: su.lastStep !== null ? new Date(su.lastStep * STEP_MS).toISOString() : null,
      failures: su.failures, pausedUntil: su.pausedUntilMs ? new Date(su.pausedUntilMs).toISOString() : null, frozen: su.frozen,
    } : null,
    recoveryCreatedAt: stored?.wrappers.find(w => w.type === 'recovery')?.createdAt ?? null,
    requirePresence: stored?.requirePresence === true,
    autoLockMinutes: stored?.autoLock?.minutes ?? 30,
    autoLockInMs: s.autoLockInMs ?? null, pendingStepup: s.pendingStepup === true, lockedBy: s.lockedBy ?? null,
    recoveryTodo: s.recoveryTodo ?? null,
    gates: Object.fromEntries(Object.entries(VAULT_ACTION_ROWS).map(([k, r]) => [k, { code: r.code, gesture: r.gesture, grant: r.grant !== null }])),
    gestures: { probe: PRESENCE_GESTURES.probe, enroll: PRESENCE_GESTURES.enroll },
    setupCode: {
      owed: setupCodeOwed(Boolean(stored?.stepup), { session }),
      command: setupCodeCommand(AGENTISTICS_DATA_DIR, DEFAULT_AGENTISTICS_DATA_DIR),
      where: setupCodeWhere(vaultLang()),
    },
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
