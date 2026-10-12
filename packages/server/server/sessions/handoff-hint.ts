/** LEADER.HANDOFF.HINT — one low-noise suggestion as a leader approaches context limits. */

export const HANDOFF_HINT_DEFAULT_TOKENS = 150_000
export const HANDOFF_HINT_DEFAULT_FRACTION = 0.35
export const HANDOFF_HINT_REMINDER_DELTA = 50_000

export interface HandoffHintRow {
  id: string
  title: string
  leader?: boolean
  contextTokens?: number
  contextWindow?: number
  hintedLevel?: number
  /** Context size when the last hint was sent; the next reminder is +50k after it. */
  hintedTokens?: number
}

export interface HandoffHint {
  id: string
  level: number
  tokens: number
  fraction: number
}

/** Leader means the explicit registry role OR the user-visible title convention. */
export function isLeaderRow(row: Pick<HandoffHintRow, 'title' | 'leader'>): boolean {
  return row.leader === true || /^(?:\[ LEADER \]|\[ LÍDER \]|Líder)/.test(row.title)
}

/** Level 1 at the first crossing, then one reminder for every further +50k over the last hint. */
export function planHandoffHints(rows: readonly HandoffHintRow[]): HandoffHint[] {
  return rows.flatMap(row => {
    if (!isLeaderRow(row) || !Number.isFinite(row.contextTokens) || row.contextTokens! < 0) return []
    const tokens = row.contextTokens!
    const fraction = row.contextWindow && row.contextWindow > 0 ? tokens / row.contextWindow : 0
    const crossed = tokens >= HANDOFF_HINT_DEFAULT_TOKENS || fraction >= HANDOFF_HINT_DEFAULT_FRACTION
    if (!crossed) return []
    const previous = row.hintedLevel ?? 0
    if (previous >= 1) {
      const since = row.hintedTokens ?? HANDOFF_HINT_DEFAULT_TOKENS
      if (tokens < since + HANDOFF_HINT_REMINDER_DELTA) return []
    }
    return [{ id: row.id, level: previous + 1, tokens, fraction }]
  })
}

/** `awayNote` is `awayHandoffNote` (@agentistics/core): while the owner is away the hint says so, so the
 *  predecessor writes it into the hand-off file — the successor's briefing carries it too. */
export function handoffHintText(hint: HandoffHint, awayNote = ''): string {
  const n = Math.round(hint.tokens / 1_000)
  const pct = Math.round(hint.fraction * 100)
  return `Seu contexto passou de ${n}k tokens (${pct}% da janela). Para economizar, prepare a passagem: escreva o handoff e abra a sessão sucessora (handoff:true).${awayNote}`
}

export interface HandoffHintDeps {
  rows: () => Promise<readonly HandoffHintRow[]>
  prompt: (id: string, text: string) => Promise<{ ok: boolean }>
  /** The persisted state, read fresh. */
  hinted: (id: string) => Promise<{ level: number; tokens?: number }>
  /** Persists the state; returns false when it could not be written. */
  markHinted: (id: string, level: number, tokens: number | undefined) => Promise<boolean>
  /** The away-mode sentence to append (empty when the owner is not away). Optional: absent = none. */
  awayNote?: () => Promise<string>
}

const inFlight = new Set<string>()

/**
 * Sends through the same prompt path as agentistics_session_message. The level is MARKED BEFORE the
 * send (and put back if the send fails), so two overlapping runs can never both deliver one level.
 */
export async function sendHandoffHints(deps: HandoffHintDeps): Promise<number> {
  let sent = 0
  for (const row of await deps.rows().catch(() => [])) {
    if (inFlight.has(row.id)) continue
    // The row carries the state as the caller last read it. A hint that state does not call for is
    // not called for by a fresher one either (a level only moves up, bar a failed send putting it
    // back, which the next run then sees) — so only a row that MAY get a hint pays the fresh read.
    // It used to be one full registry read per fleet row per fleet build (PERF.IDLE).
    if (planHandoffHints([row]).length === 0) continue
    inFlight.add(row.id)
    try {
      const prev = await deps.hinted(row.id).catch(() => ({ level: row.hintedLevel ?? 0, tokens: row.hintedTokens }))
      const [hint] = planHandoffHints([{ ...row, hintedLevel: prev.level, hintedTokens: prev.tokens }])
      if (!hint) continue
      if (!(await deps.markHinted(row.id, hint.level, hint.tokens).catch(() => false))) continue
      const awayNote = await (deps.awayNote?.() ?? Promise.resolve('')).catch(() => '')
      const result = await deps.prompt(row.id, `[from agentistics · question]\n${handoffHintText(hint, awayNote)}`).catch(() => ({ ok: false }))
      if (result.ok) sent++
      else await deps.markHinted(row.id, prev.level, prev.tokens).catch(() => false)
    } finally {
      inFlight.delete(row.id)
    }
  }
  return sent
}
