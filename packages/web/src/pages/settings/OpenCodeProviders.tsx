/** Settings → Billing: connect OpenCode providers (Go, Zen, bring-your-own) by link + pasted key. */
import React, { useCallback, useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { HarnessMark } from '../../components/sessions/HarnessMark'
import { MetricNote } from '../../components/MetricNote'
import { ConfirmModal, DialogActions, FieldInput, dialogButtonStyle } from './primitives'
import { OC_COPY, maybeMisfiledGo, pickerOrder, type OcConnected, type OcProvider } from './opencodeProviderLogic'

interface Answer { installed: boolean; connected: OcConnected[]; providers: OcProvider[] }

export default function OpenCodeProviders({ lang, show, onChanged }: { lang: 'pt' | 'en'; show: boolean; onChanged: () => void }) {
  const pt = lang === 'pt', t = OC_COPY(pt), mobile = useIsMobile()
  const [data, setData] = useState<Answer | null>(null)
  const [open, setOpen] = useState(false), [pick, setPick] = useState('opencode-go'), [key, setKey] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [note, setNote] = useState<string | null>(null)
  const [removing, setRemoving] = useState<OcConnected | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/opencode/auth')
      if (res.ok) setData(await res.json())
    } catch { /* offline: the section just stays out of the way */ }
  }, [])
  useEffect(() => { void load() }, [load])

  if (!data || (!show && !data.installed && data.connected.length === 0)) return null
  const providers = pickerOrder(data.providers, data.connected)
  const chosen = providers.find(p => p.id === pick) ?? providers[0]
  const button = (kind: 'primary' | 'secondary', disabled = false) => dialogButtonStyle(kind, mobile, disabled)
  const close = () => { setOpen(false); setKey(''); setError(null); setBusy(false) }

  const save = async () => {
    if (!chosen || busy || !key.trim()) return
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/opencode/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: chosen.id, key }) })
      const body = await res.json().catch(() => null)
      if (!res.ok) { setError(typeof body?.message === 'string' ? body.message : t.failed); setBusy(false); return }
      setNote(body?.movedFrom ? t.movedGo : t.saved)
      close(); await load(); onChanged()
    } catch { setError(t.failed); setBusy(false) }
  }
  const doRemove = async (c: OcConnected) => {
    setRemoving(null)
    try { await fetch(`/api/opencode/auth/${encodeURIComponent(c.id)}`, { method: 'DELETE' }) } catch { /* the reload shows the truth */ }
    await load(); onChanged()
  }
  const fix = async () => {
    try {
      const res = await fetch('/api/opencode/auth/fix', { method: 'POST' })
      const body = await res.json().catch(() => null)
      setNote(body?.moved ? t.fixed : t.notGo)
    } catch { setNote(t.failed) }
    await load(); onChanged()
  }

  return <div data-opencode-providers style={{ marginTop: 14 }}>
    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>{t.section}</div>
    {data.connected.length === 0 && <MetricNote>{t.none}</MetricNote>}
    {data.connected.map(c => <div key={c.id} data-opencode-provider={c.id} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 8,
      border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', background: 'var(--bg-card)',
    }}>
      <HarnessMark harness="opencode" size={18} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{c.id} · {t.type(c.type)}</div>
      </div>
      <button type="button" aria-label={t.remove(c.label)} title={t.remove(c.label)} onClick={() => setRemoving(c)}
        style={{ width: mobile ? 44 : 32, height: mobile ? 44 : 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, background: 'transparent', border: '1px solid transparent', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}><X size={mobile ? 18 : 16} /></button>
    </div>)}
    {note && <div role="status" style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 8px' }}>{note}</div>}
    {maybeMisfiledGo(data.connected) && <MetricNote>{t.fixNote}</MetricNote>}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" style={button('secondary')} onClick={() => { setNote(null); setOpen(true) }}><HarnessMark harness="opencode" size={16} />{t.add}</button>
      {maybeMisfiledGo(data.connected) && <button type="button" style={button('secondary')} onClick={() => { void fix() }}>{t.fix}</button>}
    </div>

    {open && chosen && <ConfirmModal open tone="default" maxWidth={520} closeLabel={t.close} title={t.title} message=""
      icon={<HarnessMark harness="opencode" size={22} />} confirmLabel={t.save} cancelLabel={t.cancel} onConfirm={() => { void save() }} onCancel={close}
      footer={<DialogActions>
        <button type="button" style={button('secondary')} onClick={close}>{t.cancel}</button>
        <button type="button" style={button('primary', busy || !key.trim())} disabled={busy || !key.trim()} onClick={() => { void save() }}>{t.save}</button>
      </DialogActions>}>
      <div style={{ paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          {t.provider}
          <select value={chosen.id} onChange={e => setPick(e.target.value)} style={{ minHeight: mobile ? 44 : 36, fontSize: 16, padding: '0 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>1. {t.stepOpen}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '2px 0 8px' }}>{t.stepOpenNote(chosen)}</div>
          <a href={chosen.url} target="_blank" rel="noopener noreferrer" style={{ ...button('primary'), textDecoration: 'none' }}><ExternalLink size={14} aria-hidden />{t.openLink}</a>
        </div>
        <div onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save() } }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>2. {t.stepPaste}</div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '2px 0 8px' }}>{t.stepPasteNote}</div>
          <FieldInput label={t.stepPaste} hideLabel value={key} onChange={setKey} type="text" masked mono maxLength={1024} autoComplete="off" spellCheck={false} minHeight={mobile ? 44 : 36} disabled={busy} />
        </div>
        {error && <div role="alert" style={{ fontSize: 13, color: 'var(--accent-red)' }}>{error}</div>}
      </div>
    </ConfirmModal>}
    {removing && <ConfirmModal open title={t.removeTitle(removing.label)} message={t.removeNote} confirmLabel={t.removeConfirm} cancelLabel={t.cancel}
      onConfirm={() => { void doRemove(removing) }} onCancel={() => setRemoving(null)} />}
  </div>
}
