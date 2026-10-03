/**
 * useNativeSession — one native Agentistics session, live (UI.3). Modelled on `useTerminalStream`:
 * the pure reducer lives in `lib/nativeChat.ts`; this hook owns the I/O.
 *
 * - **The window** (`GET …/messages`) on open, and again after any frame that means the persisted
 *   conversation has news (`needsWindowRefresh`) — debounced, so a burst of tool events is one read.
 * - **The stream** (`GET …/stream`, SSE). On a drop it reconnects from the cursor after the last frame
 *   applied (`?from=`), so nothing is replayed into the view twice (the reducer also drops a frame it
 *   has seen) and nothing is lost: a gap the hub could not replay is a `gap` frame, answered by a
 *   window read.
 * - **Acts**: send (shown at once, pending), answer a question, stop the run in flight. A refusal is
 *   the engine's own sentence, kept in `state.notice`.
 */
import { uploadPreviewUrl } from '../lib/nativeAttachments'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import {
  INITIAL_NATIVE_CHAT,
  nativeChatReducer,
  needsWindowRefresh,
  parseNativeFrame,
  streamFromSeq,
  type NativeChatState,
  type NativeWindow,
} from '../lib/nativeChat'
import { approveUrl, cancelUrl, effortUrl, execIdOf, messagesUrl, modelUrl, refusalSentence, runsUrl, streamUrl, windowUrl } from '../lib/nativeSession'
import { parseRuns, type RunLineView } from '../lib/nativeRuns'

const REFRESH_DEBOUNCE_MS = 250
const RECONNECT_MS = 1500

/** One upload in the chat attachment store, as the composer holds it before sending. */
export interface NativeUpload { name: string; mediaType: string; size: number }

export interface NativeSession {
  state: NativeChatState
  /** H6: one line per run (tokens, cost, cache share, the context gauge); re-read with the window. */
  runs: RunLineView[]
  /** `null` while the first window read is in flight; a sentence when it failed (not found, …). */
  loadError: string | null
  /** UI follow-up 3: `attachments` are uploads already in the chat attachment store (stored names). */
  send: (text: string, attachments?: readonly NativeUpload[]) => Promise<boolean>
  answer: (questionId: string, a: { choice?: number; text?: string }) => Promise<void>
  stop: () => Promise<void>
  /** H24: switch the model for the next runs; `null` when done, else the engine's sentence. */
  switchModel: (model: string) => Promise<string | null>
  /** B9.1: set the reasoning effort for the next runs; `null` when done, else the engine's sentence. */
  setEffort: (effort: 'low' | 'medium' | 'high' | 'off') => Promise<string | null>
}

export function useNativeSession(id: string, lang: 'pt' | 'en'): NativeSession {
  const [state, dispatch] = useReducer(nativeChatReducer, INITIAL_NATIVE_CHAT)
  const stateRef = useRef(state)
  stateRef.current = state
  const loadErrorRef = useRef<string | null>(null)
  const [, force] = useReducer((n: number) => n + 1, 0)

  const runsRef = useRef<RunLineView[]>([])
  const readRuns = useCallback(async () => {
    try {
      const res = await fetch(runsUrl(id))
      if (!res.ok) return
      runsRef.current = parseRuns(await res.json().catch(() => null))
      force()
    } catch { /* the lines are a reading aid; a failed read keeps the last ones */ }
  }, [id])

  const readWindow = useCallback(async () => {
    void readRuns()
    try {
      const res = await fetch(windowUrl(id))
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        loadErrorRef.current = refusalSentence(body, res.status, lang)
        force()
        return
      }
      loadErrorRef.current = null
      dispatch({ type: 'window', window: body as NativeWindow })
    } catch {
      loadErrorRef.current = lang === 'pt' ? 'Erro de rede ao ler a sessão.' : 'Network error reading the session.'
      force()
    }
  }, [id, lang, readRuns])

  // the window, debounced
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => { void readWindow() }, REFRESH_DEBOUNCE_MS)
  }, [readWindow])

  useEffect(() => {
    void readWindow()
    return () => { if (refreshTimer.current) clearTimeout(refreshTimer.current) }
  }, [readWindow])

  // the stream, reconnecting from the cursor
  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let alive = true
    const open = () => {
      if (!alive) return
      es = new EventSource(streamUrl(id, streamFromSeq(stateRef.current)))
      es.onmessage = e => {
        const frame = parseNativeFrame(String(e.data))
        if (!frame) return
        dispatch({ type: 'frame', frame })
        if (needsWindowRefresh(frame)) scheduleRefresh()
        if (frame.kind === 'closed') { es?.close(); es = null }
      }
      es.onerror = () => {
        es?.close()
        es = null
        if (alive) retry = setTimeout(open, RECONNECT_MS)
      }
    }
    open()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [id, scheduleRefresh])

  const send = useCallback(async (text: string, attachments: readonly NativeUpload[] = []): Promise<boolean> => {
    const clientRef = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    dispatch({
      type: 'sent', clientRef, text,
      ...(attachments.length ? { attachments: attachments.map(a => ({ url: uploadPreviewUrl(a.name), mediaType: a.mediaType, name: a.name })) } : {}),
    })
    try {
      const res = await fetch(messagesUrl(id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRef, text, ...(attachments.length ? { attachments: attachments.map(a => a.name) } : {}) }),
      })
      const body = await res.json().catch(() => null) as { status?: string; sentence?: string } | null
      if (!res.ok || body?.status === 'refused') {
        dispatch({ type: 'send-failed', clientRef, sentence: refusalSentence(body, res.status, lang) })
        return false
      }
      scheduleRefresh()
      return true
    } catch {
      dispatch({ type: 'send-failed', clientRef, sentence: lang === 'pt' ? 'Erro de rede ao enviar.' : 'Network error sending.' })
      return false
    }
  }, [id, lang, scheduleRefresh])

  const answer = useCallback(async (questionId: string, a: { choice?: number; text?: string }) => {
    try {
      const res = await fetch(approveUrl(id, execIdOf(questionId)), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId, ...a }),
      })
      if (!res.ok) dispatch({ type: 'notice', sentence: refusalSentence(await res.json().catch(() => null), res.status, lang) })
    } catch {
      dispatch({ type: 'notice', sentence: lang === 'pt' ? 'Erro de rede ao responder.' : 'Network error answering.' })
    }
  }, [id, lang])

  const stop = useCallback(async () => {
    const runId = stateRef.current.runId
    if (!runId) return
    try {
      const res = await fetch(cancelUrl(id, runId), { method: 'POST' })
      if (!res.ok) dispatch({ type: 'notice', sentence: refusalSentence(await res.json().catch(() => null), res.status, lang) })
    } catch {
      dispatch({ type: 'notice', sentence: lang === 'pt' ? 'Erro de rede ao parar.' : 'Network error stopping.' })
    }
  }, [id, lang])

  const switchModel = useCallback(async (model: string): Promise<string | null> => {
    try {
      const res = await fetch(modelUrl(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) })
      if (!res.ok) return refusalSentence(await res.json().catch(() => null), res.status, lang)
      void readWindow()
      return null
    } catch {
      return lang === 'pt' ? 'Erro de rede ao trocar o modelo.' : 'Network error switching the model.'
    }
  }, [id, lang, readWindow])

  const setEffort = useCallback(async (effort: 'low' | 'medium' | 'high' | 'off'): Promise<string | null> => {
    try {
      const res = await fetch(effortUrl(id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effort }) })
      if (!res.ok) return refusalSentence(await res.json().catch(() => null), res.status, lang)
      void readWindow()
      return null
    } catch {
      return lang === 'pt' ? 'Erro de rede ao mudar o esforço de raciocínio.' : 'Network error changing the reasoning effort.'
    }
  }, [id, lang, readWindow])

  return { state, runs: runsRef.current, loadError: loadErrorRef.current, send, answer, stop, switchModel, setEffort }
}
