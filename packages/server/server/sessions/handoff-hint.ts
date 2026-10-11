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
}

export interface HandoffHint {
  id: string
  level: 1 | 2
  tokens: number
  fraction: number
}

/** Leader means the explicit registry role OR the user-visible title convention. */
export function isLeaderRow(row: Pick<HandoffHintRow, 'title' | 'leader'>): boolean {
  return row.leader === true || /^(?:\[ LEADER \]|\[ LÍDER \]|Líder)/.test(row.title)
}

/** Select at most the next level for each row; persistence makes this safe across polls/processes. */
export function planHandoffHints(rows: readonly HandoffHintRow[], nowLevel = 0): HandoffHint[] {
  void nowLevel
  return rows.flatMap(row => {
    if (!isLeaderRow(row) || !Number.isFinite(row.contextTokens) || row.contextTokens! < 0) return []
    const tokens = row.contextTokens!
    const fraction = row.contextWindow && row.contextWindow > 0 ? tokens / row.contextWindow : 0
    const crossed = tokens >= HANDOFF_HINT_DEFAULT_TOKENS || fraction >= HANDOFF_HINT_DEFAULT_FRACTION
    if (!crossed) return []
    const previous = row.hintedLevel ?? 0
    const level: 1 | 2 = previous < 1
      ? 1
      : tokens >= HANDOFF_HINT_DEFAULT_TOKENS + HANDOFF_HINT_REMINDER_DELTA ? 2 : 1
    if (level <= previous) return []
    return [{ id: row.id, level, tokens, fraction }]
  })
}

export function handoffHintText(hint: HandoffHint): string {
  const n = Math.round(hint.tokens / 1_000)
  const pct = Math.round(hint.fraction * 100)
  return `Seu contexto passou de ${n}k tokens (${pct}% da janela). Para economizar, prepare a passagem: escreva o handoff e abra a sessão sucessora (handoff:true).`
}

export interface HandoffHintDeps {
  rows: () => Promise<readonly HandoffHintRow[]>
  prompt: (id: string, text: string) => Promise<{ ok: boolean }>
  hintedLevel: (id: string) => Promise<number>
  markHinted: (id: string, level: number) => Promise<boolean>
}

/** Sends through the same prompt path as agentistics_session_message, with an agentistics sender. */
export async function sendHandoffHints(deps: HandoffHintDeps): Promise<number> {
  let sent = 0
  for (const row of await deps.rows().catch(() => [])) {
    const level = await deps.hintedLevel(row.id).catch(() => row.hintedLevel ?? 0)
    const [hint] = planHandoffHints([{ ...row, hintedLevel: level }])
    if (!hint) continue
    const result = await deps.prompt(row.id, `[from agentistics · question]\n${handoffHintText(hint)}`).catch(() => ({ ok: false }))
    if (!result.ok) continue
    if (await deps.markHinted(row.id, hint.level).catch(() => false)) sent++
  }
  return sent
}
