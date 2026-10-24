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
 *     there are never two live rows. A copy that fails gives the session back on its OWN account.
 */
import type { HarnessId } from '@agentistics/core'
import type { ResumeSessionRequest, SpawnSessionResult, SwitchAccountRequest } from '@agentistics/tui/control'
import { decideSwitch, planSwitchCopies, switchMessage, switchStatus, type SwitchRefusal } from './account-switch'
import { executeCopies, findSourceFiles, readLimitState, resolveRoot } from './account-switch-io'
import { spawnAccountContext } from './spawn-account-io'
import { spawnAccountMessage } from './spawn-account'
import { killAndRetireSession, readRegistry } from './registry'
import type { SessionBackend } from './types'

export interface SwitchHostDeps {
  lang: 'en' | 'pt'
  backend: Pick<SessionBackend, 'list' | 'kill'>
  /** `resumeSessionLocked` — the reopen body, WITHOUT taking the lock again. */
  resume: (r: ResumeSessionRequest) => Promise<SpawnSessionResult>
  withLock: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T>
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
}

const REAL_IO: SwitchIo = {
  readRows: () => readRegistry(),
  context: h => spawnAccountContext(h),
  findFiles: findSourceFiles,
  copy: executeCopies,
  limit: readLimitState,
  killAndRetire: (id, kill) => killAndRetireSession(id, kill),
}

export type SwitchResult = SpawnSessionResult & { code?: SwitchRefusal; status?: number }

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
    const base: ResumeSessionRequest = {
      sessionId: conv,
      harness,
      cwd: row.cwd,
      label: row.label ?? row.harnessName ?? '',
      replaces: row.id,
      attach: false,
      origin: 'web',
      ...(req.callerVerified ? { callerVerified: true } : {}),
    }
    try {
      await io.copy(copies)
    } catch {
      // Give the session back where it was rather than leaving it ended.
      const back = await deps.resume(base)
      const why = lang === 'pt' ? 'Não foi possível copiar a conversa para a outra conta; a sessão continua na conta de antes.'
        : 'The conversation could not be copied to the other account; the session continues on its previous account.'
      return { ...back, ok: false, message: why }
    }
    const out = await deps.resume({ ...base, switchToAccount: decided.target.id, ...(pending ? { prompt: pending } : {}) })
    if (out.ok) {
      const done = lang === 'pt' ? 'Sessão continuada na outra conta.' : 'Session continued on the other account.'
      return { ...out, message: pending ? `${done} ${lang === 'pt' ? 'A última mensagem foi reenviada.' : 'The last message was re-sent.'}` : done }
    }
    return out
  })
}
