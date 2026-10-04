/**
 * SessionRoute — every `/sessions` route. There is ONE session shell (UI.UNIFY, owner 2026-10-03):
 * a NATIVE Agentistics session opens in the same workspace as every other harness — it is a fleet
 * row now (`nativeFleetRow.ts`) — so `/sessions/:id` is the workspace for any id, and the old native
 * page links keep working because they were always this URL. The one thing a native session has no
 * equivalent of is a harness SCREEN, so its `/terminal` sends the reader to the conversation instead
 * of a terminal page that could only ever say "nothing here".
 */
import { lazy } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { isNativeSessionId, sessionPath } from '../lib/sessionRoute'

const SessionsPage = lazy(() => import('./SessionsPage'))

/** PURE: where a request for this path should land instead, or null to render it. */
export function nativeRedirect(pathname: string, sessionId: string | undefined): string | null {
  if (!isNativeSessionId(sessionId)) return null
  return /\/terminal\/?$/.test(pathname) ? sessionPath(sessionId!) : null
}

export default function SessionRoute() {
  const { sessionId } = useParams()
  const { pathname } = useLocation()
  const to = nativeRedirect(pathname, sessionId)
  return to ? <Navigate to={to} replace /> : <SessionsPage />
}
