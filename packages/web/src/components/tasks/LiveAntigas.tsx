/**
 * LiveAntigas — the collapsed group "Antigas sem registro": legacy cards that left "Revisão do líder" because nothing proves
 * they shipped, nothing is alive on them and they have been untouched for over 24 h. One click per card, and one for the
 * whole group: "Marcar publicado" (a version may be typed, optional) and "Arquivar" (abandoned, with a reason comment).
 * Both go through `POST /api/deliveries/antigas` — the same door the CLI (`agentop flow antigas`) and the MCP use. Nothing is
 * ever deleted; a refusal is said on the card in the server's own sentence.
 */
import { useState } from 'react'
import { shortTitle } from '@agentistics/core'
import type { LiveHidden } from './liveDeliveryModel'

export interface LiveAntigasProps {
  items: readonly LiveHidden[]
  /** The full count (the list is capped); the group buttons act on ALL of them, the server decides which. */
  total: number
  pt: boolean
  mobile: boolean
  onOpen: (taskId: string) => void
  /** Called after the server accepted at least one piece, so the line can refetch. */
  onChanged?: () => void
}

type Action = 'publish' | 'archive'
interface Outcome { ok: boolean; reason?: string }

const T = (pt: boolean) => pt
  ? { note: 'Sem registro de entrega, sem prova de publicação, sem sessão viva e parados há mais de 24 h — saíram da coluna “Revisão do líder”. Nada é apagado.', publish: 'Marcar publicado', archive: 'Arquivar', all: (n: number) => `Todas (${n})`, version: 'versão (opcional)', reason: 'motivo (opcional)', more: (n: number) => `e mais ${n}`, done: 'feito', failed: (s: string) => `recusada: ${s}`, busy: 'enviando…' }
  : { note: 'No delivery record, no proof of release, no live session and untouched for over 24 h — they left the “Leader review” column. Nothing is deleted.', publish: 'Mark published', archive: 'Archive', all: (n: number) => `All (${n})`, version: 'version (optional)', reason: 'reason (optional)', more: (n: number) => `and ${n} more`, done: 'done', failed: (s: string) => `refused: ${s}`, busy: 'sending…' }

export function LiveAntigas({ items, total, pt, mobile, onOpen, onChanged }: LiveAntigasProps) {
  const L = T(pt)
  const [version, setVersion] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const send = async (action: Action, ids: readonly string[] | 'all') => {
    setBusy(true)
    try {
      const res = await fetch('/api/deliveries/antigas', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(ids === 'all' ? { all: true } : { ids }), ...(action === 'publish' && version.trim() ? { version: version.trim() } : {}), ...(action === 'archive' && reason.trim() ? { reason: reason.trim() } : {}) }),
      })
      const body = await res.json().catch(() => ({})) as { done?: Array<{ subtaskId: string; ok: boolean; reason?: string }>; sentence?: string; error?: string }
      if (!res.ok) { setOutcomes(o => ({ ...o, ...Object.fromEntries((ids === 'all' ? items.flatMap(i => i.subtaskId ? [i.subtaskId] : []) : ids).map(id => [id, { ok: false, reason: body.sentence ?? body.error ?? String(res.status) }])) })); return }
      setOutcomes(o => ({ ...o, ...Object.fromEntries((body.done ?? []).map(x => [x.subtaskId, { ok: x.ok, reason: x.reason }])) }))
      if ((body.done ?? []).some(x => x.ok)) onChanged?.()
    } catch (e) {
      const reasonText = e instanceof Error ? e.message : String(e)
      setOutcomes(o => ({ ...o, ...Object.fromEntries((ids === 'all' ? [] : ids).map(id => [id, { ok: false, reason: reasonText }])) }))
    } finally { setBusy(false) }
  }
  const btn = (primary = false): React.CSSProperties => ({
    minHeight: mobile ? 44 : 26, padding: '0 10px', borderRadius: 6, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 11.5,
    border: `1px solid ${primary ? 'var(--anthropic-orange)' : 'var(--border)'}`, background: primary ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)', color: 'var(--text-primary)', opacity: busy ? 0.6 : 1,
  })
  const field: React.CSSProperties = { minHeight: mobile ? 44 : 26, fontSize: mobile ? 16 : 11.5, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', minWidth: 0 }
  return (
    <div data-live-antigas style={{ display: 'grid', gap: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11.5 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{L.note}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <input data-live-antigas-version value={version} onChange={e => setVersion(e.target.value)} placeholder={L.version} aria-label={L.version} style={{ ...field, width: mobile ? '100%' : 130 }} />
        <button type="button" data-live-antigas-all-publish disabled={busy} onClick={() => void send('publish', 'all')} style={btn(true)}>{L.publish} · {L.all(total)}</button>
        <input data-live-antigas-reason value={reason} onChange={e => setReason(e.target.value)} placeholder={L.reason} aria-label={L.reason} style={{ ...field, width: mobile ? '100%' : 160 }} />
        <button type="button" data-live-antigas-all-archive disabled={busy} onClick={() => void send('archive', 'all')} style={btn()}>{L.archive} · {L.all(total)}</button>
      </span>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {items.filter(a => !a.subtaskId || outcomes[a.subtaskId]?.ok !== true).map(a => {
          const out = a.subtaskId ? outcomes[a.subtaskId] : undefined
          return (
            <li key={a.key} data-live-archived={a.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <button type="button" onClick={() => onOpen(a.taskId)} title={a.title} style={{ background: 'none', border: 0, padding: 0, minHeight: mobile ? 44 : undefined, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'left', flex: '1 1 160px', minWidth: 0 }}>{shortTitle(a.title, 54)}</button>
              {a.subtaskId && <button type="button" data-live-antiga-publish={a.subtaskId} disabled={busy} onClick={() => void send('publish', [a.subtaskId!])} style={btn()}>{L.publish}</button>}
              {a.subtaskId && <button type="button" data-live-antiga-archive={a.subtaskId} disabled={busy} onClick={() => void send('archive', [a.subtaskId!])} style={btn()}>{L.archive}</button>}
              {out && !out.ok && <span data-live-antiga-error style={{ color: 'var(--accent-red, #ff5f5f)', flexBasis: '100%', overflowWrap: 'anywhere' }}>{L.failed(out.reason ?? '?')}</span>}
            </li>
          )
        })}
      </ul>
      {total > items.length && <span style={{ color: 'var(--text-tertiary)' }}>{L.more(total - items.length)}</span>}
    </div>
  )
}
