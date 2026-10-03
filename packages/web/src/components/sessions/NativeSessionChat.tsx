/**
 * NativeSessionChat — the chat of a NATIVE Agentistics session (UI.3). Its own component, not a
 * branch of `SessionChat` (that one reads a harness's transcript and a terminal; this one reads the
 * runtime's window and its canonical events — `useNativeSession` / `lib/nativeChat.ts`). It REUSES
 * the pieces: `ChatBubble` for text, `WorkingNote` while the run works, the composer's shell, field,
 * microphone and send button, the stop button's look, and `ApprovalCard`'s look
 * (`NativeApprovalCard`). New: `ToolCallCard`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader, Square } from 'lucide-react'
import { ChatBubble } from './ChatBubble'
import { WorkingNote } from './WorkingNote'
import { ToolCallCard } from './ToolCallCard'
import { NativeApprovalCard } from './NativeApprovalCard'
import { ComposerMicButton, ComposerSendButton, ComposerShell, ComposerToolbar, composerFieldStyle } from '../chat/ComposerShell'
import { hasSomethingToSend, stopShown } from '../../lib/composerAction'
import { nativeChatItems } from '../../lib/nativeChat'
import { NATIVE_HARNESS_ID } from '../../lib/nativeSession'
import type { NativeSession } from '../../hooks/useNativeSession'
import { useDictation } from '../../hooks/useDictation'
import { useIsCoarsePointer } from '../../hooks/useIsMobile'

/** `live` is the page's `useNativeSession` — one stream per session, read by the header too. */
export function NativeSessionChat({ live, lang }: { live: NativeSession; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const { state, loadError, send, answer, stop } = live
  const items = useMemo(() => nativeChatItems(state), [state])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const coarse = useIsCoarsePointer()
  const editDraft = useCallback((f: (d: string) => string) => setDraft(f), [])
  const dictation = useDictation(lang, editDraft, setNotice)

  // follow the conversation while the person is at its end
  const scrollRef = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [items])

  useEffect(() => { if (!state.running) setStopping(false) }, [state.running])

  const awaiting = items.some(i => (i.kind === 'tool' && i.card.ask) || i.kind === 'approval')
  const liveText = items.some(i => i.kind === 'turn' && i.key === 'live')
  const runningTools = items.flatMap(i => (i.kind === 'tool' && i.card.status === 'running' ? [{ name: i.card.name, ...(i.card.detail ? { detail: i.card.detail } : {}) }] : []))
  const showWorking = state.running && !awaiting && !liveText
  const showStop = stopShown({ working: state.running, stopEnabled: state.runId !== undefined, draft, attachments: 0 })
  const something = hasSomethingToSend({ draft, attachments: 0 })

  const doSend = async () => {
    const text = draft.trim()
    if (!text || sending) return
    dictation.end()
    setSending(true)
    setDraft('')
    const ok = await send(text)
    if (!ok) setDraft(d => (d === '' ? text : d))
    setSending(false)
  }
  const doStop = async () => {
    setStopping(true)
    await stop()
  }

  const shownNotice = notice ?? state.notice ?? loadError
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
      <div
        ref={scrollRef}
        onScroll={e => { const el = e.currentTarget; atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '16px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        {state.window === null && !loadError && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-tertiary)', fontSize: 12.5 }}>
            <Loader size={14} className="ag-working-spin" /> {pt ? 'Abrindo a sessão…' : 'Opening the session…'}
          </div>
        )}
        {state.window !== null && items.length === 0 && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', margin: 'auto 0' }}>
            {pt ? 'Sessão pronta. Escreva a primeira mensagem.' : 'Session ready. Write the first message.'}
          </div>
        )}
        {items.map(i => {
          if (i.kind === 'turn') {
            return <ChatBubble key={i.key} turn={i.turn} lang={lang} harness={NATIVE_HARNESS_ID}
              {...(i.key === 'live' ? { provisional: true } : {})}
              {...(i.turn.role === 'user' && i.turn.pending ? { awaiting: true, awaitingWorking: state.running } : {})} />
          }
          if (i.kind === 'tool') {
            return (
              <div key={i.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                <ToolCallCard card={i.card} lang={lang} />
                {i.card.ask && <NativeApprovalCard ask={i.card.ask} lang={lang} onAnswer={a => answer(i.card.ask!.questionId, a)} />}
              </div>
            )
          }
          return <NativeApprovalCard key={i.key} ask={i.ask} lang={lang} onAnswer={a => answer(i.ask.questionId, a)} />
        })}
        {showWorking && <WorkingNote lang={lang} {...(runningTools.length > 0 ? { tools: runningTools } : {})} />}
      </div>

      {shownNotice && (
        <div role="alert" style={{ margin: '0 14px 8px', padding: '8px 10px', borderRadius: 9, background: 'var(--accent-red-dim, rgba(239,68,68,0.12))', color: 'var(--accent-red)', fontSize: 12.5, overflowWrap: 'anywhere' }}>
          {shownNotice}
        </div>
      )}

      <div style={{ padding: '0 12px 12px' }}>
        <ComposerShell dimmed={state.closed}>
          <textarea
            value={draft}
            onChange={e => { setDraft(e.target.value); if (notice) setNotice(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) { e.preventDefault(); void doSend() }
            }}
            rows={2}
            placeholder={pt ? 'Mensagem para o Agentistics…' : 'Message Agentistics…'}
            aria-label={pt ? 'Mensagem' : 'Message'}
            style={composerFieldStyle}
          />
          <ComposerToolbar>
            {dictation.ready && (
              <ComposerMicButton onClick={dictation.toggle} disabled={state.closed} listening={dictation.listening}
                label={dictation.listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')} />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              {showStop ? (
                <button
                  type="button"
                  onClick={() => void doStop()}
                  disabled={stopping}
                  title={pt ? 'Parar' : 'Stop'}
                  aria-label={pt ? 'Parar' : 'Stop'}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, borderRadius: 9, flexShrink: 0,
                    border: 'none', cursor: stopping ? 'default' : 'pointer', background: 'var(--accent-red)', color: '#fff',
                  }}
                >
                  {stopping ? <Loader size={14} className="ag-working-spin" /> : <Square size={13} fill="currentColor" />}
                </button>
              ) : (
                <ComposerSendButton onClick={() => void doSend()} disabled={sending || !something || state.closed} sending={sending} active={something && !state.closed} label={pt ? 'Enviar' : 'Send'} />
              )}
            </div>
          </ComposerToolbar>
        </ComposerShell>
      </div>
    </div>
  )
}
