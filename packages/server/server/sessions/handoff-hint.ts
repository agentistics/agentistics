/** LEADER.HANDOFF.HINT / WHY — low-noise handoff timing and its explainable numbers. */
import { getModelPrice, hasModelPrice } from '@agentistics/core'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const HANDOFF_HINT_DEFAULT_FRACTION = 0.25
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
  cwd?: string
  /** Assistant responses so far — what `g` grows per. */
  calls?: number
  /** Past leaders' context after ~15 calls: the samples behind F. */
  baseSamples?: readonly number[]
  /** The owner's latest message in this session has no reply yet: never hint over it. */
  ownerWaiting?: boolean
}

export interface HandoffFile { path: string; bytes: number }
type HandoffCacheEntry = { at: number; value?: HandoffFile }
const handoffCache = new Map<string, HandoffCacheEntry>()
const HANDOFF_CACHE_MS = 30_000

/** Find the newest fixed-location handoff file without reading its contents. */
export async function findHandoffFile(cwd?: string): Promise<HandoffFile | undefined> {
  if (!cwd) return undefined
  const cached = handoffCache.get(cwd)
  if (cached && Date.now() - cached.at < HANDOFF_CACHE_MS) return cached.value
  const candidates = [join(cwd, 'leader', 'HANDOFF.md'), join(cwd, 'HANDOFF.md'), join(cwd, 'docs', 'HANDOFF.md')]
  try {
    for (const name of await readdir(join(cwd, 'leader'))) {
      if (/HANDOFF.*\.md$/i.test(name)) candidates.push(join(cwd, 'leader', name))
    }
  } catch { /* no leader directory */ }
  let newest: { path: string; bytes: number; mtimeMs: number } | undefined
  for (const path of new Set(candidates)) {
    try {
      const info = await stat(path)
      if (info.isFile() && (!newest || info.mtimeMs > newest.mtimeMs)) newest = { path, bytes: info.size, mtimeMs: info.mtimeMs }
    } catch { /* missing or inaccessible candidate */ }
  }
  const value = newest ? { path: newest.path, bytes: newest.bytes } : undefined
  handoffCache.set(cwd, { at: Date.now(), value })
  return value
}

export interface HandoffHint {
  id: string
  level: number
  tokens: number
  fraction: number
  /** The context size at which this row is told to hand off (`handoffThreshold`). */
  threshold?: number
  why?: HandoffWhy
}

/**
 * HANDOFF.CALC (owner 16/10). The earlier math priced a successor at the hand-off file's bytes/4 + 2k,
 * which is not what a successor costs: measured 16/10, one starts at ~63k (system prompt, tools,
 * memory, briefing) and sits at ~95–110k once it has read the hand-off and caught up (10–20 calls).
 * The hint at 153k said "break-even: 1 answer" and the successor got ~50k of useful context.
 *
 * The model, in CACHE-READ token units (every call re-reads the whole context from cache, so a call
 * at size x costs ≈ x; the price only scales the result):
 *  - F — the successor's base: the median context of past leaders after their first ~15 calls
 *    (`ManagedSession.handoffBaseTokens`), 100k with no samples;
 *  - H — the hand-off's one-off overhead: the cache WRITE of F (≈12.5× a read), the ~15 ramp calls
 *    at ≈F, and ~3 calls at the current size C to write the hand-off;
 *  - g — this session's context growth per call.
 * A session that starts at F and grows by g per call spends, over n calls, nF + g·n²/2 + H; the
 * average per productive call is minimal at n = sqrt(2H/g), i.e. at a size T* = F + sqrt(2·H·g).
 * The hint never fires below max(F + 100k, 25 % of the window): a hand-off must buy real room.
 */
export const HANDOFF_FALLBACK_BASE_TOKENS = 100_000
export const HANDOFF_RAMP_CALLS = 15
export const HANDOFF_WRITE_CALLS = 3
export const CACHE_WRITE_TO_READ = 12.5
export const HANDOFF_MIN_GAIN_TOKENS = 100_000
export const HANDOFF_DEFAULT_GROWTH = 1_300
/** What any session holds before its first call (system prompt, tools, memory) — measured ~63k. */
export const SESSION_START_TOKENS = 60_000

/** H in cache-read token units, for a successor base F and a current size C. */
export function handoffOverheadTokens(base: number, current: number): number {
  return CACHE_WRITE_TO_READ * base + HANDOFF_RAMP_CALLS * base + HANDOFF_WRITE_CALLS * current
}

/** g: measured from the session's own size and call count; the default when there is too little. */
export function growthPerCall(row: Pick<HandoffHintRow, 'contextTokens' | 'calls'>): { g: number; measured: boolean } {
  const c = row.contextTokens, n = row.calls
  if (Number.isFinite(c) && Number.isFinite(n) && n! >= 5 && c! > SESSION_START_TOKENS) {
    return { g: (c! - SESSION_START_TOKENS) / n!, measured: true }
  }
  return { g: HANDOFF_DEFAULT_GROWTH, measured: false }
}

/** T* = F + sqrt(2·H·g). */
export function handoffTargetTokens(base: number, g: number, current: number): number {
  return base + Math.sqrt(2 * handoffOverheadTokens(base, current) * g)
}

/** The size the hint fires at: T*, floored by F + 100k and by the default fraction of the window. */
export function handoffThreshold(base: number, g: number, current: number, window?: number): number {
  const floor = Math.max(base + HANDOFF_MIN_GAIN_TOKENS, window && window > 0 ? HANDOFF_HINT_DEFAULT_FRACTION * window : 0)
  return Math.max(handoffTargetTokens(base, g, current), floor)
}

/** F from the samples: their median, or the fallback with none. */
export function successorBase(samples: readonly number[] = []): { tokens: number; samples: number } {
  const ok = samples.filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (ok.length === 0) return { tokens: HANDOFF_FALLBACK_BASE_TOKENS, samples: 0 }
  const mid = Math.floor(ok.length / 2)
  return { tokens: ok.length % 2 ? ok[mid]! : (ok[mid - 1]! + ok[mid]!) / 2, samples: ok.length }
}

export interface HandoffWhy {
  contextTokens?: number
  turnsDone?: number
  avgCostPerTurnUSD?: number
  projectedTurns?: number
  estimated?: boolean
  /** F, and how many past leaders it was measured on (0 = the 100k fallback). */
  successorBaseTokens: number
  successorBaseSamples: number
  /** H, in cache-read tokens. */
  overheadTokens?: number
  /** g, and whether it was measured on this session. */
  growthPerCall?: number
  growthMeasured?: boolean
  /** T* and the size the hint fires at (T* floored). */
  targetTokens?: number
  thresholdTokens?: number
  /** C − F: what each answer costs less after the hand-off. */
  gainPerCallTokens?: number
  gainPerCallUSD?: number
  costContinueUSD?: number
  costSuccessorUSD?: number
  breakEvenTurns?: number
  savingsUSD?: number
  workInFlight: string[]
  successor?: { handoffPath?: string }
}

export interface HandoffWhyDeps {
  /** The model used for the session; absent means the price is unknown. */
  model?: string
  /** Average completed turns of prior leader sessions, when available. */
  pastLeaderTurns?: readonly number[]
  /** Contexts of past leaders after their first ~15 calls (`ManagedSession.handoffBaseTokens`). */
  baseSamples?: readonly number[]
  /** A known handoff file. Its size is part of F (the successor reads it), never priced on its own. */
  handoffPath?: string
  handoffBytes?: number
  workInFlight?: readonly string[]
}

/** Pure, deliberately omission-preserving explanation of why (and when) a leader handoff helps. */
export function computeHandoffWhy(row: HandoffHintRow, deps: HandoffWhyDeps = {}): HandoffWhy {
  const base = successorBase(deps.baseSamples ?? row.baseSamples)
  const out: HandoffWhy = {
    workInFlight: [...(deps.workInFlight ?? row.workInFlight ?? [])],
    successorBaseTokens: base.tokens,
    successorBaseSamples: base.samples,
  }
  if (Number.isFinite(row.contextTokens)) out.contextTokens = row.contextTokens
  if (Number.isFinite(row.turns)) out.turnsDone = row.turns
  const model = deps.model ?? row.model
  const price = model && hasModelPrice(model) ? getModelPrice(model).cacheRead : undefined
  const measured = Number.isFinite(row.turns) && row.turns! > 0 && Number.isFinite(row.costUSD)
    ? row.costUSD! / row.turns! : undefined
  const perTurn = price !== undefined && Number.isFinite(row.contextTokens)
    ? row.contextTokens! / 1_000_000 * price : undefined
  const avg = measured ?? perTurn
  if (avg !== undefined) out.avgCostPerTurnUSD = avg
  const samples = (deps.pastLeaderTurns ?? []).filter(n => Number.isFinite(n) && n > 0)
  const projected = samples.length ? samples.reduce((a, n) => a + n, 0) / samples.length : 40
  out.projectedTurns = Math.round(projected)
  if (!samples.length) out.estimated = true
  if (deps.handoffPath !== undefined) out.successor = { handoffPath: deps.handoffPath }
  if (!Number.isFinite(row.contextTokens)) return out
  const c = row.contextTokens!
  const { g, measured: gMeasured } = growthPerCall(row)
  const h = handoffOverheadTokens(base.tokens, c)
  out.overheadTokens = Math.round(h)
  out.growthPerCall = Math.round(g)
  out.growthMeasured = gMeasured
  out.targetTokens = Math.round(handoffTargetTokens(base.tokens, g, c))
  out.thresholdTokens = Math.round(handoffThreshold(base.tokens, g, c, row.contextWindow))
  const gain = c - base.tokens
  if (gain > 0) {
    out.gainPerCallTokens = Math.round(gain)
    out.breakEvenTurns = Math.ceil(h / gain)
    if (price !== undefined) out.gainPerCallUSD = gain / 1_000_000 * price
  }
  if (price !== undefined) {
    const turns = out.projectedTurns!
    out.costContinueUSD = turns * c / 1_000_000 * price
    out.costSuccessorUSD = (h + turns * base.tokens) / 1_000_000 * price
    out.savingsUSD = Math.max(0, out.costContinueUSD - out.costSuccessorUSD)
  }
  return out
}

/** Leader means the explicit registry role OR the user-visible title convention. */
export function isLeaderRow(row: Pick<HandoffHintRow, 'title' | 'leader'>): boolean {
  return row.leader === true || /^(?:\[ LEADER \]|\[ LÍDER \]|Líder)/.test(row.title)
}

/**
 * Level 1 when the context crosses `handoffThreshold`, then one reminder for every further +50k over
 * the last hint. Only while the leader's turn is IDLE and the owner has no unanswered message: a hint
 * typed into a working turn, or right after the owner asked something, is how an answer got
 * swallowed on 16/10 (HANDOFF.RELAY).
 */
export function planHandoffHints(rows: readonly HandoffHintRow[]): HandoffHint[] {
  return rows.flatMap(row => {
    if (!isLeaderRow(row) || !Number.isFinite(row.contextTokens) || row.contextTokens! < 0) return []
    const tokens = row.contextTokens!
    const fraction = row.contextWindow && row.contextWindow > 0 ? tokens / row.contextWindow : 0
    const base = successorBase(row.baseSamples).tokens
    const threshold = handoffThreshold(base, growthPerCall(row).g, tokens, row.contextWindow)
    if (tokens < threshold) return []
    const inFlight = row.workInFlight?.length || row.activity === 'working' || row.state === 'working'
    if (inFlight || row.ownerWaiting) return []
    const previous = row.hintedLevel ?? 0
    if (previous >= 1) {
      const since = row.hintedTokens ?? threshold
      if (tokens < since + HANDOFF_HINT_REMINDER_DELTA) return []
    }
    return [{ id: row.id, level: previous + 1, tokens, fraction, threshold: Math.round(threshold) }]
  })
}

const k = (n: number) => `${Math.round(n / 1_000)}k`

/** `awayNote` is `awayHandoffNote` (@agentistics/core): while the owner is away the hint says so, so the
 *  predecessor writes it into the hand-off file — the successor's briefing carries it too. */
export function handoffHintText(hint: HandoffHint, awayNote = ''): string {
  const pct = Math.round(hint.fraction * 100)
  const why = hint.why
  let numbers = ''
  if (why && why.targetTokens !== undefined) {
    const f = `F ≈ ${k(why.successorBaseTokens)} (${why.successorBaseSamples > 0 ? `mediana de ${why.successorBaseSamples} líderes após ~15 chamadas` : 'estimado, sem amostras'})`
    const gain = why.gainPerCallTokens !== undefined
      ? `; ganho ≈ ${k(why.gainPerCallTokens)} tokens${why.gainPerCallUSD !== undefined ? ` (US$ ${why.gainPerCallUSD.toFixed(2)})` : ''} por resposta, equilíbrio em ${why.breakEvenTurns} respostas`
      : ''
    numbers = ` Sucessor começa em ${f}; passagem custa H ≈ ${k(why.overheadTokens ?? 0)} tokens de cache; ponto ótimo T* = F + √(2·H·g) ≈ ${k(why.targetTokens)} (g ≈ ${((why.growthPerCall ?? 0) / 1_000).toFixed(1)}k/chamada)${gain}.`
  }
  return `Hora de passar a liderança: contexto ${k(hint.tokens)} tokens (${pct}% do limite).${numbers} Prepare a passagem e abra a sessão sucessora (handoff:true).${awayNote}`
}

export interface HandoffHintDeps {
  rows: () => Promise<readonly HandoffHintRow[]>
  prompt: (id: string, text: string) => Promise<{ ok: boolean }>
  /** The persisted state, read fresh. */
  hinted: (id: string) => Promise<{ level: number; tokens?: number }>
  /** Persists the state; returns false when it could not be written. */
  markHinted: (id: string, level: number, tokens: number | undefined) => Promise<boolean>
  /** The away-mode sentence to append (empty when the owner is not away). Optional: absent = none. */
  awayNote?: (id: string) => Promise<string>
  /** Read fresh right before sending: the owner's latest message has no reply yet. Absent = never. */
  ownerWaiting?: (id: string) => Promise<boolean>
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
      const awayNote = await (deps.awayNote?.(row.id) ?? Promise.resolve('')).catch(() => '')
      const handoff = row.handoffPath !== undefined || row.handoffBytes !== undefined
        ? { path: row.handoffPath, bytes: row.handoffBytes }
        : await findHandoffFile(row.cwd)
      if (deps.ownerWaiting && await deps.ownerWaiting(row.id).catch(() => false)) {
        await deps.markHinted(row.id, prev.level, prev.tokens).catch(() => false)
        continue
      }
      const detailed = { ...hint, why: computeHandoffWhy(row, {
        model: row.model,
        ...(handoff ? { handoffPath: handoff.path, handoffBytes: handoff.bytes } : {}),
      }) }
      const result = await deps.prompt(row.id, `[from agentistics · question]\n${handoffHintText(detailed, awayNote)}`).catch(() => ({ ok: false }))
      if (result.ok) sent++
      else await deps.markHinted(row.id, prev.level, prev.tokens).catch(() => false)
    } finally {
      inFlight.delete(row.id)
    }
  }
  return sent
}
