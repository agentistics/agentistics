/**
 * sessionWaits — DSL.ACORDAR: the "aguardando X até Y" line of a session row.
 *
 * ONE poll for the whole list (never one per row), only while some row is mounted. The server answers every open
 * wait still waiting, one per owner (`GET /api/flows/waits`). Flows off (403) or a community build (501) = no
 * line, and the poll slows to a rare re-check. A wait is a line of its own: it never changes the row's state word,
 * never makes it "working" and never asks for a person.
 */
import { useSyncExternalStore } from 'react'

export interface SessionWaitLine { sessionId: string; waitId: string; describe: string; deadlineAt: string }

const POLL_MS = 30_000
const OFF_POLL_MS = 5 * 60_000

let lines: ReadonlyMap<string, SessionWaitLine> = new Map()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

/** PURE. The server's answer as a map by owner session id; anything malformed is dropped. */
export function parseWaitLines(body: unknown): Map<string, SessionWaitLine> {
  const out = new Map<string, SessionWaitLine>()
  const list = body && typeof body === 'object' && Array.isArray((body as { waits?: unknown }).waits) ? (body as { waits: unknown[] }).waits : []
  for (const w of list) {
    if (!w || typeof w !== 'object') continue
    const r = w as Record<string, unknown>
    if (typeof r.sessionId !== 'string' || typeof r.waitId !== 'string' || typeof r.describe !== 'string' || typeof r.deadlineAt !== 'string') continue
    out.set(r.sessionId, { sessionId: r.sessionId, waitId: r.waitId, describe: r.describe, deadlineAt: r.deadlineAt })
  }
  return out
}

/** PURE. The line itself: "aguardando handback de 3f5f… até 14:30" (the date too when it is not today). */
export function waitLineText(w: SessionWaitLine, lang: 'pt' | 'en', now = new Date()): string {
  const d = new Date(w.deadlineAt)
  const sameDay = d.toDateString() === now.toDateString()
  const locale = lang === 'pt' ? 'pt-BR' : 'en-US'
  const when = sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  return lang === 'pt' ? `aguardando ${w.describe} até ${when}` : `waiting for ${w.describe} until ${when}`
}

const same = (a: ReadonlyMap<string, SessionWaitLine>, b: ReadonlyMap<string, SessionWaitLine>) =>
  a.size === b.size && [...a].every(([k, v]) => { const o = b.get(k); return o && o.waitId === v.waitId && o.deadlineAt === v.deadlineAt && o.describe === v.describe })

async function poll(): Promise<void> {
  let next = POLL_MS
  try {
    const r = await fetch('/api/flows/waits', { cache: 'no-store' })
    if (r.ok) {
      const fresh = parseWaitLines(await r.json())
      if (!same(fresh, lines)) { lines = fresh; for (const l of listeners) l() }
    } else {
      next = OFF_POLL_MS
      if (lines.size) { lines = new Map(); for (const l of listeners) l() }
    }
  } catch { /* offline: keep the last answer */ }
  if (listeners.size) timer = setTimeout(() => { void poll() }, next)
  else timer = null
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  if (!timer) timer = setTimeout(() => { void poll() }, 0)
  return () => {
    listeners.delete(fn)
    if (!listeners.size && timer) { clearTimeout(timer); timer = null }
  }
}

const snapshot = () => lines

/** The open wait of one session (null = none, flows off, or not loaded yet). */
export function useSessionWait(sessionId: string | undefined): SessionWaitLine | null {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot)
  return sessionId ? all.get(sessionId) ?? null : null
}
