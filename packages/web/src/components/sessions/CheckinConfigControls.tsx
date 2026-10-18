import { Pause, RefreshCw } from 'lucide-react'
import { ToggleSwitch } from '../ToggleSwitch'
import { Select } from '../../pages/settings/primitives'
import { CHECKIN_ITEMS, type CheckinConfig } from '../../lib/checkin'
import { parseSnooze, SNOOZE_PRESETS } from '../../lib/nayNotify'

const CHECKIN_ROW = { display: 'flex', alignItems: 'center', gap: 7, minHeight: 28, fontSize: 12, color: 'var(--text-secondary)' } as const

export function CheckinConfigControls({ config, pt, isMobile, update, disabled = false, global = false }: {
  config: CheckinConfig; pt: boolean; isMobile: boolean; disabled?: boolean; global?: boolean
  update: (patch: Partial<CheckinConfig>) => Promise<void>
}) {
  const paused = config.paused !== null
  const checklist = CHECKIN_ITEMS.map(item => ({ id: item.id, enabled: config.checklist.find(x => x.id === item.id)?.enabled ?? true }))
  return <><div style={{ display: 'grid', gap: 2 }}>
      <div style={CHECKIN_ROW}><RefreshCw size={15} /><span>{pt ? 'Intervalo' : 'Interval'}</span><div style={{ marginLeft: 'auto' }}><Select disabled={disabled} value={String(config.intervalMin)} onChange={value => void update({ intervalMin: Number(value) as CheckinConfig['intervalMin'] })} options={[
        { value: '15', label: '15 min' }, { value: '30', label: '30 min' },
        { value: '60', label: '1 h' }, { value: '120', label: '2 h' },
      ]} /></div></div>
      <div style={CHECKIN_ROW}><Pause size={15} /><span>{global ? (pt ? 'Habilitar check-in' : 'Enable check-in') : (pt ? 'Pausar check-in' : 'Pause check-in')}</span><span style={{ marginLeft: 'auto', display: 'inline-flex' }}><ToggleSwitch on={global ? !paused : paused} onToggle={() => void update({ paused: paused ? null : { until: null } })} disabled={disabled} label={global ? (pt ? 'Habilitar check-in' : 'Enable check-in') : (pt ? 'Pausar check-in' : 'Pause check-in')} tap={isMobile ? 44 : undefined} /></span></div>
      {!global && paused && <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', padding: '0 0 3px 22px', fontSize: 11 }}><span style={{ color: 'var(--text-secondary)' }}>{pt ? 'Pausar até:' : 'Pause until:'}</span>{SNOOZE_PRESETS.map(p => <button key={p.ms} type="button" onClick={() => { const parsed = parseSnooze(`${p.ms / 60_000}m`); if (parsed.ok) void update({ paused: { until: Date.now() + parsed.ms } }) }} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange)' }}>{p.label[pt ? 'pt' : 'en']}</button>)}<button type="button" onClick={() => void update({ paused: { until: null } })} style={{ all: 'unset', cursor: 'pointer', color: 'var(--anthropic-orange)' }}>{pt ? 'até religar' : 'until resumed'}</button></div>}
    </div>
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '2px 0' }}>{pt ? 'Roteiro: o que o líder confere' : 'Checklist: what the leader checks'}</div>
      {CHECKIN_ITEMS.map(item => { const current = checklist.find(x => x.id === item.id); const enabled = current?.enabled ?? true; return <div key={item.id} style={{ ...CHECKIN_ROW, minHeight: isMobile ? 44 : 28 }}><span style={{ color: enabled ? 'var(--text-secondary)' : 'var(--text-secondary)' }}>{item[pt ? 'pt' : 'en']}</span><span style={{ marginLeft: 'auto', display: 'inline-flex' }}><ToggleSwitch on={enabled} disabled={disabled} onToggle={() => void update({ checklist: checklist.map(x => x.id === item.id ? { ...x, enabled: !enabled } : x) })} label={item[pt ? 'pt' : 'en']} tap={isMobile ? 44 : undefined} /></span></div> })}
    </div>
  </>
}
