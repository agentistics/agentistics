/**
 * SESSION MENTIONS in Agentask comments and threads.
 *
 * A comment may point at a session with the chip the composers already write —
 * `#«Title · 3f5f21a8»` (`web/src/lib/sessionMention.ts`; one chip format, one reader). When such a
 * comment is posted and the mentioned session is LIVE, that session receives a SYSTEM item: the
 * `[from agentistics · mention]` header every other agentistics-originated message opens with, which
 * the chat draws as a system card and never as something the person typed. It names the task (and
 * subtask), the author, a short excerpt and where to open it.
 *
 * Not live (ended, lost, external, sitting on a dialog) means NOTHING is typed: the mention stays on
 * the board, where the session finds it the next time it reads the task. Nothing is queued — a
 * mention is information, not an instruction that must not be lost, and replaying an old one into a
 * session that has since moved on would be noise.
 *
 * The pure half (`extractMentionIds`, `planMentionTargets`, `mentionText`) is tested on its own; the
 * IO half takes its host as a dependency.
 */
import { redactSecrets } from '@agentistics/core'

/** `#«Title · 3f5f21a8»` — the id is the last `·`-separated part, hex, at least 4 characters. */
const CHIP = /#«[^»\n]*?·\s*([0-9a-fA-F]{4,})\s*»/g

/** The distinct short ids named by chips in `body`, in order of appearance, lower-cased. */
export function extractMentionIds(body: string): string[] {
  const out: string[] = []
  for (const m of body.matchAll(CHIP)) {
    const id = m[1]!.toLowerCase()
    if (!out.includes(id)) out.push(id)
  }
  return out
}

export interface MentionRow {
  id: string
  conversationId?: string
  state: string
  /** False for an external assistant agentop does not host. */
  actionable: boolean
}

const LIVE = new Set(['working', 'waiting'])

/**
 * The rows to notify. A short id matches a row by the prefix of its id or its conversation id and
 * must match EXACTLY ONE row (an ambiguous prefix is refused, never guessed); the author's own
 * session is never told it mentioned itself; a row is notified at most once. `waiting-approval` is
 * excluded — typing into an open dialog would answer it.
 */
export function planMentionTargets(
  ids: readonly string[],
  rows: readonly MentionRow[],
  authorSessionIds: readonly string[] = [],
): string[] {
  const hit = new Set<string>()
  for (const short of ids) {
    const matches = rows.filter(r => r.id.toLowerCase().startsWith(short) || (r.conversationId ?? '').toLowerCase().startsWith(short))
    if (matches.length !== 1) continue
    const row = matches[0]!
    if (!row.actionable || !LIVE.has(row.state)) continue
    if (authorSessionIds.some(a => a === row.id || a === row.conversationId)) continue
    hit.add(row.id)
  }
  return [...hit]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** The system item typed into a mentioned session. English: it is read by a model, not by the owner. */
export function mentionText(o: {
  taskId: string
  taskTitle: string
  subtaskTitle?: string
  threadTitle?: string
  author: string
  body: string
  commentId: string
}): string {
  const excerpt = clip(redactSecrets(o.body.replace(/#«([^»\n]*?)\s*·\s*[0-9a-fA-F]{4,}\s*»/g, '$1').replace(/\s+/g, ' ').trim()), 280)
  const where = [o.subtaskTitle ? `subtask "${clip(o.subtaskTitle, 80)}"` : '', o.threadTitle ? `thread "${clip(o.threadTitle, 80)}"` : ''].filter(Boolean).join(', ')
  return [
    '[from agentistics · mention]',
    `You were mentioned in a comment on the Agentask task "${clip(o.taskTitle, 100)}" (${o.taskId})${where ? `, ${where}` : ''}.`,
    `By: ${clip(o.author, 60)}`,
    `Excerpt: "${excerpt}"`,
    `Open: /tasks/${o.taskId}#comment-${o.commentId}  (or call agentistics_task with ref ${o.taskId})`,
    'This is a notification, not an instruction: read the comment and answer on the board if it needs a reply.',
  ].join('\n')
}

export interface MentionDeps {
  rows: () => Promise<readonly MentionRow[]>
  prompt: (rowId: string, text: string) => Promise<{ ok: boolean }>
}

/** Deliver the mention to every live mentioned session. Returns the rows it reached. Never throws. */
export async function deliverMentions(
  o: Parameters<typeof mentionText>[0] & { authorSessionIds?: readonly string[] },
  deps: MentionDeps,
): Promise<string[]> {
  try {
    const ids = extractMentionIds(o.body)
    if (ids.length === 0) return []
    const targets = planMentionTargets(ids, await deps.rows(), o.authorSessionIds)
    const text = mentionText(o)
    const reached: string[] = []
    for (const rowId of targets) {
      const r = await deps.prompt(rowId, text).catch(() => ({ ok: false }))
      if (r.ok) reached.push(rowId)
    }
    return reached
  } catch { return [] }
}

/** The real host: the fleet's rows and the composer's own send path. */
export async function defaultMentionDeps(): Promise<MentionDeps> {
  const { hostForFleet, runFleetAction } = await import('./fleet-web')
  return {
    rows: async () => {
      const host = await hostForFleet('en')
      const snap = await host.sessions?.()
      return (snap?.sessions ?? []).map(r => ({
        id: r.id, state: r.state, actionable: r.actionable,
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
      }))
    },
    prompt: async (rowId, text) => {
      const out = await runFleetAction('en', { action: 'prompt', id: rowId, text })
      return { ok: out.ok }
    },
  }
}
