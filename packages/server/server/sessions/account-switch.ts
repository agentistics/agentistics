/**
 * account-switch.ts — PURE (CONTA.TROCA). Move a RUNNING conversation to ANOTHER account of the same
 * harness, without losing it: end the process, make the conversation resumable under the target
 * account's login root, resume the SAME conversation id there.
 *
 * This deliberately relaxes `spawn-account.ts`'s "a recorded account is immutable" rule — but only
 * through this one door, and only after the transcript has been COPIED to where the target account's
 * CLI will look for it. A reopen still runs in the row's own account; a switch is the explicit act of
 * changing which account that is.
 *
 * Rules that must hold:
 * - **Same harness only.** An account of another harness is `unknown_account`: its CLI cannot read
 *   this conversation at all.
 * - **Only where the transcript can be carried.** `SWITCH_LAYOUT` is per harness, and a `null` is a
 *   FINDING: the option is hidden there, never offered and failing. Claude (`CLAUDE_CONFIG_DIR/
 *   projects/<cwd-slug>/<id>.jsonl` + its sidecar directory) and Codex (`CODEX_HOME/sessions/YYYY/MM/
 *   DD/rollout-…-<id>.jsonl`) are the two whose resume-by-id reads a file we can place.
 * - **Copy, never move.** The source transcript stays where it is: the switch can be undone, and the
 *   old account's history must keep reading. Credentials are never copied — only the conversation.
 * - **The target's own refusals are `decideSpawnAccount`'s** (off, removed, signed out, unknown), so
 *   an account the switch offers is exactly an account a fresh spawn could start on.
 * - **A pending prompt is sent ONCE**: it rides the single resume as its first prompt, never typed in
 *   afterwards as well.
 */
import { join, relative, isAbsolute, dirname, basename } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { limitRuleFor } from './limit'
import {
  decideSpawnAccount, decideRecordedAccount, type SpawnAccountContext, type SpawnAccountRefusal, type SpawnAccountRow,
} from './spawn-account'

/** Where a harness keeps a conversation, relative to its login root — or `null`: no switch there. */
export const SWITCH_LAYOUT: Record<HarnessId, 'claude-projects' | 'codex-sessions' | null> = {
  claude: 'claude-projects',
  codex: 'codex-sessions',
  // copilot/gemini/kimi have an isolation variable but their resume-by-id keys on a store that also
  // carries per-login state (copilot's session-state, gemini's project hash table, kimi's workspace
  // index); nobody has measured a copied conversation resuming there. Hidden until somebody has.
  copilot: null, gemini: null, kimi: null,
  antigravity: null, opencode: null,
}

export const switchSupported = (harness: HarnessId): boolean => SWITCH_LAYOUT[harness] !== null

/** Claude Code files a cwd's transcripts under: every non-alphanumeric character becomes `-`. */
export const claudeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export type SwitchRefusal =
  | SpawnAccountRefusal
  | 'switch_unsupported' | 'no_conversation' | 'same_account' | 'not_running_here' | 'no_transcript' | 'no_target'
  | 'harness_unavailable'

/** One copy: a file, or a directory copied recursively. Never a move. */
export interface SwitchCopy { from: string; to: string; kind: 'file' | 'dir' }

/** What the IO found on disk for the conversation, in the SOURCE root. */
export interface SourceFiles {
  /** The transcript (Claude) or rollout (Codex) file. Absent: nothing to carry. */
  transcript?: string
  /** Claude's `<project>/<id>/` sidecar (subagents, tool results), when present. */
  sidecar?: string
}

/**
 * The copies that make `conversationId` resumable under `targetRoot`. `null` when the transcript is
 * missing or the layout refuses it (a Codex rollout outside its own root cannot be re-rooted).
 */
export function planSwitchCopies(o: {
  harness: HarnessId
  conversationId: string
  cwd: string
  sourceRoot: string
  targetRoot: string
  files: SourceFiles
}): SwitchCopy[] | null {
  const layout = SWITCH_LAYOUT[o.harness]
  if (!layout || !o.files.transcript) return null
  if (layout === 'claude-projects') {
    // The DESTINATION is keyed on the cwd the resume runs in, not on where the source happened to
    // be filed: `claude --resume <id>` looks under the slug of its own cwd, and a session whose cwd
    // moved has its source under an older slug.
    const dir = join(o.targetRoot, 'projects', claudeProjectDir(o.cwd))
    const out: SwitchCopy[] = [{ from: o.files.transcript, to: join(dir, `${o.conversationId}.jsonl`), kind: 'file' }]
    if (o.files.sidecar) out.push({ from: o.files.sidecar, to: join(dir, o.conversationId), kind: 'dir' })
    return out
  }
  // codex: the rollout keeps its dated path; `codex resume <id>` scans `sessions/` for it.
  const rel = relative(o.sourceRoot, o.files.transcript)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !rel.startsWith('sessions')) return null
  if (!basename(o.files.transcript).includes(o.conversationId)) return null
  return [{ from: o.files.transcript, to: join(o.targetRoot, rel), kind: 'file' }]
}

/** A copy whose destination is its own source is nothing to do — and refusing it guards a self-overwrite. */
export const copiesAreNoop = (copies: readonly SwitchCopy[]): boolean => copies.every(c => c.from === c.to)

/**
 * One account a switch could land on, as a client is told about it. `harness` names the harness the
 * account belongs to: the same one continues the conversation, another one starts a new conversation
 * there with a summary (CONTA.TROCA v2).
 */
export interface SwitchOption { id: string; harness: HarnessId; label: string; plan?: string; recommended?: boolean }

export interface SwitchAccountMeta { id: string; label: string; plan?: string }

/**
 * Which accounts this session could move to: the harness's live, visible, signed-in accounts other
 * than its own, each passing exactly the check a fresh spawn would (`decideSpawnAccount`). The router's
 * pick (the account with room) is marked `recommended` and listed first.
 */
export function switchOptions(o: {
  harness: HarnessId
  currentAccountId?: string
  agentCaller: boolean
  context: SpawnAccountContext
  meta: readonly SwitchAccountMeta[]
}): SwitchOption[] {
  if (!o.context.enabled || !switchSupported(o.harness)) return []
  const current = currentAccountOf(o.harness, o.currentAccountId, o.context.accounts)
  const picked = o.context.picks?.[o.harness]
  const out: SwitchOption[] = []
  for (const a of o.context.accounts) {
    if (a.harness !== o.harness || a.id === current) continue
    const ok = decideSpawnAccount({ harness: o.harness, requested: a.id, agentCaller: o.agentCaller, context: o.context })
    if (!ok.ok || !a.available) continue
    const m = o.meta.find(x => x.id === a.id)
    out.push({ id: a.id, harness: o.harness, label: m?.label ?? a.id, ...(m?.plan ? { plan: m.plan } : {}), ...(picked === a.id ? { recommended: true } : {}) })
  }
  return out.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || (firstSeen(o.context.accounts, a.id) - firstSeen(o.context.accounts, b.id)))
}

const firstSeen = (rows: readonly SpawnAccountRow[], id: string) => rows.find(r => r.id === id)?.firstSeen ?? 0

/**
 * CONTA.TROCA v2 — every account a session could move to, across EVERY harness that can start a
 * session here (`startable`: spec'd and on PATH), grouped by harness in `startable`'s order with the
 * session's own harness first. The same harness contributes `switchOptions` (only where its
 * conversation can be carried); another harness contributes each of its live, signed-in, available
 * accounts that a fresh spawn would accept — a harness with no registered account offers nothing,
 * because "is anybody signed in at its default root" is not something the registry can vouch for,
 * and a hand-off onto a login prompt would end the old session for a pane that cannot work.
 */
export function allSwitchOptions(o: {
  harness: HarnessId
  currentAccountId?: string
  agentCaller: boolean
  context: SpawnAccountContext
  meta: readonly SwitchAccountMeta[]
  startable: readonly HarnessId[]
}): SwitchOption[] {
  if (!o.context.enabled) return []
  const same = switchOptions(o)
  const others: SwitchOption[] = []
  for (const h of o.startable) {
    if (h === o.harness) continue
    const picked = o.context.picks?.[h]
    const mine: SwitchOption[] = []
    for (const a of o.context.accounts) {
      if (a.harness !== h || a.retired || !a.bound || !a.available) continue
      const ok = decideSpawnAccount({ harness: h, requested: a.id, agentCaller: o.agentCaller, context: o.context })
      if (!ok.ok) continue
      const m = o.meta.find(x => x.id === a.id)
      mine.push({ id: a.id, harness: h, label: m?.label ?? a.id, ...(m?.plan ? { plan: m.plan } : {}), ...(picked === a.id ? { recommended: true } : {}) })
    }
    others.push(...mine.sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || (firstSeen(o.context.accounts, a.id) - firstSeen(o.context.accounts, b.id))))
  }
  return [...same, ...others]
}

/** Why an account of this machine is NOT among a session's switch targets (CONTA.LIMITES). */
export type SwitchUnavailableReason = 'not_agentic' | 'signed_out' | 'cant_carry' | 'harness_unavailable' | 'unavailable'

export interface SwitchUnavailable extends Omit<SwitchOption, 'recommended'> { reason: SwitchUnavailableReason }

/**
 * Every live account that `allSwitchOptions` did NOT offer, each with the one reason a person can act
 * on — so the picker can list the whole machine's accounts and say why a row cannot be chosen,
 * instead of silently leaving it out. The session's own account and retired accounts are not listed.
 * Order: the session's harness first, then `startable`'s order, then any other harness.
 */
export function unavailableSwitchTargets(o: {
  harness: HarnessId
  currentAccountId?: string
  context: SpawnAccountContext
  meta: readonly SwitchAccountMeta[]
  startable: readonly HarnessId[]
  offered: readonly { id: string }[]
}): SwitchUnavailable[] {
  if (!o.context.enabled) return []
  const current = currentAccountOf(o.harness, o.currentAccountId, o.context.accounts)
  const offered = new Set(o.offered.map(x => x.id))
  const rank = (h: HarnessId) => h === o.harness ? -1 : (o.startable.indexOf(h) === -1 ? 999 : o.startable.indexOf(h))
  const out: SwitchUnavailable[] = []
  for (const a of o.context.accounts) {
    if (a.retired || a.id === current || offered.has(a.id)) continue
    const reason: SwitchUnavailableReason =
      a.harness === o.harness && !switchSupported(a.harness) ? 'cant_carry'
        : a.harness !== o.harness && !o.startable.includes(a.harness) ? 'harness_unavailable'
          : !a.available ? 'not_agentic'
            : !a.bound ? 'signed_out'
              : 'unavailable'
    const m = o.meta.find(x => x.id === a.id)
    out.push({ id: a.id, harness: a.harness, label: m?.label ?? a.id, ...(m?.plan ? { plan: m.plan } : {}), reason })
  }
  return out.sort((x, y) => rank(x.harness) - rank(y.harness) || (firstSeen(o.context.accounts, x.id) - firstSeen(o.context.accounts, y.id)))
}

export type CrossDecision =
  | { ok: true; target: { id: string; root: string | null } }
  | { ok: false; reason: SwitchRefusal; detail: string }

/**
 * Decide a hand-off to ANOTHER harness before anything starts or ends. Nothing is carried on disk —
 * the new harness cannot read this conversation — so no layout or link is required; the session
 * must only still be running here and the target must be an account a fresh spawn would accept.
 */
export function decideCrossSwitch(o: {
  harness: HarnessId
  targetHarness: HarnessId
  running: boolean
  requested: string
  agentCaller: boolean
  context: SpawnAccountContext
  startable: readonly HarnessId[]
}): CrossDecision {
  if (!o.context.enabled) return { ok: false, reason: 'accounts_disabled', detail: o.requested }
  if (!o.running) return { ok: false, reason: 'not_running_here', detail: '' }
  if (!o.startable.includes(o.targetHarness)) return { ok: false, reason: 'harness_unavailable', detail: o.targetHarness }
  const target = decideSpawnAccount({ harness: o.targetHarness, requested: o.requested, agentCaller: o.agentCaller, context: o.context })
  if (!target.ok) return { ok: false, reason: target.reason, detail: target.detail }
  if (!target.account) return { ok: false, reason: 'unknown_account', detail: o.requested }
  if (o.context.accounts.find(a => a.id === o.requested)?.available === false) return { ok: false, reason: 'account_unavailable', detail: o.requested }
  return { ok: true, target: target.account }
}

/** A turn as the summary reads it: `ChatTurn`'s fields that matter here, nothing harness-specific. */
export interface SummaryTurn {
  role: 'user' | 'assistant'
  text: string
  composer?: boolean
  tools?: { writes?: string[] }[]
}

const SUMMARY_GOAL = 1200
const SUMMARY_STATE = 1500
const SUMMARY_TURN = 400
const SUMMARY_LAST_TURNS = 6
const SUMMARY_FILES = 30

const clip = (s: string, n: number): string => {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * The first prompt of the session that continues the work on ANOTHER harness: a distilled summary
 * (goal, state, last turns, files touched) — never the whole conversation — plus the message the
 * limit refused, when the person asked to re-send it. Same harness-neutral reading for every
 * harness: the turns come from that harness's own transcript reader. An unreadable conversation is
 * SAID, and the new session is told to establish the state itself.
 */
export function crossSwitchPrompt(o: {
  lang: 'en' | 'pt'
  fromHarness: string
  fromHarnessId: HarnessId
  fromAccount?: string
  turns: readonly SummaryTurn[] | { unavailable: string }
  pending?: string
}): string {
  const pt = o.lang === 'pt'
  const from = `${o.fromHarness}${o.fromAccount ? ` (${pt ? 'conta' : 'account'} ${o.fromAccount})` : ''}`
  const out: string[] = [pt
    ? `Você continua o trabalho de uma sessão ${from} que foi encerrada para trocar de harness/conta. Esta é uma conversa NOVA: abaixo está um resumo da anterior, não o histórico inteiro.`
    : `You are continuing the work of a ${from} session that was ended to switch harness/account. This is a NEW conversation: below is a summary of the previous one, not its whole history.`]
  if ('unavailable' in o.turns) {
    out.push(pt ? `A conversa anterior não pôde ser lida (${o.turns.unavailable}). Estabeleça o estado pelo repositório (git status, git log) antes de agir.`
      : `The previous conversation could not be read (${o.turns.unavailable}). Establish the state from the repository (git status, git log) before acting.`)
  } else {
    const rule = limitRuleFor(o.fromHarnessId)
    // A refusal is the reason for switching, not the work's state. Filter before taking the
    // recent window so repeated refusals cannot crowd out the last real replies.
    const turns = o.turns.filter(t => !t.composer && t.text.trim()
      && !(t.role === 'assistant' && rule?.banner.some(re => re.test(t.text))))
    const goal = turns.find(t => t.role === 'user')
    const state = [...turns].reverse().find(t => t.role === 'assistant')
    if (goal) out.push(`${pt ? '## Objetivo (primeira mensagem)' : '## Goal (first message)'}\n${clip(goal.text, SUMMARY_GOAL)}`)
    if (state) out.push(`${pt ? '## Estado (última resposta do assistente)' : '## State (last assistant reply)'}\n${clip(state.text, SUMMARY_STATE)}`)
    const last = turns.slice(-SUMMARY_LAST_TURNS)
    if (last.length) {
      out.push(`${pt ? '## Últimos turnos' : '## Last turns'}\n${last.map(t => `- ${t.role === 'user' ? (pt ? 'Pessoa' : 'Person') : (pt ? 'Assistente' : 'Assistant')}: ${clip(t.text, SUMMARY_TURN).replace(/\n+/g, ' ')}`).join('\n')}`)
    }
    const files = [...new Set(o.turns.flatMap(t => (t.tools ?? []).flatMap(x => x.writes ?? [])))]
    if (files.length) {
      const shown = files.slice(-SUMMARY_FILES)
      out.push(`${pt ? '## Arquivos tocados' : '## Files touched'}\n${shown.map(f => `- ${f}`).join('\n')}${files.length > shown.length ? `\n- … (+${files.length - shown.length})` : ''}`)
    }
    if (!state) out.push(pt ? 'Estabeleça o estado pelo repositório antes de agir.' : 'Establish the state from the repository before acting.')
  }
  out.push(o.pending
    ? `${pt ? '## Mensagem pendente — a anterior foi recusada; responda a ela agora' : '## Pending message — it was refused before; answer it now'}\n${o.pending}`
    : (pt ? 'Confirme o estado (git status) e continue de onde parou.' : 'Confirm the state (git status) and carry on where it stopped.'))
  return out.join('\n\n')
}

/**
 * The account a row runs on NOW: its recorded one, or — recorded before accounts — whichever account
 * is signed in to the default root.
 */
export function currentAccountOf(harness: HarnessId, recorded: string | undefined, rows: readonly SpawnAccountRow[]): string | undefined {
  if (recorded) return recorded
  return rows.find(a => a.harness === harness && a.bound && a.root === null)?.id
}

export type SwitchDecision =
  | {
    ok: true
    target: { id: string; root: string | null }
    /** The root the conversation runs in now (`null`: the default root). */
    sourceRoot: string | null
  }
  | { ok: false; reason: SwitchRefusal; detail: string }

/**
 * Decide a switch BEFORE anything is ended. Every refusal here leaves the running session untouched,
 * which is why this runs first: a switch that ended the process and then found the target signed out
 * would cost the person their running session for nothing.
 */
export function decideSwitch(o: {
  harness: HarnessId
  conversationId?: string
  running: boolean
  currentAccountId?: string
  requested: string
  agentCaller: boolean
  context: SpawnAccountContext
}): SwitchDecision {
  if (!switchSupported(o.harness)) return { ok: false, reason: 'switch_unsupported', detail: o.harness }
  if (!o.context.enabled) return { ok: false, reason: 'accounts_disabled', detail: o.requested }
  if (!o.conversationId) return { ok: false, reason: 'no_conversation', detail: '' }
  if (!o.running) return { ok: false, reason: 'not_running_here', detail: '' }
  const current = currentAccountOf(o.harness, o.currentAccountId, o.context.accounts)
  if (current && current === o.requested) return { ok: false, reason: 'same_account', detail: o.requested }
  const target = decideSpawnAccount({ harness: o.harness, requested: o.requested, agentCaller: o.agentCaller, context: o.context })
  if (!target.ok) return { ok: false, reason: target.reason, detail: target.detail }
  if (!target.account) return { ok: false, reason: 'unknown_account', detail: o.requested }
  // An account switched OFF is refused for the owner too: the switch moves running work onto it, and
  // "off" is the owner's own statement that work should not land there.
  if (o.context.accounts.find(a => a.id === o.requested)?.available === false) return { ok: false, reason: 'account_unavailable', detail: o.requested }
  // The row's own root: its recorded account must still resolve to a place on disk to copy FROM.
  const source = decideRecordedAccount(o.currentAccountId, o.context.accounts)
  if (!source.ok && source.reason !== 'account_unavailable') return { ok: false, reason: source.reason, detail: source.detail }
  const sourceRoot = source.ok ? source.account?.root ?? null : o.context.accounts.find(a => a.id === o.currentAccountId)?.root ?? null
  if (sourceRoot === target.account.root) return { ok: false, reason: 'same_account', detail: o.requested }
  return { ok: true, target: target.account, sourceRoot }
}

/** HTTP status of a switch refusal. */
export function switchStatus(reason: SwitchRefusal): 403 | 404 | 409 | 422 {
  if (reason === 'account_unavailable') return 403
  if (reason === 'no_target') return 404
  if (reason === 'account_retired' || reason === 'account_signed_out' || reason === 'not_running_here' || reason === 'no_transcript') return 409
  return 422
}

/** The sentence for a refusal, in the caller's language. Spawn-account refusals reuse their own words. */
export function switchMessage(reason: SwitchRefusal, detail: string, lang: 'en' | 'pt', spawnMessage: (r: SpawnAccountRefusal, d: string) => string): string {
  const pt = lang === 'pt'
  switch (reason) {
    case 'switch_unsupported':
      return pt ? `Trocar de conta no meio da sessão ainda não é possível para ${detail}: não há como levar a conversa para outra conta dele.`
        : `Switching accounts mid-session is not available for ${detail} yet: there is no way to carry its conversation to another account.`
    case 'no_conversation':
      return pt ? 'Esta sessão ainda não tem uma conversa ligada, então não há o que levar para outra conta.'
        : 'This session has no linked conversation yet, so there is nothing to carry to another account.'
    case 'same_account':
      return pt ? 'A sessão já está nessa conta.' : 'The session is already on that account.'
    case 'not_running_here':
      return pt ? 'Só uma sessão iniciada pelo agentistics nesta máquina pode trocar de conta.'
        : 'Only a session agentistics started on this machine can switch accounts.'
    case 'no_transcript':
      return pt ? 'A conversa desta sessão não foi encontrada no disco, então não pode ser levada para outra conta. Nada foi encerrado.'
        : "This session's conversation was not found on disk, so it cannot be carried to another account. Nothing was ended."
    case 'harness_unavailable':
      return pt ? `${detail} não pode iniciar uma sessão nesta máquina (não está instalado ou não está no PATH do servidor). Nada foi encerrado.`
        : `${detail} cannot start a session on this machine (it is not installed or not on the server's PATH). Nothing was ended.`
    case 'no_target':
      return pt ? 'Essa sessão não existe mais. Atualize a lista.' : 'That session no longer exists. Refresh the list.'
    default:
      return spawnMessage(reason, detail)
  }
}

// ---------------------------------------------------------------------------------------------------
// The limit, read off the conversation's own last turn.

export interface LimitState {
  /** Epoch ms the account's window resets, when the harness said. */
  resetsAt?: number
  /** The sentence the harness wrote. */
  message?: string
  /** The person's prompt that the limit refused, to be re-sent once on the new account. */
  pendingPrompt?: string
}

const text = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v : undefined

/** A Claude user entry the PERSON typed (not a tool result, not a harness note). */
function claudePromptOf(e: Record<string, unknown>): string | undefined {
  if (e.type !== 'user' || e.isMeta === true || e.isCompactSummary === true) return undefined
  const msg = e.message as { content?: unknown } | undefined
  const c = msg?.content
  if (typeof c === 'string') return c.startsWith('<') ? undefined : text(c)
  if (!Array.isArray(c)) return undefined
  if (c.some(b => (b as { type?: string })?.type === 'tool_result')) return undefined
  const joined = c.map(b => (b as { type?: string; text?: unknown }).type === 'text' ? (b as { text?: unknown }).text : '').filter(t => typeof t === 'string' && t).join('\n')
  return joined && !joined.startsWith('<') ? joined : undefined
}

/**
 * Is the conversation stopped on a usage limit RIGHT NOW? Read from the transcript's tail, oldest
 * first. Measured shapes (2026-10-24, this machine's own transcripts):
 * - Claude: a synthetic assistant entry with `apiError: "usage_limit_reached"` and
 *   `apiErrorParams.rate_limit_info.resetsAt` (epoch seconds).
 * - Codex: `event_msg` `task_complete` whose `error.codex_error_info` is `usage_limit_exceeded`.
 * Anything the harness writes after it that is real work (an assistant reply, a completed turn)
 * clears it; a new prompt from the person does NOT — that prompt is the pending one, refused again.
 */
export function detectLimitInTail(harness: HarnessId, lines: readonly string[]): LimitState | null {
  let limit: LimitState | null = null
  let lastPrompt: string | undefined
  for (const line of lines) {
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (!e || typeof e !== 'object') continue
    if (harness === 'claude') {
      const prompt = claudePromptOf(e)
      if (prompt) { lastPrompt = prompt; continue }
      if (e.type !== 'assistant') continue
      if (e.apiError === 'usage_limit_reached' || e.apiError === 'rate_limit') {
        const info = (e.apiErrorParams as { rate_limit_info?: { resetsAt?: unknown } } | undefined)?.rate_limit_info
        const content = (e.message as { content?: { text?: unknown }[] } | undefined)?.content
        const message = Array.isArray(content) ? text(content[0]?.text) : undefined
        limit = {
          ...(typeof info?.resetsAt === 'number' ? { resetsAt: info.resetsAt * 1000 } : {}),
          ...(message ? { message } : {}),
          ...(lastPrompt ? { pendingPrompt: lastPrompt } : {}),
        }
      } else if (e.isApiErrorMessage !== true) {
        limit = null
      }
      continue
    }
    if (harness === 'codex') {
      if (e.type !== 'event_msg') continue
      const p = e.payload as { type?: string; message?: unknown; error?: { message?: unknown; codex_error_info?: unknown } } | undefined
      if (p?.type === 'user_message') { const m = text(p.message); if (m) lastPrompt = m; continue }
      if (p?.type === 'task_complete' || p?.type === 'error') {
        if (p.error?.codex_error_info === 'usage_limit_exceeded' || (p.type === 'error' && /usage limit/i.test(String(p.message ?? '')))) {
          const message = text(p.error?.message) ?? text(p.message)
          limit = { ...(message ? { message } : {}), ...(lastPrompt ? { pendingPrompt: lastPrompt } : {}) }
        } else if (p.type === 'task_complete') {
          limit = null
        }
      } else if (p?.type === 'agent_message') {
        limit = null
      }
    }
  }
  return limit
}

/** Codex's rollout name ends in the conversation id. */
export const isCodexRolloutOf = (path: string, conversationId: string): boolean =>
  basename(path).startsWith('rollout-') && basename(path).endsWith(`${conversationId}.jsonl`)

/** Claude's sidecar directory sits beside the transcript, named after the conversation. */
export const claudeSidecarOf = (transcript: string, conversationId: string): string => join(dirname(transcript), conversationId)

const DIED_AT_SPAWN = /^(the session exited as soon as it started|a sessão terminou assim que começou)\b/i

/**
 * A start failure as a person reads it: one capitalised sentence, never the CLI's raw stderr (that
 * goes to the server log). The host's "exited as soon as it started: <stderr>" becomes a sentence
 * of its own; anything else keeps its words, capitalised and closed with a full stop.
 */
export function startFailureSentence(message: string | undefined, lang: 'en' | 'pt'): string {
  const m = (message ?? '').trim()
  if (!m) return ''
  if (DIED_AT_SPAWN.test(m)) {
    return lang === 'pt'
      ? 'Ela terminou assim que começou (os detalhes estão no log do servidor).'
      : 'It exited as soon as it started (details are in the server log).'
  }
  const s = m.charAt(0).toUpperCase() + m.slice(1)
  return /[.!?…]$/.test(s) ? s : `${s}.`
}

/** The new account refused to start, and the session was given back on its own account. */
export function switchFallbackMessage(reason: string | undefined, lang: 'en' | 'pt'): string {
  const head = lang === 'pt'
    ? 'A sessão não iniciou na outra conta; ela continua na conta de antes.'
    : 'The session did not start on the other account; it continues on its previous account.'
  const why = startFailureSentence(reason, lang)
  return why ? `${head} ${why}` : head
}

/** Neither the new account nor the old one could start: the conversation is intact, the pane is not. */
export function switchLostMessage(lang: 'en' | 'pt'): string {
  return lang === 'pt'
    ? 'A sessão não iniciou na outra conta nem pôde ser reaberta na conta de antes. A conversa está guardada: use Reabrir.'
    : 'The session did not start on the other account and could not be reopened on its previous account. The conversation is kept: use Reopen.'
}
