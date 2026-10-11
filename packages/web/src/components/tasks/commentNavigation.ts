import type { TaskComment } from '../../lib/tasks'

export type CommentView = 'loose' | { kind: 'thread'; id: string }
export type CommentNavigation =
  | { kind: 'same'; id: string }
  | { kind: 'switch'; id: string; view: CommentView }
  | { kind: 'missing' }

/** Decide where a comment link should go before touching the DOM. */
export function commentNavigation(
  comments: readonly TaskComment[], id: string, current: CommentView,
): CommentNavigation {
  const target = comments.find(c => c.id === id)
  if (!target) return { kind: 'missing' }
  const view: CommentView = target.threadId ? { kind: 'thread', id: target.threadId } : 'loose'
  const same = current === 'loose' && view === 'loose'
    || typeof current !== 'string' && typeof view !== 'string' && current.id === view.id
  return same ? { kind: 'same', id } : { kind: 'switch', id, view }
}
