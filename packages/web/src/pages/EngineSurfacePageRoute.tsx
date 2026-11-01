import { useOutletContext, useParams } from 'react-router-dom'
import type { AppContext } from '../lib/app-context'
import { EngineSurfacePage } from '../components/EngineSurfaceHost'

/** `/x/:surfaceId` — the page of an engine surface announced for the `rail` placement. */
export default function EngineSurfacePageRoute() {
  const { surfaceId = '' } = useParams()
  const ctx = useOutletContext<AppContext>()
  return <EngineSurfacePage key={surfaceId} surfaceId={surfaceId} lang={ctx.lang === 'pt' ? 'pt' : 'en'} />
}
