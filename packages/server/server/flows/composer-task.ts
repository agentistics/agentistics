import { createHash } from 'node:crypto'
import { validComposerTask } from '@agentistics/core'
import type { Subtask } from '../sessions/task-model'
import type { TaskStore } from '../sessions/task-store'
import { isOwnerComposerRequest, ownerMessageTarget } from './owner-message'

export interface ComposerTaskDeps {
  ready?(): Promise<boolean>
  target(id: string): Promise<{ taskId?: string; conversationId?: string } | undefined>
  store(): Promise<TaskStore>
  /** Direct runs deliberately bypass owner.message's automatic placement trigger. */
  run(name: string, inputs: Record<string, unknown>): Promise<unknown>
  now(): number
}
type Request = { id: string; text?: string; messageId?: string; asTask?: unknown; action?: unknown; session?: unknown; callerVerified?: unknown }
export type ComposerTaskResult = { ok: true; subtask: Subtask; note: string } | { ok: false; message: string }

/** The only future forecast integration point. Forecasts remain calculated on server projections. */
function requestForecast(_subtask: Subtask): void {
  // TODO(feat/registro-previsao, slice 6): call resolvePieceForecast once available on main;
  // do not store a guessed date or let the browser supply calculated forecast fields.
}

/** Registration precedes delivery, so a refusal leaves the draft intact. */
export async function registerComposerTask(req: Request, lang: 'pt' | 'en', d = defaultComposerTaskDeps()): Promise<ComposerTaskResult> {
  try { return await registerOnce(req, lang, d) } catch {
    return { ok: false, message: lang === 'pt' ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' }
  }
}

async function registerOnce(req: Request, lang: 'pt' | 'en', d: ComposerTaskDeps): Promise<ComposerTaskResult> {
  const pt = lang === 'pt'
  if (!isOwnerComposerRequest(req) || !validComposerTask(req.asTask) || typeof req.messageId !== 'string' || !/^[\w-]{1,120}$/.test(req.messageId) || !req.text?.trim()) {
    return { ok: false, message: pt ? 'Informe a mensagem, sua identificação, prioridade e um prazo válido opcional.' : 'Provide the message, its id, a priority and an optional valid due date.' }
  }
  const target = await d.target(req.id)
  if (!target?.taskId) return { ok: false, message: pt ? 'Vincule esta sessão ou seu líder a uma tarefa antes de criar uma subtarefa.' : 'File this session or its leader on a task before creating a subtask.' }
  if (d.ready && !await d.ready()) return { ok: false, message: pt ? 'O fluxo de registro de tarefas não está disponível nesta instância.' : 'The task registration flow is unavailable on this instance.' }
  const store = await d.store()
  const text = req.text.trim()
  const title = text.split(/\r?\n/)[0]!.trim().slice(0, 120)
  const at = new Date(d.now()).toISOString()
  const conversationId = target.conversationId ?? req.id
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
  const subtask = await store.registerComposerSubtask({
    id: `s-${hash(req.messageId)}`, taskId: target.taskId, title,
    status: 'todo', done: false, createdAt: at, updatedAt: at,
    // This request has not been dispatched yet: startedAt is stamped by ordinary filing.
    priority: req.asTask.priority, assignee: 'leader', notes: text,
    ...(req.asTask.dueDate ? { dueDate: req.asTask.dueDate } : {}),
    ownerRequest: { messageId: req.messageId, sessionId: req.id, conversationId, at, text,
      pedidoId: `p-${createHash('sha256').update(`${conversationId}\0${at}\0${text}`).digest('hex').slice(0, 12)}` },
  })
  if (!subtask?.ownerRequest) return { ok: false, message: pt ? 'A tarefa de destino não existe mais.' : 'The destination task no longer exists.' }
  if (subtask.ownerRequest.text !== text) return { ok: false, message: pt ? 'Esta identificação de mensagem já foi usada com outro texto.' : 'This message id was already used with different text.' }
  const r = subtask.ownerRequest
  // Retries use the ORIGINAL timestamp and text, including after a crash between these two runs.
  const registered = await d.run('pedido-do-dono', { sessionId: r.sessionId, conversationId: r.conversationId, taskId: subtask.taskId, text: r.text, at: r.at, role: 'leader', channel: 'composer-task' }) as { status?: string; output?: { pedido?: { state?: string; linkedSubtaskIds?: string[] } } }
  if (registered?.status !== 'success' || !registered.output?.pedido?.state) return { ok: false, message: pt ? 'A subtarefa foi salva, mas o pedido não foi registrado. Tente enviar novamente.' : 'The subtask was saved, but request registration failed. Retry sending.' }
  if (registered.output.pedido.state === 'linked' && !registered.output.pedido.linkedSubtaskIds?.includes(subtask.id)) return { ok: false, message: pt ? 'O pedido já está vinculado a outra subtarefa.' : 'The request is already linked to another subtask.' }
  if (registered.output?.pedido?.state === 'open') {
    const linked = await d.run('pedido-link', { id: r.pedidoId, subtaskIds: [subtask.id], by: 'owner:composer' }) as { status?: string }
    if (linked?.status !== 'success') {
      const checked = await d.run('pedido-do-dono', { sessionId: r.sessionId, conversationId: r.conversationId, taskId: subtask.taskId, text: r.text, at: r.at, role: 'leader', channel: 'composer-task' }) as { output?: { pedido?: { state?: string; linkedSubtaskIds?: string[] } } }
      if (checked.output?.pedido?.state !== 'linked' || !checked.output.pedido.linkedSubtaskIds?.includes(subtask.id)) return { ok: false, message: pt ? 'O pedido foi salvo, mas não vinculado. Tente enviar novamente.' : 'The request was saved, but not linked. Retry sending.' }
    }
  }
  requestForecast(subtask)
  return { ok: true, subtask, note: pt ? `Registrado como tarefa: ${subtask.title}` : `Registered as task: ${subtask.title}` }
}

export function defaultComposerTaskDeps(): ComposerTaskDeps {
  return {
    now: Date.now,
    ready: async () => {
      const { loadEngine, engine } = await import('../engine/load')
      await loadEngine()
      return process.env.AGENTISTICS_FLOWS === '1' && !!engine()?.flows
    },
    store: async () => (await (await import('../sessions/task-source')).loadTaskWorld()).store,
    target: async id => {
      const { readRegistry } = await import('../sessions/registry')
      const rows = await readRegistry()
      const row = ownerMessageTarget(id, rows)
      if (row?.taskId) return row
      // Only the verified parent chain is eligible; never pick an unrelated leader's task.
      const parent = row && rows.find(r => r.id === row.parentSessionId || (row.parentConversationId && r.conversationId === row.parentConversationId && !r.endedAt))
      if (parent?.taskId) return { ...row, taskId: parent.taskId }
      if (row) {
        const { effectiveRole } = await import('../sessions/session-roles')
        const candidates = rows.filter(r => !r.endedAt && r.cwd === row.cwd && r.taskId)
        const leaders = (await Promise.all(candidates.map(async r => await effectiveRole(r) === 'leader' ? r : null))).filter(r => r !== null)
        const taskIds = new Set(leaders.map(r => r.taskId!))
        if (taskIds.size === 1) return { ...row, taskId: [...taskIds][0]! }
      }
      const native = await (await import('../sessions/task-web')).nativeFilingOf(id)
      return native ?? undefined
    },
    run: async (name, inputs) => {
      const { loadEngine, engine } = await import('../engine/load')
      await loadEngine()
      if (!engine()?.flows) throw new Error('Task registration flows are unavailable')
      return engine()!.flows!.run(name, inputs)
    },
  }
}
