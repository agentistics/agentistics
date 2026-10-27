import { Navigate } from 'react-router-dom'

/** The standalone Limits page is replaced by Usage's account list. */
export default function UsageLimitsPage() {
  return <Navigate to={{ pathname: '/usage', hash: '#contas' }} replace />
}
