import type { SessionMeta, SurfaceHarnessId } from '@agentistics/core'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { usePlanLimits } from '../../lib/planLimits'
import { usageHeadline } from '../../lib/usagePlan'
import { useApiUsage } from '../../lib/apiUsage'
import { ApiUsageSection } from '../../components/ApiUsageSection'
import { BillingAccountsPanel } from '../settings/BillingSettings'
import { UsageChartsPanel, usageLimitsStatus } from './UsageChartsPanel'
import { orderedBudgets, type Lang } from './usageView'
import { HarnessCatalogTable } from '../../components/HarnessCatalogTable'
import { useChatHarnesses } from '../../hooks/useChatHarnesses'

export default function UsageNowPage() {
  const { lang, data, isCentral } = useOutletContext<AppContext>()
  return <UsageNowContent lang={lang} sessions={data?.sessions} harnesses={data?.harnesses} accounts={!isCentral} />
}

/**
 * Usage: the charts, then ONE compact row per account (rings, agent switch, pencil) and the billing
 * notes — what used to be split across "Now", "Plan", "Limits" and Settings → Billing. Also rendered
 * by fixture tests without mounting the application shell (`accounts={false}` skips the registry).
 */
export function UsageNowContent({ lang, sessions = [], harnesses = [], accounts = true }: { lang: Lang; sessions?: SessionMeta[]; harnesses?: SurfaceHarnessId[]; accounts?: boolean }) {
  const isMobile = useIsMobile()
  const { budgets, readings, now, limits, failure } = usePlanLimits()
  const { harnesses: chatHarnesses, loading: chatHarnessesLoading } = useChatHarnesses(true)
  const rows = orderedBudgets(budgets)
  const usage = sessions.reduce<Record<string, { sessions: number }>>((out, session) => {
    const id = session.harness ?? 'claude'
    out[id] = { sessions: (out[id]?.sessions ?? 0) + 1 }
    return out
  }, {})
  const apis = useApiUsage().items
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="now" isMobile={isMobile} status={usageHeadline(rows, now, lang) ?? undefined} />
    <div style={{ marginBottom: 20 }}><UsageChartsPanel budgets={rows} readings={readings} status={usageLimitsStatus(limits, failure)} sessions={sessions} harnesses={harnesses} lang={lang} now={now} /></div>
    <section style={{ marginBottom: 20 }} aria-labelledby="usage-harness-catalog-title">
      <h2 id="usage-harness-catalog-title" style={{ fontSize: 16, margin: '0 0 6px' }}>{lang === 'pt' ? 'Uso por harness' : 'Usage by harness'}</h2>
      <p style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '0 0 12px' }}>{lang === 'pt' ? 'O catálogo completo, com instalação, leitura e uso claramente separados.' : 'The full catalog, with installation, reading and usage kept explicit.'}</p>
      <HarnessCatalogTable lang={lang} statuses={chatHarnesses} usage={usage} planLimits={limits} readings={readings} now={now} mode="usage" loading={chatHarnessesLoading} />
    </section>
    {accounts && <BillingAccountsPanel />}
    <ApiUsageSection items={apis} now={now} lang={lang} emptyNotice />
  </div>
}
