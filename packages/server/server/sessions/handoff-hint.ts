/** LEADER.HANDOFF.HINT / WHY — low-noise handoff timing and its explainable numbers. */
import { getModelPrice, hasModelPrice } from '@agentistics/core'

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
  model?: string
  turns?: number
  costUSD?: number
  activity?: 'working' | 'waiting' | 'waiting-approval' | 'exited'
  state?: 'working' | 'waiting' | 'waiting-approval' | 'exited' | 'closed'
  workInFlight?: string[]
  handoffPath?: string
  handoffBytes?: number
}

export interface HandoffHint {
  id: string
  level: number
  tokens: number
  fraction: number
  why?: HandoffWhy
}

export interface HandoffWhy {
  contextTokens?: number
  turnsDone?: number
  avgCostPerTurnUSD?: number
  projectedTurns?: number
  estimated?: boolean
  costContinueUSD?: number
  costSuccessorUSD?: number
  breakEvenTurns?: number
  savingsUSD?: number
  workInFlight: string[]
  successor?: { handoffPath?: string; handoffTokens?: number }
}

export interface HandoffWhyDeps {
  /** The model used for the session; absent means the price is unknown. */
  model?: string
  /** Average completed turns of prior leader sessions, when available. */
  pastLeaderTurns?: readonly number[]
  /** A known handoff file and its byte size. */
  handoffPath?: string
  handoffBytes?: number
  /** Fixed briefing overhead in tokens; defaults to the installed briefing's estimate. */
  briefingTokens?: number
  workInFlight?: readonly string[]
}

/** Pure, deliberately omission-preserving explanation of why a leader handoff helps. */
export function computeHandoffWhy(row: HandoffHintRow, deps: HandoffWhyDeps = {}): HandoffWhy {
  const out: HandoffWhy = { workInFlight: [...(deps.workInFlight ?? row.workInFlight ?? [])] }
  if (Number.isFinite(row.contextTokens)) out.contextTokens = row.contextTokens
  if (Number.isFinite(row.turns)) out.turnsDone = row.turns
  const model = deps.model ?? row.model
  // An unpriced model has no figure: omit the costs instead of showing a fake zero.
  const price = model && hasModelPrice(model) ? getModelPrice(model).cacheRead : undefined
  if (price !== undefined && Number.isFinite(row.contextTokens)) {
    const perTurn = row.contextTokens! / 1_000_000 * price
    const measured = Number.isFinite(row.turns) && row.turns! > 0 && Number.isFinite(row.costUSD)
      ? row.costUSD! / row.turns! : undefined
    out.avgCostPerTurnUSD = measured ?? perTurn
  }
  const samples = (deps.pastLeaderTurns ?? []).filter(n => Number.isFinite(n) && n > 0)
  const projected = samples.length ? samples.reduce((a, n) => a + n, 0) / samples.length : 40
  out.projectedTurns = Math.round(projected)
  if (!samples.length) out.estimated = true
  const handoffTokens = Number.isFinite(deps.handoffBytes)
    ? Math.ceil(deps.handoffBytes! / 4) + (deps.briefingTokens ?? 2_000) : undefined
  if (deps.handoffPath !== undefined || handoffTokens !== undefined) {
    out.successor = {
      ...(deps.handoffPath !== undefined ? { handoffPath: deps.handoffPath } : {}),
      ...(handoffTokens !== undefined ? { handoffTokens } : {}),
    }
  }
  if (price !== undefined && Number.isFinite(row.contextTokens)) {
    const turns = out.projectedTurns!
    const continueOne = row.contextTokens! / 1_000_000 * price
    const successorOne = handoffTokens !== undefined ? handoffTokens / 1_000_000 * price : undefined
    if (successorOne !== undefined) {
      out.costContinueUSD = turns * continueOne
      out.costSuccessorUSD = turns * successorOne
      const delta = continueOne - successorOne
      if (delta > 0) {
        out.breakEvenTurns = Math.ceil(successorOne / delta)
        out.savingsUSD = Math.max(0, out.costContinueUSD - out.costSuccessorUSD)
      }
    }
  }
  return out
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
    const hardCap = fraction >= HANDOFF_HINT_DEFAULT_FRACTION
    const inFlight = row.workInFlight?.length || row.activity === 'working' || row.state === 'working'
    if (inFlight && !hardCap) return []
    const previous = row.hintedLevel ?? 0
    if (previous >= 1) {
      const since = row.hintedTokens ?? HANDOFF_HINT_DEFAULT_TOKENS
      if (tokens < since + HANDOFF_HINT_REMINDER_DELTA) return []
    }
    return [{ id: row.id, level: previous + 1, tokens, fraction }]
  })
}

export function handoffHintText(hint: HandoffHint): string {
  const n = Math.round(hint.tokens / 1_000)
  const pct = Math.round(hint.fraction * 100)
  const why = hint.why
  const cost = why?.avgCostPerTurnUSD !== undefined ? ` Custo médio: ~US$ ${why.avgCostPerTurnUSD.toFixed(2)} por resposta.` : ''
  const breakEven = why?.breakEvenTurns !== undefined ? ` Ponto de equilíbrio: ${why.breakEvenTurns} respostas.` : ''
  return `Trocar agora pode economizar e deixar as respostas mais rápidas. Contexto: ${n}k tokens (${pct}% do limite).${cost}${breakEven} Prepare a passagem e abra a sessão sucessora (handoff:true).`
}

export interface HandoffHintDeps {
  rows: () => Promise<readonly HandoffHintRow[]>
  prompt: (id: string, text: string) => Promise<{ ok: boolean }>
  /** The persisted state, read fresh. */
  hinted: (id: string) => Promise<{ level: number; tokens?: number }>
  /** Persists the state; returns false when it could not be written. */
  markHinted: (id: string, level: number, tokens: number | undefined) => Promise<boolean>
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
      const detailed = { ...hint, why: computeHandoffWhy(row, { model: row.model }) }
      const result = await deps.prompt(row.id, `[from agentistics · question]\n${handoffHintText(detailed)}`).catch(() => ({ ok: false }))
      if (result.ok) sent++
      else await deps.markHinted(row.id, prev.level, prev.tokens).catch(() => false)
    } finally {
      inFlight.delete(row.id)
    }
  }
  return sent
}
