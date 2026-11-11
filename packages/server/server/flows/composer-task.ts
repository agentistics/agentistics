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
  /** Canonical engine request: placement may have linked it before emit completes. */
  pedido?(id: string, taskId: string): Promise<{ id: string; taskId?: string; state: string; linkedSubtaskIds: string[] } | undefined>
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

/**
 * One registration at a time per task. The engine creates its "Owner's request" card asynchronously from the
 * event, and that card carries no ownerRequest (the engine is not ours to change), so the only way to know which
 * new cards belong to THIS request is for no other registration on the task to be in flight. Concurrent sends
 * used to share one engine queue: link retries (3 x 200ms) expired for the later ones, the subtask was rolled
 * back, and the flow's card then landed AFTER the rollback sweep, orphaned.
 */
const tails = new Map<string, Promise<unknown>>()
async function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => undefined)
  tails.set(key, tail)
  try { return await run } finally { if (tails.get(key) === tail) tails.delete(key) }
}

async function registerOnce(req: Request, lang: 'pt' | 'en', d: ComposerTaskDeps): Promise<ComposerTaskResult> {
  const pt = lang === 'pt'
  if (!isOwnerComposerRequest(req) || !validComposerTask(req.asTask) || typeof req.messageId !== 'string' || !/^[\w-]{1,120}$/.test(req.messageId) || !req.text?.trim()) {
    return { ok: false, message: pt ? 'Informe a mensagem, sua identificação, prioridade e um prazo válido opcional.' : 'Provide the message, its id, a priority and an optional valid due date.' }
  }
  const target = await d.target(req.id)
  if (!target?.taskId) return { ok: false, message: pt ? 'Vincule esta sessão ou seu líder a uma tarefa antes de criar uma subtarefa.' : 'File this session or its leader on a task before creating a subtask.' }
  return serialised(target.taskId, () => registerLocked(req, lang, d, target as { taskId: string; conversationId?: string }))
}

async function registerLocked(req: Request & { text?: string; messageId?: string; asTask?: unknown }, lang: 'pt' | 'en', d: ComposerTaskDeps, target: { taskId: string; conversationId?: string }): Promise<ComposerTaskResult> {
  const pt = lang === 'pt'
  if (!validComposerTask(req.asTask) || typeof req.messageId !== 'string' || !req.text?.trim()) throw new Error('unreachable')
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
  const sleep = d.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  /** Own cards only: new since the emit AND carrying this request's identity (ownerRequest, or the pedido id the flow writes in its title). */
  const rollbackEventCards = async (keepId?: string) => {
    const linked = await d.pedido?.(request.pedidoId, target.taskId)
    const after = await store.read()
    await Promise.all(after.subtasks.filter(s => s.id !== keepId && !linked?.linkedSubtaskIds.includes(s.id) && !beforeEvent.has(s.id) && s.taskId === target.taskId &&
      (s.ownerRequest?.pedidoId === request.pedidoId || s.ownerRequest?.messageId === request.messageId || (!s.ownerRequest && s.title.includes(request.pedidoId)))).map(s => store.removeSubtask(s.id)))
  }
  /** The flow's card can land after the first sweep; a failed registration sweeps again once it settles. */
  const failAndSweep = async () => { await rollbackEventCards(); await sleep(200); await rollbackEventCards() }
  const eventId = `owner.message:${conversationId}:${at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`
  let emitted: unknown
  try {
    emitted = await emit({ type: 'owner.message', id: eventId, payload: {
      sessionId: req.id, conversationId, taskId: target.taskId, text, at,
      attachments: [], role: 'leader', channel: 'composer-task',
    } })
  } catch { await failAndSweep(); return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' } }
  if (emitted === false) { await failAndSweep(); return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' } }
  const placed = await d.pedido?.(request.pedidoId, target.taskId)
  const placedCard = placed?.state === 'linked' && placed.taskId === target.taskId && placed.linkedSubtaskIds.length === 1
    ? (await store.read()).subtasks.find(s => s.id === placed.linkedSubtaskIds[0] && s.taskId === target.taskId && !s.ownerRequest && s.title.includes(request.pedidoId))
    : undefined
  // Encaixe already closes the pedido. Adopt its card atomically; removing it and calling pedido-link
  // again refuses an already-linked pedido and leaves the engine pointing at a deleted subtask.
  if (placed?.state === 'linked' && !placedCard) return { ok: false, message: pt ? 'O pedido já está vinculado a outra subtarefa. Confira o Agentask antes de tentar novamente.' : 'The request is already linked to another subtask. Check Agentask before retrying.' }
  if (!placedCard) await rollbackEventCards()
  const subtask = await store.registerComposerSubtask({
    ...(placedCard ?? {}), id: placedCard?.id ?? `s-${hash(req.messageId)}`, taskId: target.taskId, title,
    status: placedCard?.status ?? 'todo', done: placedCard?.done ?? false, createdAt: placedCard?.createdAt ?? at, updatedAt: at,
    // This request has not been dispatched yet: startedAt is stamped by ordinary filing.
    priority: req.asTask.priority, assignee: placedCard?.assignee ?? 'leader', notes: text,
    ...(req.asTask.dueDate ? { dueDate: req.asTask.dueDate } : {}),
    ownerRequest: request,
  })
  if (!subtask?.ownerRequest) return { ok: false, message: pt ? 'A tarefa de destino não existe mais.' : 'The destination task no longer exists.' }
  if (subtask.ownerRequest.text !== text) return { ok: false, message: pt ? 'Esta identificação de mensagem já foi usada com outro texto.' : 'This message id was already used with different text.' }
  const r = subtask.ownerRequest
  // Retries use the ORIGINAL timestamp and text, including after a crash between these two runs.
  let linked: { status?: string } = placedCard ? { status: 'success' } : {}
  for (let attempt = 0; !placedCard && attempt < 3; attempt++) {
    try {
      linked = await d.run('pedido-link', { id: r.pedidoId, subtaskIds: [subtask.id], by: 'owner:composer' }) as { status?: string }
    } catch { linked = {} }
    if (linked.status === 'success') break
    if (attempt < 2) await sleep(200)
  }
  if (linked?.status !== 'success') {
    // A link can commit before its response fails. The canonical document decides whether it landed.
    const recorded = await d.pedido?.(r.pedidoId, target.taskId)
    if (!(recorded?.state === 'linked' && recorded.taskId === target.taskId && recorded.linkedSubtaskIds.length === 1 && recorded.linkedSubtaskIds[0] === subtask.id)) {
      if (!recorded?.linkedSubtaskIds.includes(subtask.id)) await store.removeSubtask(subtask.id)
      await failAndSweep()
      return { ok: false, message: pt ? 'Não foi possível concluir o registro da tarefa. Tente enviar novamente.' : 'Task registration could not finish. Retry sending.' }
    }
  }
  await rollbackEventCards(subtask.id)
  return { ok: true, subtask, note: pt ? `Registrado como tarefa: ${subtask.title}` : `Registered as task: ${subtask.title}` }
}

export function defaultComposerTaskDeps(): ComposerTaskDeps {
  return {
    now: Date.now,
    ready: async () => {
      const { loadEngine, engine } = await import('../engine/load')
      await loadEngine()
      return process.env.AGENTISTICS_FLOWS === '1' && !!engine()?.flows?.emit && !!engine()?.flows?.read
    },
    store: async () => (await (await import('../sessions/task-source')).loadTaskWorld()).store,
    pedido: async (id, taskId) => {
      const { engine } = await import('../engine/load')
      const view = await engine()?.flows?.read?.('pedidos', { taskId, state: 'all' }) as { pedidos?: Array<{ id: string; taskId?: string; state: string; linkedSubtaskIds: string[] }> } | undefined
      return view?.pedidos?.find(p => p.id === id)
    },
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
