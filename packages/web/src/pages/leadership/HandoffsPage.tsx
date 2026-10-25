import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import { PageHeader } from '../../components/nav/PageHeader'
import { Section } from '../../components/Section'

export default function HandoffsPage() {
  const { lang } = useOutletContext<AppContext>()
  return <HandoffsContent lang={lang} />
}

export function HandoffsContent({ lang }: { lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  return <div style={{ minWidth: 0 }}>
    <PageHeader lang={lang} areaId="sessions" pageId="handoffs" />
    <Section title={pt ? 'Configuração de passagem' : 'Hand-off configuration'}>
      <p style={{ margin: 0, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{pt
        ? 'A configuração de passagem (limite global, medidor e custo por fatia extra) chega na próxima entrega.'
        : 'Hand-off configuration (global threshold, meter and cost per extra slice) arrives in the next delivery.'}</p>
    </Section>
  </div>
}
