/**
 * useBrowserScreen / useBrowserInput — the glue between a browser screen on the page and the S4 channels
 * (NAVEGADOR S5).
 *
 * READ: `GET /api/browser/stream?owner=…&tab=…` through `openEventStream` (the stream mux — never a bare
 * EventSource). The stream is open ONLY while the surface is watching (in view, page visible): nobody
 * watching = no stream = the server stops the screencast. The last picture stays, and
 * `browserScreenStatus` says it is paused.
 *
 * WRITE: `WS /api/browser/input?owner=…&tab=…`, opened ONLY while `open` (the padlock is unlocked). Locked =
 * no socket exists, so nothing can be sent; the server still decides the padlock at every event.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { openEventStream, type EventStreamLike } from '../lib/streamMux'
import {
  INITIAL_BROWSER_SCREEN, browserScreenReducer, parseBrowserFrame, parseBrowserGone, parseBrowserState, type BrowserScreenState,
} from '../lib/browserStream'
import { browserAckReducer, type BrowserAckState, type BrowserInputOut } from '../lib/terminalInput'
import { sessionBrowserOf } from '../lib/browserCard'

export function browserStreamUrl(owner: string, tab: string | null): string {
  return `/api/browser/stream?owner=${encodeURIComponent(owner)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`
}

export function browserInputUrl(owner: string, tab: string | null, protocol: string, host: string): string {
  const proto = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${host}/api/browser/input?owner=${encodeURIComponent(owner)}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}`
}

export type OpenStream = (url: string) => EventStreamLike

export function useBrowserScreen(owner: string | null, tab: string | null, watching: boolean, open: OpenStream = openEventStream): BrowserScreenState {
  const [state, dispatch] = useReducer(browserScreenReducer, INITIAL_BROWSER_SCREEN)
  useEffect(() => { dispatch({ type: 'watching', watching }) }, [watching])
  useEffect(() => {
    if (!owner || !watching) return
    dispatch({ type: 'connecting' })
    const es = open(browserStreamUrl(owner, tab))
    const onFrame = (e: MessageEvent) => { const f = parseBrowserFrame(String(e.data)); if (f) dispatch({ type: 'frame', frame: f }) }
    const onState = (e: MessageEvent) => { const s = parseBrowserState(String(e.data)); if (s) dispatch({ type: 'state', state: s }) }
    const onGone = (e: MessageEvent) => { const r = parseBrowserGone(String(e.data)); if (r) dispatch({ type: 'gone', reason: r }) }
    es.addEventListener('frame', onFrame as EventListener)
    es.addEventListener('state', onState as EventListener)
    es.addEventListener('gone', onGone as EventListener)
    es.onerror = () => dispatch({ type: 'stall' })
    return () => {
      es.removeEventListener('frame', onFrame as EventListener)
      es.removeEventListener('state', onState as EventListener)
      es.removeEventListener('gone', onGone as EventListener)
      es.onerror = null
      es.close()
    }
  }, [owner, tab, watching, open])
  return state
}

/** How often a conversation asks the host whether its session has a browser open. */
export const BROWSER_STATUS_POLL_MS = 5_000

/**
 * Does this session have a LIVE browser? Read off `GET /api/browser/status` (the host's own snapshot, never
 * guessed), while the page is visible. A refusal (exposed profile, the switch off, an older server) = no.
 */
export function useSessionBrowserLive(managedId: string | null, poll = BROWSER_STATUS_POLL_MS): boolean {
  const [live, setLive] = useState(false)
  useEffect(() => {
    if (!managedId) { setLive(false); return }
    let stop = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      if (stop) return
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        try {
          const r = await fetch('/api/browser/status')
          const body = r.ok ? await r.json().catch(() => null) : null
          if (!stop) setLive(sessionBrowserOf(body, managedId) !== null)
        } catch { if (!stop) setLive(false) }
      }
      if (!stop) timer = setTimeout(() => void tick(), poll)
    }
    void tick()
    return () => { stop = true; if (timer) clearTimeout(timer) }
  }, [managedId, poll])
  return live
}

export type BrowserInputEvent = BrowserInputOut extends infer U ? U extends { seq: number } ? Omit<U, 'seq'> : never : never

export interface BrowserInput {
  send: (ev: BrowserInputEvent) => void
  ready: boolean
  acks: BrowserAckState
}

export function useBrowserInput(owner: string | null, tab: string | null, open: boolean): BrowserInput {
  const wsRef = useRef<WebSocket | null>(null)
  const seq = useRef(1)
  const [ready, setReady] = useState(false)
  const [acks, setAcks] = useState<BrowserAckState>({ inFlight: 0, lastRefusal: null })
  useEffect(() => {
    if (!owner || !open) { setReady(false); return }
    let ws: WebSocket
    try { ws = new WebSocket(browserInputUrl(owner, tab, window.location.protocol, window.location.host)) } catch { return }
    wsRef.current = ws
    seq.current = 1
    ws.onopen = () => setReady(true)
    ws.onmessage = (e: MessageEvent) => {
      try {
        const a = JSON.parse(typeof e.data === 'string' ? e.data : '') as { seq?: number; ok?: boolean; reason?: string }
        if (typeof a.seq === 'number' && typeof a.ok === 'boolean') {
          const ok = a.ok
          setAcks(s => browserAckReducer(s, { type: 'ack', ok, ...(a.reason ? { reason: a.reason } : {}) }))
        }
      } catch { /* not JSON: ignored */ }
    }
    ws.onclose = () => setReady(false)
    return () => {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try { ws.close() } catch { /* closing */ }
      wsRef.current = null
      setReady(false)
    }
  }, [owner, tab, open])
  const send = useCallback((ev: BrowserInputEvent) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ ...ev, seq: seq.current++ }))
    setAcks(s => browserAckReducer(s, { type: 'sent' }))
  }, [])
  return { send, ready, acks }
}
