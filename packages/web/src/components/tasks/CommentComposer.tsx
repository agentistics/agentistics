/**
 * CommentComposer — the field a comment is written in. It is the session composer's behaviour on a
 * comment: the same paste rules (`pastePlan.ts` — a clipboard FILE attaches, ordinary text types, a
 * paste past the limit becomes a `.txt` file), the same attachment cap, the same upload door
 * (`POST /api/fleet/attach`, which returns the `{name, path}` reference a chat message carries —
 * there is no second store), the same microphone (`useDictation` over `dictation.ts`), the same
 * drag-and-drop, and the same Enter rule (a software keyboard breaks the line; a hardware one sends).
 *
 * `SessionChat.tsx` keeps its own copy of the textarea wiring: that composer is welded to session
 * state (queued sends, dialogs, mentions, quote cards) and extracting it whole would be a rewrite of
 * a 3.700-line file for a field that needs a fraction of it. What IS shared is every rule above, so
 * the two cannot disagree about a limit or a paste.
 */

import { useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import type { ChatAttachmentRef } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { attachmentUrl } from '../../lib/attachmentUrl'
import { appendDictation } from '../../lib/dictation'
import { attachmentKind, isImageAttachment } from '../../lib/messageAttachments'
import { ComposerAttachButton, ComposerAttachments, ComposerMicButton, ComposerSendButton, ComposerShell, ComposerToolbar, composerFieldStyle } from '../chat/ComposerShell'
import { AttachmentLightbox } from '../sessions/AttachmentLightbox'
import { MAX_ATTACHMENTS, attachmentRoom, planPaste } from '../../lib/pastePlan'
import { useDictation } from '../../lib/useDictation'
import { surface } from './board'
import type { Lang } from './copy'

export function CommentComposer({ lang, value, onChange, attachments, onAttachments, ariaLabel, placeholder, submitLabel, busy, onSubmit, refusal }: {
  lang: Lang
  value: string
  onChange: (v: string) => void
  attachments: readonly ChatAttachmentRef[]
  onAttachments: (next: ChatAttachmentRef[]) => void
  ariaLabel: string
  placeholder: string
  submitLabel: string
  busy: boolean
  onSubmit: () => void
  refusal?: string | null
}) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const dictation = useDictation(lang, text => onChange(appendDictation(valueRef.current, text)))
  // Attachments change while uploads are in flight; the ref keeps the cap honest across awaits.
  const attachedRef = useRef(attachments)
  attachedRef.current = attachments

  async function upload(files: readonly File[]): Promise<void> {
    if (files.length === 0) return
    setUploading(true)
    for (const file of files) {
      if (attachedRef.current.length >= MAX_ATTACHMENTS) break
      const body = new FormData()
      body.append('file', file)
      try {
        const res = await fetch(`/api/fleet/attach?lang=${lang}`, { method: 'POST', body })
        const json = await res.json() as { ok: boolean; path?: string; name?: string; message?: string }
        if (json.ok && json.path && json.name) {
          attachedRef.current = [...attachedRef.current, { name: json.name, path: json.path }]
          onAttachments(attachedRef.current as ChatAttachmentRef[])
        } else {
          setNotice(json.message ?? (pt ? 'O anexo falhou.' : 'The attachment failed.'))
        }
      } catch {
        setNotice(pt ? 'Erro de rede ao enviar o anexo.' : 'Network error uploading the attachment.')
      }
    }
    setUploading(false)
  }

  function pick(list: readonly File[]): void {
    const room = attachmentRoom(attachedRef.current.length)
    if (list.length > room) {
      setNotice(pt ? `No máximo ${MAX_ATTACHMENTS} anexos por mensagem.` : `At most ${MAX_ATTACHMENTS} attachments per message.`)
    }
    void upload(list.slice(0, room))
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const plan = planPaste({
      files: Array.from(e.clipboardData.files),
      text: e.clipboardData.getData('text/plain'),
      existing: attachedRef.current.length,
    })
    if (plan.kind === 'text') return
    e.preventDefault()
    if (plan.kind === 'files') void upload(plan.files)
    if (plan.kind === 'textFile') {
      void upload([new File([plan.text], plan.name, { type: 'text/plain' })])
      setNotice(pt ? 'O texto colado era grande demais, então foi anexado como arquivo.' : 'The pasted text was too large, so it was attached as a file.')
    }
  }

  const canSend = !busy && !uploading && (value.trim() !== '' || attachments.length > 0)
  const send = () => { if (canSend) { dictation.stop(); onSubmit() } }
  const images = attachments.filter(a => isImageAttachment(a.path)).map(a => a.path)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Auto-grow, the way the session composer's field does (capped, then it scrolls).
  useEffect(() => {
    const t = taRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`
  }, [value])

  return (
    <div
      style={{ outline: dropping ? '1px dashed var(--anthropic-orange)' : 'none', borderRadius: 14, display: 'grid', gap: 6 }}
      onDragOver={e => { e.preventDefault(); setDropping(true) }}
      onDragLeave={() => setDropping(false)}
      onDrop={e => {
        e.preventDefault(); setDropping(false)
        pick(Array.from(e.dataTransfer?.files ?? []))
      }}
    >
      <ComposerShell dimmed={busy}>
        <input
          ref={fileRef} type="file" multiple style={{ display: 'none' }}
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; pick(files) }}
        />
        <ComposerAttachments
          items={attachments}
          pt={pt}
          isImage={isImageAttachment}
          imageSrc={attachmentUrl}
          onOpenImage={path => setLightbox(images.indexOf(path))}
          onRemove={path => onAttachments(attachments.filter(a => a.path !== path))}
        />
        <textarea
          ref={taRef}
          rows={1}
          value={value}
          aria-label={ariaLabel}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={e => {
            // Same rule as the session composer: Enter breaks the line on a phone, sends elsewhere.
            if (e.key === 'Enter' && !e.shiftKey && !isMobile && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
          }}
          style={{ ...composerFieldStyle, color: 'var(--text-primary)', minHeight: 36, maxHeight: 220 }}
        />
        <ComposerToolbar>
          <ComposerAttachButton
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            uploading={uploading}
            label={pt ? 'Anexar arquivo' : 'Attach file'}
          />
          {dictation.support.state === 'ready' && (
            <ComposerMicButton
              onClick={dictation.toggle}
              disabled={busy}
              listening={dictation.listening}
              label={dictation.listening ? (pt ? 'Parar de ouvir' : 'Stop listening') : (pt ? 'Ditar' : 'Dictate')}
            />
          )}
          <span style={{ flex: 1 }} />
          <ComposerSendButton
            onClick={send}
            disabled={!canSend}
            sending={busy}
            active={canSend}
            label={submitLabel}
          />
        </ComposerToolbar>
      </ComposerShell>
      {dictation.heard && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{dictation.heard}</div>
      )}
      {(notice || dictation.error) && (
        <div role="status" style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{notice ?? dictation.error}</div>
      )}
      {refusal && <div role="alert" style={{ fontSize: 12, color: 'var(--accent-red)' }}>{refusal}</div>}
      {lightbox !== null && lightbox >= 0 && (
        <AttachmentLightbox paths={images} index={lightbox} onIndexChange={setLightbox} onClose={() => setLightbox(null)} lang={lang} />
      )}
    </div>
  )
}

/** Attachments of a posted comment, inline in the thread: images as thumbnails, the rest as links. */
export function CommentAttachments({ attachments, lang }: { attachments: readonly ChatAttachmentRef[]; lang: Lang }) {
  const [open, setOpen] = useState<string | null>(null)
  const pt = lang === 'pt'
  if (attachments.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {attachments.map(a => {
        const url = attachmentUrl(a.path)
        return attachmentKind(a.path) === 'image'
          ? (
            <button key={a.path} type="button" onClick={() => setOpen(open === a.path ? null : a.path)} title={a.name}
              style={{ padding: 0, border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'none', cursor: 'zoom-in', maxWidth: '100%' }}>
              <img src={url} alt={a.name} style={{ display: 'block', maxWidth: open === a.path ? '100%' : 160, maxHeight: open === a.path ? 480 : 120, borderRadius: 6 }} />
            </button>
          )
          : (
            <a key={a.path} href={url} target="_blank" rel="noreferrer" title={pt ? `Abrir ${a.name}` : `Open ${a.name}`}
              style={{ ...surface, padding: '6px 9px', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-primary)', textDecoration: 'none', maxWidth: '100%' }}>
              <FileText size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            </a>
          )
      })}
    </div>
  )
}
