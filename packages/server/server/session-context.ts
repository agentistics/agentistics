/**
 * session-context.ts — **pure**: what `agentop hooks context` tells a starting Claude Code session
 * about the assistants already running on this machine.
 *
 * The division of labour with the skill is the whole design, and it is worth stating once:
 *
 *  - the **skill** (`claude-skill.ts`) is KNOWLEDGE. It does not change between sessions, so it is
 *    loaded by the model when the task calls for it and costs nothing when it does not;
 *  - this **hook** is FACTS. Which sessions exist right now, which one is blocked on a permission
 *    prompt, which task can be reopened here. None of that can live in a static file, and all of it
 *    is stale by the time the next session starts.
 *
 * Which is why the one thing this function must be able to do is **say nothing**. On a machine with
 * no agentop sessions it returns `null`, the hook prints nothing, and the session pays zero tokens
 * for it. A SessionStart hook that injected a paragraph into every session — including every
 * session that will never start a second assistant — is the design this one exists instead of.
 */

/** The subset of a `SessionView` this decision reads. Structural, so the poller's rows are passed
 *  in directly and a test does not need one. */
export interface ContextSession {
  id: string
  status: string
  activity?: string | undefined
  /** Busy workers a finished turn is waiting on: not waiting on a person. */
  waitingOnWorkers?: number | undefined
  harness?: string | undefined
  cwd: string
  label?: string | undefined
  task?: string | undefined
}

/** Most-urgent first. The order of the list is the answer to "is any of this on me?". */
const RANK: Record<string, number> = { 'waiting-approval': 0, waiting: 1, working: 2, exited: 4 }
const rankOf = (a?: string): number => (a !== undefined && RANK[a] !== undefined ? RANK[a]! : 3)

/** `/home/u/app` → `~/app`, for a line a person may well read too. Never rewrites a path that only
 *  happens to start with the same characters (`/home/user2`). */
export function tildePath(path: string, home: string): string {
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(home.endsWith('/') ? home : `${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Is `child` the directory `parent`, or inside it? Segment-aware: `/a/bc` is not inside `/a/b`. */
function within(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
}

const shortId = (id: string): string => id.slice(0, 8)

const stateWord = (s: ContextSession): string => {
  if (s.activity === 'waiting-approval') return 'needs approval'
  if (s.activity === 'waiting' && s.waitingOnWorkers) return 'waiting on workers'
  if (s.activity) return s.activity
  return s.status
}

/**
 * The context block, or `null` when there is nothing worth a single token.
 *
 * Deliberately reports only sessions agentop HOSTS. An assistant someone started by hand in another
 * terminal is visible to `agentop session list` as `external`, but nothing about it is capturable —
 * it has no task, no activity and no id to attach to — so naming it here would spend context on a
 * row that answers no question.
 */
export function planSessionContext(o: {
  sessions: readonly ContextSession[]
  /** The directory Claude Code was started in — scopes the "reopen this task" half. */
  cwd: string
  home?: string
  maxRows?: number
}): string | null {
  const home = o.home ?? ''
  const maxRows = o.maxRows ?? 8

  const running = o.sessions
    .filter(s => s.status === 'running')
    .slice()
    .sort((a, b) => rankOf(a.activity) - rankOf(b.activity) || a.id.localeCompare(b.id))

  const waiting = running.filter(s => s.activity === 'waiting-approval' || (s.activity === 'waiting' && !s.waitingOnWorkers))

  // A task is reopenable HERE when it has no live session left and at least one of its sessions sat
  // in this directory (or under it). Machine-wide it would be noise; scoped, it is the answer to
  // "what was I doing here".
  const liveTasks = new Set(running.map(s => s.task).filter((t): t is string => !!t))
  const reopen = new Map<string, number>()
  for (const s of o.sessions) {
    if (!s.task || liveTasks.has(s.task)) continue
    if (s.status === 'running' || s.status === 'external' || s.status === 'closed') continue
    if (!within(s.cwd, o.cwd)) continue
    reopen.set(s.task, (reopen.get(s.task) ?? 0) + 1)
  }

  if (running.length === 0 && reopen.size === 0) return null

  const lines: string[] = []

  if (running.length > 0) {
    const n = running.length
    // "2 of them are waiting" reads as a subset. When it is all of them, say so — the whole point
    // of the sentence is whether anything is blocked on the reader.
    const waitingNote = waiting.length === 0 ? ''
      : n === 1 ? ' It is waiting on a person.'
      : waiting.length === n ? ' All of them are waiting on a person.'
      : ` ${waiting.length} of them ${waiting.length === 1 ? 'is' : 'are'} waiting on a person.`
    lines.push(`agentop is hosting ${n} assistant session${n === 1 ? '' : 's'} on this machine.${waitingNote}`)
    for (const s of running.slice(0, maxRows)) {
      const bits = [
        shortId(s.id),
        stateWord(s),
        s.harness ?? '?',
        s.task ? `task "${s.task}"` : s.label ? `"${s.label}"` : '',
        tildePath(s.cwd, home),
      ].filter(Boolean)
      lines.push(`  ${bits.join('  ·  ')}`)
    }
    const hidden = running.length - Math.min(running.length, maxRows)
    if (hidden > 0) lines.push(`  …and ${hidden} more — \`agentop session list --json\``)
  }

  if (reopen.size > 0) {
    const named = [...reopen.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([task, n]) => `"${task}" (${n} session${n === 1 ? '' : 's'})`)
    lines.push(
      `Filed in this directory and not running: ${named.join(', ')} — reopen with \`agentop session open "<task>"\`.`,
    )
  }

  // Said outright, because injected context reads like an instruction otherwise: this is state, and
  // acting on it unasked is exactly what the skill tells you not to do.
  lines.push('These are facts about this machine, not a request. Do not attach, kill or start sessions unless asked.')

  return `<agentop-sessions>\n${lines.join('\n')}\n</agentop-sessions>`
}
