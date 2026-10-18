import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { awayUntilLabel, useAway } from '../../lib/awayMode'
import { PageHeader } from '../../components/nav/PageHeader'
import { AwayImpact } from '../../components/AwayImpact'
import AwaySection from '../settings/AwaySection'

export default function AwayPage() {
  const { lang, capabilities, isCentral } = useOutletContext<AppContext>()
  return <AwayContent lang={lang} capable={capabilities?.localShell !== false && !isCentral} />
}

export function AwayContent({ lang, capable }: { lang: 'pt' | 'en'; capable: boolean }) {
  const pt = lang === 'pt'
  const away = useAway()
  const status = !capable ? (pt ? 'Modo ausente indisponível nesta instância.' : 'Away mode is unavailable on this instance.')
    : !away.state ? (pt ? 'Carregando modo ausente…' : 'Loading away mode…')
    : away.active ? `${pt ? 'Ausente' : 'Away'} ${awayUntilLabel(away.state, lang, Date.now())}`
    : (pt ? 'Você está presente.' : 'You are present.')
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="leadership" pageId="away" status={status} />
    {capable && <div style={{ padding: 14, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--bg-card)' }}>
      <AwaySection embedded lang={lang} capable={capable} />
      <AwayImpact pt={pt} />
    </div>}
  </div>
}
