/**
 * harness-notice.ts — PURE. What the person is told when the harness's OWN build is the blocker.
 *
 * The engine refuses a start with `blocked: { kind: 'harness-version', need, found }` (engine-api 1.18) when
 * the installed harness is too old for what was asked — opencode below 1.18.0 on its free tier answers HTTP
 * 426 — and a tmux fallback would meet the same wall. The words are for someone who does not know what a
 * version or a terminal is: what is wrong, what to do about it (update it), never a command to type. The
 * `action` is data: a surface that has an "update" affordance offers it; none is invented here.
 */
import type { StructuredBlocked } from '@agentistics/engine-api'
import type { HarnessId } from '@agentistics/core'
import { SessionNotice } from './action-error'

const NAMES: Partial<Record<HarnessId, string>> = { opencode: 'OpenCode' }
const nameOf = (h: HarnessId): string => NAMES[h] ?? h

export function harnessBlockedNotice(harness: HarnessId, b: StructuredBlocked): SessionNotice {
  const name = nameOf(harness)
  const en = `${name} needs to be updated to version ${b.need} or newer before it can start a chat${b.found ? ` (this computer has ${b.found})` : ''}. Update ${name}, then start the session again.`
  const pt = `O ${name} precisa ser atualizado para a versão ${b.need} ou mais nova antes de iniciar uma conversa${b.found ? ` (este computador tem a ${b.found})` : ''}. Atualize o ${name} e inicie a sessão de novo.`
  return new SessionNotice(en, pt, { kind: 'update-harness', harness, need: b.need })
}

/**
 * A fork was asked for and cannot be done here: the harness's driver offers no fork, the spawn does not run
 * structured (a TUI cannot fork by itself), the engine is older than the fork contract, or the driver refused.
 * Nothing is started — a fork that quietly became a NEW, empty conversation would be a lie.
 */
export function forkUnavailableNotice(harness: HarnessId | null, why?: string): SessionNotice {
  const name = harness ? nameOf(harness) : null
  const en = `This ${name ? `${name} ` : ''}session cannot be forked here, so nothing was started. Reopen it as it was, or start a new session.${why ? ` (${why})` : ''}`
  const pt = `Esta sessão${name ? ` do ${name}` : ''} não pode ser ramificada aqui, então nada foi iniciado. Reabra-a como estava ou inicie uma nova sessão.${why ? ` (${why})` : ''}`
  return new SessionNotice(en, pt)
}
