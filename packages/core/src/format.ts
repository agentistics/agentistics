import { redactSecrets } from './redact'

/** Compact number for dense UI: 1.5K, 2.4M, 13.3B. Scales past M — a heavy Claude history
 *  reaches billions of tokens, and "13290.8M" is not a number anyone can read at a glance. */
export function fmt(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/**
 * `deliveredAt − startedAt` in ms, or `null` when either is missing or the pair does not produce a
 * non-negative span (bad data, e.g. delivered stamped before started) — the ONE place this
 * arithmetic lives, so a sort key (`subtaskSort.ts`'s `duration`) and the cell it orders (the
 * board's Duration column) can never disagree about what counts as "no answer".
 */
export function elapsedMs(startedAt: string | undefined, deliveredAt: string | undefined): number | null {
  if (!startedAt || !deliveredAt) return null
  const ms = Date.parse(deliveredAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/**
 * A span of time as the TWO largest non-zero units — "1h 2min" (EN: "1h 2m"), never "1h 0min 2s".
 * For the board's Duration column (`deliveredAt − startedAt`), distinct from `fmtDuration` above
 * (which has its own callers and stays exactly as it was).
 *
 * `null` in, `null` out — a caller that cannot compute the span (or that computed something
 * negative or non-finite, which is bad data rather than "no answer") renders that as `NA`, never a
 * confident but wrong duration. `null` is not zero: the same rule this codebase applies to every
 * unmeasurable figure.
 */
export function fmtElapsed(ms: number, lang: 'pt' | 'en'): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return lang === 'pt' ? '<1min' : '<1m'
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 1) return lang === 'pt' ? `${totalMinutes}min` : `${totalMinutes}m`
  const totalDays = Math.floor(totalHours / 24)
  if (totalDays < 1) {
    const m = totalMinutes % 60
    const h = `${totalHours}h`
    return m === 0 ? h : lang === 'pt' ? `${h} ${m}min` : `${h} ${m}m`
  }
  const h = totalHours % 24
  const d = `${totalDays}d`
  return h === 0 ? d : `${d} ${h}h`
}

export function fmtCost(usd: number, currency: 'USD' | 'BRL' = 'USD', rate = 1): string {
  if (currency === 'BRL') {
    const brl = usd * rate
    // Exactly zero (a local/offline model — see isLocalModelId) is a different fact from "some
    // real but sub-cent amount" and must read differently: '<R$0,05' on a genuinely free session
    // reads as "cheap", not "free", and hides the one signal a user has for spotting local-only
    // usage in a cost breakdown.
    if (brl === 0) return 'R$0,00'
    if (brl < 0.05) return '<R$0,05'
    const [intPart, decPart] = brl.toFixed(2).split('.')
    return `R$${(intPart ?? '0').replace(/\B(?=(\d{3})+$)/g, '.')},${decPart}`
  }
  if (usd === 0) return 'USD 0.00'
  if (usd < 0.01) return '<USD 0.01'
  const [intPart, decPart] = usd.toFixed(2).split('.')
  return `USD ${(intPart ?? '0').replace(/\B(?=(\d{3})+$)/g, ',')}.${decPart}`
}

/**
 * Human-readable label for a session: its title if set, otherwise the first prompt with
 * Claude's local-command/command wrappers stripped (those show up as noisy
 * `<local-command-caveat>…` blocks that make untitled sessions look broken). Returns '' when
 * there's nothing usable, so callers can supply their own localized placeholder.
 */
export function sessionLabel(s: { user_label?: string; title?: string; first_prompt?: string }): string {
  // The user's own name wins over everything: being able to name a session is worth nothing if the
  // harness's generated title then displaces it.
  const own = (s.user_label ?? '').trim()
  if (own) return own
  const title = (s.title ?? '').trim()
  if (title) return title
  return cleanPromptText(s.first_prompt ?? '')
}

/**
 * A first prompt with the harness's own wrappers removed (`<local-command-…>` / `<command-…>`
 * blocks, any other tag) and whitespace collapsed. The ONE reading of "what the person typed" —
 * `sessionLabel` falls back to it and `promptTitle` derives a stored title from it, so the label a
 * list shows and the title a native session is given can never strip different things.
 */
export function cleanPromptText(prompt: string): string {
  return prompt
    .replace(/<local-command-[a-z]*>[\s\S]*?<\/local-command-[a-z]*>/gi, ' ')
    .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How long a derived title may be, in characters, ellipsis included. */
export const PROMPT_TITLE_MAX = 60

/** A prompt that is ONLY a slash command — exactly one `/word` token (`/clear`, `/plugin:skill`). */
const ONLY_SLASH_COMMAND = /^\/[\w:.-]+$/

/**
 * A DETERMINISTIC title for a session, derived from its first prompt with no model call: the same
 * prompt always yields the same title. Steps, in this order:
 *
 * 1. `cleanPromptText` — the same stripping `sessionLabel` does.
 * 2. `redactSecrets` — BEFORE the cut, so a key is replaced whole rather than cut to a prefix the
 *    redactor no longer recognises and then shown. A pasted credential never becomes a title.
 * 3. Cap at `max` characters, cutting on a WORD boundary and ending in `…`; a single word longer
 *    than the cap is cut hard (there is no boundary to cut on).
 *
 * An empty prompt, or one that is only a slash command, has nothing to name the session by and
 * yields `fallback` — callers pass something neutral and stable, such as the creation time.
 */
export function promptTitle(prompt: string, fallback: string, max = PROMPT_TITLE_MAX): string {
  const cleaned = cleanPromptText(typeof prompt === 'string' ? prompt : '')
  if (cleaned === '' || ONLY_SLASH_COMMAND.test(cleaned)) return fallback
  const safe = redactSecrets(cleaned)
  const limit = Math.max(2, Math.floor(max))
  if (safe.length <= limit) return safe
  const room = safe.slice(0, limit - 1)
  const space = room.lastIndexOf(' ')
  const cut = space > 0 ? room.slice(0, space) : room
  return `${cut.replace(/[\s,.;:!?-]+$/, '')}…`
}

/**
 * The neutral fallback for `promptTitle`: `Session YYYY-MM-DD HH:MM UTC`, read straight off an ISO
 * timestamp so it does not depend on the clock or the zone of whoever computes it. A value that is
 * not an ISO timestamp yields plain `Session`.
 */
export function sessionTimeTitle(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(typeof iso === 'string' ? iso : '')
  return m ? `Session ${m[1]} ${m[2]} UTC` : 'Session'
}

export function fmtFull(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function fmtCostFull(usd: number, currency: 'USD' | 'BRL' = 'USD', rate = 1): string {
  if (currency === 'BRL') {
    const brl = usd * rate
    if (brl === 0) return 'R$0,000000'
    if (brl < 0.00001) return '<R$0,00001'
    const [intPart, decPart] = brl.toFixed(6).split('.')
    return `R$${(intPart ?? '0').replace(/\B(?=(\d{3})+$)/g, '.')},${decPart}`
  }
  if (usd === 0) return 'USD 0.000000'
  if (usd < 0.000001) return '<USD 0.000001'
  return `USD ${usd.toFixed(6)}`
}
