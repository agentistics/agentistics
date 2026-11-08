/**
 * LiveAntigas — the group "Antigas sem registro": legacy cards with no proof of release, nobody alive on them, untouched for over
 * 24 h and no delivery still waiting on its leader. Filtros v2 keeps them in "Tudo", marked, at the bottom of "Revisão do líder";
 * this dialog, opened from that tab's bar, is where they are DECIDED: one click per card, one for the whole group.
 *
 * Both actions go through `POST /api/deliveries/antigas`, the same door the CLI (`agentop flow antigas`) and the MCP use. Nothing
 * is ever deleted. The group action asks first and says the number it will act on; that number IS the list of ids it sends, in
 * small batches, so the screen and the server can never disagree, it shows progress, and stopping really stops. A refusal is said
 * on the card, in words, with its way out.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { shortTitle } from '@agentistics/core'
import { ConfirmModal } from '../../pages/settings/primitives'
import { button } from './board'

export interface LiveAntigaItem {
  key: string
  taskId: string
  /** Absent for a task-level piece: it can only be opened. */
  subtaskId: string | null
  title: string
  suggestion?: { repo: string; pr: number; tag?: string; via: string }
}

export interface LiveAntigasProps {
  open: boolean
  items: readonly LiveAntigaItem[]
  pt: boolean
  mobile: boolean
  onClose: () => void
  onOpen: (taskId: string) => void
}

type Action = 'publish' | 'archive'
interface Outcome { ok: boolean; reason?: string; code?: 'no_session' }

/** How many pieces one request carries: the answer stays immediate and the group can be stopped between two of them. */
export const ANTIGAS_CHUNK = 5

const T = (pt: boolean) => pt ? {
  title: (n: number) => `Antigas sem registro · ${n}`,
  note: 'Sem prova de publicação, sem sessão viva e paradas há mais de 24 h. Decida cada uma: nada é apagado e nada sai daqui sozinho.',
  publish: 'Marcar publicado', archive: 'Arquivar', all: (n: number) => `Todas (${n})`, version: 'versão (opcional)', reason: 'motivo (opcional)',
  failed: (s: string) => `Recusada: ${s}`, busy: (a: number, b: number) => `Enviando ${a} de ${b}…`, stop: 'Parar', close: 'Fechar', cancel: 'Cancelar', openTask: 'Abrir a tarefa',
  noSession: 'Nenhuma sessão ficou registrada nesta peça, e o quadro só marca como publicada o que tem sessão. Arquive, ou abra a tarefa e registre a conversa que a entregou.',
  suggest: (tag: string | undefined, pr: number) => `Pode ter saído${tag ? ` na ${tag}` : ''}, PR #${pr}. A prova é fraca, então nada mudou sozinho.`,
  accept: (tag: string) => `Publicar na ${tag}`,
  taskLevel: 'Tarefa sem subtarefas: decida abrindo a tarefa.',
  confirmArchiveTitle: (n: number) => `Arquivar ${n} ${n === 1 ? 'peça' : 'peças'}?`,
  confirmArchive: 'Elas saem da revisão como abandonadas. Nada é apagado, mas para voltar é preciso abrir cada tarefa. Uma peça que ainda espera alguém não é tocada.',
  confirmPublishTitle: (n: number) => `Marcar ${n} ${n === 1 ? 'peça' : 'peças'} como publicadas?`,
  confirmPublish: 'Elas vão para concluídas sem prova, porque você está dizendo que saíram. Uma peça que ainda espera alguém não é tocada.',
  unreachable: 'Não consegui falar com o servidor. Nada mudou nesta peça.',
} : {
  title: (n: number) => `Old, no record · ${n}`,
  note: 'No proof of release, no live session and untouched for over 24 h. Decide each one: nothing is deleted and nothing leaves here by itself.',
  publish: 'Mark published', archive: 'Archive', all: (n: number) => `All (${n})`, version: 'version (optional)', reason: 'reason (optional)',
  failed: (s: string) => `Refused: ${s}`, busy: (a: number, b: number) => `Sending ${a} of ${b}…`, stop: 'Stop', close: 'Close', cancel: 'Cancel', openTask: 'Open the task',
  noSession: 'No session was filed on this piece, and the board only marks done what has one. Archive it, or open the task and file the conversation that delivered it.',
  suggest: (tag: string | undefined, pr: number) => `May have shipped${tag ? ` in ${tag}` : ''}, PR #${pr}. The proof is weak, so nothing changed by itself.`,
  accept: (tag: string) => `Publish in ${tag}`,
  taskLevel: 'A task with no subtasks: decide it by opening the task.',
  confirmArchiveTitle: (n: number) => `Archive ${n} ${n === 1 ? 'piece' : 'pieces'}?`,
  confirmArchive: 'They leave review as abandoned. Nothing is deleted, but bringing one back means opening its task. A piece still waiting on somebody is not touched.',
  confirmPublishTitle: (n: number) => `Mark ${n} ${n === 1 ? 'piece' : 'pieces'} as published?`,
  confirmPublish: 'They go to done with no proof, because you are saying they shipped. A piece still waiting on somebody is not touched.',
  unreachable: 'Could not reach the server. Nothing changed on this piece.',
}

export function LiveAntigas({ open, items, pt, mobile, onClose, onOpen }: LiveAntigasProps) {
  const L = T(pt)
  const [version, setVersion] = useState('')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [asking, setAsking] = useState<Action | null>(null)
  const stopper = useRef<AbortController | null>(null)
  const stopRequested = useRef(false)
  useEffect(() => () => stopper.current?.abort(), [])
  const busy = progress !== null
  // What the screen lists is what the group button acts on: a piece already decided here leaves both at once.
  const visible = useMemo(() => items.filter(a => !a.subtaskId || outcomes[a.subtaskId]?.ok !== true), [items, outcomes])
  const actionable = useMemo(() => visible.flatMap(a => (a.subtaskId ? [a.subtaskId] : [])), [visible])

  const send = async (action: Action, ids: readonly string[], chosenVersion: string | undefined, signal?: AbortSignal): Promise<void> => {
    const fail = (why: string) => setOutcomes(o => ({ ...o, ...Object.fromEntries(ids.map(id => [id, { ok: false, reason: why }])) }))
    try {
      const res = await fetch('/api/deliveries/antigas', {
        method: 'POST', headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
        body: JSON.stringify({ action, ids, expect: ids.length, ...(action === 'publish' && chosenVersion ? { version: chosenVersion } : {}), ...(action === 'archive' && reason.trim() ? { reason: reason.trim() } : {}) }),
      })
      const body = await res.json().catch(() => ({})) as { done?: Array<{ subtaskId: string; ok: boolean; reason?: string; code?: 'no_session' }>; sentence?: string; error?: string }
      if (!res.ok) { fail(body.sentence ?? body.error ?? String(res.status)); return }
      setOutcomes(o => ({ ...o, ...Object.fromEntries((body.done ?? []).map(x => [x.subtaskId, { ok: x.ok, ...(x.reason ? { reason: x.reason } : {}), ...(x.code ? { code: x.code } : {}) }])) }))
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') fail(L.unreachable)
    }
  }
  const one = async (action: Action, id: string, chosenVersion?: string) => {
    setProgress({ done: 0, total: 1 })
    await send(action, [id], chosenVersion ?? (version.trim() || undefined))
    setProgress(null)
  }
  const group = async (action: Action) => {
    const ids = [...actionable]
    const ac = new AbortController()
    stopper.current = ac
    stopRequested.current = false
    setProgress({ done: 0, total: ids.length })
    // "Stop" lets the batch in flight finish, so the list says exactly what happened; leaving the screen aborts it (the server then stops too).
    for (let at = 0; at < ids.length && !stopRequested.current && !ac.signal.aborted; at += ANTIGAS_CHUNK) {
      await send(action, ids.slice(at, at + ANTIGAS_CHUNK), version.trim() || undefined, ac.signal)
      setProgress({ done: Math.min(ids.length, at + ANTIGAS_CHUNK), total: ids.length })
    }
    stopper.current = null
    setProgress(null)
  }

  const btn = (primary = false): React.CSSProperties => ({
    ...button(mobile), flexShrink: 0, opacity: busy ? 0.6 : 1, cursor: busy ? 'default' : 'pointer',
    ...(primary ? { borderColor: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', color: 'var(--text-primary)' } : {}),
  })
  const field: React.CSSProperties = { minHeight: mobile ? 44 : 30, fontSize: mobile ? 16 : 12, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: 'inherit', minWidth: 0, boxSizing: 'border-box' }
  const footer = (
    // The phone sheet scrolls as one: Stop and Close stay on its floor, like the dialog's own buttons.
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', flexWrap: 'wrap', ...(mobile ? { position: 'sticky' as const, bottom: 0, zIndex: 1, background: 'var(--bg-card)', padding: '8px 0 2px', boxShadow: '0 -8px 8px -8px rgba(0,0,0,0.35)' } : {}) }}>
      {progress && <span role="status" data-live-antigas-progress style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{L.busy(progress.done, progress.total)}</span>}
      {progress && stopper.current && <button type="button" data-live-antigas-stop onClick={() => { stopRequested.current = true }} style={btn()}>{L.stop}</button>}
      <button type="button" data-live-antigas-close onClick={onClose} style={{ ...button(mobile) }}>{L.close}</button>
    </div>
  )
  return (
    <>
      <ConfirmModal
        open={open} title={L.title(items.length)} message={L.note} tone="default" confirmLabel={L.close} cancelLabel={L.close}
        onConfirm={onClose} onCancel={onClose} maxWidth={720} mobileSheet focusPanel layer={mobile ? 2000 : 300} footer={footer}
      >
        <div data-live-antigas style={{ display: 'grid', gap: 10, fontSize: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <input data-live-antigas-version value={version} onChange={e => setVersion(e.target.value)} placeholder={L.version} aria-label={L.version} style={{ ...field, width: mobile ? '100%' : 130 }} />
            <button type="button" data-live-antigas-all-publish disabled={busy || actionable.length === 0} onClick={() => setAsking('publish')} style={btn(true)}>{L.publish} · {L.all(actionable.length)}</button>
            <input data-live-antigas-reason value={reason} onChange={e => setReason(e.target.value)} placeholder={L.reason} aria-label={L.reason} style={{ ...field, width: mobile ? '100%' : 160 }} />
            <button type="button" data-live-antigas-all-archive disabled={busy || actionable.length === 0} onClick={() => setAsking('archive')} style={btn()}>{L.archive} · {L.all(actionable.length)}</button>
          </div>
          {/* On a phone the sheet itself is the one scroller, with its footer pinned; a second one inside it fights the thumb. */}
          <ul className="ag-scroll" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8, ...(mobile ? {} : { maxHeight: '46vh', overflowY: 'auto' as const, overscrollBehavior: 'contain' as const }) }}>
            {visible.map(a => {
              const out = a.subtaskId ? outcomes[a.subtaskId] : undefined
              return (
                <li key={a.key} data-live-archived={a.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                  <button type="button" onClick={() => onOpen(a.taskId)} title={a.title} style={{ background: 'none', border: 0, padding: 0, minHeight: mobile ? 44 : undefined, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left', flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>{shortTitle(a.title, 72)}</button>
                  {a.subtaskId
                    ? <span style={{ display: 'flex', gap: 6, flexShrink: 0, ...(mobile ? { flexBasis: '100%' } : {}) }}>
                        <button type="button" data-live-antiga-publish={a.subtaskId} disabled={busy} onClick={() => void one('publish', a.subtaskId!)} style={{ ...btn(), ...(mobile ? { flex: 1 } : {}) }}>{L.publish}</button>
                        <button type="button" data-live-antiga-archive={a.subtaskId} disabled={busy} onClick={() => void one('archive', a.subtaskId!)} style={{ ...btn(), ...(mobile ? { flex: 1 } : {}) }}>{L.archive}</button>
                      </span>
                    : <span style={{ color: 'var(--text-tertiary)', fontSize: 11.5 }}>{L.taskLevel}</span>}
                  {a.suggestion && (
                    <span data-live-antiga-suggestion style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 11.5 }} title={a.suggestion.via}>
                      <span style={{ minWidth: 0, flex: '1 1 200px' }}>{L.suggest(a.suggestion.tag, a.suggestion.pr)}</span>
                      {a.subtaskId && a.suggestion.tag && <button type="button" data-live-antiga-accept={a.subtaskId} disabled={busy} onClick={() => void one('publish', a.subtaskId!, a.suggestion!.tag!.replace(/^v/, ''))} style={btn(true)}>{L.accept(a.suggestion.tag)}</button>}
                    </span>
                  )}
                  {out && !out.ok && (
                    <span data-live-antiga-error style={{ color: 'var(--accent-red, #ff5f5f)', flexBasis: '100%', overflowWrap: 'anywhere', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span style={{ flex: '1 1 200px', minWidth: 0 }}>{out.code === 'no_session' ? L.noSession : L.failed(out.reason ?? '?')}</span>
                      {out.code === 'no_session' && <button type="button" data-live-antiga-open={a.key} onClick={() => onOpen(a.taskId)} style={btn()}>{L.openTask}</button>}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </ConfirmModal>
      <ConfirmModal
        open={asking !== null} layer={mobile ? 2020 : 320} tone={asking === 'archive' ? 'danger' : 'default'} focusCancel
        title={asking === 'archive' ? L.confirmArchiveTitle(actionable.length) : L.confirmPublishTitle(actionable.length)}
        message={asking === 'archive' ? L.confirmArchive : L.confirmPublish}
        confirmLabel={asking === 'archive' ? L.archive : L.publish} cancelLabel={L.cancel}
        onCancel={() => setAsking(null)}
        onConfirm={() => { const a = asking; setAsking(null); if (a) void group(a) }}
      />
    </>
  )
}
