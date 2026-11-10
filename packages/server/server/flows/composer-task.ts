import { createHash } from 'node:crypto'
import { validComposerTask } from '@agentistics/core'
import type { Subtask } from '../sessions/task-model'
import type { TaskStore } from '../sessions/task-store'
import { isOwnerComposerRequest, ownerMessageTarget, prepareOwnerRequestFlows } from './owner-message'

export interface ComposerTaskDeps {
  ready?(): Promise<boolean>
  target(id: string): Promise<{ taskId?: string; conversationId?: string } | undefined>
  store(): Promise<TaskStore>
  /** Only explicit single-operation commands are allowed here; event-triggered flows use emit. */
  run(name: string, inputs: Record<string, unknown>): Promise<unknown>
  emit?(event: { type: string; id: string; payload: Record<string, unknown> }): Promise<unknown>
  sleep?(ms: number): Promise<void>
  now(): number
}
type Request = { id: string; text?: string; messageId?: string; asTask?: unknown; action?: unknown; session?: unknown; callerVerified?: unknown }
export type ComposerTaskResult = { ok: true; subtask: Subtask; note: string } | { ok: false; message: string }

// Forecast: none is stored here. buildLive runs resolvePieceForecast over every open piece (a queued one gets the
// bootstrap/general interval, flagged queueTimeUnknown), so the registered subtask carries its server forecast on read.

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
  const request = {
    messageId: req.messageId, sessionId: req.id, conversationId, at, text,
    pedidoId: `p-${createHash('sha256').update(`${conversationId}\0${at}\0${text}`).digest('hex').slice(0, 12)}`,
  }
  const existing = (await store.read()).subtasks.find(s => s.ownerRequest?.messageId === request.messageId)
  if (existing) {
    if (existing.ownerRequest?.text !== text) return { ok: false, message: pt ? 'Esta identificação de mensagem já foi usada com outro texto.' : 'This message id was already used with different text.' }
    return { ok: true, subtask: existing, note: pt ? `Registrado como tarefa: ${existing.title}` : `Registered as task: ${existing.title}` }
  }
  // H1 is event-only. In particular, never call pedido-do-dono through flows.run: the engine
  // deliberately rejects that operation because it is triggered exclusively by owner.message.
  const emit = d.emit ?? (async event => {
    const { engine } = await import('../engine/load')
    await prepareOwnerRequestFlows()
    const flows = engine()?.flows
    if (!flows?.emit) throw new Error('Task registration flows are unavailable')
    return flows.emit(event)
  })
  const beforeEvent = new Set((await store.read()).subtasks.map(s => s.id))
  const rollbackEventCards = async () => {
    const after = await store.read()
    // Never use the snapshot as ownership. Another request may have been recorded while the
    // event was in flight. Only a card carrying this request's durable identity is ours.
    await Promise.all(after.subtasks.filter(s => !beforeEvent.has(s.id) && s.taskId === target.taskId &&
      (s.ownerRequest?.pedidoId === request.pedidoId || s.ownerRequest?.messageId === request.messageId)).map(s => store.removeSubtask(s.id)))
  }
  const eventId = `owner.message:${conversationId}:${at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
  let emitted: unknown
  try {
    emitted = await emit({ type: 'owner.message', id: eventId, payload: {
      sessionId: req.id, conversationId, taskId: target.taskId, text, at,
      attachments: [], role: 'leader', channel: 'composer-task',
    } })
  } catch { await rollbackEventCards(); return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' } }
  if (emitted === false) { await rollbackEventCards(); return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' } }
  await rollbackEventCards()
  const subtask = await store.registerComposerSubtask({
    id: `s-${hash(req.messageId)}`, taskId: target.taskId, title,
    status: 'todo', done: false, createdAt: at, updatedAt: at,
    // This request has not been dispatched yet: startedAt is stamped by ordinary filing.
    priority: req.asTask.priority, assignee: 'leader', notes: text,
    ...(req.asTask.dueDate ? { dueDate: req.asTask.dueDate } : {}),
    ownerRequest: request,
  })
  if (!subtask?.ownerRequest) return { ok: false, message: pt ? 'A tarefa de destino não existe mais.' : 'The destination task no longer exists.' }
  if (subtask.ownerRequest.text !== text) return { ok: false, message: pt ? 'Esta identificação de mensagem já foi usada com outro texto.' : 'This message id was already used with different text.' }
  const r = subtask.ownerRequest
  // Retries use the ORIGINAL timestamp and text, including after a crash between these two runs.
  let linked: { status?: string } = {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      linked = await d.run('pedido-link', { id: r.pedidoId, subtaskIds: [subtask.id], by: 'owner:composer' }) as { status?: string }
    } catch { linked = {} }
    if (linked.status === 'success') break
    if (attempt < 2) await (d.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms))))(200)
  }
  if (linked?.status !== 'success') {
    await store.removeSubtask(subtask.id)
    return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' }
  }
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
