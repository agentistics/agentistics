import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { usePlanLimits } from '../../lib/planLimits'
import { UsageCharts } from './UsageCharts'

export default function UsageHistoryPage() {
  const { lang } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  const { budgets, limits, readings } = usePlanLimits()
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="history" isMobile={isMobile} status={readings.some(reading => reading.points.some(point => point.weekPct !== null || point.fiveHourPct !== null)) ? (lang === 'pt' ? 'Histórico desde que o servidor iniciou.' : 'History since the server started.') : undefined} />
    <UsageCharts budgets={budgets} limits={limits} readings={readings} lang={lang} bothWindows />
  </div>
}
