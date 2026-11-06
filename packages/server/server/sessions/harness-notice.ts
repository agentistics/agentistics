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

/**
 * NAY.ADAPTER — the Nay starts ONLY on the structured route (the adapter), never as a terminal session. When
 * that road is closed the start is REFUSED in words: a Nay that quietly became a TUI is a chat panel with no
 * conversation behind it. `why` says which door is shut so the sentence can send the person the right way:
 *  - `engine`: the adapter chat is off (flag OFF, or a build without the engine) → the Nay is unavailable;
 *  - `driver`: this assistant has no ready driver → offer the ones that have (`ready`);
 *  - `mode`/`refused`: the driver cannot start it as asked / the start was refused.
 */
export function nayStartRefusedNotice(why: 'engine' | 'driver' | 'refused', harness: HarnessId | null, ready: readonly HarnessId[]): SessionNotice {
  const name = harness ? nameOf(harness) : null
  if (why === 'engine') {
    return new SessionNotice(
      'Nay needs the agentistics engine, which is not available in this build (or the engine chat is switched off). Nothing was started.',
      'A Nay precisa do motor do agentistics, que não está disponível nesta instalação (ou o chat do motor está desligado). Nada foi iniciado.',
    )
  }
  const list = ready.map(nameOf).join(', ')
  const offer = ready.length > 0
  const reason = why === 'driver'
    ? `${name ?? 'This assistant'} has no ready connection to run the Nay`
    : `${name ?? 'The assistant'} refused to start the Nay`
  const reasonPt = why === 'driver'
    ? `${name ? `O ${name}` : 'Este assistente'} não tem conexão pronta para rodar a Nay`
    : `${name ? `O ${name}` : 'O assistente'} recusou iniciar a Nay`
  return new SessionNotice(
    `${reason}, so nothing was started.${offer ? ` Pick another assistant: ${list}.` : ''}`,
    `${reasonPt}, então nada foi iniciado.${offer ? ` Escolha outro assistente: ${list}.` : ''}`,
  )
}
