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
import { useState } from 'react'
import { HarnessPicker, withMissingHarnesses } from '../../components/sessions/HarnessPicker'
import { HarnessInstallDialog } from '../../components/HarnessInstallDialog'
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
  const { harnesses: chatHarnesses, reload } = useChatHarnesses(true)
  const [installing, setInstalling] = useState<string | null>(null)
  // Only the harnesses this machine does NOT have: the charts above already show the rest.
  const missing = (withMissingHarnesses([], chatHarnesses) ?? [])
  const rows = orderedBudgets(budgets)
  const apis = useApiUsage().items
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="now" isMobile={isMobile} status={usageHeadline(rows, now, lang) ?? undefined} />
    <div style={{ marginBottom: 20 }}><UsageChartsPanel budgets={rows} readings={readings} status={usageLimitsStatus(limits, failure)} sessions={sessions} harnesses={harnesses} lang={lang} now={now} /></div>
    {missing.length > 0 && <div style={{ marginBottom: 20 }} data-usage-missing-harnesses>
      <HarnessPicker lang={lang} harnesses={missing} value="" onChange={() => undefined} onInstall={setInstalling} />
      <HarnessInstallDialog
        target={installing ? { id: installing, label: missing.find(h => h.id === installing)?.label ?? installing } : null}
        pt={lang === 'pt'}
        onClose={() => setInstalling(null)}
        onDone={() => reload()}
      />
    </div>}
    {accounts && <BillingAccountsPanel />}
    <ApiUsageSection items={apis} now={now} lang={lang} emptyNotice />
  </div>
}
