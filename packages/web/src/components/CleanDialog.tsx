import { useEffect, useState } from 'react'
import { ConfirmModal } from '../pages/settings/primitives'
import { pushNotification } from '../lib/notifications'

type Item = { id: string; repo: string; path: string; kind: string; bytes: number; reason: string }
type Plan = { items: Item[]; reclaimable: { bytes: number; count: number } }
const size = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`

export function CleanDialog({ lang, open, onClose }: { lang: 'pt' | 'en'; open: boolean; onClose: () => void }) {
  const pt = lang === 'pt'; const [plan, setPlan] = useState<Plan | null>(null); const [picked, setPicked] = useState<Set<string>>(new Set()); const [confirm, setConfirm] = useState(false); const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) return; fetch('/api/clean/plan').then(r => r.json()).then(x => { if (x.items) { setPlan(x); setPicked(new Set(x.items.filter((i: Item) => i.kind !== 'node-modules').map((i: Item) => i.id))) } }).catch(() => {}) }, [open])
  if (!open) return null
  const toggle = (id: string) => setPicked(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const run = async () => { setBusy(true); setConfirm(false); try { const r = await fetch('/api/clean/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...picked] }) }); if (!r.ok) throw new Error(); pushNotification({ type: 'info', code: 'clean.started' }) } catch { pushNotification({ type: 'error', code: 'clean.failed' }) } finally { setBusy(false); onClose() } }
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}><div onClick={e => e.stopPropagation()} style={{ width: 'min(680px,100%)', maxHeight: '80vh', overflow: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 }}>
    <h2 style={{ marginTop: 0 }}>{pt ? 'O que dá para limpar' : 'What can be cleaned'}</h2>
    {!plan ? <p>{pt ? 'Verificando…' : 'Checking…'}</p> : plan.items.length === 0 ? <p>{pt ? 'Nada para limpar.' : 'Nothing to clean.'}</p> : plan.items.map(i => <label key={i.id} style={{ display: 'flex', gap: 10, padding: '9px 0', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}><input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} /><span style={{ flex: 1 }}><strong>{i.path}</strong><br /><small style={{ color: 'var(--text-tertiary)' }}>{size(i.bytes)} · {i.reason}</small></span></label>)}
    {plan && <p style={{ color: 'var(--text-secondary)' }}>{size([...picked].reduce((n, id) => n + (plan.items.find(i => i.id === id)?.bytes ?? 0), 0))}</p>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}><button onClick={onClose}>{pt ? 'Cancelar' : 'Cancel'}</button><button disabled={busy || picked.size === 0} onClick={() => setConfirm(true)}>{pt ? 'Limpar' : 'Clean'}</button></div>
    <ConfirmModal open={confirm} title={pt ? 'Confirmar limpeza' : 'Confirm cleanup'} message={pt ? 'Nada em andamento será tocado. Os branches permanecem.' : 'Nothing in progress will be touched. Branches stay.'} confirmLabel={pt ? 'Limpar' : 'Clean'} cancelLabel={pt ? 'Cancelar' : 'Cancel'} onConfirm={() => void run()} onCancel={() => setConfirm(false)} />
  </div></div>
}
