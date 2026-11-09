import { useOutletContext } from 'react-router-dom'
import type { AppContext } from '../lib/app-context'
import { DeliveryCalendar } from '../components/calendar/DeliveryCalendar'

/** `/tasks/calendar` — the Delivery calendar (BETA), in the Agentask area beside the Live line. */
export default function DeliveryCalendarPage() {
  const { lang } = useOutletContext<AppContext>()
  return <DeliveryCalendar lang={lang} />
}
