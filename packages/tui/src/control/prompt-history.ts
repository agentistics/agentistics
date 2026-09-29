/**
 * prompt-history.ts — CD-18, PURE: the prompt-history overlay (`ctrl+r`, `/history`).
 *
 * A filter field over this machine's earlier prompts (`CodeHost.promptHistory`), newest first; ↑↓
 * select, `enter` puts the picked text back in the composer — it NEVER sends it: a prompt picked out
 * of history is one somebody means to edit, and a history that fires a months-old instruction on a
 * keypress is a history nobody dares open. Prototype: `ovHist`.
 */

import { COLORS } from '../theme'
import { cellWidth, editDraft, fitLine, lr, sanitize, seg, truncateCells, type CodeKey, type Line } from './code'
import type { CodeStrings } from './code-i18n'
import type { CodePromptRecord } from './code-types'

export interface HistoryState {
  query: string
  /** Index into the FILTERED list. */
  sel: number
  /** `null` while the host is still reading. */
  prompts: CodePromptRecord[] | null
  /** The host's refusal, in its words. */
  error: string | null
}

export const openHistory = (): HistoryState => ({ query: '', sel: 0, prompts: null, error: null })

/**
 * The prompts matching `query` (case-insensitive, whitespace-insensitive), NEWEST FIRST. The host
 * already answers newest first; the sort is stable and only reorders what carries a readable date,
 * so a record without one keeps the place the host gave it.
 */
export function filterPrompts(prompts: readonly CodePromptRecord[], query: string): CodePromptRecord[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  const hit = prompts.filter(p => !q || p.text.toLowerCase().replace(/\s+/g, ' ').includes(q))
  return hit
    .map((p, i) => ({ p, i, at: Date.parse(p.at) }))
    .sort((a, b) => (Number.isFinite(a.at) && Number.isFinite(b.at) ? b.at - a.at : 0) || a.i - b.i)
    .map(x => x.p)
}

export type HistoryEffect = { kind: 'none' } | { kind: 'close' } | { kind: 'use'; text: string }

/** One key on the overlay. Typing filters; ↑↓ move; enter uses the pick; esc closes. */
export function historyKey(state: HistoryState, k: CodeKey): { state: HistoryState; effect: HistoryEffect } {
  const list = filterPrompts(state.prompts ?? [], state.query)
  if (k.escape) return { state, effect: { kind: 'close' } }
  if (k.return) {
    const pick = list[Math.min(state.sel, list.length - 1)]
    return pick ? { state, effect: { kind: 'use', text: pick.text } } : { state, effect: { kind: 'none' } }
  }
  if (k.upArrow) return { state: { ...state, sel: Math.max(0, state.sel - 1) }, effect: { kind: 'none' } }
  if (k.downArrow) return { state: { ...state, sel: Math.min(Math.max(0, list.length - 1), state.sel + 1) }, effect: { kind: 'none' } }
  const next = editDraft(state.query, k)
  if (next !== null && next !== state.query) return { state: { ...state, query: next, sel: 0 }, effect: { kind: 'none' } }
  return { state, effect: { kind: 'none' } }
}

/** `MM-DD HH:MM` on the local clock, or '' for an instant that does not parse. */
function stamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface HistoryLines {
  /** The filter field and a blank — fixed above the list. */
  head: Line[]
  /** One row per matching prompt, or the empty state in words. */
  body: Line[]
  /** The row the selection is on (for `windowOffset`), or null when the body is a sentence. */
  selected: number | null
  foot: Line[]
}

export function historyLines(state: HistoryState, t: CodeStrings, width: number): HistoryLines {
  const w = Math.max(0, width)
  const head: Line[] = [
    fitLine([seg('› ', { color: COLORS.text }), seg(sanitize(state.query), { color: COLORS.text }), seg('▍', { color: COLORS.accent })], w),
    [],
  ]
  const foot: Line[] = [[], fitLine([seg(t.histFoot, { color: COLORS.muted })], w)]
  const say = (text: string): HistoryLines => ({ head, body: [fitLine([seg(text, { color: COLORS.muted })], w)], selected: null, foot })
  if (state.error) return say(state.error)
  if (state.prompts === null) return say(t.histLoading)
  if (state.prompts.length === 0) return say(t.histNone)
  const list = filterPrompts(state.prompts, state.query)
  if (list.length === 0) return say(t.histNoMatch)
  const sel = Math.min(state.sel, list.length - 1)
  const body = list.map((p, i) => {
    const on = i === sel
    const text = sanitize(p.text).replace(/\s+/g, ' ').trim()
    const when = stamp(p.at)
    const room = Math.max(1, w - 2 - (when ? cellWidth(when) + 2 : 0))
    return lr(
      [seg(on ? '▸ ' : '  ', { color: COLORS.accent }), seg(truncateCells(text, room), { color: on ? COLORS.text : COLORS.label, bold: on })],
      when ? [seg(when, { color: COLORS.muted })] : [],
      w,
      2,
    )
  })
  return { head, body, selected: sel, foot }
}
