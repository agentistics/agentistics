/**
 * unlock-policy.ts — what a presence UNLOCK asks besides the gesture (owner decision 2026-10-02).
 * PURE: the clock and the window's anchor are passed in.
 *
 * Three modes, chosen in Settings → Vault (changing it costs the code AND the gesture):
 *
 *   always      "Hello + code, always"  — every unlock is the gesture and the authenticator code.
 *   hello-only  "Hello only"            — the gesture alone opens it. The code is still asked for
 *               everything else the §2.4 table gates (the inventory, settings, recovery, …).
 *   daily       "Per day" (the DEFAULT) — gesture + code on the first unlock after the service starts,
 *               or once the window has expired; within the window, a re-open after auto-lock is the
 *               gesture alone. The window is `hours` long (default 24, 1–24), anchored to the last
 *               gesture+code unlock.
 *
 * The window survives a lock and a service restart (the service keeps its anchor in a file MACed under
 * the data key — vault/service.ts) and is dropped on recovery, reset, a protector change and ANY failed
 * code. Absent from vault.json reads as `daily` / 24 h: the owner's default (VAULT.UX-R2, 2026-10-05:
 * "the code once, then only Hello for 24 hours").
 */
export type UnlockMode = 'always' | 'hello-only' | 'daily'
export interface UnlockPolicy { mode: UnlockMode; hours: number }

export const UNLOCK_MODES: readonly UnlockMode[] = ['always', 'hello-only', 'daily']
export const UNLOCK_WINDOW_DEFAULT_H = 24
export const UNLOCK_WINDOW_MIN_H = 1
export const UNLOCK_WINDOW_MAX_H = 24
export const DEFAULT_UNLOCK_POLICY: UnlockPolicy = Object.freeze({ mode: 'daily', hours: UNLOCK_WINDOW_DEFAULT_H }) as UnlockPolicy

/** PURE. A requested policy, or null when it is not one (unknown mode, hours outside 1–24 or not whole). */
export function parseUnlockPolicy(v: unknown): UnlockPolicy | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.mode !== 'string' || !(UNLOCK_MODES as readonly string[]).includes(o.mode)) return null
  const hours = o.hours === undefined ? UNLOCK_WINDOW_DEFAULT_H : o.hours
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < UNLOCK_WINDOW_MIN_H || hours > UNLOCK_WINDOW_MAX_H) return null
  return { mode: o.mode as UnlockMode, hours }
}

/** PURE. The policy in force: the stored one, or the default when none was chosen. */
export function effectiveUnlockPolicy(stored: UnlockPolicy | undefined | null): UnlockPolicy {
  return stored ?? DEFAULT_UNLOCK_POLICY
}

/**
 * PURE. Does THIS unlock owe the code after the gesture? `anchorMs` is the last gesture+code unlock
 * this service process saw (null after a start, or after anything that drops the window).
 */
export function unlockNeedsCode(policy: UnlockPolicy, anchorMs: number | null, nowMs: number): boolean {
  if (policy.mode === 'always') return true
  if (policy.mode === 'hello-only') return false
  if (anchorMs === null) return true
  return nowMs - anchorMs >= policy.hours * 3_600_000 || nowMs < anchorMs
}

/** PURE. When the per-day window ends (ms), or null when no window is running. */
export function unlockWindowEndsMs(policy: UnlockPolicy, anchorMs: number | null): number | null {
  return policy.mode === 'daily' && anchorMs !== null ? anchorMs + policy.hours * 3_600_000 : null
}
