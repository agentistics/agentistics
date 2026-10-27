import { Navigate } from 'react-router-dom'

/** The "Plan" page is gone (it planned nothing per account); its per-account line lives in the account editor. */
export default function UsagePlanPage() {
  return <Navigate to="/usage" replace />
}
