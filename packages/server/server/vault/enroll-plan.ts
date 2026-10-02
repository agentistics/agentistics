/**
 * vault/enroll-plan.ts — the pure half of `agentop vault enroll` (SECRETS.4 §7.3): which steps a run
 * does, how the QR and the 24 words are laid out on a terminal. No IO, so the choices are testable
 * and the two things that must never go wrong — the QR's polarity and the words' numbering — are
 * pinned by tests rather than by eye.
 */
import { qrMatrix } from '../../../web/src/lib/qr'

export type EnrolStep = 'authenticator' | 'recovery' | 'presence'
export type PresenceKind = 'hello' | 'fido2'

export interface EnrolArgs {
  /** The steps the user asked for; empty = "whatever is still missing" (decided against the vault's state). */
  only: EnrolStep[]
  presence: PresenceKind | null
  requirePresence: boolean
}

/** PURE. `--authenticator`, `--presence <hello|se|fido2>`, `--recovery`, `--require-presence`. */
export function parseEnrolArgs(args: readonly string[]): { ok: true; value: EnrolArgs } | { ok: false; usage: string; deferred?: 'se' } {
  const usage = 'usage: agentop vault enroll [--authenticator] [--presence hello|fido2] [--recovery] [--require-presence]'
  const only: EnrolStep[] = []
  let presence: PresenceKind | null = null
  let requirePresence = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--authenticator') only.push('authenticator')
    else if (a === '--recovery') only.push('recovery')
    else if (a === '--require-presence') requirePresence = true
    else if (a === '--presence') {
      const v = args[++i]
      if (v === 'se') return { ok: false, usage, deferred: 'se' }
      if (v !== 'hello' && v !== 'fido2') return { ok: false, usage }
      presence = v
      only.push('presence')
    } else return { ok: false, usage }
  }
  return { ok: true, value: { only: [...new Set(only)], presence, requirePresence } }
}

export interface EnrolState {
  authenticator: boolean
  recovery: boolean
  presence: boolean
  /** The presence kinds this machine can enrol (`presenceAvailable` of the view), best first. */
  available: readonly string[]
}

/**
 * PURE. The steps to run, in the only safe order (§7.3: authenticator, then the recovery key, then
 * presence — presence retires the silent wrapper, so the other two must already exist). Explicit
 * flags force a step (replace the phone, a new recovery key); none = what is still missing.
 */
export function stepsToRun(a: EnrolArgs, s: EnrolState): EnrolStep[] {
  // Leader decision 2: presence BEFORE the recovery key — presence replaces the data key, so the words
  // made last wrap the final key and never have to be kept in memory across steps.
  const order: EnrolStep[] = ['authenticator', 'presence', 'recovery']
  if (a.only.length > 0) return order.filter(x => a.only.includes(x))
  return order.filter(x => (x === 'authenticator' ? !s.authenticator : x === 'recovery' ? !s.recovery : !s.presence && s.available.length > 0))
}

/** PURE. Which presence kind to enrol: the one asked for, else the first this machine offers. */
export function pickPresence(asked: PresenceKind | null, available: readonly string[]): PresenceKind | null {
  if (asked) return available.includes(asked) ? asked : null
  const first = available.find(x => x === 'hello' || x === 'fido2')
  return (first as PresenceKind | undefined) ?? null
}

/**
 * PURE. A QR as terminal text, two modules per character row (▀ ▄ █). It sets its own colours —
 * black modules on a white field with a 2-module quiet zone — so it scans on a dark theme and a light
 * one alike; relying on the terminal's default colours would invert it for half the users.
 */
export function qrHalfBlocks(uri: string, quiet = 2): string[] {
  const m = qrMatrix(uri)
  const n = m.length + quiet * 2
  const dark = (r: number, c: number): boolean => {
    const rr = r - quiet, cc = c - quiet
    return rr >= 0 && cc >= 0 && rr < m.length && cc < m.length && m[rr]![cc] === true
  }
  const on = '\x1b[30;47m', off = '\x1b[0m'
  const lines: string[] = []
  for (let r = 0; r < n; r += 2) {
    let line = on
    for (let c = 0; c < n; c++) {
      const top = dark(r, c), bottom = r + 1 < n && dark(r + 1, c)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line + off)
  }
  return lines
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
