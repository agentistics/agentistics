import type { SessionMeta, SurfaceHarnessId } from '@agentistics/core'
import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { usePlanLimits } from '../../lib/planLimits'
import { usageHeadline } from '../../lib/usagePlan'
import { BillingAccountsPanel } from '../settings/BillingSettings'
import { UsageChartsPanel } from './UsageChartsPanel'
import { orderedBudgets, type Lang } from './usageView'

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
  const { budgets, readings, now } = usePlanLimits()
  const rows = orderedBudgets(budgets)
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="now" isMobile={isMobile} status={usageHeadline(rows, now, lang) ?? undefined} />
    <div style={{ marginBottom: 20 }}><UsageChartsPanel budgets={rows} readings={readings} sessions={sessions} harnesses={harnesses} lang={lang} now={now} /></div>
    {accounts && <BillingAccountsPanel />}
  </div>
}
