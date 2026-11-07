/**
 * owner-message.ts — ORQ.H1's emitter: the OWNER's composer message to a managed session, as the
 * `owner.message` event of the engine's flows bus.
 *
 * Every confirmed owner composer send reaches here (HTTP, TUI and late confirmations), carrying NO session proof.
 * The text goes through the hand-off relay's classifier: an ordinary relay (`[from session …]`,
 * `[from flow …]`, `<agent-message>`), a context block, a task notification or any other system
 * entry is NOT an owner message and emits nothing. Leaders' messages become pedidos; a worker's
 * becomes a comment on its subtask (the engine decides — the role travels in the payload).
 * Trusted handoff readers emit original owner turns separately, retaining their conversation and timestamp.
 * A failure here never changes a confirmed send's outcome.
 */
import { createHash } from 'node:crypto'
import { isOwnerTurn } from '../sessions/handoff-relay'
import type { ManagedSession } from '../sessions/types'
import type { EngineCommand } from '@agentistics/engine-api'

/** The mandatory owner-request path uses the engine's own switches, not a second request store. */
export async function enableOwnerRequestFlows(commands: readonly EngineCommand[]): Promise<void> {
  const flow = commands.find(c => c.verb === 'flow')
  if (!flow) throw new Error('the official flow command is unavailable')
  const lines: string[] = []
  const io = { out: (s: string) => { lines.push(s) }, err: (_s: string) => {} }
  if (await flow.run(['ls'], io) !== 0) throw new Error('owner-request flow switches could not be read')
  for (const name of ['pedido-do-dono', 'encaixe-do-pedido']) {
    if (lines.some(line => line.trim() === `${name}\tenabled`)) continue
    if (await flow.run(['enable', name], io) !== 0) throw new Error(`mandatory owner-request flow ${name} could not be enabled`)
  }
}

export async function prepareOwnerRequestFlows(): Promise<boolean> {
  if (process.env.AGENTISTICS_FLOWS !== '1') return false
  const load = await import('../engine/load')
  await load.loadEngine()
  const current = load.engine()
  if (!current?.flows?.emit) return false
  await enableOwnerRequestFlows(current.commands)
  return true
}

/** Resolve a retired leader through handoffs and reopenings before recording who owns its request now. */
export function ownerMessageTarget(id: string, registry: readonly ManagedSession[]): ManagedSession | undefined {
  let row = registry.find(m => m.id === id || m.conversationId === id)
  const seen = new Set<string>()
  while (row && !seen.has(row.id)) {
    seen.add(row.id)
    const next = (row.handoffTo ? registry.find(m => m.id === row!.handoffTo) : undefined)
      ?? (row.endedAt && row.conversationId ? registry.find(m => m.id !== row!.id && !m.endedAt && m.conversationId === row!.conversationId) : undefined)
    if (!next || seen.has(next.id)) break
    row = { ...next, taskId: next.taskId ?? row.taskId }
  }
  return row
}

export interface OwnerMessageDeps {
  flowsOn(): boolean
  /** The registry row the composer targeted (by managed id or conversation id). */
  row(id: string): Promise<{ id: string; conversationId?: string; taskId?: string; subtaskId?: string; leader?: boolean } | undefined>
  roleOf(row: { id: string; conversationId?: string; leader?: boolean }): Promise<string | undefined>
  /** A relay may already have been captured at the original composer; only relays consult this. */
  recorded?(conversationId: string, text: string, at: string, taskId?: string): Promise<boolean>
  /** The owner's saved `ownerRequestMode` preference, when set. */
  mode(): Promise<string | undefined>
  emit(event: { type: string; id: string; payload: Record<string, unknown> }): Promise<unknown>
  now(): number
}

export type OwnerMessageOutcome = 'emitted' | 'flows-off' | 'no-engine' | 'not-composer' | 'not-owner' | 'no-session' | 'no-role'

/**
 * PURE. A composer prompt from the web/TUI as the owner sends it: `action: prompt` and NO session proof at
 * all (a body carrying `session`, valid or not, is a session's). This is the honest rule until the owner
 * credential exists (SECRETS.4): a process that crafts the same raw request is indistinguishable, so a
 * pedido it creates is a known limit — and a pedido closes, overrides or bypasses nothing.
 */
export function isOwnerComposerRequest(body: { action?: unknown; session?: unknown; callerVerified?: unknown }): boolean {
  return body.action === 'prompt' && body.session === undefined && body.callerVerified !== true
}

export async function emitOwnerMessage(req: { id: string; text?: string; channel?: string; action?: unknown; session?: unknown; callerVerified?: unknown }, deps: OwnerMessageDeps, source: { at?: string; conversationId?: string } = {}): Promise<OwnerMessageOutcome> {
  if (!deps.flowsOn()) return 'flows-off'
  if (!isOwnerComposerRequest(req)) return 'not-composer'
  const text = (req.text ?? '').trim()
  if (!isOwnerTurn({ role: 'user', text })) return 'not-owner'
  const row = await deps.row(req.id)
  if (!row) return 'no-session'
  const role = await deps.roleOf(row).catch(() => undefined)
  if (role !== 'leader' && role !== 'worker') return 'no-role'
  const at = source.at && Number.isFinite(Date.parse(source.at)) ? source.at : new Date(deps.now()).toISOString()
  const conversationId = source.conversationId ?? row.conversationId ?? row.id
  if (req.channel === 'handoff-relay' && await deps.recorded?.(conversationId, text, at, row.taskId)) return 'emitted'
  const mode = await deps.mode().catch(() => undefined)
  const emitted = await deps.emit({
    type: 'owner.message',
    id: `owner.message:${conversationId}:${at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    payload: {
      sessionId: row.id, conversationId, text, attachments: [], at, channel: req.channel ?? 'app', role,
      ...(row.taskId ? { taskId: row.taskId } : {}), ...(row.subtaskId ? { subtaskId: row.subtaskId } : {}),
      ...(mode ? { mode } : {}),
    },
  })
  return emitted === false ? 'no-engine' : 'emitted'
}

/** Called only by the trusted handoff reader, with original owner turns, never by parsing an agent's prose. */
export async function emitRelayedOwnerMessages(targetId: string, source: { id: string; conversationId?: string; createdAt?: string }, messages: readonly { text: string; at?: string; label?: string }[], deps = defaultOwnerMessageDeps()): Promise<void> {
  for (const message of messages) {
    if (message.label || !isOwnerTurn({ role: 'user', text: message.text })) continue
    await emitOwnerMessage({ id: targetId, action: 'prompt', channel: 'handoff-relay', text: message.text }, deps, {
      conversationId: source.conversationId ?? source.id,
      ...(message.at || source.createdAt ? { at: message.at ?? source.createdAt } : {}),
    })
  }
}

export function defaultOwnerMessageDeps(): OwnerMessageDeps {
  return {
    flowsOn: () => process.env.AGENTISTICS_FLOWS === '1',
    row: async id => {
      return ownerMessageTarget(id, await (await import('../sessions/registry')).readRegistry())
    },
    roleOf: async row => (await (await import('../sessions/session-roles')).storedRoleFor([row.conversationId, row.id])) ?? (row.leader ? 'leader' : undefined),
    recorded: async (conversationId, text, at, taskId) => {
      const { engine } = await import('../engine/load')
      const view = await engine()?.flows?.read?.('pedidos', { taskId }) as { pedidos?: Array<{ conversationId?: string; text?: string; at?: string }> } | undefined
      return view?.pedidos?.some(p => p.conversationId === conversationId && p.text === text && Math.abs(Date.parse(p.at ?? '') - Date.parse(at)) < 60_000) ?? false
    },
    mode: async () => {
      const prefs = await (await import('../preferences')).readPreferences() as { ownerRequestMode?: unknown }
      return typeof prefs.ownerRequestMode === 'string' ? prefs.ownerRequestMode : undefined
    },
    emit: async event => {
      const { engine } = await import('../engine/load')
      if (!(await prepareOwnerRequestFlows())) return false
      return engine()!.flows!.emit!(event)
    },
    now: () => Date.now(),
  }
}
