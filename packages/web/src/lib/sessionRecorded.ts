/**
 * lib/sessionRecorded.ts — LIVE.2's presentation, PURE. What a session surface may show from the journal
 * (the server's `ChatPayload.recorded` / `.attention`): NUMBERS about a conversation whose transcript is gone
 * (the owner's Q3: no turns, no tool summaries, no text) and the times a person was asked something.
 * Types mirror `server/sessions/chat-web.ts` (the web cannot import server code).
 */

export interface ChatAttentionMark {
  at: string
  kind: 'approval' | 'question' | 'select' | 'confirm' | 'unknown'
  via: 'screen' | 'acp'
  optionCount?: number
  how?: 'answered-here' | 'answered-elsewhere' | 'session-ended' | 'unknown'
  choice?: number
  blockedMs?: number
}

export interface ChatRecorded {
  firstAt: string | null
  lastAt: string | null
  turns: number
  toolCalls: number
  toolsFailed: number
  toolsDenied: number
  models: string[]
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null
}

/**
 * Marks go BEFORE the first turn dated after them; a mark after every dated turn goes to the end. A turn
 * with no time (`at` is never invented) cannot anchor one. Nothing is dropped.
 */
export function placeAttention(
  turns: ReadonlyArray<{ at?: string }>,
  marks: readonly ChatAttentionMark[],
): { before: Map<number, ChatAttentionMark[]>; after: ChatAttentionMark[] } {
  const before = new Map<number, ChatAttentionMark[]>()
  const after: ChatAttentionMark[] = []
  for (const m of [...marks].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    const i = turns.findIndex(t => t.at !== undefined && t.at > m.at)
    if (i < 0) { after.push(m); continue }
    const list = before.get(i) ?? []
    list.push(m)
    before.set(i, list)
  }
  return { before, after }
}

const ASKED = {
  en: { approval: 'Asked you to approve', question: 'Asked you a question', select: 'Asked you to choose', confirm: 'Asked you to confirm', unknown: 'Needed your attention' },
  pt: { approval: 'Pediu sua aprovação', question: 'Perguntou algo a você', select: 'Pediu uma escolha', confirm: 'Pediu uma confirmação', unknown: 'Precisou da sua atenção' },
} as const

const ENDED = {
  en: { 'answered-here': 'answered here', 'answered-elsewhere': 'answered elsewhere', 'session-ended': 'the session ended', unknown: 'closed' },
  pt: { 'answered-here': 'respondido aqui', 'answered-elsewhere': 'respondido em outro lugar', 'session-ended': 'a sessão terminou', unknown: 'encerrado' },
} as const

function waited(ms: number, pt: boolean): string {
  const s = Math.round(ms / 1000)
  const t = s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ''}`.trim() : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  return `${pt ? 'esperou' : 'waited'} ${t}`
}

export function attentionLine(m: ChatAttentionMark, pt: boolean): string {
  const L = pt ? 'pt' : 'en'
  const parts: string[] = [ASKED[L][m.kind]]
  parts.push(m.how ? ENDED[L][m.how] : (pt ? 'sem resposta aqui' : 'not answered here'))
  if (m.blockedMs !== undefined) parts.push(waited(m.blockedMs, pt))
  return parts.join(' · ')
}

const compact = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n))

export function recordedFigures(r: ChatRecorded, pt: boolean): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  out.push({ label: pt ? 'Interações' : 'Turns', value: String(r.turns) })
  const extra = [r.toolsFailed > 0 ? `${r.toolsFailed} ${pt ? 'falharam' : 'failed'}` : '', r.toolsDenied > 0 ? `${r.toolsDenied} ${pt ? 'negadas' : 'denied'}` : ''].filter(Boolean)
  out.push({ label: pt ? 'Chamadas de ferramenta' : 'Tool calls', value: `${r.toolCalls}${extra.length ? ` (${extra.join(', ')})` : ''}` })
  if (r.models.length > 0) out.push({ label: pt ? 'Modelos' : 'Models', value: r.models.join(', ') })
  if (r.tokens) {
    const t = r.tokens
    const bits = [t.input !== undefined ? `${compact(t.input)} ${pt ? 'entrada' : 'in'}` : '', t.output !== undefined ? `${compact(t.output)} ${pt ? 'saída' : 'out'}` : ''].filter(Boolean)
    if (bits.length > 0) out.push({ label: 'Tokens', value: bits.join(' · ') })
  }
  return out
}
