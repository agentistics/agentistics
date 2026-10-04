/**
 * spawnAdmission.ts — PURE. Reading `/api/fleet/new`'s memory-budget refusal, once, for every caller.
 *
 * The server's `spawn-admission.ts` (`packages/server/server/sessions/spawn-admission.ts`) turned the
 * memory-budget meter into a GATE on starting a session: a refusal comes back as HTTP 409 with
 * `{ok: false, code: 'memory_budget', message, refusal: {...}}`, and a forced success (the caller
 * re-posted with `force: true`) comes back `{ok: true, id?, message, overridden: true, note}`. The
 * web package cannot import the server module (`packages/server/` is server-only — see CLAUDE.md), so
 * the wire shape is mirrored here STRUCTURALLY, and the three `/api/fleet/new` callers
 * (`NewSessionModal.tsx`, `SessionsPage.tsx`'s `confirmPresetLaunch`, `DeliveryDetail.tsx`'s
 * `confirmFire`) all read the response through this one module rather than three hand-written checks
 * that could quietly drift from the server's actual shape or from each other.
 *
 * `isAdmissionRefusal` is deliberately narrow: it is true ONLY for the exact memory-budget refusal
 * shape (`ok === false`, `code === 'memory_budget'`, and a `refusal` object whose fields are the
 * right TYPES) — a plain `ok: false` from any other spawn refusal (an unknown harness, a relative
 * path, …) must read as an ordinary error, never as one offering "start anyway". A malformed refusal
 * (a field missing or of the wrong type) is also `false`: a caller that trusted a half-read refusal
 * would offer to skip a memory check it never actually confirmed exists.
 */

/** Why a spawn was refused — see `spawn-admission.ts`'s `AdmissionReason`. */
export type AdmissionReason = 'swap' | 'no-room' | 'cpu'

/** The refusal's own numbers — every figure the server's sentence is built from. */
export interface AdmissionRefusal {
  reason: AdmissionReason
  requested: number
  fits: number
  availableBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
  costBytes: number
  costBasis: 'measured' | 'assumed'
  used: number
  max: number
}

/** The exact shape `/api/fleet/new` answers with on a memory-budget refusal (HTTP 409). */
export interface SpawnAdmissionRefusal {
  ok: false
  code: 'memory_budget'
  message: string
  refusal: AdmissionRefusal
}

function isAdmissionReason(v: unknown): v is AdmissionReason {
  return v === 'swap' || v === 'no-room' || v === 'cpu'
}

function isCostBasis(v: unknown): v is 'measured' | 'assumed' {
  return v === 'measured' || v === 'assumed'
}

function isAdmissionRefusalData(v: unknown): v is AdmissionRefusal {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    isAdmissionReason(r.reason)
    && typeof r.requested === 'number'
    && typeof r.fits === 'number'
    && typeof r.availableBytes === 'number'
    && typeof r.swapUsedBytes === 'number'
    && typeof r.swapTotalBytes === 'number'
    && typeof r.costBytes === 'number'
    && isCostBasis(r.costBasis)
    && typeof r.used === 'number'
    && typeof r.max === 'number'
  )
}

/**
 * True only for the exact memory-budget refusal — `ok: false`, `code: 'memory_budget'`, a `message`
 * string and a well-typed `refusal`. Every other `ok: false` (including one with no `code` at all)
 * is an ordinary refusal and must keep behaving exactly as it does today: shown as a plain message,
 * with no "start anyway" offered.
 */
export function isAdmissionRefusal(json: unknown): json is SpawnAdmissionRefusal {
  if (!json || typeof json !== 'object') return false
  const j = json as Record<string, unknown>
  return (
    j.ok === false
    && j.code === 'memory_budget'
    && typeof j.message === 'string'
    && isAdmissionRefusalData(j.refusal)
  )
}

/**
 * The sentence to show for a FORCED success — "started anyway, overriding the memory check: …" — or
 * `null` when the response was not a forced admission. Read `overridden` itself with a strict
 * equality check, the same reason the server's `readForce` does: a truthy-but-not-`true` value must
 * never be read as the server's own confession that it started this session over a refusal.
 */
export function forcedNote(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const j = json as Record<string, unknown>
  return j.overridden === true && typeof j.note === 'string' ? j.note : null
}
