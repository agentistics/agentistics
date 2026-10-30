/**
 * owner-message.ts — ORQ.H1's emitter: the OWNER's composer message to a managed session, as the
 * `owner.message` event of the engine's flows bus.
 *
 * Only the owner's composer path reaches here (`/api/fleet/act` prompt carrying NO session proof,
 * `isOwnerComposerRequest`), and the text still goes through the hand-off relay's classifier: a relay (`[from session …]`,
 * `[from flow …]`, `<agent-message>`), a context block, a task notification or any other system
 * entry is NOT an owner message and emits nothing. Leaders' messages become pedidos; a worker's
 * becomes a comment on its subtask (the engine decides — the role travels in the payload).
 * Best effort and never on the delivery path: a failure here never fails the send.
 */
import { createHash } from 'node:crypto'
import { isOwnerTurn } from '../sessions/handoff-relay'

export interface OwnerMessageDeps {
  flowsOn(): boolean
  /** The registry row the composer targeted (by managed id or conversation id). */
  row(id: string): Promise<{ id: string; conversationId?: string; taskId?: string; subtaskId?: string } | undefined>
  roleOf(row: { id: string; conversationId?: string }): Promise<string | undefined>
  /** The owner's saved `ownerRequestMode` preference, when set. */
  mode(): Promise<string | undefined>
  emit(event: { type: string; id: string; payload: Record<string, unknown> }): Promise<unknown>
  now(): number
}

export type OwnerMessageOutcome = 'emitted' | 'flows-off' | 'not-composer' | 'not-owner' | 'no-session' | 'no-role'

/**
 * PURE. A composer prompt from the web/TUI as the owner sends it: `action: prompt` and NO session proof at
 * all (a body carrying `session`, valid or not, is a session's). This is the honest rule until the owner
 * credential exists (SECRETS.4): a process that crafts the same raw request is indistinguishable, so a
 * pedido it creates is a known limit — and a pedido closes, overrides or bypasses nothing.
 */
export function isOwnerComposerRequest(body: { action?: unknown; session?: unknown; callerVerified?: unknown }): boolean {
  return body.action === 'prompt' && body.session === undefined && body.callerVerified !== true
}

export async function emitOwnerMessage(req: { id: string; text?: string; channel?: string; action?: unknown; session?: unknown; callerVerified?: unknown }, deps: OwnerMessageDeps): Promise<OwnerMessageOutcome> {
  if (!deps.flowsOn()) return 'flows-off'
  if (!isOwnerComposerRequest(req)) return 'not-composer'
  const text = (req.text ?? '').trim()
  if (!isOwnerTurn({ role: 'user', text })) return 'not-owner'
  const row = await deps.row(req.id)
  if (!row) return 'no-session'
  const role = await deps.roleOf(row).catch(() => undefined)
  if (role !== 'leader' && role !== 'worker') return 'no-role'
  const at = new Date(deps.now()).toISOString()
  const conversationId = row.conversationId ?? row.id
  const mode = await deps.mode().catch(() => undefined)
  await deps.emit({
    type: 'owner.message',
    id: `owner.message:${conversationId}:${at}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
    payload: {
      sessionId: row.id, conversationId, text, attachments: [], at, channel: req.channel ?? 'app', role,
      ...(row.taskId ? { taskId: row.taskId } : {}), ...(row.subtaskId ? { subtaskId: row.subtaskId } : {}),
      ...(mode ? { mode } : {}),
    },
  })
  return 'emitted'
}

export function defaultOwnerMessageDeps(): OwnerMessageDeps {
  return {
    flowsOn: () => process.env.AGENTISTICS_FLOWS === '1',
    row: async id => {
      const row = (await (await import('../sessions/registry')).readRegistry()).find(m => m.id === id || m.conversationId === id)
      return row ? { id: row.id, ...(row.conversationId ? { conversationId: row.conversationId } : {}), ...(row.taskId ? { taskId: row.taskId } : {}), ...(row.subtaskId ? { subtaskId: row.subtaskId } : {}) } : undefined
    },
    roleOf: async row => (await import('../sessions/session-roles')).storedRoleFor([row.conversationId, row.id]),
    mode: async () => {
      const prefs = await (await import('../preferences')).readPreferences() as { ownerRequestMode?: unknown }
      return typeof prefs.ownerRequestMode === 'string' ? prefs.ownerRequestMode : undefined
    },
    emit: async event => {
      const { engine } = await import('../engine/load')
      return engine()?.flows?.emit?.(event)
    },
    now: () => Date.now(),
  }
}
