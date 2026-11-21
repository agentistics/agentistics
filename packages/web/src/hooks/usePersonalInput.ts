/**
 * usePersonalInput — the person's pointer and keys into THEIR OWN browser (NAVEGADOR S10 r3).
 * The same socket and protocol `useBrowserInput` speaks, with one difference that is the whole point: the
 * personal door asks for the owner's grant, offered as a SUB-PROTOCOL (`agentop-personal, <grant>`) — never in
 * the URL. It is a sibling of `useBrowserInput` rather than a parameter on it only because that file belongs to
 * another slice (S5c) in flight; fold the two once it lands.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { browserAckReducer, type BrowserAckState } from '../lib/terminalInput'
import { browserInputUrl, type BrowserInput, type BrowserInputEvent } from './useBrowserScreen'
import { PERSONAL_GRANT_PROTOCOL } from '../lib/personalGrant'

export function usePersonalInput(tab: string | null, grant: string | null, open: boolean): BrowserInput {
  const wsRef = useRef<WebSocket | null>(null)
  const seq = useRef(1)
  const [ready, setReady] = useState(false)
  const [acks, setAcks] = useState<BrowserAckState>({ inFlight: 0, lastRefusal: null })
  useEffect(() => {
    if (!open || !grant) { setReady(false); return }
    let ws: WebSocket
    try { ws = new WebSocket(browserInputUrl('personal', tab, window.location.protocol, window.location.host), [PERSONAL_GRANT_PROTOCOL, grant]) } catch { return }
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
  }, [tab, grant, open])
  const send = useCallback((ev: BrowserInputEvent) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ ...ev, seq: seq.current++ }))
    setAcks(s => browserAckReducer(s, { type: 'sent' }))
  }, [])
  return { send, ready, acks }
}
