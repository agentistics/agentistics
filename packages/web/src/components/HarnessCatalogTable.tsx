import type { HarnessChatStatus } from '../hooks/useChatHarnesses'
import type { PlanLimits } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'
import { HarnessMark } from './sessions/HarnessMark'
import { PlanLimitBars } from './PlanLimitMeter'
import { useIsMobile } from '../hooks/useIsMobile'

export interface HarnessCatalogTableProps {
  lang: 'pt' | 'en'
  statuses: readonly HarnessChatStatus[]
  available?: readonly { id: string; label: string }[]
  usage?: Readonly<Record<string, { sessions: number; lastUsed?: string }>>
  planLimits?: readonly PlanLimits[] | null
  readings?: readonly { harness: string; points: readonly unknown[] }[]
  now?: number
  selected?: string
  mode: 'new' | 'usage'
  loading?: boolean
  onSelect?: (id: string) => void
  onInstall?: (id: string) => void
}

/** Shared compact catalog for Nova sessão and Uso; installation is always an explicit action. */
export function HarnessCatalogTable({ lang, statuses, available = [], usage = {}, planLimits = [], readings = [], now = Date.now(), selected = '', mode, loading = false, onSelect, onInstall }: HarnessCatalogTableProps) {
  const mobile = useIsMobile()
  const grid = gridStyle(mode, mobile)
  const pt = lang === 'pt'
  const availableIds = new Set(available.map(h => h.id))
  const byId = new Map(statuses.map(h => [h.id, h]))
  for (const h of available) if (!byId.has(h.id)) byId.set(h.id, { id: h.id, label: h.label, installed: true, authReady: true, ready: true, models: [], defaultModel: '', setup: {} })
  const rows = [...byId.values()]
  if (loading && rows.length === 0) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '8px 0' }}>{pt ? 'Vendo todos os harnesses compatíveis…' : 'Checking all compatible harnesses…'}</div>
  if (rows.length === 0) return <div style={{ color: 'var(--text-secondary)', fontSize: 13, padding: '8px 0' }}>{pt ? 'Nenhum harness compatível foi encontrado.' : 'No compatible harness was found.'}</div>
  return <div data-harness-catalog={mode} style={{ border: '1px solid var(--border)', borderRadius: 10, minWidth: 0, overflow: 'hidden' }}>
    {!mobile && <div data-catalog-header style={{ ...grid, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}><span>Harness</span><span>{pt ? 'Instalação' : 'Installation'}</span><span>{pt ? 'Leitura' : 'Reading'}</span><span>{pt ? 'Uso' : 'Usage'}</span>{mode === 'new' && <span />}</div>}
    {rows.map(h => {
      const count = usage[h.id]?.sessions ?? 0
      const limits = planLimits?.find(l => l.harness === h.id)
      const label = (HARNESS_LABELS as Record<string, string>)[h.id] ?? h.label
      const canSelect = availableIds.has(h.id)
      const installed = h.installed || canSelect
      const hasReading = !!limits || readings.some(r => r.harness === h.id && r.points.length > 0)
      const reading = hasReading ? (pt ? 'Disponível' : 'Available') : (pt ? 'Sem leitura' : 'No reading')
      const cell = (kind: string): React.CSSProperties => ({ minWidth: 0, ...(mobile ? { gridColumn: mode === 'new' ? '1' : '1 / -1', fontSize: 11.5 } : {}), color: kind === 'ok' ? 'var(--accent-green)' : 'var(--text-secondary)' })
      return <div key={h.id} data-harness-row={h.id} style={{ ...grid, borderTop: '1px solid var(--border)', background: selected === h.id ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent', fontSize: 12, textTransform: 'none', letterSpacing: 'normal', fontWeight: 400 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, ...(mobile ? { gridColumn: '1', gridRow: '1' } : {}) }}><HarnessMark harness={h.id} size={22} /><div style={{ minWidth: 0, flex: 1 }}><span style={{ display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 650 }}>{label}</span>{limits && <PlanLimitBars limits={limits} now={now} lang={lang} />}</div></div>
        <span data-catalog-installation style={cell(installed ? 'ok' : '')}>{mobile && `${pt ? 'Instalação' : 'Installation'}: `}{installed ? (pt ? 'Instalado' : 'Installed') : (pt ? 'Não instalado' : 'Not installed')}</span>
        <span data-catalog-reading style={cell(hasReading ? 'ok' : '')}>{mobile && `${pt ? 'Leitura' : 'Reading'}: `}{reading}</span>
        <span data-catalog-usage style={cell(count > 0 ? 'ok' : '')}>{mobile && `${pt ? 'Uso' : 'Usage'}: `}{count > 0 ? `${count.toLocaleString(pt ? 'pt-BR' : 'en-US')} ${pt ? 'sessões' : 'sessions'}` : (pt ? 'Sem uso' : 'No usage')}</span>
        {mode === 'new' && <div data-catalog-action style={{ minWidth: 0, ...(mobile ? { gridColumn: '2', gridRow: '1 / 5', alignSelf: 'center' } : {}) }}>
          {installed && canSelect ? <button type="button" onClick={() => onSelect?.(h.id)} style={buttonStyle(selected === h.id, mobile)}>{selected === h.id ? (pt ? 'Selecionado' : 'Selected') : (pt ? 'Selecionar' : 'Select')}</button>
            : !installed && h.canInstall ? <button type="button" onClick={() => onInstall?.(h.id)} style={buttonStyle(false, mobile)}>{pt ? 'Instalar' : 'Install'}</button>
              : !installed && h.setup.docUrl ? <a href={h.setup.docUrl} target="_blank" rel="noopener noreferrer" style={{ ...buttonStyle(false, mobile), display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', textDecoration: 'none' }}>{pt ? 'Como instalar' : 'How to install'}</a>
                : <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{pt ? 'Sem lançamento' : 'Cannot launch'}</span>}
        </div>}

      </div>
    })}
  </div>
}

function gridStyle(mode: 'new' | 'usage', mobile: boolean): React.CSSProperties {
  return { display: 'grid', gridTemplateColumns: mobile ? (mode === 'new' ? 'minmax(0, 1fr) 100px' : 'minmax(0, 1fr)') : (mode === 'new' ? 'minmax(100px, 1.5fr) minmax(65px, 1fr) minmax(60px, .9fr) minmax(52px, .8fr) 94px' : 'minmax(100px, 2fr) repeat(3, minmax(65px, 1fr))'), minWidth: 0, gap: mobile ? '4px 8px' : 8, alignItems: 'center', padding: '10px', color: 'var(--text-secondary)' }
}
function buttonStyle(selected: boolean, mobile: boolean): React.CSSProperties { return { width: '100%', minHeight: mobile ? 44 : '2.75rem', padding: '6px 9px', borderRadius: 7, border: `1px solid ${selected ? 'var(--accent)' : 'var(--border-subtle)'}`, background: selected ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 650 } }
