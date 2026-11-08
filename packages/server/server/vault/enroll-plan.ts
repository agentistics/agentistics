/**
 * vault/enroll-plan.ts — the pure half of `agentop vault enroll` (SECRETS.4 §7.3): which steps a run
 * does, which way of confirming it enrols, and how the 24 words are laid out on a terminal. No IO, so
 * the choices are testable and the words' numbering is pinned by a test rather than by eye.
 */

/**
 * COFRE.DESBLOQUEIO (owner, 2026-11-07): there is no authenticator step any more. The vault is
 * protected in two steps — how it confirms it is you (presence: Touch ID / the Mac password, Windows
 * Hello, the vault password, or a security key), then the 24 words.
 */
export type EnrolStep = 'recovery' | 'presence'
export type PresenceKind = 'touchid' | 'hello' | 'password' | 'fido2'
const PRESENCE_KINDS: readonly PresenceKind[] = ['touchid', 'hello', 'password', 'fido2']

export interface EnrolArgs {
  /** The steps the user asked for; empty = "whatever is still missing" (decided against the vault's state). */
  only: EnrolStep[]
  presence: PresenceKind | null
  requirePresence: boolean
}

/** PURE. `--presence <touchid|hello|password|fido2>`, `--recovery`, `--require-presence`. */
export function parseEnrolArgs(args: readonly string[]): { ok: true; value: EnrolArgs } | { ok: false; usage: string; retired?: 'authenticator' } {
  const usage = 'usage: agentop vault enroll [--presence touchid|hello|password|fido2] [--recovery] [--require-presence]'
  const only: EnrolStep[] = []
  let presence: PresenceKind | null = null
  let requirePresence = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--authenticator') return { ok: false, usage, retired: 'authenticator' }
    if (a === '--recovery') only.push('recovery')
    else if (a === '--require-presence') requirePresence = true
    else if (a === '--presence') {
      const v = args[++i] as PresenceKind | undefined
      if (!v || !PRESENCE_KINDS.includes(v)) return { ok: false, usage }
      presence = v
      only.push('presence')
    } else return { ok: false, usage }
  }
  return { ok: true, value: { only: [...new Set(only)], presence, requirePresence } }
}

export interface EnrolState {
  recovery: boolean
  presence: boolean
  /** The ways this machine offers (`unlockMethods` of the view), best first; `advanced` ones last. */
  available: readonly { id: string; advanced: boolean }[]
}

/**
 * PURE. The steps to run, in the only safe order: presence BEFORE the recovery key (leader decision 2 —
 * presence replaces the data key, so the words made last wrap the final key). Explicit flags force a
 * step; none = what is still missing. The vault password is offered everywhere, so a machine always
 * has a way to confirm.
 */
export function stepsToRun(a: EnrolArgs, s: EnrolState): EnrolStep[] {
  const order: EnrolStep[] = ['presence', 'recovery']
  if (a.only.length > 0) return order.filter(x => a.only.includes(x))
  return order.filter(x => (x === 'recovery' ? !s.recovery : !s.presence && s.available.length > 0))
}

/** PURE. Which way to enrol: the one asked for (when this machine offers it), else the first non-advanced offer. */
export function pickPresence(asked: PresenceKind | null, available: readonly { id: string; advanced: boolean }[]): PresenceKind | null {
  const offered = available.filter(m => PRESENCE_KINDS.includes(m.id as PresenceKind))
  if (asked) return offered.some(m => m.id === asked) ? asked : null
  return (offered.find(m => !m.advanced)?.id as PresenceKind | undefined) ?? null
}

/** PURE. The 24 words as a numbered grid, 4 per row (6 rows), each cell `NN word`. */
export function wordGrid(words: readonly string[], perRow = 4): string[] {
  const w = Math.max(...words.map(x => x.length))
  const rows: string[] = []
  for (let i = 0; i < words.length; i += perRow) {
    rows.push(words.slice(i, i + perRow).map((x, j) => `${String(i + j + 1).padStart(2, ' ')}. ${x.padEnd(w)}`).join('   ').trimEnd())
  }
  return rows
}
