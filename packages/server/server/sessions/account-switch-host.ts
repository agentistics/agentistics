/**
 * account-switch-host.ts — CONTA.TROCA, the ACT. One implementation behind every door (the HTTP
 * route, `agentop session switch-account`, the MCP tool): decide, end, copy, resume.
 *
 * The order is the safety:
 *  1. DECIDE everything that can refuse (`decideSwitch`, the files on disk, the copy plan) while the
 *     session is still running — a refusal must cost the person nothing.
 *  2. Under the conversation's resume lock (the same lock every reopen takes, so a double click or a
 *     second tab cannot start two copies), END the process.
 *  3. COPY the conversation into the target account's root — after the process ended, so the copy
 *     carries its last line whole. Never a move.
 *  4. RESUME the same conversation id on the target account, replacing the row: the reopen path
 *     retires the old row and carries its identity (name, note, task, role) onto the new one, so
 *     there are never two live rows. A copy that fails, or a target account that refuses to start,
 *     gives the session back on its OWN account (forced: the memory it held was just freed).
 */
import { HARNESS_LABELS, type HarnessId } from '@agentistics/core'
import type { ResumeSessionRequest, SpawnSessionRequest, SpawnSessionResult, SwitchAccountRequest } from '@agentistics/tui/control'
import {
  crossSwitchPrompt, decideCrossSwitch, decideSwitch, planSwitchCopies, startFailureSentence, switchFallbackMessage,
  switchLostMessage, switchMessage, switchStatus,
  type SummaryTurn, type SwitchRefusal,
} from './account-switch'
import { accountLabel, executeCopies, findSourceFiles, readLimitState, resolveRoot, startableHere } from './account-switch-io'
import { spawnAccountContext } from './spawn-account-io'
import { spawnAccountMessage } from './spawn-account'
import { killAndRetireSession, readRegistry } from './registry'
import type { ManagedSession, SessionBackend } from './types'

export interface SwitchHostDeps {
  lang: 'en' | 'pt'
  backend: Pick<SessionBackend, 'list' | 'kill'>
  /** `resumeSessionLocked` — the reopen body, WITHOUT taking the lock again. */
  resume: (r: ResumeSessionRequest) => Promise<SpawnSessionResult>
  withLock: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T>
  /** The host's own `spawnSession` — the cross-harness hand-off starts its new session through it. */
  spawn?: (r: SpawnSessionRequest) => Promise<SpawnSessionResult>
  /** The disk and registry, replaceable by a test. */
  io?: Partial<SwitchIo>
}

export interface SwitchIo {
  readRows: typeof readRegistry
  context: typeof spawnAccountContext
  findFiles: typeof findSourceFiles
  copy: typeof executeCopies
  limit: typeof readLimitState
  killAndRetire: (id: string, kill: () => Promise<boolean>) => Promise<boolean>
  startable: typeof startableHere
  /** The session's conversation, through its harness's own transcript reader. */
  turns: (m: ManagedSession) => Promise<{ turns: SummaryTurn[] } | { unavailable: string }>
  role: (keys: (string | undefined)[]) => Promise<'leader' | 'worker' | undefined>
  label: typeof accountLabel
  /** Link old → new so a message to the replaced row (or its children's parent link) follows on. */
  link: (oldId: string, newId: string) => Promise<void>
}

const REAL_IO: SwitchIo = {
  readRows: () => readRegistry(),
  context: h => spawnAccountContext(h),
  findFiles: findSourceFiles,
  copy: executeCopies,
  limit: readLimitState,
  killAndRetire: (id, kill) => killAndRetireSession(id, kill),
  startable: startableHere,
  turns: async m => (await import('./handoff-relay-io')).readSessionTurns(m),
  role: async keys => (await import('./session-roles')).storedRoleFor(keys) as Promise<'leader' | 'worker' | undefined>,
  label: accountLabel,
  link: async (oldId, newId) => (await import('./handoff-relay-io')).recordHandoffLink(oldId, newId, undefined),
}

/** MEM.GUARD: a forced start below the hard memory floor says so in the sentence the switch returns. */
function floorSentence(r: SpawnSessionResult): string {
  return r.overridden && r.note ? ` ${r.note}` : ''
}

/** `ended` + `endedId`: the session WAS ended and could not be given back — the UI offers Reopen on that row. */
export type SwitchResult = SpawnSessionResult & { code?: SwitchRefusal; status?: number; ended?: boolean; endedId?: string }

function refuse(reason: SwitchRefusal, detail: string, lang: 'en' | 'pt'): SwitchResult {
  return {
    ok: false,
    code: reason,
    status: switchStatus(reason),
    message: switchMessage(reason, detail, lang, (r, d) => spawnAccountMessage(r, d, lang)),
  }
}

export async function switchSessionAccountImpl(req: SwitchAccountRequest, deps: SwitchHostDeps): Promise<SwitchResult> {
  const { lang } = deps
  const io: SwitchIo = { ...REAL_IO, ...deps.io }
  const row = (await io.readRows()).find(m => m.id === req.id)
  if (!row) return refuse('not_running_here', '', lang)
  const harness = row.harness as HarnessId
  if (req.harness && req.harness !== harness) return crossHarnessSwitch(row, req, deps, io)
  const conversationId = row.conversationId
  const context = await io.context([harness])
  const decided = decideSwitch({
    harness,
    ...(conversationId ? { conversationId } : {}),
    running: true,
    ...(row.accountId ? { currentAccountId: row.accountId } : {}),
    requested: req.accountId,
    agentCaller: req.callerVerified === true,
    context,
  })
  if (!decided.ok) return refuse(decided.reason, decided.detail, lang)
  const conv = conversationId!

  const sourceRoot = resolveRoot(harness, decided.sourceRoot)
  const targetRoot = resolveRoot(harness, decided.target.root)
  const files = await io.findFiles(harness, sourceRoot, conv, row.cwd)
  const copies = planSwitchCopies({ harness, conversationId: conv, cwd: row.cwd, sourceRoot, targetRoot, files })
  if (!copies) return refuse('no_transcript', '', lang)
  // Read BEFORE the process ends: the prompt the limit refused is the last thing the person said.
  const pending = req.resendPending
    ? (await io.limit({ harness, conversationId: conv, cwd: row.cwd, ...(row.accountId ? { accountId: row.accountId } : {}) }).catch(() => null))?.pendingPrompt
    : undefined

  return deps.withLock(conv, async () => {
    // Re-read INSIDE the lock: a second request for the same row (a double click, another tab) finds
    // it already replaced and is refused rather than switching — and re-sending the prompt — twice.
    const fresh = (await io.readRows()).find(m => m.id === row.id)
    if (!fresh || (fresh.endedAt && !row.endedAt)) return refuse('no_target', '', lang)
    const live = (await deps.backend.list().catch(() => [])).find(b => b.id === row.id)
    if (live?.alive) {
      const ended = await io.killAndRetire(row.id, () => deps.backend.kill(row.id)).catch(() => false)
      if (!ended) {
        return { ok: false, message: lang === 'pt' ? 'Não foi possível encerrar a sessão para trocar de conta. Nada mudou.' : 'The session could not be ended to switch accounts. Nothing changed.' }
      }
    }
    // `force`: the process this resume replaces was just ended, so the memory gate has nothing to
    // protect — refusing here is what left a person with NO session under RAM pressure.
    const base: ResumeSessionRequest = {
      sessionId: conv,
      harness,
      cwd: row.cwd,
      label: row.label ?? row.harnessName ?? '',
      replaces: row.id,
      attach: false,
      origin: 'web',
      force: true,
      ...(req.callerVerified ? { callerVerified: true } : {}),
    }
    const backOnOld = async (why: string): Promise<SwitchResult> => {
      const back = await deps.resume(base).catch(e => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as SpawnSessionResult)
      if (back.ok) return { ...back, ok: false, message: why }
      console.error(`[account-switch] ${row.id}: reopening on the previous account failed too: ${back.message}`)
      return { ok: false, message: switchLostMessage(lang), ended: true, endedId: row.id }
    }
    try {
      await io.copy(copies)
    } catch {
      return backOnOld(lang === 'pt' ? 'Não foi possível copiar a conversa para a outra conta; a sessão continua na conta de antes.'
        : 'The conversation could not be copied to the other account; the session continues on its previous account.')
    }
    const out = await deps.resume({ ...base, switchToAccount: decided.target.id, ...(pending ? { prompt: pending } : {}) })
      .catch(e => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as SpawnSessionResult)
    if (out.ok) {
      const done = lang === 'pt' ? 'Sessão continuada na outra conta.' : 'Session continued on the other account.'
      const resent = pending ? ` ${lang === 'pt' ? 'A última mensagem foi reenviada.' : 'The last message was re-sent.'}` : ''
      return { ...out, message: `${done}${resent}${floorSentence(out)}` }
    }
    // The new account refused to start: never leave the person without the session.
    console.error(`[account-switch] ${row.id}: resume on ${decided.target.id} failed: ${out.message}`)
    return backOnOld(switchFallbackMessage(out.message, lang))
  })
}

/**
 * CONTA.TROCA v2 — continue on ANOTHER harness. The new harness cannot read this conversation, so
 * nothing is copied: a NEW session starts in the same cwd, inheriting the row's filing, folder, pin,
 * mute, note, role and parent, briefed with a distilled summary (`crossSwitchPrompt`) plus the
 * refused message when asked. The order is the safety, and it is the opposite of the same-harness
 * path: the old session is ended only AFTER the new one is confirmed running; any failure before
 * that leaves the old one exactly as it was.
 */
async function crossHarnessSwitch(row: ManagedSession, req: SwitchAccountRequest, deps: SwitchHostDeps, io: SwitchIo): Promise<SwitchResult> {
  const { lang } = deps
  const pt = lang === 'pt'
  const harness = row.harness as HarnessId
  const target = req.harness as HarnessId
  if (!deps.spawn) return { ok: false, message: 'unavailable' }
  const startable = await io.startable()
  const context = await io.context([target])
  const live = (await deps.backend.list().catch(() => [])).find(b => b.id === row.id)
  const decided = decideCrossSwitch({
    harness, targetHarness: target, running: !row.endedAt && live?.alive === true,
    requested: req.accountId, agentCaller: req.callerVerified === true, context, startable,
  })
  if (!decided.ok) return refuse(decided.reason, decided.detail, lang)
  const conv = row.conversationId
  const pending = req.resendPending && conv
    ? (await io.limit({ harness, conversationId: conv, cwd: row.cwd, ...(row.accountId ? { accountId: row.accountId } : {}) }).catch(() => null))?.pendingPrompt
    : undefined
  const turns = await io.turns(row).catch(e => ({ unavailable: e instanceof Error ? e.message : String(e) }))
  const fromAccount = await io.label(harness, row.accountId).catch(() => undefined)
  const prompt = crossSwitchPrompt({
    lang, fromHarness: HARNESS_LABELS[harness] ?? harness, fromHarnessId: harness, ...(fromAccount ? { fromAccount } : {}),
    turns: 'unavailable' in turns ? turns : turns.turns, ...(pending ? { pending } : {}),
  })
  const role = await io.role([conv, row.id]).catch(() => undefined)
  const started = await deps.spawn({
    harness: target,
    cwd: row.cwd,
    attach: false,
    origin: 'web',
    prompt,
    switchFrom: row.id,
    accountId: decided.target.id,
    accountDecided: true,
    // The replacement frees a session's worth of memory the moment it is confirmed; queueing it
    // could start it later beside a session the person already moved on from.
    force: true,
    ...(row.label ? { label: row.label } : {}),
    ...(row.task ? { task: row.task } : {}),
    ...(row.mode ? { mode: row.mode } : {}),
    ...(role ? { role } : {}),
    ...(row.parentSessionId ? { parentSessionId: row.parentSessionId, parentVerified: true } : {}),
    away: row.away === true,
    ...(req.callerVerified ? { callerVerified: true } : {}),
  }).catch(e => ({ ok: false, message: e instanceof Error ? e.message : String(e) }) as SpawnSessionResult)
  // A spawn that is running but whose configuration (filing/folder) is pending still RUNS: the old
  // session is ended only when the new one exists as a live pane.
  const newId = started.id
  const running = newId ? (await deps.backend.list().catch(() => [])).some(b => b.id === newId && b.alive) : false
  if (!newId || !running) {
    if (started.message) console.error(`[account-switch] ${row.id}: hand-off to ${target} failed: ${started.message}`)
    const reason = startFailureSentence(started.message, lang)
    const why = reason ? ` ${reason}` : ''
    return { ok: false, message: pt ? `A nova sessão não iniciou; a sessão atual continua como estava.${why}` : `The new session did not start; the current session continues as it was.${why}` }
  }
  await io.link(row.id, newId).catch(() => undefined)
  const ended = await io.killAndRetire(row.id, () => deps.backend.kill(row.id)).catch(() => false)
  const done = pt ? 'Trabalho continuado em outro assistente, numa conversa nova com um resumo da anterior.' : 'Work continued on another assistant, in a new conversation briefed with a summary of the previous one.'
  const tail = ended ? '' : (pt ? ' A sessão anterior não pôde ser encerrada: encerre-a você.' : ' The previous session could not be ended: end it yourself.')
  return { ...started, ok: true, id: newId, message: `${done}${pending ? (pt ? ' A última mensagem foi reenviada.' : ' The last message was re-sent.') : ''}${floorSentence(started)}${tail}` }
}
