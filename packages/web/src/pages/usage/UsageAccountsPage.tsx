import { Navigate, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import BillingSettings from '../settings/BillingSettings'

/** Accounts, plans and their usage: the former Settings → Billing, living where the usage is read. */
export default function UsageAccountsPage() {
  const { lang, isCentral } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  // A central aggregates many machines; one operator's plan timeline cannot price a fleet.
  if (isCentral) return <Navigate to="/usage" replace />
  return <div className="ag-settings" style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="accounts" isMobile={isMobile} />
    <BillingSettings />
  </div>
}
