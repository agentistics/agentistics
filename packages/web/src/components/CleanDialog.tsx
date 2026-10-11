import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, ConfirmModal, DialogActions, dialogButtonStyle, RecordCard, SectionHeader, StatusDot } from '../pages/settings/primitives'
import { pushNotification } from '../lib/notifications'
import { useIsMobile } from '../hooks/useIsMobile'

type Item = { id: string; repo: string; path: string; kind: string; bytes: number; reason: string }
type Plan = { items: Item[]; reclaimable: { bytes: number; count: number } }
type Job = { id?: string; state: string; progress: number; result?: { freedBytes: number; worktrees: number; nodeModules: number; skipped: Array<{ path: string; reason: string }>; errors: string[] } }

const size = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.round(n / 1024)} KB`
const stage = (state: string, pt: boolean) => ({ verifying: pt ? 'Conferindo…' : 'Checking…', 'removing worktrees': pt ? 'Removendo worktrees…' : 'Removing worktrees…', 'removing node_modules': pt ? 'Removendo node_modules…' : 'Removing node_modules…', pruning: pt ? 'Limpando registros do git…' : 'Cleaning git records…', done: pt ? 'Concluído' : 'Done' }[state] ?? (pt ? 'Limpando…' : 'Cleaning…'))
const kindLabel = (kind: string, pt: boolean) => ({ remove: pt ? 'worktree merged e limpo' : 'merged, clean worktree', prune: pt ? 'registro de worktree ausente' : 'missing worktree record', 'node-modules': 'node_modules' }[kind] ?? kind)
const reasonLabel = (reason: string, pt: boolean) => {
  const labels: Record<string, [string, string]> = {
    'merged and clean': ['merged e limpo', 'merged and clean'],
    'directory is gone': ['a pasta não existe mais', 'directory is gone'],
    'no commit in 30+ days': ['sem commit há 30+ dias', 'no commit in 30+ days'],
    'changed since the plan': ['mudou desde o plano', 'changed since the plan'],
    'the server working directory': ['diretório do servidor', 'server working directory'],
    'an active session': ['sessão ativa', 'active session'],
    'a process is running inside it (or its location is unknown)': ['há um processo dentro (ou localização desconhecida)', 'a process is running inside it (or its location is unknown)'],
  }
  return labels[reason]?.[pt ? 0 : 1] ?? reason
}

export function CleanDialog({ lang, open, onClose }: { lang: 'pt' | 'en'; open: boolean; onClose: () => void }) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [scanProgress, setScanProgress] = useState(0)
  const resultRef = useRef<HTMLElement>(null)
  const keptPaths = useRef(new Set<string>())
  const selectFreshItems = (items: Item[]) => new Set(items.filter(i => i.kind !== 'node-modules' && !keptPaths.current.has(i.path)).map(i => i.id))

  useEffect(() => {
    if (!open) return
    setPlan(null); setJob(null); setBusy(false); setConfirm(false); setError(false)
    keptPaths.current = new Set()
    let stopped = false
    const pollPlan = async () => {
      try {
        const response = await fetch('/api/clean/plan')
        if (!response.ok) throw new Error('plan failed')
        const value = await response.json() as Plan | { state: string; progress?: number }
        if (stopped) return
        if ('items' in value) {
          setPlan(value)
          setPicked(selectFreshItems(value.items))
          return
        }
        if (typeof value.progress === 'number') setScanProgress(value.progress)
        window.setTimeout(pollPlan, 300)
      } catch {
        if (!stopped) { setError(true); setPlan(null) }
      }
    }
    void pollPlan()
    return () => { stopped = true }
  }, [open, retry])

  useEffect(() => {
    if (!busy) return
    let stopped = false
    const poll = async () => {
      try {
        const response = await fetch('/api/clean/job')
        if (!response.ok) throw new Error('job failed')
        const value = await response.json() as Job
        if (stopped) return
        setJob(value)
        if (value.state !== 'done') window.setTimeout(poll, 350)
        else {
          keptPaths.current = new Set(value.result?.skipped.map(item => item.path) ?? [])
          setBusy(false)
          window.setTimeout(() => {
            resultRef.current?.scrollIntoView({ block: 'nearest' })
            void refreshPlan()
          }, 0)
        }
      } catch {
        if (!stopped) window.setTimeout(poll, 1000)
      }
    }
    void poll()
    return () => { stopped = true }
  }, [busy])

  const refreshPlan = async () => {
    try {
      const response = await fetch('/api/clean/plan')
      if (!response.ok) throw new Error('plan failed')
      const value = await response.json() as Plan | { state: string; progress?: number }
      if ('items' in value) {
        setPlan(value)
        setPicked(selectFreshItems(value.items))
      } else window.setTimeout(() => void refreshPlan(), 300)
    } catch { /* the completed result remains visible if the refresh fails */ }
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, Item[]>()
    for (const item of plan?.items ?? []) groups.set(item.repo, [...(groups.get(item.repo) ?? []), item])
    return [...groups]
  }, [plan])
  const selectedBytes = [...picked].reduce((total, id) => total + (plan?.items.find(i => i.id === id)?.bytes ?? 0), 0)
  const toggle = (id: string) => setPicked(current => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
  const run = async () => {
    setBusy(true); setConfirm(false)
    try {
      const response = await fetch('/api/clean/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...picked] }) })
      if (!response.ok) throw new Error('apply failed')
      setJob(await response.json() as Job)
      pushNotification({ type: 'info', code: 'clean.started' })
    } catch {
      setBusy(false); pushNotification({ type: 'error', code: 'clean.failed' })
    }
  }
  const cancel = () => { if (confirm) setConfirm(false); else onClose() }
  const title = confirm ? (pt ? 'Confirmar limpeza' : 'Confirm cleanup') : (pt ? 'O que dá para limpar' : 'What can be cleaned')

  return (
    <ConfirmModal
      open={open}
      title={title}
      message={confirm ? (pt ? 'Nada em andamento será tocado. Os branches permanecem.' : 'Nothing in progress will be touched. Branches stay.') : (pt ? 'Escolha os worktrees e dados que podem ser removidos com segurança.' : 'Choose the worktrees and data that can be safely removed.')}
      confirmLabel={pt ? 'Limpar' : 'Clean'}
      cancelLabel={pt ? 'Fechar' : 'Close'}
      onConfirm={() => void run()}
      onCancel={cancel}
      tone={confirm ? 'danger' : 'default'}
      footer={<DialogActions>
        <button type="button" onClick={cancel} style={dialogButtonStyle('secondary', isMobile)}>{confirm ? (pt ? 'Voltar' : 'Back') : (pt ? 'Fechar' : 'Close')}</button>
        {!confirm && <button type="button" disabled={busy || picked.size === 0 || !plan} onClick={() => setConfirm(true)} style={dialogButtonStyle('primary', isMobile, busy || picked.size === 0 || !plan)}>{pt ? 'Limpar' : 'Clean'}</button>}
        {confirm && <button type="button" onClick={() => void run()} disabled={busy || picked.size === 0} style={dialogButtonStyle('danger', isMobile, busy || picked.size === 0)}>{pt ? 'Confirmar' : 'Confirm'}</button>}
      </DialogActions>}
    >
      <div style={{ maxHeight: 'calc(60vh / var(--ui-zoom, 1))', overflowY: 'auto' }}>
        {busy && job && <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 12 }}><StatusDot state={job.state === 'done' ? 'ok' : 'warn'} /><span>{stage(job.state, pt)} ({job.progress}%)</span></div>}
      {error && <div role="alert" style={{ color: 'var(--text-secondary)', fontSize: 13 }}><p>{pt ? 'Não foi possível carregar a limpeza.' : 'Could not load cleanup options.'}</p><button type="button" onClick={() => setRetry(value => value + 1)} style={dialogButtonStyle('secondary', isMobile)}>{pt ? 'Tentar novamente' : 'Retry'}</button></div>}
      {!error && !plan && <p>{pt ? `Conferindo… ${Math.round(scanProgress * 100)}%` : `Checking… ${Math.round(scanProgress * 100)}%`}</p>}
      {!error && plan && plan.items.length === 0 && <p>{pt ? 'Nada para limpar.' : 'Nothing to clean.'}</p>}
      {!error && plan && grouped.map(([repo, items]) => <section key={repo}><SectionHeader label={repo} /><div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{items.map(item => <RecordCard key={item.id} title={item.path} subtitle={reasonLabel(item.reason, pt)} leading={<Checkbox checked={picked.has(item.id)} onChange={() => toggle(item.id)} label="" ariaLabel={item.path} disabled={busy} />} fields={[{ label: pt ? 'Tipo' : 'Kind', value: kindLabel(item.kind, pt) }, { label: pt ? 'Tamanho' : 'Size', value: size(item.bytes) }]} />)}</div></section>)}
      {plan && plan.items.length > 0 && <p style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 0 }}>{size(selectedBytes)}</p>}
        {job?.state === 'done' && job.result && <div ref={resultRef} role="status"><p>{pt ? `${size(job.result.freedBytes)} liberados; ${job.result.skipped.length} mantidos por segurança.` : `${size(job.result.freedBytes)} freed; ${job.result.skipped.length} kept for safety.`}</p>{job.result.skipped.length > 0 && <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{job.result.skipped.map(item => <li key={item.path}><code>{item.path}</code> — {reasonLabel(item.reason, pt)}</li>)}</ul>}</div>}
      </div>
    </ConfirmModal>
  )
}
