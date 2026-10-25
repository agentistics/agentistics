/** The real steps a "yes" goes through on the server (`server/away-digest.ts` `AwayDigestPhase`). */
export type AwayDigestPhase = 'collect' | 'prepare' | 'send' | 'writing'
export const AWAY_DIGEST_PHASES: readonly AwayDigestPhase[] = ['collect', 'prepare', 'send', 'writing']

export const AWAY_DIGEST_PHASE_LABEL: Record<AwayDigestPhase, { pt: string; en: string }> = {
  collect: { pt: 'Recolhendo tarefas e sessões…', en: 'Collecting tasks and sessions…' },
  prepare: { pt: 'Preparando o resumo…', en: 'Preparing the summary…' },
  send: { pt: 'Enviando para a Nay…', en: 'Sending to Nay…' },
  writing: { pt: 'Nay está escrevendo…', en: 'Nay is writing…' },
}

export interface AwayDigestAnswerResult { ok: boolean; conversationId?: string; status: number; answerStarted?: boolean; needsLogin?: boolean }

type StreamLine = { phase?: AwayDigestPhase; done?: boolean; result?: { ok: boolean; conversationId?: string; error?: string }; answerStarted?: boolean; needsLogin?: boolean }

/** Applies one NDJSON line; returns the final answer when the line is the last one. Pure, for tests. */
export function readDigestLine(line: string, onPhase: (p: AwayDigestPhase) => void): AwayDigestAnswerResult | null {
  if (!line.trim()) return null
  let parsed: StreamLine
  try { parsed = JSON.parse(line) as StreamLine } catch { return null }
  if (parsed.phase && (AWAY_DIGEST_PHASES as readonly string[]).includes(parsed.phase)) onPhase(parsed.phase)
  if (!parsed.done || !parsed.result) return null
  const r = parsed.result
  const status = r.ok ? 200 : r.error === 'stale' || r.error === 'not_away' ? 409 : 400
  return { ok: r.ok, status, conversationId: r.conversationId, ...(parsed.answerStarted !== undefined ? { answerStarted: parsed.answerStarted } : {}), ...(parsed.needsLogin ? { needsLogin: true } : {}) }
}

/**
 * Answers the offer. With `onPhase`, the server streams each step as it starts (NDJSON) and the call
 * resolves once Nay's answer has started (or the server gave up waiting); without it, one JSON answer.
 */
export async function answerAwayDigest(
  answer: 'yes' | 'no', bucket: unknown, since: unknown, lang: 'pt' | 'en', onPhase?: (p: AwayDigestPhase) => void,
): Promise<AwayDigestAnswerResult> {
  const response = await fetch('/api/away/digest/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(onPhase ? { Accept: 'application/x-ndjson' } : {}) },
    body: JSON.stringify({ answer, bucket, since, lang }),
  })
  const streamed = onPhase && response.ok && (response.headers.get('content-type') ?? '').includes('application/x-ndjson') && response.body
  if (!streamed) {
    const body = await response.json().catch(() => ({})) as { conversationId?: string }
    return { conversationId: body.conversationId, ok: response.ok, status: response.status }
  }
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const lines = buffer.split('\n')
    buffer = done ? '' : lines.pop() ?? ''
    for (const line of lines) {
      const final = readDigestLine(line, onPhase)
      if (final) { void reader.cancel().catch(() => {}); return final }
    }
    if (done) break
  }
  // The stream ended without its last line: the server went away mid-answer.
  return { ok: false, status: 502 }
}
