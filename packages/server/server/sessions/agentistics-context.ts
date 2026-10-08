/**
 * agentistics-context.ts — PURE. The text a harness is told at spawn about where it is running.
 *
 * ONE file holds every word (`contextText`, English — the model reads it) so the owner can edit the
 * wording without touching delivery. `spawn-spec.ts` decides HOW each harness receives it (official flag, env dir,
 * or the first-message fallback); this module only decides WHAT it says.
 *
 * Harness-neutral on purpose: no sentence mentions a tool only one CLI has. Spec:
 * docs/superpowers/specs/2026-10-08-session-context-injection.md
 */

export type ContextLang = 'en' | 'pt'

export interface ContextInput {
  /** The managed session id (`AGENTOP_MANAGED_ID`). */
  sessionId: string
  /** The folder the session works in. */
  cwd: string
  /** Set when the session was created from an Agentask task. Optional: most sessions have none. */
  taskId?: string
  taskTitle?: string
  /** Set when it was created from one subtask of that task. */
  subtaskId?: string
  subtaskTitle?: string
  /** Set when another managed session started this one: its id and (best effort) its title. */
  parentId?: string
  parentTitle?: string
  /** Display names of the harnesses installed here (the fleet's own detection). Omitted when unknown. */
  harnesses?: readonly string[]
}

/** The block is fenced so the chat UI can recognise it and render it collapsed. */
export const CONTEXT_OPEN = '<agentistics-context>'
export const CONTEXT_CLOSE = '</agentistics-context>'

/**
 * First line of the text in EVERY channel. The context is background for the model, never a turn:
 * without this a harness answers it ("Understood!") before the person has said anything.
 */
export const CONTEXT_HEADER =
  "Background context from agentistics — not a message from the user. Do not reply to it, summarize it or acknowledge it; keep it in mind and respond only to the user's actual request."

/** The collapsed-block label the chat UI shows (UI chrome, not model text). */
export const CONTEXT_LABEL: Record<ContextLang, string> = {
  pt: 'contexto do agentistics',
  en: 'agentistics context',
}

/**
 * The context as plain lines — what `--append-system-prompt` and friends receive. ENGLISH only: it
 * is read by the model, and the UI label is the only part a person sees. A section whose data is
 * absent is omitted, never printed empty.
 */
export function contextText(i: ContextInput): string {
  const lines = [
    CONTEXT_HEADER,
    `You are running inside agentistics, an app that manages and measures coding-assistant sessions. Session: ${i.sessionId}. Project folder: ${i.cwd}.`,
    'Tools — the "agentistics" MCP server gives you:',
    '- Tasks (Agentask): agentistics_tasks, agentistics_task, agentistics_task_create, agentistics_task_subtask, agentistics_task_comment, agentistics_task_status, agentistics_task_session — plan, record and close work.',
    '- Sessions and sidebar folders: agentistics_sessions, agentistics_session_groups, agentistics_session_group_create, agentistics_session_group_edit, agentistics_session_notify.',
    '- Metrics: agentistics_summary, agentistics_costs, agentistics_projects, agentistics_repos, agentistics_harnesses.',
  ]
  if (i.taskId) {
    const sub = i.subtaskId ? `, subtask ${i.subtaskId}${i.subtaskTitle ? ` "${i.subtaskTitle}"` : ''}` : ''
    lines.push(
      `This session belongs to Agentask task ${i.taskId}${i.taskTitle ? ` "${i.taskTitle}"` : ''}${sub}. Record progress there: comment on the subtask (or the task) at each milestone and move its status; never mark it done before the user validates.`,
    )
  } else {
    lines.push('This session is not linked to a task. If the work grows beyond a quick question, offer to file it in Agentask — ask first.')
  }
  if (i.parentId) {
    lines.push(
      `You were started by session ${i.parentId}${i.parentTitle ? ` ("${i.parentTitle}")` : ''}. When you finish, get blocked or need a decision, report to it with agentistics_session_message (kind: handback | block | question) — not to the user — and keep working only on what it asked.`,
    )
  }
  if (i.harnesses && i.harnesses.length > 0) lines.push(`Harnesses installed on this machine: ${i.harnesses.join(', ')}.`)
  lines.push(
    'Rules:',
    '- Never start, delegate to or orchestrate another session or harness on your own. You may SUGGEST it (which harness, why, what it would do); start it only after the user explicitly approves in this conversation.',
    '- Secrets come from the vault: use vault://name references. Never ask the user to paste a key and never print a secret.',
    '- Ports 47291 and 47292 belong to agentistics: never start, stop or bind anything there; never run `agentop upgrade`; never restart the agentistics service.',
    '- Never open public tunnels (ngrok, cloudflared, etc.) to this machine.',
    `- Do not delete, move or rewrite files outside ${i.cwd} without asking.`,
    "- Clean up after yourself: when a session you started has finished and its work is committed/pushed, close it (agentop session kill) and file it in the task's finished folder; when a git worktree you created has been merged or published, remove it (git worktree remove) — never leave finished sessions, worktrees, temp servers or temp files accumulating on the user's machine. Ask before removing anything you did not create.",
    "- Keep the user's sidebar organised: sessions you create with approval go into their task's folder.",
    '- To ask the user something, write the question in the conversation and wait; they answer from the agentistics app or their phone.',
  )
  return lines.join('\n')
}

/**
 * The fallback shape: the same text, fenced, to PREPEND to the first user message of a harness with
 * no verified system channel. The fence is what the chat UI keys on to collapse it.
 */
export function contextBlock(i: ContextInput): string {
  return `${CONTEXT_OPEN}\n${contextText(i)}\n${CONTEXT_CLOSE}`
}

/** `contextBlock` + the person's own prompt. */
export function prependContext(block: string, prompt: string): string {
  return `${block}\n\n${prompt}`
}

/** Remove a leading context block from a message (chat rendering / tests). Null when none. */
export function splitContextBlock(text: string): { block: string; rest: string } | null {
  if (!text.startsWith(CONTEXT_OPEN)) return null
  const end = text.indexOf(CONTEXT_CLOSE)
  if (end < 0) return null
  return { block: text.slice(0, end + CONTEXT_CLOSE.length), rest: text.slice(end + CONTEXT_CLOSE.length).replace(/^\s+/, '') }
}

/** The note the chat draws, between turns, where a context travelled inside the first message. */
export const CONTEXT_SENT_NOTE = 'agentistics context sent'

/**
 * For OUR chat: a user turn that opens with the fenced context shows ONLY what the person typed,
 * and the context itself becomes one small system chip just before it. The fenced block never
 * reaches a bubble, collapsed or not. A turn carrying nothing but the block (held context sent
 * alone by an older build) is replaced by the chip alone.
 */
export function stripContextTurns<T extends { role: string; text: string; system?: string }>(turns: T[]): T[] {
  const out: T[] = []
  for (const t of turns) {
    const split = t.role === 'user' && !t.system ? splitContextBlock(t.text) : null
    if (!split) { out.push(t); continue }
    out.push({ ...t, text: '', system: CONTEXT_SENT_NOTE })
    if (split.rest !== '') out.push({ ...t, text: split.rest })
  }
  return out
}
