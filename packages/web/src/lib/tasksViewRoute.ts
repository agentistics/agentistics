/** tasksViewRoute — PURE: each Agentask view is its own route, so the sidebar can link to it and highlight it. */
import type { BoardView } from '../components/tasks/boardPrefs'

const PATH: Record<BoardView, string> = { overview: '/tasks/metrics', board: '/tasks/board', table: '/tasks/table', live: '/tasks/live' }
export const pathOfView = (v: BoardView): string => PATH[v]

/** The view a pathname names; `null` for `/tasks` itself (the stored choice decides) and for a task detail. */
export function viewOfPath(pathname: string): BoardView | null {
  const clean = pathname.replace(/\/+$/, '')
  for (const v of Object.keys(PATH) as BoardView[]) if (PATH[v] === clean) return v
  return null
}
