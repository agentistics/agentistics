import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PageHeader } from '../../components/nav/PageHeader'
import { NayLimitsTab } from '../../components/nay/NayLimitsTab'

export default function UsageLimitsPage() {
  const { lang } = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  return <div className="ag-settings" style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="usage" pageId="limits" isMobile={isMobile} />
    <NayLimitsTab lang={lang} isMobile={isMobile} />
  </div>
}
