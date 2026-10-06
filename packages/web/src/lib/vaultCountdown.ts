/**
 * vaultCountdown.ts — the clock beside the vault (VAULT.UX-R2, owner 2026-10-05): how long until the
 * authenticator code is asked again. PURE: the policy view and the clock are passed in.
 *
 * It is drawn only when the server says a window is RUNNING (`daily`, `codeNextUnlock: false`, a
 * `windowEndsAt` in the future). "Always" and "Hello only" have no window, and a vault whose next unlock
 * already owes the code has nothing to count down — an absent clock, never a `0 min`.
 */
import type { UnlockPolicyView } from './vaultApi'

/** When the code will be asked again (ms), or null when no window is running. */
export function codeWindowEndsMs(p: Pick<UnlockPolicyView, 'mode' | 'codeNextUnlock' | 'windowEndsAt'> | null | undefined, nowMs: number): number | null {
  if (!p || p.mode !== 'daily' || p.codeNextUnlock || !p.windowEndsAt) return null
  const ends = Date.parse(p.windowEndsAt)
  return Number.isFinite(ends) && ends > nowMs ? ends : null
}

/** "5 h 12 min" / "48 min" / "menos de 1 min" — rounded DOWN, so it never promises a minute it does not have. */
export function remainingWords(ms: number, lang: 'pt' | 'en'): string {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMin < 1) return lang === 'pt' ? 'menos de 1 min' : 'less than 1 min'
  const h = Math.floor(totalMin / 60), m = totalMin % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The whole sentence, or null when there is no clock to show. */
export function codeCountdownText(endsMs: number | null, nowMs: number, lang: 'pt' | 'en'): string | null {
  if (endsMs === null || endsMs <= nowMs) return null
  const left = remainingWords(endsMs - nowMs, lang)
  return lang === 'pt' ? `Código do autenticador pedido de novo em ${left}` : `Authenticator code asked again in ${left}`
}
