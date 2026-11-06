import type { HarnessChatStatus } from '../hooks/useChatHarnesses'
import { HARNESS_COLORS, HARNESS_LABELS } from '../lib/harness'
import { HarnessMark } from './sessions/HarnessMark'

export interface HarnessCatalogTableProps {
  lang: 'pt' | 'en'
  statuses: readonly HarnessChatStatus[]
  available?: readonly { id: string; label: string }[]
  usage?: Readonly<Record<string, { sessions: number; lastUsed?: string }>>
  selected?: string
  mode: 'new' | 'usage'
  loading?: boolean
  onSelect?: (id: string) => void
  onInstall?: (id: string) => void
}

/** Shared compact catalog for Nova sessão and Uso; installation is always an explicit action. */
export function HarnessCatalogTable({ lang, statuses, available = [], usage = {}, selected = '', mode, loading = false, onSelect, onInstall }: HarnessCatalogTableProps) {
  const pt = lang === 'pt'
  const availableIds = new Set(available.map(h => h.id))
  const byId = new Map(statuses.map(h => [h.id, h]))
  for (const h of available) if (!byId.has(h.id)) byId.set(h.id, { id: h.id, label: h.label, installed: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {} })
  const rows = [...byId.values()]
  if (loading && rows.length === 0) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '8px 0' }}>{pt ? 'Vendo todos os harnesses compatíveis…' : 'Checking all compatible harnesses…'}</div>
  if (rows.length === 0) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '8px 0' }}>{pt ? 'Nenhum harness compatível foi encontrado.' : 'No compatible harness was found.'}</div>
  return <div data-harness-catalog={mode} style={{ border: '1px solid var(--border)', borderRadius: 10, overflowX: 'auto' }}>
    <div style={gridStyle}><span>Harness</span><span>{pt ? 'Instalação' : 'Installation'}</span><span>{pt ? 'Leitura' : 'Reading'}</span><span>{pt ? 'Uso' : 'Usage'}</span><span /></div>
    {rows.map(h => {
      const count = usage[h.id]?.sessions ?? 0
      const label = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
      const canSelect = availableIds.has(h.id)
      const reading = h.installed ? (count > 0 ? (pt ? 'Disponível' : 'Available') : (pt ? 'Sem leitura' : 'No reading')) : '—'
      return <div key={h.id} data-harness-row={h.id} style={{ ...gridStyle, borderTop: '1px solid var(--border)', background: selected === h.id ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent', fontSize: 12.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}><HarnessMark harness={h.id} size={22} /><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 650 }}>{label}</span></div>
        <span style={{ color: h.installed ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{h.installed ? (pt ? 'Instalado' : 'Installed') : (pt ? 'Não instalado' : 'Not installed')}</span>
        <span style={{ color: h.installed && count > 0 ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{reading}</span>
        <span style={{ color: count > 0 ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{count > 0 ? `${count.toLocaleString(pt ? 'pt-BR' : 'en-US')} ${pt ? 'sessões' : 'sessions'}` : (pt ? 'Sem uso' : 'No usage')}</span>
        {mode === 'new' && (h.installed && canSelect ? <button type="button" onClick={() => onSelect?.(h.id)} style={buttonStyle(selected === h.id)}>{selected === h.id ? (pt ? 'Selecionado' : 'Selected') : (pt ? 'Selecionar' : 'Select')}</button> : !h.installed ? <button type="button" onClick={() => onInstall?.(h.id)} style={buttonStyle(false)}>{pt ? 'Instalar' : 'Install'}</button> : <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{pt ? 'Sem leitura' : 'No reading'}</span>)}
        {mode === 'usage' && <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{h.installed ? (count > 0 ? (pt ? 'Abrir' : 'Open') : (pt ? 'Sem uso' : 'No usage')) : (pt ? 'Instalar' : 'Install')}</span>}
      </div>
    })}
  </div>
}

const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(180px, 2fr) 1.2fr 1.1fr 1.1fr 112px', minWidth: 680, gap: 12, alignItems: 'center', padding: '10px 13px', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }
function buttonStyle(selected: boolean): React.CSSProperties { return { minHeight: 44, padding: '6px 9px', borderRadius: 7, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`, background: selected ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 650 } }
