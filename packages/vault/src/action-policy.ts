/**
 * action-policy.ts — WHICH proof each kind of vault action asks (owner decision 2026-10-06). PURE.
 *
 * The person chooses, per kind of action, between the authenticator CODE, the GESTURE (Windows Hello /
 * Face ID / biometrics / a security key — the vault's presence wrapper, or a phone passkey), BOTH, and —
 * for the low-risk READ kinds only — NOTHING (the open vault is the proof, as it already is for the list).
 *
 *  - A CRITICAL kind (deleting, wiping, the security settings, recovery) can never be `none`: the parse
 *    REFUSES such a policy, so neither the page nor a hand-written request can store one. Editing is not
 *    a read, so it is not offered `none` either.
 *  - An absent choice is TODAY'S behaviour (`ACTION_KINDS[k].default`), so a vault that never chose
 *    anything asks exactly what it asked before this existed.
 *  - What is ASKED is decided against what the vault HAS (`proofsFor`): a chosen proof the vault cannot
 *    ask (no authenticator enrolled, no presence wrapper) is replaced by the OTHER one when it exists — a
 *    choice of "code" on a vault with no authenticator does not silently become "nothing". A vault with
 *    neither proof asks nothing, exactly as the table did before (there is nothing to ask yet).
 *
 * Opening the vault is NOT here: it is the unlock policy (unlock-policy.ts), whose modes are already the
 * three honest choices for an unlock — the gesture is what unwraps the key, so "code only" cannot exist.
 */
export type ProofChoice = 'code' | 'gesture' | 'both' | 'none'
export const PROOF_CHOICES: readonly ProofChoice[] = ['code', 'gesture', 'both', 'none']

export type ActionKind =
  | 'reveal' | 'use' | 'edit' | 'delete-secret' | 'delete-device' | 'wipe' | 'settings' | 'recovery'
export const ACTION_KINDS_ORDER: readonly ActionKind[] = ['reveal', 'use', 'edit', 'delete-secret', 'delete-device', 'wipe', 'settings', 'recovery']

export interface ActionKindSpec {
  /** A read: `none` is allowed. */
  read: boolean
  /** Critical: at least one proof, always. */
  critical: boolean
  /** Today's behaviour — what an absent choice means. */
  default: ProofChoice
}

/** A `Record`, so a new kind does not compile until it says whether it is critical and what it asked before. */
export const ACTION_KINDS: Readonly<Record<ActionKind, ActionKindSpec>> = {
  reveal: { read: true, critical: false, default: 'gesture' },
  use: { read: true, critical: false, default: 'gesture' },
  edit: { read: false, critical: false, default: 'gesture' },
  'delete-secret': { read: false, critical: true, default: 'both' },
  'delete-device': { read: false, critical: true, default: 'both' },
  wipe: { read: false, critical: true, default: 'both' },
  settings: { read: false, critical: true, default: 'both' },
  recovery: { read: false, critical: true, default: 'both' },
}

/** PURE. The choices a kind may take: `none` only for a read. */
export function choicesFor(kind: ActionKind): readonly ProofChoice[] {
  return ACTION_KINDS[kind].read ? PROOF_CHOICES : PROOF_CHOICES.filter(c => c !== 'none')
}

export interface AuthPolicy { v: 1; choices: Partial<Record<ActionKind, ProofChoice>> }
export const DEFAULT_AUTH_POLICY: AuthPolicy = Object.freeze({ v: 1, choices: Object.freeze({}) }) as AuthPolicy

/**
 * PURE. A requested policy, or null when it is not one: an unknown kind, an unknown choice, or `none` on
 * a kind that is not a read (every critical kind among them). Refused WHOLE — a half-applied policy is a
 * policy nobody chose. A choice equal to the default is stored as given (it is still a choice).
 */
export function parseAuthPolicy(v: unknown): AuthPolicy | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = (v as { choices?: unknown }).choices ?? v
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const choices: Partial<Record<ActionKind, ProofChoice>> = {}
  for (const [k, c] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in ACTION_KINDS)) return null
    const kind = k as ActionKind
    if (typeof c !== 'string' || !(choicesFor(kind) as readonly string[]).includes(c)) return null
    choices[kind] = c as ProofChoice
  }
  return { v: 1, choices }
}

/** PURE. The choice in force for a kind: the stored one, or today's behaviour. A stored `none` on a non-read kind (a hand edit) reads as the default. */
export function choiceFor(policy: AuthPolicy | null | undefined, kind: ActionKind): ProofChoice {
  const c = policy?.choices[kind]
  if (!c) return ACTION_KINDS[kind].default
  if (c === 'none' && !ACTION_KINDS[kind].read) return ACTION_KINDS[kind].default
  return c
}

/** PURE. The policy a record that EXISTS but cannot be opened stands for: the strictest — both, everywhere. */
export const STRICTEST_AUTH_POLICY: AuthPolicy = Object.freeze({
  v: 1,
  choices: Object.freeze(Object.fromEntries(ACTION_KINDS_ORDER.map(k => [k, 'both']))) as Partial<Record<ActionKind, ProofChoice>>,
}) as AuthPolicy

export interface VaultProofs { hasAuthenticator: boolean; hasPresence: boolean }

/**
 * PURE. What a choice ASKS on a vault with these proofs. A chosen proof the vault cannot ask is replaced
 * by the other one when it exists; `none` asks nothing; a vault with neither proof asks nothing.
 */
export function proofsFor(choice: ProofChoice, has: VaultProofs): { code: boolean; gesture: boolean } {
  if (choice === 'none') return { code: false, gesture: false }
  const code = (choice === 'code' || choice === 'both') && has.hasAuthenticator
  const gesture = (choice === 'gesture' || choice === 'both') && has.hasPresence
  if (code || gesture) return { code, gesture }
  if (has.hasAuthenticator) return { code: true, gesture: false }
  if (has.hasPresence) return { code: false, gesture: true }
  return { code: false, gesture: false }
}

/** PURE. The choice as its two wanted halves, before the vault's proofs are considered. */
export function wants(choice: ProofChoice): { code: boolean; gesture: boolean } {
  return { code: choice === 'code' || choice === 'both', gesture: choice === 'gesture' || choice === 'both' }
}
