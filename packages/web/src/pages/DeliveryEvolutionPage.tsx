import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../lib/app-context'
import { DeliveryEvolution } from '../components/evolution/DeliveryEvolution'

/** `/delivery-evolution` — "Evolução de entregas" (BETA), in the Métricas area. */
export default function DeliveryEvolutionPage() {
  const { lang, filters, currency, brlRate } = useOutletContext<AppContext>()
  return <DeliveryEvolution lang={lang} filters={filters} currency={currency} brlRate={brlRate} />
}
