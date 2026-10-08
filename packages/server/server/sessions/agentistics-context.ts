/**
 * agentistics-context.ts — PURE. The text a harness is told at spawn about where it is running.
 *
 * ONE file holds every word (`CONTEXT_STRINGS`, PT + EN) so the owner can edit the wording without
 * touching delivery. `spawn-spec.ts` decides HOW each harness receives it (official flag, env dir,
 * or the first-message fallback); this module only decides WHAT it says.
 *
 * Harness-neutral on purpose: no sentence mentions a tool only one CLI has. Spec:
 * docs/superpowers/specs/2026-10-08-session-context-injection.md
 */

export type ContextLang = 'en' | 'pt'

export interface ContextInput {
  lang: ContextLang
  /** The managed session id (`AGENTOP_MANAGED_ID`). */
  sessionId: string
  /** Set when the session was created from an Agentask task. */
  taskId?: string
  taskTitle?: string
}

/** The block is fenced so the chat UI can recognise it and render it collapsed. */
export const CONTEXT_OPEN = '<agentistics-context>'
export const CONTEXT_CLOSE = '</agentistics-context>'

interface Strings {
  /** Collapsed-block label the chat UI shows. */
  label: string
  intro: (id: string) => string
  task: (taskId: string, title: string) => string
  progress: string
  secrets: string
  ask: string
  ports: string
}

export const CONTEXT_STRINGS: Record<ContextLang, Strings> = {
  pt: {
    label: 'contexto do agentistics',
    intro: id => `Você está rodando dentro do agentistics (sessão ${id}), um painel que gerencia e mede sessões de assistentes de código.`,
    task: (taskId, title) => `Esta sessão foi criada a partir da tarefa ${taskId}${title ? ` — "${title}"` : ''} do Agentask.`,
    progress: 'Registre seu progresso nela com as ferramentas MCP do agentistics (agentistics_task_comment para comentar, agentistics_task_status para mudar o status).',
    secrets: 'Segredos (chaves, tokens) vêm do cofre: use referências vault://nome. Nunca peça ao usuário para colar uma chave no chat.',
    ask: 'Para perguntar algo ao usuário, escreva a pergunta direto na conversa e espere a resposta; ele a vê no painel do agentistics.',
    ports: 'Nunca suba servidores nas portas 47291 e 47292: são do próprio agentistics.',
  },
  en: {
    label: 'agentistics context',
    intro: id => `You are running inside agentistics (session ${id}), a dashboard that manages and measures coding-assistant sessions.`,
    task: (taskId, title) => `This session was created from Agentask task ${taskId}${title ? ` — "${title}"` : ''}.`,
    progress: 'File your progress there with the agentistics MCP tools (agentistics_task_comment to comment, agentistics_task_status to change status).',
    secrets: 'Secrets (keys, tokens) come from the vault: use vault://name references. Never ask the user to paste a key into the chat.',
    ask: 'To ask the user something, write the question in the conversation and wait for the reply; they see it in the agentistics panel.',
    ports: 'Never start servers on ports 47291 and 47292: they belong to agentistics itself.',
  },
}

/** The context as plain lines — what `--append-system-prompt` and friends receive. */
export function contextText(i: ContextInput): string {
  const s = CONTEXT_STRINGS[i.lang]
  const lines = [s.intro(i.sessionId)]
  if (i.taskId) lines.push(s.task(i.taskId, i.taskTitle ?? ''), s.progress)
  lines.push(s.secrets, s.ask, s.ports)
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
