/**
 * liveDeepLink — where a notification about a delivery lands on the Live (PURE).
 *
 *  - `?card=<key>`   one piece (`<taskId>/<subtaskId>`, or `<taskId>` for a task-level piece): the Live opens on that piece.
 *  - `?orphans=1`    the pieces waiting for review with no leader: the Live opens filtered on them.
 *
 * Both are what a notice's click does, so the action it names ("review and finish, or abandon") is one click away.
 */
import { pathOfView } from './tasksViewRoute'

export type LiveDeepLink = { kind: 'card'; key: string; taskId: string } | { kind: 'orphans' }

export function liveDeepLink(o: { card?: string; orphans?: boolean }): string {
  const q = new URLSearchParams()
  if (o.card) q.set('card', o.card)
  else if (o.orphans) q.set('orphans', '1')
  const s = q.toString()
  return s ? `${pathOfView('live')}?${s}` : pathOfView('live')
}

export function parseLiveDeepLink(search: string): LiveDeepLink | null {
  const q = new URLSearchParams(search)
  const card = (q.get('card') ?? '').trim()
  if (card) return { kind: 'card', key: card, taskId: card.split('/')[0]! }
  if (q.get('orphans') === '1') return { kind: 'orphans' }
  return null
}
