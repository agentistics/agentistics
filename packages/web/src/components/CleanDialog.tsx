import { useEffect, useMemo, useState } from 'react'
import { Check, Search, Trash2, X } from 'lucide-react'
import type { CleanJob, CleanKind, CleanScanState, CleanWebItem } from '@agentistics/core'
import { Checkbox, ConfirmModal, DialogActions, dialogButtonStyle, RecordCard, TabSelect } from '../pages/settings/primitives'
import { pushNotification } from '../lib/notifications'
import { useIsMobile } from '../hooks/useIsMobile'
import { backgroundCleanScan, cancelCleanScan, finalizeCleanScan, startCleanScan, useCleanScan } from '../lib/cleanScan'
import { cleanIdle, cleanKind, cleanMatches, cleanName, cleanReason, cleanSize, sortCleanItems, initialCleanSelection, toggleCleanVisible, type CleanFilter, type CleanSort } from '../lib/cleanPresentation'
import './CleanDialog.css'

const COLORS: Record<CleanKind, string> = { remove: 'var(--anthropic-orange)', 'node-modules': 'var(--accent-purple)', prune: 'var(--accent-cyan)', keep: 'var(--text-tertiary)' }
const STEP = {
  discovering: ['localizando os projetos', 'finding projects'], measuring: ['medindo o tamanho de cada pasta', 'measuring each folder'], preparing: ['preparando o resultado', 'preparing results'],
} as const
const jobStage = (state: string, pt: boolean) => (({ verifying: pt ? 'Conferindo novamente…' : 'Checking again…', 'removing worktrees': pt ? 'Removendo worktrees…' : 'Removing worktrees…', 'removing node_modules': pt ? 'Removendo node_modules…' : 'Removing node_modules…', pruning: pt ? 'Limpando registros do git…' : 'Cleaning git records…' } as Record<string, string>)[state] ?? '')
const time = (ms: number, lang: string) => new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function CleanScanView({ scan, lang }: { scan: CleanScanState | null; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  return <div className="clean-scan" data-testid="clean-scan">
    <div className="clean-found">
      <div><span className="clean-muted">{pt ? 'Encontrado até agora' : 'Found so far'}</span><strong className="clean-number">{cleanSize(scan?.foundBytes ?? 0, lang)}</strong></div>
      <div className="clean-counters"><div><b>{scan?.itemCount ?? 0}</b><span>{pt ? 'itens' : 'items'}</span></div><div><b>{scan?.projectCount ?? 0} {pt ? 'de' : 'of'} {scan?.projectTotal ?? 0}</b><span>{pt ? 'projetos' : 'projects'}</span></div></div>
    </div>
    <div><div className="clean-step"><span>{pt ? 'Etapa' : 'Step'} {scan?.step ?? 1} {pt ? 'de' : 'of'} 3 · {(STEP[scan?.label ?? 'discovering'] ?? STEP.discovering)[pt ? 0 : 1]}</span><span className="clean-muted">{Math.round((scan?.progress ?? 0) * 100)}% · {scan?.etaMs ? (pt ? `cerca de ${Math.ceil(scan.etaMs / 1000)} s` : `about ${Math.ceil(scan.etaMs / 1000)} s`) : (pt ? 'estimando tempo…' : 'estimating time…')}</span></div><progress aria-label={pt ? 'Progresso da varredura' : 'Scan progress'} max={1} value={scan?.progress ?? 0} /></div>
    <div><p className="clean-muted">{pt ? 'O que está acontecendo' : 'What is happening'}</p><div className="clean-log" role="log" aria-live="polite" aria-relevant="additions text">
      {(scan?.log ?? []).slice(-8).map((line, index) => <div className="clean-log-line" key={`${line.at}-${index}`}>
        <span style={{ color: line.state === 'done' ? 'var(--accent-green)' : line.state === 'running' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>{line.state === 'done' ? '✓' : line.state === 'running' ? '›' : '·'}</span>
        <time className="clean-muted">{time(line.at, lang)}</time><span className="clean-ellipsis" title={line.name}>{line.state === 'queued' ? (pt ? 'na fila: ' : 'queued: ') : line.state === 'running' ? (pt ? 'medindo ' : 'measuring ') : ''}{line.name}</span>
        {line.state === 'done' && line.bytes !== undefined && <span className="clean-muted">{cleanSize(line.bytes, lang)}</span>}
      </div>)}
      {!scan?.log.length && <span className="clean-muted">{pt ? 'Localizando as pastas dos seus projetos…' : 'Finding your project folders…'}</span>}
    </div></div>
  </div>
}

export function CleanDialog({ lang, open, onClose }: { lang: 'pt' | 'en'; open: boolean; onClose: () => void }) {
  const pt = lang === 'pt', mobile = useIsMobile()
  const { scan, plan, error } = useCleanScan()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<CleanFilter>('all')
  const [sort, setSort] = useState<CleanSort>('bytes')
  const [descending, setDescending] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [job, setJob] = useState<CleanJob | null>(null)
  const [notice, setNotice] = useState('')
  const [showRemoved, setShowRemoved] = useState(false)
  const done = job?.state === 'done' ? job.result : undefined
  const scanning = !plan && !done && !busy && !error
  useEffect(() => { if (open && !busy && !done) void startCleanScan() }, [open])
  useEffect(() => {
    if (plan) {
      setPicked(initialCleanSelection(plan.items))
      setFilter('all'); setConfirm(false)
    }
  }, [plan?.scanId])
  useEffect(() => {
    if (!busy) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const response = await fetch('/api/clean/job')
        if (!response.ok) throw new Error('job unavailable')
        const next = await response.json() as CleanJob
        if (stopped) return
        setJob(next)
        if (next.state === 'done') { setBusy(false); void finalizeCleanScan().catch(() => {}) }
        else timer = setTimeout(() => void poll(), 500)
      } catch { if (!stopped) timer = setTimeout(() => void poll(), 1500) }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [busy])

  const now = plan?.scannedAt ?? Date.now()
  const items = plan?.items ?? []
  const rows = useMemo(() => sortCleanItems(items.filter(i => cleanMatches(i, filter, now)), sort, descending), [plan, filter, sort, descending])
  const selectable = rows.filter(i => i.kind !== 'keep')
  const allSelected = selectable.length > 0 && selectable.every(i => picked.has(i.id))
  const selected = items.filter(i => i.kind !== 'keep' && picked.has(i.id))
  const selectedBytes = selected.reduce((n, i) => n + i.bytes, 0)
  const toggle = (id: string) => setPicked(current => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next })
  const toggleAll = () => setPicked(current => toggleCleanVisible(current, rows))
  const reorder = (value: CleanSort) => { setSort(value); setDescending(sort === value ? !descending : value === 'bytes') }
  const fail = () => setNotice(pt ? 'Não foi possível concluir esta ação. Tente novamente.' : 'Could not complete this action. Try again.')
  const background = async () => { try { await backgroundCleanScan(); onClose() } catch { fail() } }
  const close = async () => {
    if (confirm) { setConfirm(false); return }
    if (scanning) { await background(); return }
    if (!busy) { try { await finalizeCleanScan() } catch { fail(); return }; setJob(null); setPicked(new Set()); setShowRemoved(false) }
    setNotice(''); onClose()
  }
  const cancel = async () => { try { await cancelCleanScan(); onClose() } catch { fail() } }
  const run = async () => {
    if (submitting) return
    setSubmitting(true); setConfirm(false); setNotice('')
    try {
      const response = await fetch('/api/clean/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected.map(i => i.id) }) })
      if (!response.ok) throw new Error('apply failed')
      setJob(await response.json() as CleanJob); setBusy(true)
      pushNotification({ type: 'info', code: 'clean.started' })
    } catch { pushNotification({ type: 'error', code: 'clean.failed' }); fail() }
    finally { setSubmitting(false) }
  }
  const cleanLabel = `${pt ? 'Limpar' : 'Clean'} ${cleanSize(selectedBytes, lang)}`
  const button = (kind: 'primary' | 'secondary' | 'danger', disabled = false) => ({ ...dialogButtonStyle(kind, mobile, disabled), ...(kind === 'primary' ? { background: 'var(--anthropic-orange)', color: 'var(--text-on-accent, #fff)' } : {}) })
  const filters: Array<{ value: CleanFilter; label: string }> = [
    { value: 'all', label: pt ? 'Todos' : 'All' }, { value: 'worktrees', label: 'Worktrees' }, { value: 'node-modules', label: 'node_modules' }, { value: 'idle', label: pt ? 'Parados há +7 dias' : 'Idle for 7+ days' },
  ].map(f => ({ ...f, value: f.value as CleanFilter, label: `${f.label} ${items.filter(i => cleanMatches(i, f.value as CleanFilter, now)).length}` }))
  const title = done ? (pt ? `${cleanSize(done.freedBytes, lang)} liberados` : `${cleanSize(done.freedBytes, lang)} freed`) : busy ? (pt ? 'Limpando com segurança' : 'Cleaning safely') : confirm ? (pt ? 'Confirmar limpeza' : 'Confirm cleanup') : scanning ? (pt ? 'Procurando o que dá para limpar' : 'Looking for cleanup options') : (pt ? 'O que dá para limpar' : 'What can be cleaned')
  const message = scanning ? (pt ? 'Olhando worktrees, node_modules e registros do git nas pastas dos seus projetos. Nada é apagado nesta etapa.' : 'Checking worktrees, node_modules and git records in your project folders. Nothing is deleted during this step.') : confirm ? (pt ? 'Nada em andamento será tocado. Os branches permanecem. Os itens serão conferidos novamente antes de remover.' : 'Nothing in progress will be touched. Branches stay. Items are checked again before removal.') : ''
  const sortHeading = (value: CleanSort, label: string) => <th scope="col" aria-sort={sort === value ? descending ? 'descending' : 'ascending' : 'none'}><button type="button" onClick={() => reorder(value)}>{label}{sort === value ? descending ? ' ↓' : ' ↑' : ''}</button></th>
  const checkbox = (item: CleanWebItem) => <Checkbox checked={picked.has(item.id)} disabled={busy || item.kind === 'keep'} onChange={() => toggle(item.id)} label="" ariaLabel={item.path} />

  return <ConfirmModal className="clean-dialog" headerAction={mobile && !scanning ? <button type="button" className="clean-close" aria-label={pt ? 'Fechar' : 'Close'} onClick={() => void close()}><X size={18} /></button> : undefined} open={open} title={title} message={message} tone={confirm ? 'danger' : 'default'} icon={done ? <Check size={20} /> : scanning ? <Search size={20} /> : <Trash2 size={20} />}
    confirmLabel={cleanLabel} cancelLabel={pt ? 'Fechar' : 'Close'} onConfirm={() => void run()} onCancel={() => void close()}
    footer={<DialogActions start={scanning ? <span className="clean-muted">{pt ? 'Pode fechar: a Nay avisa quando terminar.' : 'You can close this: Nay will let you know when it is ready.'}</span> : plan && !done && !busy && !confirm ? <span className="clean-selected"><b>{selected.length}</b> {pt ? 'marcados' : 'selected'} · {cleanSize(selectedBytes, lang)}</span> : undefined}>
      {scanning ? <><button type="button" style={button('secondary')} onClick={() => void cancel()}>{pt ? 'Cancelar' : 'Cancel'}</button><button type="button" data-testid="clean-background" style={button('primary')} onClick={() => void background()}>{pt ? 'Continuar em segundo plano' : 'Continue in background'}</button></> : <>
        {done && <button type="button" style={button('secondary')} onClick={() => setShowRemoved(v => !v)}>{showRemoved ? (pt ? 'Ocultar detalhes' : 'Hide details') : (pt ? 'Ver o que foi removido' : 'See what was removed')}</button>}
        <button type="button" style={button(done ? 'primary' : 'secondary')} onClick={() => void close()}>{confirm ? (pt ? 'Voltar' : 'Back') : (pt ? 'Fechar' : 'Close')}</button>
        {plan && !done && !busy && <button type="button" data-testid="clean-apply" disabled={!selected.length || submitting} style={button(confirm ? 'danger' : 'primary', !selected.length || submitting)} onClick={() => confirm ? void run() : setConfirm(true)}><Trash2 size={15} />{confirm ? (pt ? 'Confirmar' : 'Confirm') : cleanLabel}</button>}
      </>}
    </DialogActions>}>
    <div className={`clean-content${plan && !done && !busy && !confirm ? ' clean-result-content' : ''}`}>
      {notice && <p role="alert">{notice}</p>}
      {error && !done && <div role="alert"><p>{pt ? 'Não foi possível carregar a limpeza.' : 'Could not load cleanup options.'}</p><button type="button" style={button('secondary')} onClick={() => void finalizeCleanScan().then(startCleanScan).catch(fail)}>{pt ? 'Tentar novamente' : 'Retry'}</button></div>}
      {scanning && <CleanScanView scan={scan} lang={lang} />}
      {busy && <div role="status"><p>{jobStage(job?.state ?? 'verifying', pt)}</p><progress aria-label={pt ? 'Progresso da limpeza' : 'Cleanup progress'} max={100} value={job?.progress ?? 0} /><p className="clean-muted">{pt ? 'Você pode fechar esta janela; a limpeza continua.' : 'You can close this window; cleanup will continue.'}</p></div>}
      {done && <div className="clean-done" role="status" data-testid="clean-done">
        <p className="clean-muted">{done.diskFreeBefore !== null && done.diskFreeAfter !== null ? `${pt ? 'Disco' : 'Disk'}: ${cleanSize(done.diskFreeBefore, lang)} → ${cleanSize(done.diskFreeAfter, lang)} ${pt ? 'livres' : 'free'} · ` : ''}{pt ? 'levou' : 'took'} {Math.ceil(done.elapsedMs / 1000)} s</p>
        <div className="clean-done-counts">{[[done.removedWorktrees, pt ? 'worktrees removidos' : 'worktrees removed'], [done.pruned, pt ? 'registros consertados' : 'records repaired'], [done.skipped.length, pt ? 'mantidos por segurança' : 'kept for safety']].map(([n, label]) => <div key={label}><b>{n}</b><span className="clean-muted">{label}</span></div>)}</div>
        {done.skipped.length > 0 && <section><h3>{pt ? 'Mantidos por segurança' : 'Kept for safety'}</h3>{done.skipped.map(item => <div className="clean-outcome" key={item.path}><b title={item.path}>{cleanName({ ...item, name: '', kind: 'keep' })}</b><span>{cleanReason(item.reason, pt)}</span></div>)}</section>}
        {done.errors.length > 0 && <section role="alert"><h3>{pt ? 'Não foi possível remover' : 'Could not remove'}</h3>{done.errors.map((e, i) => <p className="clean-error" key={i}>{e}</p>)}</section>}
        {showRemoved && <section><h3>{pt ? 'Removidos' : 'Removed'}</h3>{done.removed.map(item => <div className="clean-outcome" key={`${item.path}:${item.kind}`}><b title={item.path}>{cleanName({ ...item, name: '' })}</b><span>{cleanSize(item.bytes, lang)}</span></div>)}</section>}
      </div>}
      {plan && !done && !busy && <>
        <div className="clean-summary" data-testid="clean-summary"><span className="clean-muted">{confirm ? (pt ? 'Você vai liberar' : 'You will free up') : (pt ? 'Dá para liberar' : 'You can free up')}</span><div><strong className="clean-number">{cleanSize(confirm ? selectedBytes : plan.reclaimable.bytes, lang)}</strong><span className="clean-muted">{confirm ? `${selected.length} ${pt ? 'itens serão removidos' : 'items will be removed'}` : <>{plan.reclaimable.count} {pt ? 'itens' : 'items'} · {new Set(items.map(i => i.repo)).size} {pt ? 'projetos' : 'projects'} · {pt ? 'varrido às' : 'scanned at'} {time(plan.scannedAt, lang)}</>}</span></div></div>
        {!confirm && <>
          <div className="clean-types"><div className="clean-type-bar" aria-hidden="true">{(Object.keys(COLORS) as CleanKind[]).map(kind => { const bytes = items.filter(i => i.kind === kind).reduce((n, i) => n + i.bytes, 0); return bytes > 0 && <span key={kind} style={{ flexGrow: bytes, background: COLORS[kind] }} /> })}</div><div className="clean-legend">{(Object.keys(COLORS) as CleanKind[]).map(kind => <div key={kind}><i style={{ background: COLORS[kind] }} /><span>{cleanKind(kind, pt)} <small>({items.filter(i => i.kind === kind).length})</small></span><b>{cleanSize(items.filter(i => i.kind === kind).reduce((n, i) => n + i.bytes, 0), lang)}</b></div>)}</div></div>
          <TabSelect wrap options={filters} value={filter} onChange={setFilter} buttonMinHeight={mobile ? 44 : 30} />
          {mobile ? <>
            <div className="clean-mobile-select"><Checkbox checked={allSelected} onChange={toggleAll} label={pt ? 'Marcar todos' : 'Select all'} disabled={!selectable.length} /></div>
            <div className="clean-mobile-sort"><span className="clean-muted">{pt ? 'Ordenar por' : 'Sort by'}</span><TabSelect wrap options={[{ value: 'bytes', label: pt ? 'Tamanho' : 'Size' }, { value: 'name', label: pt ? 'Pasta' : 'Folder' }, { value: 'idle', label: pt ? 'Parado há' : 'Idle for' }]} value={sort} onChange={value => reorder(value)} buttonMinHeight={44} /></div>
            <div className="clean-mobile-rows">{rows.map(item => <RecordCard key={item.id} title={<span className="clean-card-name" title={item.path}>{cleanName(item)}</span>} subtitle={<span className="clean-card-subtitle">{item.kind === 'keep' ? `${item.project} · ${cleanReason(item.reason, pt)}` : `${item.project} · ${item.kind === 'node-modules' ? (pt ? 'reinstalável' : 'reinstallable') : item.kind === 'prune' ? (pt ? 'registro' : 'record') : 'merged'} · ${pt ? 'parado há' : 'idle for'} ${cleanIdle(item.lastActivityMs, now, lang)}`}</span>} leading={checkbox(item)} badge={<b>{cleanSize(item.bytes, lang)}</b>} fields={[]} onClick={item.kind !== 'keep' ? () => toggle(item.id) : undefined} />)}</div>
          </> : <div className="clean-table-wrap"><table className="clean-table"><colgroup><col style={{ width: 34 }} /><col /><col style={{ width: '20%' }} /><col style={{ width: 92 }} /><col style={{ width: 108 }} /></colgroup><thead><tr><th><Checkbox checked={allSelected} onChange={toggleAll} label="" ariaLabel={pt ? 'Marcar todos os itens visíveis' : 'Select all visible items'} disabled={!selectable.length} /></th>{sortHeading('name', pt ? 'Pasta' : 'Folder')}{sortHeading('project', pt ? 'Projeto' : 'Project')}{sortHeading('idle', pt ? 'Parado há' : 'Idle for')}{sortHeading('bytes', pt ? 'Tamanho' : 'Size')}</tr></thead><tbody>{rows.map(item => <tr key={item.id} data-kept={item.kind === 'keep'}><td>{checkbox(item)}</td><td title={`${item.path}\n${cleanReason(item.reason, pt)}`}><span className="clean-folder"><i style={{ background: COLORS[item.kind] }} /><b className="clean-ellipsis">{cleanName(item)}</b></span></td><td title={item.repo}>{item.project}</td><td>{cleanIdle(item.lastActivityMs, now, lang)}</td><td>{cleanSize(item.bytes, lang)}</td></tr>)}</tbody></table></div>}
          {rows.length === 0 && <p className="clean-muted">{pt ? 'Nenhum item neste filtro.' : 'No items match this filter.'}</p>}
        </>}
      </>}
    </div>
  </ConfirmModal>
}
