import { useId, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { usePlanLimits, fmtWhen } from '../../lib/planLimits'
import { planSessions } from '../../lib/usagePlan'
import { FieldInput, RecordCard } from '../settings/primitives'
import { HARNESS_LABELS } from '../../lib/harness'
import { orderedBudgets, unmeasured } from './usageView'

export default function UsagePlanPage() {
  const { lang } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const { budgets, now } = usePlanLimits()
  const [hours, setHours] = useState('4')
  const pt = lang === 'pt'
  const errorId = useId()
  const budgetRows = orderedBudgets(budgets)
  const duration = Number(hours)
  const valid = Number.isFinite(duration) && duration > 0
  const rows = valid ? planSessions(budgetRows, duration, now) : []
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="plan" isMobile={isMobile} actions={[{ label: pt ? 'Ajustar limites' : 'Adjust limits', onClick: () => navigate('/usage/limits') }]} />
    <div style={{ maxWidth: 320, minHeight: isMobile ? 44 : undefined }}>
      <FieldInput label={pt ? 'Quero trabalhar por quantas horas?' : 'How many hours do you want to work?'} type="number" min={0} step="any" invalid={!valid} describedBy={!valid ? errorId : undefined} isMobile={isMobile} inputMode="decimal" value={hours} onChange={setHours} />
    </div>
    {!valid && <p id={errorId} role="status">{pt ? 'Informe um número de horas maior que zero.' : 'Enter a number of hours greater than zero.'}</p>}
    {valid && !rows.length && <p>{pt ? 'Nenhum plano com leitura de uso ainda.' : 'No plans with usage readings yet.'}</p>}
    <div className="ag-grid cols-2" style={isMobile ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
      {rows.map((row, i) => <RecordCard fieldLayout="stacked" key={`${row.harness}:${row.account}`} title={`${HARNESS_LABELS[budgetRows[i]!.harness]} · ${row.label}`} subtitle={budgetRows[i]!.plan} fields={[{
        label: pt ? 'Disponibilidade' : 'Availability',
        value: row.pauseUntil !== null && row.pauseUntil > now
          ? (pt ? `Em pausa até ${fmtWhen(row.pauseUntil, now, lang)}` : `Paused until ${fmtWhen(row.pauseUntil, now, lang)}`)
          : row.parallel === null ? unmeasured(lang)
          : row.reason === 'hold' ? (pt ? 'Em pausa — aguardando renovação do plano' : 'Paused — waiting for plan renewal')
          : (pt ? `${row.parallel} sessões em paralelo` : `${row.parallel} parallel sessions`),
      }]} />)}
    </div>
  </div>
}
