/**
 * FeedbackDialog.tsx — "Encontrou um bug ou tem uma sugestão?". Mounted ONCE (`FeedbackHost`, in main.tsx
 * beside the error boundary so it survives a crash) and opened through `openFeedback`. Sending opens a
 * prefilled GitHub page in the person's browser — see `lib/feedback.ts`; nothing leaves this machine from here.
 * Reuses the settings primitives (`FieldInput`, `Checkbox`) and the ConfirmModal overlay shape.
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, Lightbulb, Info } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { Checkbox, FieldInput } from '../pages/settings/primitives'
import { closeFeedback, useFeedbackState } from '../lib/feedbackStore'
import {
  buildFeedbackTarget, canSend, collectInfo, includedInfo, type FeedbackFacts, type FeedbackKind, type InfoKey,
} from '../lib/feedback'

/** The facts the browser can state about itself; the server ones are fetched when the dialog opens. */
function browserFacts(): Pick<FeedbackFacts, 'userAgent' | 'platform' | 'arch'> {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & { userAgentData?: { platform?: string } })
  return { userAgent: nav?.userAgent ?? null, platform: nav?.userAgentData?.platform ?? null, arch: null }
}

async function serverFacts(): Promise<Pick<FeedbackFacts, 'version' | 'engine'>> {
  const get = (u: string) => fetch(u, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  const [v, e] = await Promise.all([get('/api/version'), get('/api/engine')]) as [{ current?: string } | null, { present?: boolean; version?: string; manifest?: { version?: string } } | null]
  return { version: v?.current ?? null, engine: e?.present ? (e.version ?? e.manifest?.version ?? null) : null }
}

export function FeedbackHost() {
  const { open } = useFeedbackState()
  return open ? <FeedbackDialog /> : null
}

function FeedbackDialog() {
  const { request, harnesses, pt } = useFeedbackState()
  const isMobile = useIsMobile()
  const [kind, setKind] = useState<FeedbackKind>(request.kind ?? 'bug')
  const [title, setTitle] = useState(request.title ?? '')
  const [description, setDescription] = useState(request.description ?? '')
  const [off, setOff] = useState<ReadonlySet<InfoKey>>(new Set())
  const [server, setServer] = useState<Pick<FeedbackFacts, 'version' | 'engine'>>({})
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => { let live = true; void serverFacts().then(f => { if (live) setServer(f) }); return () => { live = false } }, [])
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') closeFeedback() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  const lines = useMemo(() => collectInfo({ ...browserFacts(), ...server, harnesses }, pt), [server, harnesses, pt])
  const draft = { kind, title, description }
  const send = async () => {
    const t = buildFeedbackTarget(draft, includedInfo(lines, off), pt)
    if (t.clipboard !== null) {
      try { await navigator.clipboard.writeText(t.clipboard); setNote(pt ? 'O texto era grande demais para o link: está na área de transferência — cole na página que abriu.' : 'The text was too long for the link: it is on your clipboard — paste it into the page that opened.') }
      catch { setNote(pt ? 'O texto era grande demais para o link e não foi possível copiá-lo. Reduza a descrição e tente de novo.'
        : 'The text was too long for the link and could not be copied. Shorten the description and try again.'); return }
    }
    window.open(t.url, '_blank', 'noopener,noreferrer')
    if (t.clipboard === null) closeFeedback()
  }

  const tr = (en: string, ptt: string) => (pt ? ptt : en)
  const kindBtn = (k: FeedbackKind, icon: React.ReactNode, label: string) => (
    <button type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} style={{
      flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: isMobile ? 44 : 34,
      borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
      border: '1px solid ' + (kind === k ? 'var(--anthropic-orange)' : 'var(--border)'),
      background: kind === k ? 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)' : 'transparent',
      color: kind === k ? 'var(--text-primary)' : 'var(--text-secondary)',
    }}>{icon}{label}</button>
  )
  const btn = (primary: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minHeight: isMobile ? 44 : undefined,
    width: isMobile ? '100%' : undefined, padding: isMobile ? '0 14px' : '8px 14px', borderRadius: 7,
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    border: primary ? 'none' : '1px solid var(--border)',
    background: primary ? 'var(--anthropic-orange)' : 'transparent', color: primary ? '#fff' : 'var(--text-secondary)',
  })

  return createPortal(
    <div onClick={closeFeedback} style={{
      position: 'fixed', inset: 0, zIndex: 2100, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', padding: isMobile ? 0 : 16,
    }}>
      <div role="dialog" aria-modal="true" aria-label={tr('Report a bug or suggest something', 'Relatar um bug ou sugerir algo')}
        onClick={e => e.stopPropagation()} style={{
          width: '100%', maxWidth: 480, maxHeight: '100%', overflowY: 'auto', boxSizing: 'border-box',
          height: isMobile ? '100%' : undefined, background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 12, padding: 20, boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
        }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
          {tr('Found a bug or have a suggestion?', 'Encontrou um bug ou tem uma sugestão?')}
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 14px' }}>
          {tr('This opens a pre-filled GitHub page in your browser; you send it from your own GitHub account. Nothing is sent from here.',
            'Isto abre uma página do GitHub já preenchida no seu navegador; você envia pela sua própria conta. Nada é enviado daqui.')}
        </p>
        <div role="radiogroup" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {kindBtn('bug', <Bug size={14} />, 'Bug')}
          {kindBtn('suggestion', <Lightbulb size={14} />, tr('Suggestion', 'Sugestão'))}
        </div>
        <FieldInput label={tr('Title', 'Título')} value={title} onChange={setTitle} />
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 5 }}>{tr('Description', 'Descrição')}</div>
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={5} style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', borderRadius: 7, fontSize: 13, color: 'var(--text-primary)',
            fontFamily: 'inherit', resize: 'vertical', outline: 'none',
          }} />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
            {tr('A screenshot cannot travel in a link: drag it into the GitHub page once it opens.',
              'Uma captura de tela não vai num link: arraste-a para a página do GitHub quando ela abrir.')}
          </div>
        </div>
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 14, background: 'var(--bg-elevated)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
            <Info size={13} />{tr('Included information', 'Informações incluídas')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8 }}>
            {tr('Exactly this goes along — nothing else. Untick a line to leave it out.', 'Vai exatamente isto — mais nada. Desmarque uma linha para não enviá-la.')}
          </div>
          {lines.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{tr('Nothing to include.', 'Nada a incluir.')}</div>}
          {lines.map(l => (
            <Checkbox key={l.key} checked={!off.has(l.key)} label={`${l.label}: ${l.value}`}
              onChange={on => setOff(prev => { const n = new Set(prev); if (on) n.delete(l.key); else n.add(l.key); return n })} />
          ))}
        </div>
        {note && <p role="status" style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px' }}>{note}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexDirection: isMobile ? 'column-reverse' : 'row' }}>
          <button type="button" onClick={closeFeedback} style={btn(false)}>{tr('Close', 'Fechar')}</button>
          <button type="button" disabled={!canSend(draft)} onClick={() => { void send() }}
            style={{ ...btn(true), opacity: canSend(draft) ? 1 : 0.5, cursor: canSend(draft) ? 'pointer' : 'not-allowed' }}>
            {tr('Open on GitHub', 'Abrir no GitHub')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
