import { Navigate } from 'react-router-dom'

/** Preserve old bookmarks while Usage has one chart screen. */
export default function UsageHistoryPage() {
  return <Navigate to="/usage" replace />
}
