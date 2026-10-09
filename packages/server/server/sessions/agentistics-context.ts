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
  /** Specification/design skills installed for this session's harness. Phase 2 may store the role. */
  specSkills?: readonly string[]
  /** TODO(phase 2): stored role and `agentistics_session_role` will choose the role line. */
  role?: 'leader' | 'worker'
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

const TOOL_GROUPS = {
  Tasks: [
    'agentistics_tasks', 'agentistics_task', 'agentistics_task_create', 'agentistics_task_status', 'agentistics_task_statuses',
    'agentistics_task_types', 'agentistics_task_type_edit', 'agentistics_task_status_edit', 'agentistics_task_comment',
    'agentistics_task_subtask', 'agentistics_task_link', 'agentistics_task_blocked_by', 'agentistics_task_next',
    'agentistics_task_claim', 'agentistics_task_activity', 'agentistics_task_edit', 'agentistics_task_session', 'agentistics_task_delete',
  ],
  Sessions: ['agentistics_sessions', 'agentistics_session_groups', 'agentistics_session_group_create', 'agentistics_session_group_edit', 'agentistics_session_notify', 'agentistics_session_message'],
  Metrics: ['agentistics_summary', 'agentistics_costs', 'agentistics_projects', 'agentistics_repos', 'agentistics_harnesses', 'agentistics_tags', 'agentistics_tag_detail'],
  Dashboards: ['agentistics_component_catalog', 'agentistics_get_layouts', 'agentistics_create_layout', 'agentistics_add_component', 'agentistics_remove_component', 'agentistics_set_active_layout', 'agentistics_delete_layout', 'agentistics_export_pdf', 'agentistics_build_layout'],
} as const

/** The context's tool inventory, kept explicit so the MCP registry parity test can guard it. */
export const CONTEXT_TOOL_NAMES = Object.values(TOOL_GROUPS).flat()

/**
 * The context as plain lines — what `--append-system-prompt` and friends receive. ENGLISH only: it
 * is read by the model, and the UI label is the only part a person sees. A section whose data is
 * absent is omitted, never printed empty.
 */
export function contextText(i: ContextInput): string {
  const lines = [
    CONTEXT_HEADER,
    `You are running inside agentistics, an app that manages and measures coding-assistant sessions. Session: ${i.sessionId}. Project folder: ${i.cwd}.`,
    'Tools — the "agentistics" MCP server gives you (grouped by purpose):',
    `- Tasks (Agentask): ${TOOL_GROUPS.Tasks.join(', ')} — plan, claim, edit, link, comment, coordinate, and close work.`,
    `- Sessions: ${TOOL_GROUPS.Sessions.join(', ')} — list, message another session, notify the user, and organise sidebar folders.`,
    `- Metrics: ${TOOL_GROUPS.Metrics.join(', ')} — summary, costs, projects, repos, harnesses, and tags.`,
    `- Dashboards: ${TOOL_GROUPS.Dashboards.join(', ')} — layouts, components, and PDF export.`,
  ]
  lines.push(
    'Your role here: decide from the request. LEADER organises: break the request into Agentask tasks/subtasks, propose which sessions to open (harness + model each), follow them, have each delivery QA\'d by a different model, and report to the user; do not implement big pieces yourself. WORKER implements one defined piece, tests, commits, and reports to whoever started it. AUTO: one piece → worker; several fronts → leader; you may become leader if the work grows.',
    'Becoming leader: rename this session to "[ LEADER ] - <title>" (UI in English) or "[ LÍDER ] - <title>" (UI in Portuguese), keeping the user\'s title; propose a title and wait for the user\'s OK if needed. If you started the session, pick the title. Phase 2 will add the stored role; when present, print the role-specific line. TODO: `role?: \'leader\' | \'worker\'` is reserved in the input type.',
    'Open other sessions only after the user explicitly approves: `agentop session <harness> --bg --cwd <dir> --name "<title>" -p "<request>"` or `agentop session batch --task "<task>" …`. Every opened session is a WORKER; for a leader hand-off, tell the user it is a leader hand-off (TODO: phase 2 `--role leader` if the CLI supports it). File each opened session on its subtask and in the task\'s folder.',
    'Model/harness balance: use the strongest model for design, coordination, and hard bugs; a mid model for clearly scoped implementation; a light model for probes/screenshots; QA must use a different model from the author. Respect the user\'s usage rules. No usage rules are saved in phase 1: before proposing sessions, ask the user once what plans, quotas, and preferences they allow.',
    'Specification skill rule: if you are a leader, or a worker facing a complex implementation, ASK the user in this session whether to use a specification skill (SDD, such as superpowers). Use it only after a yes; never make it automatic. If none is installed for this harness, you may suggest installing one, but install only after the user\'s OK. Never start every session with it.',
    'Owner rule: do NOT suggest or ask about a specification skill when a brief, specification, or plan already exists — for example, a worker started by a leader with one, or when the user already gave one. A leader starting a worker must pass the specification path or text in the worker prompt; that worker never asks about specification skills in that case.',
    'For tests, servers, previews, and QA use `agentop run --rm -- <command>` so the run has its own HOME, ports, terminal, and memory cap. Never test in the user\'s real environment; stop processes only by the PID you saved, never by name.',
    'Commit at every green milestone — only commits survive a reboot.',
    ...(i.role ? [`Your stored role: ${i.role.toUpperCase()}.`] : []),
  )
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
  if (i.specSkills && i.specSkills.length > 0) lines.push(`Specification skills installed for this harness: ${i.specSkills.join(', ')}`)
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
