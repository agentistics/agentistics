/**
 * browser-admission.ts — PURE: may another Chromium start? (spec §1.4)
 *
 * Three rules, in this order, each with its own refusal code so a caller can say WHY in words:
 *
 * 1. An owner that already has a browser (live or still starting) gets THAT one — never a second.
 * 2. Ceilings: at most `MAX_SESSION_BROWSERS` session browsers and `MAX_PERSONAL_BROWSERS` personal
 *    (= `MAX_LIVE_BROWSERS` in all). A full session ceiling may be relieved by closing ONE session
 *    browser nobody watches and that has been idle longer than `EVICT_IDLE_MS` (least recently active
 *    first). A browser still STARTING counts against the ceiling — two requests in the same tick must
 *    not both be told yes — and is never an eviction candidate.
 * 3. Memory: refused when `MemAvailable` is below `MIN_AVAILABLE_BYTES`. Checked AFTER the ceiling so a
 *    refusal names the ceiling when the ceiling is the reason. An eviction does not lift a memory
 *    refusal: what the evicted browser will free is not known until it is gone.
 *
 * `memAvailable === null` is a machine with no `/proc/meminfo` (macOS, Windows). It is ADMITTED and
 * the decision says `memory: 'unmeasured'`, which `status` repeats: refusing there would make the
 * feature unusable on every non-Linux machine for want of a reading, while admitting silently would
 * hide that the brake is off. The ceiling and the watcher still apply.
 */

import {
  EVICT_IDLE_MS, MAX_LIVE_BROWSERS, MAX_PERSONAL_BROWSERS, MAX_SESSION_BROWSERS, MIN_AVAILABLE_BYTES,
  ownerKey, type BrowserOwner,
} from './browser-spec'

export interface LiveBrowserView {
  key: string
  owner: BrowserOwner
  /** `starting` until `Browser.getVersion` answered. */
  phase: 'starting' | 'live'
  viewers: number
  lastActivityMs: number
}

export interface AdmissionInput {
  owner: BrowserOwner
  live: readonly LiveBrowserView[]
  memAvailable: number | null
  now: number
}

export type AdmissionRefusal = 'session-ceiling' | 'live-ceiling' | 'low-memory'

export type AdmissionDecision =
  | { ok: true; reuse: string }
  | { ok: true; evict?: string; memory: 'ok' | 'unmeasured' }
  | { ok: false; reason: AdmissionRefusal; memAvailable?: number }

export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const key = ownerKey(input.owner)
  const mine = input.live.find(b => b.key === key)
  if (mine) return { ok: true, reuse: mine.key }

  const sessions = input.live.filter(b => b.owner.kind === 'session')
  const personals = input.live.filter(b => b.owner.kind === 'personal')
  let evict: string | undefined

  if (input.owner.kind === 'session') {
    if (sessions.length >= MAX_SESSION_BROWSERS) {
      const victim = evictionCandidate(sessions, input.now)
      if (!victim) return { ok: false, reason: 'session-ceiling' }
      evict = victim
    }
  } else if (personals.length >= MAX_PERSONAL_BROWSERS) {
    // Unreachable through `reuse` (there is one personal key) but kept so a future second personal
    // owner cannot slip past the ceiling.
    return { ok: false, reason: 'live-ceiling' }
  }
  const after = input.live.length - (evict ? 1 : 0) + 1
  if (after > MAX_LIVE_BROWSERS) return { ok: false, reason: 'live-ceiling' }

  if (input.memAvailable === null) return { ok: true, ...(evict ? { evict } : {}), memory: 'unmeasured' }
  if (input.memAvailable < MIN_AVAILABLE_BYTES) return { ok: false, reason: 'low-memory', memAvailable: input.memAvailable }
  return { ok: true, ...(evict ? { evict } : {}), memory: 'ok' }
}

/** The session browser that may be closed to make room, or `null`. */
export function evictionCandidate(sessions: readonly LiveBrowserView[], now: number): string | null {
  const idle = sessions.filter(b => b.phase === 'live' && b.viewers === 0 && now - b.lastActivityMs > EVICT_IDLE_MS)
  if (idle.length === 0) return null
  return [...idle].sort((a, b) => a.lastActivityMs - b.lastActivityMs || a.key.localeCompare(b.key))[0]!.key
}

/** The sentence a refusal is said in (the MCP tool and the panel both show it). */
export function admissionSentence(reason: AdmissionRefusal, lang: 'en' | 'pt' = 'en', memAvailable?: number): string {
  const gb = memAvailable !== undefined ? (memAvailable / 1024 ** 3).toFixed(1) : null
  const min = (MIN_AVAILABLE_BYTES / 1024 ** 3).toFixed(1)
  if (lang === 'pt') {
    if (reason === 'session-ceiling') return `O navegador está ocupado por outras ${MAX_SESSION_BROWSERS} sessões; tente em alguns minutos.`
    if (reason === 'live-ceiling') return `Já há ${MAX_LIVE_BROWSERS} navegadores abertos neste computador; feche um e tente de novo.`
    return `Pouca memória livre neste computador${gb ? ` (${gb} GB)` : ''}; o navegador precisa de pelo menos ${min} GB disponíveis.`
  }
  if (reason === 'session-ceiling') return `The browser is busy with ${MAX_SESSION_BROWSERS} other sessions; try again in a few minutes.`
  if (reason === 'live-ceiling') return `${MAX_LIVE_BROWSERS} browsers are already open on this computer; close one and try again.`
  return `Not enough free memory on this computer${gb ? ` (${gb} GB)` : ''}; the browser needs at least ${min} GB available.`
}
