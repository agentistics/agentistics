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
  /** Absent for a task-level piece: actions use its taskId. */
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

type Action = 'publish' | 'archive' | 'conclude'
interface Outcome { ok: boolean; reason?: string; code?: 'no_session' }

/** How many pieces one request carries: the answer stays immediate and the group can be stopped between two of them. */
export const ANTIGAS_CHUNK = 5

const T = (pt: boolean) => pt ? {
  title: (n: number) => `Antigas sem registro · ${n}`,
  note: 'Sem prova de publicação, sem sessão viva e paradas há mais de 24 h. Decida cada uma: nada é apagado e nada sai daqui sozinho.',
  publish: 'Marcar concluído', archive: 'Arquivar', all: (n: number) => `Todas (${n})`, version: 'versão (opcional)', reason: 'motivo (opcional)',
  failed: (s: string) => `Recusada: ${s}`, busy: (a: number, b: number) => `Enviando ${a} de ${b}…`, stop: 'Parar', close: 'Fechar', cancel: 'Cancelar', openTask: 'Abrir a tarefa',
  noSession: 'Nenhuma sessão ficou registrada nesta peça, e o quadro só marca como publicada o que tem sessão. Arquive, ou abra a tarefa e registre a conversa que a entregou.',
  suggest: (tag: string | undefined, pr: number) => `Pode ter saído${tag ? ` na ${tag}` : ''}, PR #${pr}. A prova é fraca, então nada mudou sozinho.`,
  accept: (tag: string) => `Publicar na ${tag}`,
  taskLevel: 'Tarefa sem subtarefas: decida abrindo a tarefa.',
  confirmArchiveTitle: (n: number) => `Arquivar ${n} ${n === 1 ? 'peça' : 'peças'}?`,
  confirmArchive: 'Elas saem da revisão como abandonadas. Nada é apagado, mas para voltar é preciso abrir cada tarefa. Uma peça que ainda espera alguém não é tocada.',
  concludeAll: 'Concluir', counts: (c: number, a: number) => `${c} ${c === 1 ? 'concluída' : 'concluídas'}, ${a} ${a === 1 ? 'arquivada' : 'arquivadas'}`,
  confirmConcludeTitle: (n: number) => `Concluir ${n} ${n === 1 ? 'peça' : 'peças'} de uma vez?`,
  confirmConclude: 'Quem tem sessão vai para Concluído, sem prova de release; quem não tem é arquivada. Nada é apagado. Uma peça que ainda espera alguém não é tocada.',
  confirmPublishTitle: (n: number) => `Marcar ${n} ${n === 1 ? 'peça' : 'peças'} como concluídas?`,
  confirmPublish: 'Elas vão para Concluído · sem prova de release, visíveis em Tudo. Publicado exige prova de release. Uma peça que ainda espera alguém não é tocada.',
  unreachable: 'Não consegui falar com o servidor. Nada mudou nesta peça.',
  running: 'Já há uma execução em andamento nas peças antigas. Espere ela terminar e confira a lista de novo.',
  summary: (done: number, left: number, stopped: boolean) => `${stopped ? 'Parado' : 'Terminou'}: ${done} ${done === 1 ? 'peça feita' : 'peças feitas'}, ${left} ${left === 1 ? 'restante' : 'restantes'}.`,
  whyFewer: (shown: number, n: number) => `${shown} ${shown === 1 ? 'peça' : 'peças'} na lista, mas "Todas" age em ${n}: ${shown - n === 1 ? 'a outra é uma tarefa' : `as outras ${shown - n} são tarefas`} sem subtarefas, e essas só se decidem abrindo a tarefa.`,
} : {
  title: (n: number) => `Old, no record · ${n}`,
  note: 'No proof of release, no live session and untouched for over 24 h. Decide each one: nothing is deleted and nothing leaves here by itself.',
  publish: 'Mark completed', archive: 'Archive', all: (n: number) => `All (${n})`, version: 'version (optional)', reason: 'reason (optional)',
  failed: (s: string) => `Refused: ${s}`, busy: (a: number, b: number) => `Sending ${a} of ${b}…`, stop: 'Stop', close: 'Close', cancel: 'Cancel', openTask: 'Open the task',
  noSession: 'No session was filed on this piece, and the board only marks done what has one. Archive it, or open the task and file the conversation that delivered it.',
  suggest: (tag: string | undefined, pr: number) => `May have shipped${tag ? ` in ${tag}` : ''}, PR #${pr}. The proof is weak, so nothing changed by itself.`,
  accept: (tag: string) => `Publish in ${tag}`,
  taskLevel: 'A task with no subtasks: decide it by opening the task.',
  confirmArchiveTitle: (n: number) => `Archive ${n} ${n === 1 ? 'piece' : 'pieces'}?`,
  confirmArchive: 'They leave review as abandoned. Nothing is deleted, but bringing one back means opening its task. A piece still waiting on somebody is not touched.',
  concludeAll: 'Conclude', counts: (c: number, a: number) => `${c} completed, ${a} archived`,
  confirmConcludeTitle: (n: number) => `Conclude ${n} ${n === 1 ? 'piece' : 'pieces'} in one go?`,
  confirmConclude: 'Pieces with a session go to Completed, no release proof; the rest are archived. Nothing is deleted. A piece still waiting on somebody is not touched.',
  confirmPublishTitle: (n: number) => `Mark ${n} ${n === 1 ? 'piece' : 'pieces'} as completed?`,
  confirmPublish: 'They go to Completed · no release proof, visible in All. Published requires release proof. A piece still waiting on somebody is not touched.',
  unreachable: 'Could not reach the server. Nothing changed on this piece.',
  running: 'A run on the old pieces is already going. Wait for it to finish, then look at the list again.',
  summary: (done: number, left: number, stopped: boolean) => `${stopped ? 'Stopped' : 'Finished'}: ${done} ${done === 1 ? 'piece' : 'pieces'} done, ${left} left.`,
  whyFewer: (shown: number, n: number) => `${shown} ${shown === 1 ? 'piece' : 'pieces'} listed, but "All" acts on ${n}: ${shown - n === 1 ? 'the other one is a task' : `the other ${shown - n} are tasks`} with no subtasks, and those can only be decided by opening the task.`,
}

export function LiveAntigas({ open, items, pt, mobile, onClose, onOpen }: LiveAntigasProps) {
  const L = T(pt)
  const [version, setVersion] = useState('')
  const [reason, setReason] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({})
  const [asking, setAsking] = useState<Action | null>(null)
  const [summary, setSummary] = useState<{ done: number; left: number; stopped: boolean } | null>(null)
  const [preview, setPreview] = useState<{ conclude: number; archive: number } | null>(null)
  const stopper = useRef<AbortController | null>(null)
  const stopRequested = useRef(false)
  useEffect(() => () => stopper.current?.abort(), [])
  const busy = progress !== null
  // What the screen lists is what the group button acts on: a piece already decided here leaves both at once.
  const visible = useMemo(() => items.filter(a => outcomes[a.subtaskId ?? a.taskId]?.ok !== true), [items, outcomes])
  const actionable = useMemo(() => visible.map(a => a.subtaskId ?? a.taskId), [visible])

  /** `done` = the pieces the server reported done in this request (its own numbers); `running` = another run holds the lock. */
  const send = async (action: Action, ids: readonly string[], chosenVersion: string | undefined, signal?: AbortSignal): Promise<{ done: number; running: boolean }> => {
    const fail = (why: string) => setOutcomes(o => ({ ...o, ...Object.fromEntries(ids.map(id => [id, { ok: false, reason: why }])) }))
    try {
      const res = await fetch('/api/deliveries/antigas', {
        method: 'POST', headers: { 'content-type': 'application/json' }, ...(signal ? { signal } : {}),
        body: JSON.stringify({ action, ids, expect: ids.length, ...(action === 'publish' && chosenVersion ? { version: chosenVersion } : {}), ...(action === 'archive' && reason.trim() ? { reason: reason.trim() } : {}) }),
      })
      const body = await res.json().catch(() => ({})) as { done?: Array<{ subtaskId: string; ok: boolean; reason?: string; code?: 'no_session' }>; sentence?: string; error?: string }
      if (!res.ok) {
        if (body.error === 'antigas_running') { fail(L.running); return { done: 0, running: true } }
        fail(body.sentence ?? body.error ?? String(res.status)); return { done: 0, running: false }
      }
      setOutcomes(o => ({ ...o, ...Object.fromEntries((body.done ?? []).map(x => [x.subtaskId, { ok: x.ok, ...(x.reason ? { reason: x.reason } : {}), ...(x.code ? { code: x.code } : {}) }])) }))
      return { done: (body.done ?? []).filter(x => x.ok).length, running: false }
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') fail(L.unreachable)
      return { done: 0, running: false }
    }
  }
  const one = async (action: Action, id: string, chosenVersion?: string) => {
    setProgress({ done: 0, total: 1 })
    setSummary(null)
    await send(action, [id], chosenVersion ?? (version.trim() || undefined))
    setProgress(null)
  }
  /** The dialog says beforehand what the one click will do, from the server's own count (the same one the MCP reads). */
  const askConclude = async () => {
    setPreview(null)
    setAsking('conclude')
    try {
      const res = await fetch('/api/deliveries/antigas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'conclude', preview: true, ids: actionable, expect: actionable.length }) })
      const body = await res.json().catch(() => ({})) as { preview?: { conclude: number; archive: number } }
      if (res.ok && body.preview) setPreview(body.preview)
    } catch { /* the dialog still opens, without the split */ }
  }
  const group = async (action: Action) => {
    const ids = [...actionable]
    const ac = new AbortController()
    stopper.current = ac
    stopRequested.current = false
    setProgress({ done: 0, total: ids.length })
    setSummary(null)
    let made = 0
    let blocked = false
    // "Stop" lets the batch in flight finish, so the list says exactly what happened; leaving the screen aborts it (the server then stops too).
    for (let at = 0; at < ids.length && !stopRequested.current && !ac.signal.aborted; at += ANTIGAS_CHUNK) {
      const r = await send(action, ids.slice(at, at + ANTIGAS_CHUNK), version.trim() || undefined, ac.signal)
      made += r.done
      if (r.running) { blocked = true; break } // another run holds the lock: every further chunk would be refused the same way
      setProgress({ done: Math.min(ids.length, at + ANTIGAS_CHUNK), total: ids.length })
    }
    // The numbers are the server's own: what it reported done, and what is left of the batch this screen set out to do.
    if (!ac.signal.aborted) setSummary({ done: made, left: ids.length - made, stopped: stopRequested.current || blocked })
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
        open={open} title={L.title(visible.length)} message={L.note} tone="default" confirmLabel={L.close} cancelLabel={L.close}
        onConfirm={onClose} onCancel={onClose} maxWidth={720} mobileSheet focusPanel layer={mobile ? 2000 : 300} footer={footer}
      >
        <div data-live-antigas style={{ display: 'grid', gap: 10, fontSize: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            <input data-live-antigas-version value={version} onChange={e => setVersion(e.target.value)} placeholder={L.version} aria-label={L.version} style={{ ...field, width: mobile ? '100%' : 130 }} />
            <input data-live-antigas-reason value={reason} onChange={e => setReason(e.target.value)} placeholder={L.reason} aria-label={L.reason} style={{ ...field, width: mobile ? '100%' : 160 }} />
            <button type="button" data-live-antigas-all disabled={busy || actionable.length === 0} onClick={() => void askConclude()} style={btn(true)}>{L.concludeAll} · {L.all(actionable.length)}</button>
          </div>
          {summary && !busy && <p role="status" data-live-antigas-summary style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 12 }}>{L.summary(summary.done, summary.left, summary.stopped)}</p>}
          {visible.length !== actionable.length && <p data-live-antigas-why style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 11.5 }}>{L.whyFewer(visible.length, actionable.length)}</p>}
          {/* On a phone the sheet itself is the one scroller, with its footer pinned; a second one inside it fights the thumb. */}
          <ul className="ag-scroll" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8, ...(mobile ? {} : { maxHeight: 'calc(46vh / var(--ui-zoom, 1))', overflowY: 'auto' as const, overscrollBehavior: 'contain' as const }) }}>
            {visible.map(a => {
              const id = a.subtaskId ?? a.taskId
              const out = outcomes[id]
              return (
                <li key={a.key} data-live-archived={a.key} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minWidth: 0, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
                  <button type="button" onClick={() => onOpen(a.taskId)} title={a.title} style={{ background: 'none', border: 0, padding: 0, minHeight: mobile ? 44 : undefined, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-secondary)', textAlign: 'left', flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>{shortTitle(a.title, 72)}</button>
                  <span style={{ display: 'flex', gap: 6, flexShrink: 0, ...(mobile ? { flexBasis: '100%' } : {}) }}>
                    <button type="button" data-live-antiga-publish={id} disabled={busy} onClick={() => void one('publish', id)} style={{ ...btn(), ...(mobile ? { flex: 1 } : {}) }}>{L.publish}</button>
                    <button type="button" data-live-antiga-archive={id} disabled={busy} onClick={() => void one('archive', id)} style={{ ...btn(), ...(mobile ? { flex: 1 } : {}) }}>{L.archive}</button>
                  </span>
                  {a.suggestion && (
                    <span data-live-antiga-suggestion style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 11.5 }} title={a.suggestion.via}>
                      <span style={{ minWidth: 0, flex: '1 1 200px' }}>{L.suggest(a.suggestion.tag, a.suggestion.pr)}</span>
                      {a.suggestion.tag && <button type="button" data-live-antiga-accept={id} disabled={busy} onClick={() => void one('publish', id, a.suggestion!.tag!.replace(/^v/, ''))} style={btn(true)}>{L.accept(a.suggestion.tag)}</button>}
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
        title={asking === 'conclude' ? L.confirmConcludeTitle(actionable.length) : asking === 'archive' ? L.confirmArchiveTitle(actionable.length) : L.confirmPublishTitle(actionable.length)}
        message={asking === 'conclude' ? `${preview ? `${L.counts(preview.conclude, preview.archive)}. ` : ''}${L.confirmConclude}` : asking === 'archive' ? L.confirmArchive : L.confirmPublish}
        confirmLabel={asking === 'conclude' ? L.concludeAll : asking === 'archive' ? L.archive : L.publish} cancelLabel={L.cancel}
        onCancel={() => setAsking(null)}
        onConfirm={() => { const a = asking; setAsking(null); if (a) void group(a) }}
      />
    </>
  )
}
