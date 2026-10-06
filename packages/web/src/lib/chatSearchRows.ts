/**
 * chatSearchRows.ts — PURE: one "Buscar na conversa" result as the panel draws it.
 *
 * WHO SAID IT is named the way the chat names it: `Você`/`You` for the person, the harness's own
 * label and colour (`HARNESS_LABELS`/`HARNESS_COLORS`, the bubble's) for the assistant. WHEN is
 * `messageTime` — the bubble's own stamp, the hour today and a date beyond — so the row and the
 * bubble it leads to can never disagree about the time. The EXCERPT is cut into plain and marked
 * segments here, so the component only maps them to spans and never slices strings itself.
 */

import type { ChatSearchHit, ChatSearchSpan } from '@agentistics/core'
import { HARNESS_COLORS, HARNESS_LABELS } from './harness'
import { messageTime, type MessageTime } from './messageTime'

export interface ChatSearchSegment { text: string; mark: boolean }

export interface ChatSearchRow {
  key: string
  mine: boolean
  /** `Você` or the harness's label. */
  who: string
  /** The harness colour for an assistant row; absent for the person's own. */
  color?: string
  time: MessageTime | null
  segments: ChatSearchSegment[]
}

/** The excerpt, cut at its highlights. Out-of-range or overlapping spans are clamped, never thrown. */
export function excerptSegments(excerpt: string, highlights: readonly ChatSearchSpan[]): ChatSearchSegment[] {
  const out: ChatSearchSegment[] = []
  let at = 0
  for (const h of [...highlights].sort((a, b) => a.start - b.start)) {
    const s = Math.max(at, Math.min(excerpt.length, h.start))
    const e = Math.max(s, Math.min(excerpt.length, h.end))
    if (s > at) out.push({ text: excerpt.slice(at, s), mark: false })
    if (e > s) out.push({ text: excerpt.slice(s, e), mark: true })
    at = e
  }
  if (at < excerpt.length) out.push({ text: excerpt.slice(at), mark: false })
  return out
}

export function chatSearchRow(
  hit: ChatSearchHit,
  harness: string | undefined,
  lang: 'pt' | 'en',
  nowMs: number = Date.now(),
): ChatSearchRow {
  const mine = hit.role === 'user'
  const h = harness ?? ''
  const label = (HARNESS_LABELS as Record<string, string>)[h] ?? (h || (lang === 'pt' ? 'Assistente' : 'Assistant'))
  const color = (HARNESS_COLORS as Record<string, string>)[h]
  return {
    key: `${hit.index}`,
    mine,
    who: mine ? (lang === 'pt' ? 'Você' : 'You') : label,
    ...(!mine && color ? { color } : {}),
    time: messageTime(hit.at, lang, nowMs),
    segments: excerptSegments(hit.excerpt, hit.highlights),
  }
}

/** What the result menu offers, in order. Every entry always enabled: a refusal is SAID on pick. */
export type ChatSearchAction = 'copy' | 'forward' | 'goto'

export function chatSearchMenu(lang: 'pt' | 'en'): Array<{ action: ChatSearchAction; label: string; enabled: true }> {
  const pt = lang === 'pt'
  return [
    { action: 'copy', label: pt ? 'Copiar' : 'Copy', enabled: true },
    { action: 'forward', label: pt ? 'Encaminhar' : 'Forward', enabled: true },
    { action: 'goto', label: pt ? 'Ir até a mensagem' : 'Go to message', enabled: true },
  ]
}
