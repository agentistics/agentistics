/**
 * SessionRoute — `/sessions/:sessionId` (UI.3): a NATIVE session (`isNativeSessionId`) gets its own
 * page; every other id is the fleet's, exactly as before. Decided off the id alone, before either
 * page mounts, so neither carries a branch for the other.
 */
import { lazy } from 'react'
import { useParams } from 'react-router-dom'
import { isNativeSessionId } from '../lib/sessionRoute'

const SessionsPage = lazy(() => import('./SessionsPage'))
const NativeSessionPage = lazy(() => import('./NativeSessionPage'))

export default function SessionRoute() {
  const { sessionId } = useParams()
  return isNativeSessionId(sessionId) ? <NativeSessionPage /> : <SessionsPage />
}
