/**
 * NativeSessionChat — the chat of a NATIVE Agentistics session (UI.3). Its own component, not a
 * branch of `SessionChat` (that one reads a harness's transcript and a terminal; this one reads the
 * runtime's window and its canonical events — `useNativeSession` / `lib/nativeChat.ts`). It REUSES
 * the pieces: `ChatBubble` for text, `WorkingNote` while the run works, the composer's shell, field,
 * microphone and send button, the stop button's look, and `ApprovalCard`'s look
 * (`NativeApprovalCard`). New: `ToolCallCard`.
 *
 * Attachments (UI follow-up 3): the composer takes images — and PDFs where the session's provider
 * does — by the paperclip, a paste or a drop, each checked against what that provider DECLARES
 * (`GET /api/runtime/sessions/:id` → `attachments`, `refuseFile`) before it is uploaded through the
 * host's chat attachment store; the message carries the stored names and the engine attaches the
 * bytes. No declaration, no paperclip: a provider that takes none is never offered one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader, Square } from 'lucide-react'
import { ChatBubble } from './ChatBubble'
import { WorkingNote } from './WorkingNote'
import { ToolCallCard } from './ToolCallCard'
import { NativeApprovalCard } from './NativeApprovalCard'
import { NativeRunsStrip } from './NativeRunsStrip'
import { NativeModelSwitch } from './NativeModelSwitch'
import { NativeEffortSwitch } from './NativeEffortSwitch'
import { NativeReasoning } from './NativeReasoning'
import { ComposerAttachButton, ComposerAttachments, ComposerMicButton, ComposerSendButton, ComposerShell, ComposerToolbar, composerFieldStyle } from '../chat/ComposerShell'
import { acceptOf, mediaTypeOf, refuseFile, uploadPreviewUrl, type NativeAttachmentCapability } from '../../lib/nativeAttachments'
import type { NativeAttachmentView } from '../../lib/nativeChat'
import { hasSomethingToSend, stopShown } from '../../lib/composerAction'
import { nativeChatItems } from '../../lib/nativeChat'
import { NATIVE_HARNESS_ID } from '../../lib/nativeSession'
import type { NativeSession, NativeUpload } from '../../hooks/useNativeSession'
import { useDictation } from '../../hooks/useDictation'
import { useIsCoarsePointer } from '../../hooks/useIsMobile'

/** `live` is the page's `useNativeSession` — one stream per session, read by the header too. */
export function NativeSessionChat({ live, lang }: { live: NativeSession; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const { state, runs, loadError, send, answer, stop, switchModel, setEffort } = live
  const items = useMemo(() => nativeChatItems(state), [state])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [uploads, setUploads] = useState<NativeUpload[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const sessionId = state.window?.session.sessionId
  const cap = useAttachmentCapability(sessionId)
  const s0 = state.window?.session
  const providerLabel = s0 ? (s0.provider === 'openai-compatible' ? s0.credential?.id ?? s0.provider : s0.provider === 'anthropic' ? 'Anthropic' : s0.provider) : ''
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
  const showStop = stopShown({ working: state.running, stopEnabled: state.runId !== undefined, draft, attachments: uploads.length })
  const something = hasSomethingToSend({ draft, attachments: uploads.length })

  /** Each file judged against the provider's declaration, then uploaded to the chat attachment store. */
  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0 || !sessionId) return
    setUploading(true)
    let held = uploads
    for (const file of files) {
      const why = refuseFile(cap ?? null, { name: file.name, type: file.type, size: file.size }, held.map(u => ({ name: u.name, type: u.mediaType, size: u.size })), providerLabel, lang)
      if (why) { setNotice(why); continue }
      const body = new FormData()
      body.append('file', file)
      body.append('session', sessionId)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; name?: string; message?: string }
        if (json.ok && json.name) {
          held = [...held, { name: json.name, mediaType: mediaTypeOf(file)!, size: file.size }]
          setUploads(held)
        } else setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const doSend = async () => {
    const text = draft.trim()
    if ((!text && uploads.length === 0) || sending || uploading) return
    dictation.end()
    setSending(true)
    setDraft('')
    const sent = uploads
    setUploads([])
    const ok = await send(text, sent)
    if (!ok) {
      setDraft(d => (d === '' ? text : d))
      setUploads(u => (u.length === 0 ? sent : u))
    }
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
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '16px 14px' }}
      >
        {/* The same 820 px column `SessionChat` centres its bubbles and composer in — on a wide screen
            it also keeps the composer clear of the Nay button in the corner. */}
        <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
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
            // The live text is NOT `provisional`: that is the fleet's "read from the screen" scrape. Here
            // it is the model's own stream, and it gives way to the persisted message (lib/nativeChat).
            const bubble = <ChatBubble key={i.key} turn={i.turn} lang={lang} harness={NATIVE_HARNESS_ID}
              {...(i.turn.role === 'user' && i.turn.pending ? { awaiting: true, awaitingWorking: state.running } : {})} />
            if (i.attachments?.length) {
              return (
                <div key={i.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <SentAttachments items={i.attachments} pt={pt} />
                  {i.turn.text.trim() !== '' && bubble}
                </div>
              )
            }
            if (!i.stopped) return bubble
            return (
              <div key={i.key} data-testid="stopped-answer" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                {bubble}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-tertiary)', paddingLeft: 4 }}>
                  <Square size={9} fill="currentColor" />
                  {pt ? 'Parada por você — a resposta acima ficou incompleta.' : 'Stopped by you — the answer above is incomplete.'}
                </span>
              </div>
            )
          }
          if (i.kind === 'reasoning') return <NativeReasoning key={i.key} text={i.text} {...(i.live ? { live: true } : {})} lang={lang} />
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
      </div>

      {shownNotice && (
        <div role="alert" style={{ maxWidth: 820, width: 'calc(100% - 28px)', boxSizing: 'border-box', margin: '0 auto 8px', padding: '8px 10px', borderRadius: 9, background: 'var(--accent-red-dim, rgba(239,68,68,0.12))', color: 'var(--accent-red)', fontSize: 12.5, overflowWrap: 'anywhere' }}>
          {shownNotice}
        </div>
      )}

      {state.window && (
        <div style={{ maxWidth: 820, width: 'calc(100% - 28px)', margin: '0 auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, minWidth: 0 }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <NativeModelSwitch model={state.window.session.model} provider={state.window.session.provider} running={state.running} lang={lang} onSwitch={switchModel} />
          </div>
          <NativeEffortSwitch effort={state.window.session.effort ?? 'off'} running={state.running} lang={lang} onSet={setEffort} />
        </div>
      )}
      <NativeRunsStrip runs={runs} lang={lang} />

      <div style={{ padding: '0 12px 12px', maxWidth: 844, width: '100%', margin: '0 auto', boxSizing: 'border-box' }}>
        <ComposerShell dimmed={state.closed}>
          <ComposerAttachments
            items={uploads.map(u => ({ name: u.name, path: u.name }))}
            pt={pt}
            isImage={name => uploads.find(u => u.name === name)?.mediaType.startsWith('image/') ?? false}
            imageSrc={uploadPreviewUrl}
            onOpenImage={name => window.open(uploadPreviewUrl(name), '_blank', 'noopener')}
            onRemove={name => setUploads(u => u.filter(x => x.name !== name))}
          />
          {cap && (
            <input ref={fileRef} type="file" multiple hidden accept={acceptOf(cap)} data-testid="native-attach-input"
              onChange={e => void addFiles(Array.from(e.target.files ?? []))} />
          )}
          <textarea
            onPaste={e => {
              const files = Array.from(e.clipboardData.files)
              if (files.length === 0) return
              e.preventDefault()
              void addFiles(files)
            }}
            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
            onDrop={e => {
              if (e.dataTransfer.files.length === 0) return
              e.preventDefault()
              void addFiles(Array.from(e.dataTransfer.files))
            }}
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
            {cap && (
              <ComposerAttachButton onClick={() => fileRef.current?.click()} disabled={state.closed} uploading={uploading}
                label={cap.pdf ? (pt ? 'Anexar imagem ou PDF' : 'Attach an image or PDF') : (pt ? 'Anexar imagem' : 'Attach an image')} />
            )}
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
                <ComposerSendButton onClick={() => void doSend()} disabled={sending || uploading || !something || state.closed} sending={sending} active={something && !state.closed} label={pt ? 'Enviar' : 'Send'} />
              )}
            </div>
          </ComposerToolbar>
        </ComposerShell>
      </div>
    </div>
  )
}

/** What the session's provider declares it takes as attachments; null when none, undefined while asked. */
function useAttachmentCapability(sessionId: string | undefined): NativeAttachmentCapability | null | undefined {
  const [cap, setCap] = useState<NativeAttachmentCapability | null | undefined>(undefined)
  useEffect(() => {
    if (!sessionId) return
    let alive = true
    fetch(`/api/runtime/sessions/${encodeURIComponent(sessionId)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((b: { attachments?: NativeAttachmentCapability | null } | null) => { if (alive) setCap(b?.attachments ?? null) })
      .catch(() => { if (alive) setCap(null) })
    return () => { alive = false }
  }, [sessionId])
  return cap
}

/** A sent message's attachments: image thumbnails that open, PDFs as a chip that opens. */
function SentAttachments({ items, pt }: { items: readonly NativeAttachmentView[]; pt: boolean }) {
  return (
    <div data-testid="native-sent-attachments" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
      {items.map(a => (
        <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" title={a.name}
          aria-label={pt ? `Abrir ${a.name || 'anexo'}` : `Open ${a.name || 'attachment'}`}
          style={a.mediaType.startsWith('image/')
            ? { display: 'block', width: 120, height: 90, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-elevated)' }
            : { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontSize: 12, textDecoration: 'none', maxWidth: 220 }}
        >
          {a.mediaType.startsWith('image/')
            ? <img src={a.url} alt={a.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : <><FileText size={13} style={{ flexShrink: 0 }} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name.replace(/^[0-9a-f]{8}-/, '') || 'PDF'}</span></>}
        </a>
      ))}
    </div>
  )
}
