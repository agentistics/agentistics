import { useEffect, useState } from 'react'
import { DEFAULT_HANDOFF_CONFIG, handoffCut, normalizeHandoffConfig, type HandoffConfig, type HandoffProfile } from '@agentistics/core'
import { Divider, SectionHeader } from './primitives'
import './handoffSettings.css'

export default function HandoffSettings({ pt }: { pt: boolean }) {
  const [config, setConfig] = useState<HandoffConfig>(normalizeHandoffConfig(null))
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(false)
  const [custom, setCustom] = useState('250000')
  const [extra, setExtra] = useState('10')
  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/preferences', { signal: controller.signal }).then(r => { if (!r.ok) throw new Error(); return r.json() }).then(p => {
      const c = normalizeHandoffConfig(p.handoffConfig); setConfig(c); setCustom(String(c.customTokens)); setExtra(String(c.extraPercent)); setLoaded(true)
    }).catch(() => { if (!controller.signal.aborted) { setError(true); setNotice(pt ? 'Não foi possível carregar as preferências.' : 'Could not load preferences.') } })
    return () => controller.abort()
  }, [pt])
  const profiles: { id: HandoffProfile; name: string; cut: string; description: string }[] = [
    { id: 'economy', name: pt ? 'Econômico' : 'Economy', cut: pt ? '~150 mil' : '~150k', description: pt ? 'Passa cedo. Menos custo por resposta; mais passagens.' : 'Hand off early. Lower reply cost; more handoffs.' },
    { id: 'balanced', name: pt ? 'Equilibrado' : 'Balanced', cut: pt ? '~250 mil' : '~250k', description: pt ? 'Equilibra contexto e custo. Recomendado.' : 'Balances context and cost. Recommended.' },
    { id: 'long', name: pt ? 'Longo' : 'Long', cut: pt ? '~400 mil' : '~400k', description: pt ? 'Guarda mais contexto; cada resposta custa mais.' : 'Keeps more context; replies cost more.' },
    { id: 'custom', name: pt ? 'Personalizado' : 'Custom', cut: pt ? 'você define' : 'your choice', description: pt ? 'Escolha o tamanho da conversa.' : 'Choose the conversation size.' },
  ]
  const levels = [
    { id: 'near' as const, label: pt ? 'Chegando perto do ponto de passar' : 'Approaching the handoff point', at: pt ? '80% do corte' : '80% of the cut' },
    { id: 'due' as const, label: pt ? 'Hora de passar' : 'Time to hand off', at: pt ? 'no corte' : 'at the cut' },
    { id: 'overdue' as const, label: pt ? 'Passou do ponto' : 'Past the handoff point', at: pt ? '+50 mil' : '+50k' },
  ]
  const valid = (config.profile !== 'custom' || (Number(custom) >= 1000 && Number(custom) <= 10_000_000 && Number.isInteger(Number(custom))))
    && extra.trim() !== '' && Number(extra) >= 0 && Number(extra) <= 100 && Number.isInteger(Number(extra))
  async function save() {
    if (!valid) return
    setSaving(true); setNotice(''); setError(false)
    const next = normalizeHandoffConfig({ ...config, customTokens: Number(custom), extraPercent: Number(extra) })
    try {
      const r = await fetch('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handoffConfig: next }) })
      if (!r.ok) throw new Error()
      setConfig(next); setNotice(pt ? 'Salvo' : 'Saved'); window.dispatchEvent(new Event('agentistics:handoff-settings'))
    } catch { setError(true); setNotice(pt ? 'Não foi possível salvar. Tente novamente.' : 'Could not save. Try again.') }
    finally { setSaving(false) }
  }
  return <section className="handoff-settings">
    <SectionHeader label={pt ? 'Passagem do líder' : 'Leader handoff'} />
    <p>{pt ? 'Escolha quando passar para uma sessão nova. Só vale para líderes.' : 'Choose when to move to a new session. Applies to leaders only.'}</p>
    <fieldset disabled={!loaded || saving}>
      <div className="handoff-profiles" role="radiogroup" aria-label={pt ? 'Perfil de passagem' : 'Handoff profile'}>
        {profiles.map(p => <button key={p.id} type="button" role="radio" aria-checked={config.profile === p.id} className={config.profile === p.id ? 'selected' : ''} onClick={() => { setConfig({ ...config, profile: p.id }); setNotice('') }}>
          <strong>{p.name}</strong><span>{p.cut}</span><small>{p.description}</small>
        </button>)}
      </div>
      {config.profile === 'custom' && <label className="handoff-setting-row">{pt ? 'Corte em tokens' : 'Cut in tokens'}<input type="number" min={1000} max={10000000} step={1000} value={custom} onChange={e => setCustom(e.target.value)} /></label>}
      <Divider />
      <strong>{pt ? 'Avisos visíveis' : 'Visible warnings'}</strong>
      {levels.map(l => <label className="handoff-warning" key={l.id}>
        <input type="checkbox" checked={config.warnings[l.id]} onChange={e => setConfig({ ...config, warnings: { ...config.warnings, [l.id]: e.target.checked } })} />
        <span>{l.label}</span><small>{l.at}</small>
      </label>)}
      <label className="handoff-setting-row"><span>{pt ? 'No painel, mostrar o custo de continuar mais' : 'In the panel, show the cost of continuing another'}</span><span><input type="number" min={0} max={100} value={extra} onChange={e => setExtra(e.target.value)} /> %</span></label>
      <p>{pt ? 'Percentual da janela de contexto. O corte selecionado é ' : 'Percentage of the context window. Selected cut: '}{handoffCut(config).toLocaleString(pt ? 'pt-BR' : 'en-US')} {pt ? 'tokens.' : 'tokens.'}</p>
      <div className="handoff-settings-actions"><button type="button" onClick={() => { setConfig(normalizeHandoffConfig(DEFAULT_HANDOFF_CONFIG)); setCustom('250000'); setExtra('10'); setNotice('') }}>{pt ? 'Voltar ao padrão' : 'Reset to default'}</button><button type="button" className="primary" disabled={!valid} onClick={() => void save()}>{saving ? (pt ? 'Salvando…' : 'Saving…') : (pt ? 'Salvar' : 'Save')}</button></div>
    </fieldset>
    {notice && <p role={error ? 'alert' : 'status'}>{notice}</p>}
  </section>
}
