/**
 * code-host.ts — the SERVER half of the control center's `code` tab (harness TUI P1): a `CodeHost`
 * (`@agentistics/tui/control/code-types`) that drives native runtime sessions for it.
 *
 * Spec: docs/superpowers/specs/2026-09-28-harness-tui-design.md (D-TUI-3/6/7/9, CD-01…CD-12, NW-01,
 * NW-06) over docs/superpowers/specs/2026-09-27-runtime-b4-sessions.md. The dependency direction is
 * `server -> tui`, so the tab imports nothing from here: this module TRANSLATES what the runtime's
 * hub publishes (`OutboundFrame`s) into the `CodeEvent`s the tab folds, and decides no rule the tab
 * would otherwise have to guess — every refusal leaves here as an already-localized sentence.
 *
 * ## One reader per surface, one door per act
 *
 * Reading is `hub.watch` (one watcher per `subscribe`), acting is `hub.submit` / `hub.answer` — the
 * same two doors the web routes use (`runtime-sessions-web.ts`), so a session this tab drives can be
 * watched and answered from the dashboard too. The default asker of `createRuntimeHost` is the HUB's
 * (`createHubAsker`): a permission question is broadcast to every watcher and NOBODY watching is a
 * DENIAL. That is why a run only ever asks while this tab is subscribed — and why `subscribe` is the
 * moment a queued first message is sent (below).
 *
 * ## The first message waits for the first reader
 *
 * `start()` files and arms the session and, when given a first message, holds it until the first
 * `subscribe()` has attached its watcher. Sent from `start()` itself, the run would begin before
 * anybody was reading: its first deltas would be published to nobody, and a permission question
 * raised in that window would be auto-DENIED (`unavailable`). Replaying from the ring instead would
 * duplicate history on every later re-subscribe. Holding the message costs nothing — the tab
 * subscribes as soon as `start()` answers.
 *
 * ## What is resolved EXACTLY, and what is left out
 *
 * A tool's INPUT (the path, the command, the patch) is not on any event — events carry facts, never
 * content (D5). The only durable copy is the assistant message that made the call, in the content
 * store. It is found by identity, never by resemblance: `toolExecutionId` → the run's
 * `store.listToolCalls` record → its `toolUseId` → the `tool_use` part with that very id in the
 * newest messages. If any link is missing, `target` and `diff` are OMITTED. A guess by name or path
 * would show one call's diff on another's approval card, which is the one thing that card exists to
 * prevent.
 *
 * ## Checkpoints — `CodeAsk.checkpoint` is always `false`, on purpose
 *
 * Read from `packages/runtime/src/tools/file/{checkpoint,write,patch}.ts`: (1) `checkpoint.record`
 * is called AFTER the write, not before (it records `{before, after}` of what the editor already
 * wrote); (2) the store is IN MEMORY by default (`createCheckpoint()`), so a restart loses it; (3) no
 * host seam exposes `restore` to this process. The card may say "checkpoint saved" only when a
 * checkpoint is really taken before the write and the person can use it, and none of that holds, so
 * the flag stays `false` until the runtime grows a seam.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import type {
  CodeAsk, CodeAvailability, CodeDefaults, CodeDiff, CodeDiffFile, CodeDiffHunk, CodeEvent, CodeHistoryTurn,
  CodeHost, CodeModeId, CodePlanItem, CodePolicyDecision, CodePromptRecord, CodeResult, CodeSessionFacts,
  CodeSessionRule, CodeStartInput, CodeTaskOption, CodeToolCall, CodeUsage,
} from '@agentistics/tui/control/code-types'
import type { AgentisticsEvent, ModelStopReason } from '@agentistics/core'
import { calcCost, getModelPrice, MODEL_PRICING, resolveContextWindow } from '@agentistics/core'
import {
  openSession,
  parsePatchText,
  repairInterruptedRun,
  toWireName,
  type OutboundFrame,
  type PersonQuestion,
  type PolicySubject,
  type ProviderMessage,
} from '@agentistics/runtime'
import { PROVIDER_FLAG_ENV, TEAM_CENTRAL, providerFlagOn } from './config'
import { createRuntimeHost, workspaceRootFor, type RuntimeHost } from './runtime-host'

// ── Language: this module's own small table (the host speaks the language the cockpit is in) ────

type Lang = 'en' | 'pt'

const T = {
  flagOff: {
    en: `The native runtime is off (BETA) — set ${PROVIDER_FLAG_ENV}=1 to use it.`,
    pt: `O runtime nativo está desligado (BETA) — defina ${PROVIDER_FLAG_ENV}=1 para usá-lo.`,
  },
  central: {
    en: 'A central drives no sessions on this machine — open agentop on the machine that runs them.',
    pt: 'Uma central não conduz sessões nesta máquina — abra o agentop na máquina que as executa.',
  },
  noModel: {
    en: 'No model named — start with `agentop code --model <id>`.',
    pt: 'Nenhum modelo informado — inicie com `agentop code --model <id>`.',
  },
  needTask: {
    en: 'A session started here is always filed under a task — pick or create one first.',
    pt: 'Uma sessão iniciada aqui é sempre registrada em uma tarefa — escolha ou crie uma primeiro.',
  },
  needModel: {
    en: 'No model to run the session with — start with `agentop code --model <id>`.',
    pt: 'Nenhum modelo para rodar a sessão — inicie com `agentop code --model <id>`.',
  },
  noSuchTask: {
    en: 'That task is not on the board any more — pick another.',
    pt: 'Essa tarefa não está mais no quadro — escolha outra.',
  },
  taskDone: {
    en: 'That task is done and takes no new work — pick another or create one.',
    pt: 'Essa tarefa está concluída e não recebe trabalho novo — escolha outra ou crie uma.',
  },
  fileFailed: {
    en: 'The session could not be filed under the task, so it was not started.',
    pt: 'A sessão não pôde ser registrada na tarefa, então não foi iniciada.',
  },
  noSuchSession: {
    en: 'No such session.',
    pt: 'Sessão inexistente.',
  },
  emptyTitle: {
    en: 'A task needs a title.',
    pt: 'Uma tarefa precisa de um título.',
  },
  taskCreateFailed: {
    en: 'The task could not be created.',
    pt: 'Não foi possível criar a tarefa.',
  },
  hostFailed: {
    en: 'The native runtime could not be opened.',
    pt: 'Não foi possível abrir o runtime nativo.',
  },
  nothingRunning: {
    en: 'Nothing is running in this session.',
    pt: 'Nada está rodando nesta sessão.',
  },
  cancelled: {
    en: 'Cancelling the run…',
    pt: 'Cancelando a execução…',
  },
  questionGone: {
    en: 'That question is no longer open.',
    pt: 'Essa pergunta não está mais aberta.',
  },
  answered: {
    en: 'Answered.',
    pt: 'Respondido.',
  },
  queued: {
    en: 'Queued — the session reads it when it can.',
    pt: 'Na fila — a sessão lê quando puder.',
  },
  queueFull: {
    en: 'Too many inputs are already queued for this session — try again shortly.',
    pt: 'Já há entradas demais na fila desta sessão — tente de novo em instantes.',
  },
  sessionClosed: {
    en: 'This session has ended and can no longer accept input.',
    pt: 'Esta sessão terminou e não aceita mais entrada.',
  },
  notDriver: {
    en: 'This session is not being driven by this process right now.',
    pt: 'Esta sessão não está sendo conduzida por este processo agora.',
  },
  gap: {
    en: (n: number) => `The screen missed ${n} update${n === 1 ? '' : 's'} — what follows is current.`,
    pt: (n: number) => `A tela perdeu ${n} atualiza${n === 1 ? 'ção' : 'ções'} — o que segue está em dia.`,
  },
  closed: {
    en: 'The session has ended.',
    pt: 'A sessão terminou.',
  },
  runCompleted: { en: 'The run finished.', pt: 'A execução terminou.' },
  runFailed: { en: 'The run failed.', pt: 'A execução falhou.' },
  noCredential: { en: 'No Anthropic key is stored on this machine — add one with `agentop provider key set anthropic`, then send again.', pt: 'Nenhuma chave da Anthropic está guardada nesta máquina — adicione com `agentop provider key set anthropic` e envie de novo.' },
  runAbandoned: { en: 'The run was cancelled.', pt: 'A execução foi cancelada.' },
  runLost: { en: 'The run was lost — its process stopped without finishing it.', pt: 'A execução foi perdida — o processo parou sem concluí-la.' },
  deniedByYou: { en: 'denied by you', pt: 'negado por você' },
  deniedByPolicy: { en: 'refused by the policy', pt: 'recusado pela política' },
  toolFailed: {
    en: (why: string) => `failed — ${why}`,
    pt: (why: string) => `falhou — ${why}`,
  },
  toolCancelled: { en: 'cancelled', pt: 'cancelado' },
  toolUnknown: { en: 'ended without a result', pt: 'terminou sem resultado' },
  repaired: { en: 'Repaired an interrupted run:', pt: 'Reparada uma execução interrompida:' },
  started: {
    en: (id: string, ref: string) => `Started ${id} under ${ref}. It is on the board.`,
    pt: (id: string, ref: string) => `Iniciada ${id} em ${ref}. Está no quadro.`,
  },
  resumed: {
    en: (id: string) => `Opened ${id}.`,
    pt: (id: string) => `Aberta ${id}.`,
  },
  leaseHeld: {
    en: (s: string) => s,
    pt: (s: string) => s,
  },
  // CD-15 — the prototype's word for each mode, and what it means, in one sentence.
  modeDefault: {
    en: 'Mode: ask — everything not allowlisted asks first.',
    pt: 'Modo: perguntar — tudo o que não está na lista permitida pergunta antes.',
  },
  modeAcceptEdits: {
    en: 'Mode: edits — file writes inside the workspace are allowed; the shell still asks.',
    pt: 'Modo: edições — gravações de arquivo dentro do workspace são permitidas; o shell ainda pergunta.',
  },
  modePlan: {
    en: 'Mode: plan — read-only: writes and changing commands are refused.',
    pt: 'Modo: plano — somente leitura: gravações e comandos que alteram algo são recusados.',
  },
  rulesDropped: {
    en: (n: number) => `${n} session rule${n === 1 ? '' : 's'} dropped.`,
    pt: (n: number) => `${n} regra${n === 1 ? '' : 's'} da sessão descartada${n === 1 ? '' : 's'}.`,
  },
  modeJournalFailed: {
    en: 'The switch could not be written to the journal (the mode did change).',
    pt: 'A troca não pôde ser gravada no diário (o modo mudou mesmo assim).',
  },
  modeNoSession: {
    en: 'No session is open here to change the mode of.',
    pt: 'Nenhuma sessão aberta aqui para trocar o modo.',
  },
  modeFailed: {
    en: 'The permission mode could not be changed; it is as it was.',
    pt: 'Não foi possível trocar o modo de permissão; ele continua como estava.',
  },
  historyFailed: {
    en: 'The earlier prompts could not be read.',
    pt: 'Não foi possível ler os prompts anteriores.',
  },
  noEditor: {
    en: 'There is no terminal to hand to an editor here.',
    pt: 'Não há terminal para entregar a um editor aqui.',
  },
  editorFailed: {
    en: 'The editor could not be opened; your draft is unchanged.',
    pt: 'Não foi possível abrir o editor; seu rascunho não mudou.',
  },
} as const

// ── Options ─────────────────────────────────────────────────────────────────────────────────────

/** The board, as this module needs it. The default reads the real book; a test passes a fake. */
export interface CodeTasksApi {
  /** Every task on the board (open or not — the host filters). */
  list(): Promise<{ id: string; title: string; status: string }[]>
  /** The status vocabulary, for the labels. */
  statuses(): Promise<{ id: string; label: string }[]>
  create(title: string): Promise<{ id: string; title: string; status: string } | null>
  attach(taskId: string, sessionId: string, o: { title?: string }): Promise<{ ok: true } | { ok: false; reason: string }>
  taskOf(sessionId: string): Promise<{ taskId: string; title: string; subtaskId?: string } | null>
}

export interface CodeHostOptions {
  /** The language the cockpit is speaking RIGHT NOW (read on every sentence — the toggle reassigns it). */
  lang: () => Lang
  /** `--model`: the only place, besides the last session, a model may come from. */
  model?: string
  cwd: string
  /** Default: `createRuntimeHost({})` once, lazily, with the hub's own asker. */
  runtime?: () => Promise<RuntimeHost>
  /** Default `providerFlagOn`. */
  flagOn?: () => boolean
  /** Default `TEAM_CENTRAL`. */
  central?: () => boolean
  tasks?: CodeTasksApi
  now?: () => Date
  /**
   * CD-17: opens the person's editor on a draft through the control center's suspend
   * (`code-editor.ts`, wired in cli-start.ts). Absent: there is no terminal to hand over, said in words.
   */
  editor?: (draft: string) => Promise<CodeResult<{ text: string; sentence: string }>>
  /** CD-15: where profile switches are journaled. Default: `profile-switches.jsonl` beside the runtime's session store. */
  modeJournalPath?: string
}

export type ServerCodeHost = CodeHost & { dispose(): Promise<void> }

// ── Pure helpers (exported for tests) ───────────────────────────────────────────────────────────

/** `ses_3f5f21…` → `3f5f`, the handle the tab prints. */
export function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^ses_/, '').slice(0, 4)
}

/** `t-0539886b9c` → `t-0539`. Display only — every decision uses the full id. */
export function shortTaskRef(taskId: string): string {
  const m = /^t-([0-9a-f]{4})/.exec(taskId)
  return m ? `t-${m[1]}` : taskId
}

const VERBS: Record<string, string> = {
  'file.patch': 'patch', 'file.write': 'write', 'file.read': 'read',
  'fs.grep': 'grep', 'fs.glob': 'glob',
  'shell.start': 'shell', 'shell.read': 'shell', 'shell.write': 'shell', 'shell.stop': 'shell',
  'git.status': 'git', 'git.diff': 'git', 'git.log': 'git',
  'task.plan': 'plan', 'ask.user': 'ask',
}

/**
 * A stored message names a call by its WIRE name (`file__read` — the provider rejects a dot), the
 * events by the catalogue name (`file.read`). The runtime says the mapping is not invertible by
 * string manipulation, so it is read the only exact way there is: over the names the catalogue
 * declares. An unknown name is passed through unchanged, so a tool this table has not heard of shows
 * up as itself instead of being renamed to a wrong one.
 */
export function catalogueName(wireName: string): string {
  return Object.keys(VERBS).find(k => toWireName(k) === wireName) ?? wireName
}

export function verbOf(toolName: string): string {
  return VERBS[toolName] ?? toolName
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function recordOf(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null
}

/** The short "what it acts on" of a call, from its OWN input. `''` when the input names nothing. */
export function targetOf(toolName: string, input: unknown): string {
  const r = recordOf(input)
  if (!r) return ''
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '')
  switch (toolName) {
    case 'file.read': case 'file.write': return str('path')
    case 'file.patch': {
      const patch = str('patch')
      if (!patch) return ''
      const parsed = parsePatchText(patch)
      return Array.isArray(parsed) ? parsed.map(f => f.path).join(', ') : ''
    }
    case 'fs.grep': case 'fs.glob': return str('pattern')
    case 'shell.start': return oneLine(str('command'), 120)
    case 'shell.read': case 'shell.write': case 'shell.stop': return str('sessionId')
    case 'git.status': case 'git.diff': case 'git.log': return str('repo')
    default: return ''
  }
}

function linesOfBody(body: string): string[] {
  return body === '' ? [] : body.split('\n')
}

/**
 * The change a `file.patch` call makes, read from its own patch text. A DELETE names no lines (the
 * patch does not carry the file's content), so it has no hunks and counts nothing rather than an
 * invented total.
 */
export function diffOfPatch(patchText: string): CodeDiff | null {
  const parsed = parsePatchText(patchText)
  if (!Array.isArray(parsed)) return null
  const files: CodeDiffFile[] = parsed.map((f): CodeDiffFile => {
    const first = f.hunks[0]
    if (first?.kind === 'add') {
      const lines = linesOfBody(first.body).map(text => ({ op: '+' as const, text }))
      return { path: f.path, op: 'add', added: lines.length, removed: 0, hunks: [{ lines }] }
    }
    if (first?.kind === 'delete') return { path: f.path, op: 'delete', added: 0, removed: 0, hunks: [] }
    const hunks: CodeDiffHunk[] = []
    let added = 0
    let removed = 0
    let moveTo: string | undefined
    for (const h of f.hunks) {
      if (h.kind !== 'update') continue
      if (h.moveTo) moveTo = h.moveTo
      for (const l of h.lines) { if (l.op === '+') added++; else if (l.op === '-') removed++ }
      hunks.push({
        ...(h.context.length > 0 ? { header: h.context.join(' ') } : {}),
        lines: h.lines.map(l => ({ op: l.op, text: l.text })),
      })
    }
    return { path: f.path, op: 'update', ...(moveTo ? { moveTo } : {}), added, removed, hunks }
  })
  return { files }
}

/** The change a `file.write` call makes: every line of its content is added. */
export function diffOfWrite(path: string, content: string, overwrite: boolean): CodeDiff {
  const lines = linesOfBody(content).map(text => ({ op: '+' as const, text }))
  return { files: [{ path, op: overwrite ? 'overwrite' : 'add', added: lines.length, removed: 0, hunks: [{ lines }] }] }
}

/** The diff a call's input implies, or null when the tool writes nothing / the input is unusable. */
export function diffOfCall(toolName: string, input: unknown, overwrite: (path: string) => boolean): CodeDiff | null {
  const r = recordOf(input)
  if (!r) return null
  if (toolName === 'file.patch') return typeof r.patch === 'string' ? diffOfPatch(r.patch) : null
  if (toolName === 'file.write') {
    if (typeof r.path !== 'string' || typeof r.content !== 'string') return null
    return diffOfWrite(r.path, r.content, overwrite(r.path))
  }
  return null
}

const WHY_MARK = 'It needs your approval because:'

/** The policy's own reasons: the `- ` lines after its marker line. */
export function whyOf(text: string): string[] {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.trim() === WHY_MARK)
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('- ')) out.push(l.slice(2))
    else if (l.trim() !== '') break
  }
  return out
}

/** The index of the policy's own option labelled exactly `Deny`, else null. */
export function denyIndexOf(options: readonly { label: string }[]): number | null {
  const i = options.findIndex(o => o.label === 'Deny')
  return i >= 0 ? i : null
}

function textOfMessage(m: ProviderMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n')
}

/** A resumed session's turns: text + the tools each one called (name/verb/target). Never tool results. */
export function historyOf(messages: readonly { message: ProviderMessage }[]): CodeHistoryTurn[] {
  const out: CodeHistoryTurn[] = []
  for (const { message } of messages) {
    const text = textOfMessage(message)
    const tools = typeof message.content === 'string'
      ? []
      : message.content.flatMap((p) => {
        if (p.type !== 'tool_use') return []
        const name = catalogueName(p.name)
        return [{ name, verb: verbOf(name), target: targetOf(name, p.input) }]
      })
    if (text === '' && tools.length === 0) continue
    out.push({ role: message.role, text, tools })
  }
  return out
}

/** CD-15: the cycle `shift+tab` walks — ask → edits → plan → ask. */
export function nextMode(m: CodeModeId): CodeModeId {
  return m === 'default' ? 'accept-edits' : m === 'accept-edits' ? 'plan' : 'default'
}

/**
 * Why the model stopped, in the provider's own spelling (`end_turn`, `tool_use`, `max_tokens`, …):
 * the normalised kind with its hyphens as underscores; an `other` reads its raw value (or the
 * verbatim one), never a guessed kind.
 */
export function stopReasonText(sr: ModelStopReason | undefined): string | undefined {
  if (!sr) return undefined
  const n = sr.normalised
  if (n.kind === 'other') return n.raw ?? sr.verbatim ?? 'other'
  return n.kind.replace(/-/g, '_')
}

/** How many lines of a tool's output the host keeps (the head); `total` still counts them all. */
export const OUTPUT_KEEP_LINES = 400

/**
 * CD-10: a tool's returned text as lines — the head kept, the true count beside it. One trailing
 * newline ends the last line rather than adding an empty one. Empty text is "nothing readable".
 */
export function outputOf(text: string, keep = OUTPUT_KEEP_LINES): { lines: string[]; total: number } | undefined {
  if (text === '') return undefined
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const all = body.split('\n')
  return { lines: all.slice(0, keep), total: all.length }
}

/**
 * CD-13: each counter at the model's own rate (USD per 1M tokens). The same two refusals as the
 * total: every counter must be reported, and the table must price the model EXACTLY — a fallback
 * rate split four ways is four wrong figures instead of one.
 */
export function costsOf(model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): CodeUsage['costs'] {
  if (u.input === undefined || u.output === undefined || u.cacheRead === undefined || u.cacheWrite === undefined) return undefined
  const price = getModelPrice(model)
  if (!Object.values(MODEL_PRICING).includes(price)) return undefined
  return {
    input: (u.input / 1_000_000) * price.input,
    output: (u.output / 1_000_000) * price.output,
    cacheRead: (u.cacheRead / 1_000_000) * price.cacheRead,
    cacheWrite: (u.cacheWrite / 1_000_000) * price.cacheWrite,
  }
}

/** The user text of one stored message: a string, or its text parts. `''` for a tool-result-only turn. */
function userTextOf(m: ProviderMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.flatMap(p => (p.type === 'text' ? [p.text] : [])).join('\n')
}

/** CD-18 bounds: how many prompts are returned, how many sessions and messages are read to find them. */
export const PROMPT_HISTORY_CAP = 500
export const PROMPT_HISTORY_SESSIONS = 200
export const PROMPT_HISTORY_READS = 2000

// ── The default board (task-web / task-source), loaded only when used ───────────────────────────

function defaultTasks(): CodeTasksApi {
  return {
    async list() {
      const { loadTaskBoard } = await import('./sessions/task-source')
      const { book } = await loadTaskBoard()
      return book.tasks.map(t => ({ id: t.id, title: t.title, status: t.status }))
    },
    async statuses() {
      const { loadTaskBoard } = await import('./sessions/task-source')
      const { sortTaskStatuses } = await import('@agentistics/core')
      const { book } = await loadTaskBoard()
      return sortTaskStatuses(book.statuses).map(s => ({ id: s.id, label: s.label }))
    },
    async create(title) {
      const { createTask } = await import('./sessions/task-web')
      const t = await createTask({ title })
      return t ? { id: t.id, title: t.title, status: t.status } : null
    },
    async attach(taskId, sessionId, o) {
      const { attachNativeSession } = await import('./sessions/task-web')
      const r = await attachNativeSession(taskId, sessionId, { ...(o.title ? { title: o.title } : {}), actor: 'agentop code' })
      return r.ok ? { ok: true } : { ok: false, reason: r.reason }
    },
    async taskOf(sessionId) {
      const { nativeSessionTask } = await import('./sessions/task-web')
      const t = await nativeSessionTask(sessionId)
      return t ? { taskId: t.taskId, title: t.title, ...(t.subtaskId ? { subtaskId: t.subtaskId } : {}) } : null
    },
  }
}

// ── The host ────────────────────────────────────────────────────────────────────────────────────

interface Active {
  controller: AbortController | null
  /** The message `start()` was given, sent when the first reader attaches. */
  pendingFirst?: string
  listeners: Set<(e: CodeEvent) => void>
  /** Events a resume produced before any reader existed (history, a repair notice), delivered first. */
  backlog?: CodeEvent[]
  /** The run in flight, exactly — from `run.started`, so an input is looked up in THIS run. */
  runId?: string
  /** CD-16: the session-rule list last emitted (JSON), so an unchanged list is not re-sent. */
  lastRules?: string
}

export function createCodeHost(opts: CodeHostOptions): ServerCodeHost {
  const lang = (): Lang => (opts.lang() === 'pt' ? 'pt' : 'en')
  const tr = <K extends keyof typeof T>(k: K): (typeof T)[K][Lang] => T[k][lang()] as (typeof T)[K][Lang]
  const flagOn = opts.flagOn ?? providerFlagOn
  const central = opts.central ?? (() => TEAM_CENTRAL)
  const tasks = opts.tasks ?? defaultTasks()
  const now = opts.now ?? (() => new Date())

  let runtimeP: Promise<RuntimeHost> | null = null
  /** The opened runtime, for the verbs the contract makes synchronous (`submit`/`answer`) — always set
   *  once `start`/`resume` answered `ok`, since both `await` the runtime first. */
  let resolved: RuntimeHost | null = null
  const getRuntime = (): Promise<RuntimeHost> => {
    if (!runtimeP) {
      runtimeP = (opts.runtime ?? (() => createRuntimeHost({})))()
      void runtimeP.then((r) => { resolved = r }, () => { runtimeP = null })
    }
    return runtimeP
  }
  const runtimeIfOpenSync = (): RuntimeHost | null => resolved
  const runtimeIfOpen = async (): Promise<RuntimeHost | null> => (runtimeP ? runtimeP.catch(() => null) : null)

  const sessions = new Map<string, Active>()
  /** Sessions this host started or resumed and has not ended — the ones a mode switch may act on. */
  const driven = new Set<string>()
  const active = (sessionId: string): Active => {
    let a = sessions.get(sessionId)
    if (!a) { a = { controller: null, listeners: new Set() }; sessions.set(sessionId, a) }
    return a
  }
  const emitLocal = (sessionId: string, e: CodeEvent): void => {
    for (const l of [...active(sessionId).listeners]) { try { l(e) } catch { /* a listener never breaks the host */ } }
  }
  /** The label of the option this host last sent for a question, for its `ask-closed`. */
  const lastChoice = new Map<string, string>()
  const askOptions = new Map<string, readonly { label: string }[]>()

  // ── tasks ──
  async function taskOptions(): Promise<CodeTaskOption[]> {
    const [all, statuses] = await Promise.all([tasks.list(), tasks.statuses()])
    const labels = new Map(statuses.map(s => [s.id, s.label]))
    const { isClosed } = await import('./sessions/task-model')
    const open = all.filter(t => !isClosed(t.status))
    // Work in flight first, then the most recently opened: the person is most likely continuing one.
    const rank = (s: string): number => (s === 'in_progress' ? 0 : s === 'blocked' ? 2 : 1)
    return open
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t.status) - rank(b.t.status) || a.i - b.i)
      .map(({ t }): CodeTaskOption => ({
        id: t.id, ref: shortTaskRef(t.id), title: t.title, status: t.status, statusLabel: labels.get(t.status) ?? t.status,
      }))
  }

  async function factsOf(rt: RuntimeHost, sessionId: string): Promise<CodeSessionFacts | null> {
    const s = await rt.store.getSession(sessionId)
    if (!s) return null
    const filed = await tasks.taskOf(sessionId).catch(() => null)
    let subtask: CodeSessionFacts['subtask']
    if (filed?.subtaskId) subtask = { id: filed.subtaskId, title: filed.subtaskId }
    return {
      sessionId,
      shortId: shortSessionId(sessionId),
      title: s.title ?? shortSessionId(sessionId),
      task: filed ? { id: filed.taskId, ref: shortTaskRef(filed.taskId), title: filed.title } : null,
      ...(subtask ? { subtask } : {}),
      cwd: s.cwd,
      workspaceRoot: s.workspaceRoot,
      model: s.model,
      provider: s.provider,
      // The policy object the runtime judges with (runtime-host `policyOf`): a new or resumed session
      // is a fresh policy, so this reads `default` until somebody switches.
      mode: modeOf(rt, sessionId),
    }
  }

  function modeOf(rt: RuntimeHost, sessionId: string): CodeModeId {
    try { return rt.policyOf(sessionId).profile() } catch { return 'default' }
  }

  /**
   * CD-16: the WHOLE list of "allow for this session" answers the policy holds, sent only when it
   * changed. Read after a question closes AND after the policy's verdict event: the hub publishes
   * `ask-closed` the moment the answer lands, which can be before the policy has recorded it.
   */
  function emitRulesIfChanged(rt: RuntimeHost, sessionId: string): void {
    let rules: CodeSessionRule[]
    try { rules = rt.policyOf(sessionId).approvals().map(a => ({ label: a.label, at: a.approvedAt })) } catch { return }
    const a = active(sessionId)
    const json = JSON.stringify(rules)
    if (json === (a.lastRules ?? '[]')) return
    a.lastRules = json
    emitLocal(sessionId, { kind: 'rules', rules })
  }

  function modeSentence(m: CodeModeId): string {
    return m === 'accept-edits' ? tr('modeAcceptEdits') : m === 'plan' ? tr('modePlan') : tr('modeDefault')
  }

  function attachDriver(rt: RuntimeHost, sessionId: string): void {
    const a = active(sessionId)
    rt.hub.attachDriver(sessionId, async (text) => {
      const ac = new AbortController()
      a.controller = ac
      try {
        const out = await rt.runtime.run(sessionId, text, { signal: ac.signal })
        // A refused or failed run says WHY in the loop's own sentence; run.ended only says the status.
        if (!out.ok) emitLocal(sessionId, { kind: 'notice', tone: 'error', sentence: out.sentence })
        else if (out.status === 'failed') {
          emitLocal(sessionId, { kind: 'notice', tone: 'error', sentence: out.sentence })
          // The loop names the failure by its code; the person needs the step that fixes it. Only the
          // one cause whose remedy is certain is translated — any other code is left as the loop said it.
          if (out.sentence.includes('provider.no_credential')) emitLocal(sessionId, { kind: 'notice', tone: 'info', sentence: tr('noCredential') })
        }
      } catch {
        emitLocal(sessionId, { kind: 'notice', tone: 'error', sentence: tr('runFailed') })
      } finally {
        if (a.controller === ac) a.controller = null
      }
    })
  }

  // ── translating hub frames into CodeEvents ──

  /** A call's INPUT, found by identity (module doc). `undefined`: the link could not be made. */
  async function inputOfCall(rt: RuntimeHost, sessionId: string, toolExecutionId: string, runId: string | undefined): Promise<unknown | undefined> {
    if (!runId) return undefined
    try {
      const rec = (await rt.store.listToolCalls(runId)).find(r => r.toolExecutionId === toolExecutionId)
      if (!rec) return undefined
      // The assistant message that made the call was persisted BEFORE its tools ran, so it is among
      // the newest; look a few back rather than only at the last (a run's earlier turns).
      const page = await rt.store.listMessages(sessionId, { limit: 8 })
      for (const m of [...page.messages].reverse()) {
        if (m.role !== 'assistant') continue
        const body = await rt.content.get(m.content.sha256)
        if (body === null) continue
        let msg: ProviderMessage
        try { msg = JSON.parse(body) as ProviderMessage } catch { continue }
        if (typeof msg.content === 'string') continue
        const use = msg.content.find(p => p.type === 'tool_use' && p.id === rec.toolUseId)
        if (use && use.type === 'tool_use') return use.input
      }
    } catch { /* an unreadable store means an unresolved link, not a thrown error */ }
    return undefined
  }

  /** A failure in words: the first line of what the tool returned (`text`, already read), else its status. */
  function failureWordsOf(d: { status: string; errorClass?: string }, text: string | null): string {
    let first = ''
    if (text) first = oneLine(text.split('\n').find(l => l.trim() !== '') ?? '', 160)
    if (first) return tr('toolFailed')(first)
    if (d.status === 'cancelled') return tr('toolCancelled')
    if (d.status === 'unknown') return tr('toolUnknown')
    return tr('toolFailed')(d.errorClass ?? d.status)
  }

  /**
   * The API-equivalent price of one response, through the ONE pricing function (`calcCost`). The
   * runtime journals no money (provider/emit.ts: "Nothing is priced"), so without this the panel's
   * SPEND read N/A on every session. Two refusals keep it honest: a model the table does not price
   * EXACTLY (getModelPrice falls back to a Sonnet-class rate for an unknown id) is left unpriced,
   * and so is a response missing any of the four counters — pricing three of four is a confident
   * figure for less than what was billed.
   */
  function apiEquivalentCost(model: string, u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number | undefined {
    if (u.input === undefined || u.output === undefined || u.cacheRead === undefined || u.cacheWrite === undefined) return undefined
    const price = getModelPrice(model)
    if (!Object.values(MODEL_PRICING).includes(price)) return undefined
    return calcCost({
      inputTokens: u.input, outputTokens: u.output, cacheReadInputTokens: u.cacheRead,
      cacheCreationInputTokens: u.cacheWrite, webSearchRequests: 0, costUSD: 0,
    }, model)
  }

  interface SubState {
    calls: Map<string, CodeToolCall>
    inputs: Map<string, unknown>
    runByCall: Map<string, string>
    /**
     * A model response whose text never streamed. A client that cannot stream (`streaming: false`
     * is a valid `ProviderClient`) delivers its text only inside the response, so no `delta` frame
     * ever carries it and the tab would show tool rows under an assistant that said nothing. The
     * text is read from the PERSISTED assistant message at the next point it is known to be stored
     * (the loop persists it before any of its tools run, and before `run.ended`).
     */
    streamed: boolean
    textPending: boolean
    /** The newest assistant message whose text was filled in, so none is emitted twice. */
    filledSeq: number
    /**
     * CD-06/CD-13: each provider attempt seen invoked, by `attemptId#attempt` — when it was sent
     * (`model.invoked.occurredAt`) and when this host saw its first streamed text. Dropped at its
     * terminal event, so it holds at most the attempts in flight.
     */
    attempts: Map<string, { startedAt: string; firstDeltaAt?: string }>
    /** The attempt the next streamed text belongs to: the newest one invoked. */
    currentAttempt?: string
    /** CD-13/14: calls a person was asked about, and the span of that question. */
    asked: Set<string>
    waited: Map<string, { openedAt: string; closedAt?: string }>
  }

  /** The text parts of the newest assistant message not filled in yet — `null` when there is none. */
  async function unstreamedText(rt: RuntimeHost, sessionId: string, st: SubState): Promise<string | null> {
    try {
      const page = await rt.store.listMessages(sessionId, { limit: 8 })
      for (const m of [...page.messages].reverse()) {
        if (m.role !== 'assistant') continue
        if (m.seq <= st.filledSeq) return null
        st.filledSeq = m.seq
        const body = await rt.content.get(m.content.sha256)
        if (body === null) return null
        const msg = JSON.parse(body) as ProviderMessage
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join('\n')
        return text.trim() ? text : null
      }
    } catch { /* an unreadable store costs the text, never the stream */ }
    return null
  }

  async function flushUnstreamed(rt: RuntimeHost, sessionId: string, st: SubState, emit: (e: CodeEvent) => void): Promise<void> {
    if (!st.textPending) return
    st.textPending = false
    const text = await unstreamedText(rt, sessionId, st)
    if (text !== null) emit({ kind: 'delta', text })
  }

  function permissionAsk(q: PersonQuestion, call: CodeToolCall | undefined, input: unknown | undefined): CodeAsk {
    const lines = q.text.split('\n')
    const title = lines[0] ?? ''
    const shell = q.subjects?.find((s): s is Extract<PolicySubject, { action: 'shell' }> => s.action === 'shell')
    const paths = (q.subjects ?? []).flatMap((s) => {
      if (s.action === 'write') return [{ path: s.path, op: s.op }]
      if (s.action === 'read') return [{ path: s.path, op: 'read' }]
      return []
    })
    // The op of a write is the POLICY's own subject (create/overwrite were decided by the tool from
    // the disk at gate time) — the authoritative answer for a file.write's diff.
    const overwrite = (p: string): boolean => paths.some(x => x.op === 'overwrite' && (x.path === p || x.path.endsWith(`/${p}`) || p.endsWith(x.path)))
      || (paths.length === 0 && existsSync(resolvePath(p)))
    const diff = call && input !== undefined ? diffOfCall(call.name, input, overwrite) : null
    return {
      id: q.id,
      kind: q.kind,
      ...(call ? { toolId: call.id, toolName: call.name } : {}),
      title,
      // A permission question's reasons are the policy's; a model's question has no reasons — its
      // body is what follows the first line, so that is what a card can show.
      why: q.kind === 'permission' ? whyOf(q.text) : lines.slice(1).filter(l => l.trim() !== ''),
      ...(shell ? { command: { command: shell.command, cwd: shell.cwd } } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(diff ? { diff } : {}),
      checkpoint: false,
      options: q.options.map(o => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      denyIndex: q.kind === 'permission' ? denyIndexOf(q.options) : null,
      ...(q.allowFreeText ? { allowFreeText: true } : {}),
    }
  }

  async function translate(rt: RuntimeHost, sessionId: string, st: SubState, frame: OutboundFrame, emit: (e: CodeEvent) => void): Promise<void> {
    const a = active(sessionId)
    switch (frame.kind) {
      case 'hello': return
      case 'delta':
        if (st.currentAttempt) {
          const at = st.attempts.get(st.currentAttempt)
          if (at && at.firstDeltaAt === undefined) at.firstDeltaAt = now().toISOString()
        }
        st.streamed = true
        emit({ kind: 'delta', ...(frame.runId ? { runId: frame.runId } : {}), text: frame.text })
        return
      case 'gap': emit({ kind: 'notice', tone: 'warn', sentence: tr('gap')(frame.missed) }); return
      case 'closed': emit({ kind: 'closed', sentence: tr('closed') }); return
      case 'ack':
        if (frame.status === 'refused') emit({ kind: 'notice', tone: 'error', sentence: refusalSentence(frame.code, frame.sentence) })
        return
      case 'ask-closed': {
        const label = frame.outcome === 'answered' ? lastChoice.get(frame.questionId) : undefined
        lastChoice.delete(frame.questionId)
        askOptions.delete(frame.questionId)
        emit({ kind: 'ask-closed', id: frame.questionId, outcome: frame.outcome, ...(label ? { choiceLabel: label } : {}) })
        const execId = frame.questionId.endsWith(':permission') ? frame.questionId.slice(0, -':permission'.length) : ''
        const span = st.waited.get(execId)
        const call = st.calls.get(execId)
        if (span && span.closedAt === undefined) {
          span.closedAt = now().toISOString()
          if (call) {
            const closed: CodeToolCall = { ...call, waited: { ...span } }
            st.calls.set(closed.id, closed)
            emit({ kind: 'tool', call: closed })
          }
        }
        if (frame.outcome === 'answered') emitRulesIfChanged(rt, sessionId)
        return
      }
      case 'ask': {
        const q = frame.question
        askOptions.set(q.id, q.options)
        let call: CodeToolCall | undefined
        let input: unknown | undefined
        if (q.kind === 'permission') {
          const execId = q.id.endsWith(':permission') ? q.id.slice(0, -':permission'.length) : ''
          call = st.calls.get(execId)
          if (call) {
            input = st.inputs.has(execId)
              ? st.inputs.get(execId)
              : await inputOfCall(rt, sessionId, execId, st.runByCall.get(execId) ?? a.runId)
          }
        }
        const ask = permissionAsk(q, call, input)
        if (call) {
          // CD-14: the question's span, on the host's clock — opened now, closed at its `ask-closed`.
          const span = { openedAt: now().toISOString() }
          st.asked.add(call.id)
          st.waited.set(call.id, span)
          const asking: CodeToolCall = { ...call, state: 'asking', waited: { ...span }, ...(ask.diff && !call.diff ? { diff: ask.diff } : {}) }
          st.calls.set(call.id, asking)
          emit({ kind: 'tool', call: asking })
        }
        emit({ kind: 'ask', ask })
        return
      }
      case 'event': return translateEvent(rt, sessionId, st, frame.event, emit)
    }
  }

  function refusalSentence(code: string | undefined, fallback: string | undefined): string {
    if (code === 'queue-full') return tr('queueFull')
    if (code === 'session-closed') return tr('sessionClosed')
    if (code === 'not-driver') return tr('notDriver')
    return fallback ?? tr('sessionClosed')
  }

  async function translateEvent(rt: RuntimeHost, sessionId: string, st: SubState, ev: AgentisticsEvent, emit: (e: CodeEvent) => void): Promise<void> {
    const a = active(sessionId)
    const at = ev.occurredAt
    switch (ev.type) {
      case 'run.started': {
        const runId = ev.runId ?? ''
        a.runId = runId
        emit({ kind: 'run-started', runId, at })
        return
      }
      case 'run.ended': {
        await flushUnstreamed(rt, sessionId, st, emit)
        const d = ev.data as { status: 'completed' | 'failed' | 'abandoned' | 'lost' }
        const sentence = d.status === 'completed' ? tr('runCompleted')
          : d.status === 'failed' ? tr('runFailed')
            : d.status === 'abandoned' ? tr('runAbandoned') : tr('runLost')
        emit({ kind: 'run-ended', runId: ev.runId ?? a.runId ?? '', status: d.status, sentence, at })
        if (a.runId === (ev.runId ?? a.runId)) a.runId = undefined
        return
      }
      case 'tool.requested': {
        await flushUnstreamed(rt, sessionId, st, emit)
        const d = ev.data as { toolExecutionId: string; name: string }
        const runId = ev.runId ?? a.runId
        if (runId) st.runByCall.set(d.toolExecutionId, runId)
        const input = await inputOfCall(rt, sessionId, d.toolExecutionId, runId)
        if (input !== undefined) st.inputs.set(d.toolExecutionId, input)
        const diff = input === undefined ? null : diffOfCall(d.name, input, p => existsSync(resolvePath(p)))
        const call: CodeToolCall = {
          id: d.toolExecutionId,
          name: d.name,
          verb: verbOf(d.name),
          target: input === undefined ? '' : targetOf(d.name, input),
          state: 'running',
          requestedAt: at,
          ...(diff ? { diff } : {}),
        }
        st.calls.set(call.id, call)
        emit({ kind: 'tool', call })
        return
      }
      case 'policy.approved':
      case 'policy.denied': {
        const d = ev.data as { policy: string; toolExecutionId?: string; decidedBy: 'user' | 'policy'; code?: string }
        const prev = d.toolExecutionId ? st.calls.get(d.toolExecutionId) : undefined
        if (prev) {
          const policy: CodePolicyDecision = {
            decision: ev.type === 'policy.approved' ? 'allowed' : 'denied',
            by: d.decidedBy,
            rule: d.policy,
            asked: st.asked.has(prev.id),
            ...(ev.type === 'policy.denied' && d.code ? { code: d.code } : {}),
          }
          const decided: CodeToolCall = { ...prev, policy }
          st.calls.set(decided.id, decided)
          emit({ kind: 'tool', call: decided })
        }
        // The verdict is returned AFTER the policy recorded any "for this session" answer.
        emitRulesIfChanged(rt, sessionId)
        return
      }
      case 'tool.completed': {
        const d = ev.data as { toolExecutionId: string; filesTouched?: string[]; linesAdded?: number; linesRemoved?: number; durationMs?: number; exitCode?: number; result?: { sha256: string } }
        const prev = st.calls.get(d.toolExecutionId)
        if (!prev) return
        // CD-10: the returned text, by its digest — one read, and an unreadable one is simply absent.
        const text = d.result ? await rt.content.get(d.result.sha256).catch(() => null) : null
        const output = text === null ? undefined : outputOf(text)
        const done: CodeToolCall = {
          ...prev,
          state: 'done',
          endedAt: at,
          ...(output ? { output } : {}),
          ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
          ...(d.linesAdded !== undefined ? { linesAdded: d.linesAdded } : {}),
          ...(d.linesRemoved !== undefined ? { linesRemoved: d.linesRemoved } : {}),
          ...(d.filesTouched && d.filesTouched.length > 0 ? { files: d.filesTouched } : {}),
          ...(d.exitCode !== undefined ? { result: `exit ${d.exitCode}` } : {}),
        }
        st.calls.set(done.id, done)
        emit({ kind: 'tool', call: done })
        if (prev.name === 'task.plan') {
          const plan = planOf(st.inputs.get(d.toolExecutionId))
          if (plan) emit({ kind: 'plan', items: plan })
        }
        return
      }
      case 'tool.failed': {
        const d = ev.data as { toolExecutionId: string; status: string; errorClass?: string; durationMs?: number; result?: { sha256: string } }
        const prev = st.calls.get(d.toolExecutionId)
        if (!prev) return
        const text = d.result ? await rt.content.get(d.result.sha256).catch(() => null) : null
        const output = text === null ? undefined : outputOf(text)
        const failed: CodeToolCall = {
          ...prev,
          state: 'failed',
          endedAt: at,
          failure: failureWordsOf(d, text),
          ...(d.durationMs !== undefined ? { durationMs: d.durationMs } : {}),
          ...(output ? { output } : {}),
        }
        st.calls.set(failed.id, failed)
        emit({ kind: 'tool', call: failed })
        return
      }
      case 'tool.denied': {
        const d = ev.data as { toolExecutionId: string; by: 'user' | 'policy' }
        const prev = st.calls.get(d.toolExecutionId)
        if (!prev) return
        const denied: CodeToolCall = { ...prev, state: 'denied', endedAt: at, failure: d.by === 'user' ? tr('deniedByYou') : tr('deniedByPolicy') }
        st.calls.set(denied.id, denied)
        emit({ kind: 'tool', call: denied })
        return
      }
      case 'model.invoked': {
        const d = ev.data as { attemptId?: string; attempt?: number }
        if (d.attemptId === undefined) return
        const key = `${d.attemptId}#${d.attempt ?? 1}`
        st.attempts.set(key, { startedAt: at })
        st.currentAttempt = key
        return
      }
      case 'model.failed': {
        const d = ev.data as { attemptId?: string; attempt?: number }
        if (d.attemptId !== undefined) st.attempts.delete(`${d.attemptId}#${d.attempt ?? 1}`)
        return
      }
      case 'model.completed': {
        if (!st.streamed && (ev.data as { status?: string }).status !== 'failed') {
          // The response's own message is persisted AFTER this event, so whatever is newest now is
          // older than it: only a message past this point may be filled in. Without the baseline a
          // response that persisted nothing (an empty answer) re-emitted the previous turn's text.
          try {
            const page = await rt.store.listMessages(sessionId, { limit: 1 })
            const newest = page.messages[page.messages.length - 1]
            if (newest) st.filledSeq = Math.max(st.filledSeq, newest.seq)
          } catch { /* no baseline: then nothing is filled, which is the safe direction */ st.filledSeq = Number.MAX_SAFE_INTEGER }
          st.textPending = true
        }
        st.streamed = false
        const d = ev.data as {
          model: string; usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
          costUSD?: number; contextTokens?: number; contextWindow?: number
          attemptId?: string; attempt?: number; latencyMs?: number; stopReason?: ModelStopReason
        }
        // A figure the SOURCE stated has no per-counter split to show, so `costs` is only ever the
        // host's own pricing (the runtime journals no money today, so this is every response).
        const priced = d.costUSD === undefined ? apiEquivalentCost(d.model, d.usage) : undefined
        const cost = d.costUSD ?? priced
        const costs = priced !== undefined ? costsOf(d.model, d.usage) : undefined
        const key = d.attemptId === undefined ? undefined : `${d.attemptId}#${d.attempt ?? 1}`
        const attempt = key ? st.attempts.get(key) : undefined
        if (key) st.attempts.delete(key)
        let ttftMs: number | undefined
        if (attempt?.firstDeltaAt !== undefined) {
          const ms = Date.parse(attempt.firstDeltaAt) - Date.parse(attempt.startedAt)
          // A negative or unreadable span is two clocks disagreeing, not a measurement — absent.
          if (Number.isFinite(ms) && ms >= 0) ttftMs = Math.round(ms)
        }
        const stopReason = stopReasonText(d.stopReason)
        // A window the source stated outranks the table; the table's own entries carry provenance,
        // and a model it does not know draws no gauge (contextWindows.ts).
        const windowTokens = d.contextWindow ?? resolveContextWindow(d.model)?.tokens
        emit({
          kind: 'usage',
          usage: {
            ...(ev.runId ? { runId: ev.runId } : {}),
            model: d.model,
            // A counter the source did not report stays ABSENT — never a confident 0.
            ...(d.usage.input !== undefined ? { input: d.usage.input } : {}),
            ...(d.usage.output !== undefined ? { output: d.usage.output } : {}),
            ...(d.usage.cacheRead !== undefined ? { cacheRead: d.usage.cacheRead } : {}),
            ...(d.usage.cacheWrite !== undefined ? { cacheWrite: d.usage.cacheWrite } : {}),
            ...(cost !== undefined ? { costUSD: cost } : {}),
            ...(d.contextTokens !== undefined ? { contextTokens: d.contextTokens } : {}),
            ...(windowTokens !== undefined ? { contextWindow: windowTokens } : {}),
            ...(d.attemptId !== undefined ? { attemptId: d.attemptId } : {}),
            ...(attempt ? { startedAt: attempt.startedAt } : {}),
            endedAt: at,
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            ...(d.latencyMs !== undefined ? { latencyMs: d.latencyMs } : {}),
            ...(stopReason !== undefined ? { stopReason } : {}),
            ...(costs ? { costs } : {}),
          },
        })
        return
      }
      default: return
    }
  }

  function planOf(input: unknown): CodePlanItem[] | null {
    const r = recordOf(input)
    if (!r || !Array.isArray(r.steps)) return null
    const items: CodePlanItem[] = []
    for (const s of r.steps) {
      const step = recordOf(s)
      if (!step || typeof step.text !== 'string') return null
      const status = step.status === 'completed' ? 'done' : step.status === 'in_progress' ? 'active' : step.status === 'pending' ? 'todo' : null
      if (!status) return null
      items.push({ text: step.text, status })
    }
    return items
  }

  // ── the CodeHost ──

  const host: ServerCodeHost = {
    availability(): CodeAvailability {
      if (central()) return { ok: false, sentence: tr('central') }
      if (!flagOn()) return { ok: false, sentence: tr('flagOff') }
      return { ok: true }
    },

    async defaults(): Promise<CodeDefaults> {
      const workspaceRoot = workspaceRootFor(opts.cwd)
      const base = { cwd: opts.cwd, workspaceRoot, provider: 'anthropic' }
      if (opts.model) return { ...base, model: { id: opts.model, source: 'flag' } }
      try {
        const rt = await getRuntime()
        const last = (await rt.store.listSessions({ limit: 1 })).sessions[0]
        if (last?.model) return { ...base, model: { id: last.model, source: 'last-session' } }
      } catch { /* an unreadable store is "no model named", said in words below */ }
      return { ...base, model: null, noModelSentence: tr('noModel') }
    },

    async openTasks() {
      try { return { ok: true, tasks: await taskOptions() } } catch { return { ok: false, sentence: tr('hostFailed') } }
    },

    async createTask(title) {
      const t = title.trim()
      if (!t) return { ok: false, sentence: tr('emptyTitle') }
      try {
        const made = await tasks.create(t)
        if (!made) return { ok: false, sentence: tr('taskCreateFailed') }
        const statuses = await tasks.statuses().catch(() => [])
        return {
          ok: true,
          task: {
            id: made.id, ref: shortTaskRef(made.id), title: made.title, status: made.status,
            statusLabel: statuses.find(s => s.id === made.status)?.label ?? made.status,
          },
        }
      } catch { return { ok: false, sentence: tr('taskCreateFailed') } }
    },

    async start(input: CodeStartInput) {
      const a0 = host.availability()
      if (!a0.ok) return { ok: false, sentence: a0.sentence }
      // D-TUI-6: never a session the board does not know.
      if (!input.taskId) return { ok: false, sentence: tr('needTask') }
      if (!input.model.trim()) return { ok: false, sentence: tr('needModel') }
      let rt: RuntimeHost
      try { rt = await getRuntime() } catch { return { ok: false, sentence: tr('hostFailed') } }

      const all = await tasks.list().catch(() => [])
      const task = all.find(t => t.id === input.taskId)
      if (!task) return { ok: false, sentence: tr('noSuchTask') }

      let sessionId: string | undefined
      let leased = false
      const undo = async (): Promise<void> => {
        if (sessionId === undefined) return
        rt.hub.detachDriver(sessionId)
        driven.delete(sessionId)
        if (leased) await rt.release(sessionId).catch(() => {})
        // ENDED, not left open: a session with no board record and no reader is one nobody can find.
        await rt.runtime.finish(sessionId).catch(() => {})
        sessions.delete(sessionId)
      }
      try {
        const session = await rt.runtime.create({
          workspaceRoot: workspaceRootFor(input.cwd),
          cwd: input.cwd,
          provider: 'anthropic',
          model: input.model,
          credential: { provider: 'anthropic', id: 'default' },
          title: task.title,
        })
        sessionId = session.sessionId
        const lease = await rt.acquire(sessionId)
        if (!lease.ok) { await undo(); return { ok: false, sentence: lease.sentence } }
        leased = true

        // File BEFORE the session is driveable: a failure here must leave nothing running.
        const filed = await tasks.attach(task.id, sessionId, { title: task.title })
        if (!filed.ok) {
          await undo()
          return { ok: false, sentence: filed.reason === 'task_done' ? tr('taskDone') : filed.reason === 'no_such_task' ? tr('noSuchTask') : tr('fileFailed') }
        }

        attachDriver(rt, sessionId)
        driven.add(sessionId)
        if (input.firstMessage && input.firstMessage.trim()) active(sessionId).pendingFirst = input.firstMessage
        const facts = await factsOf(rt, sessionId)
        if (!facts) { await undo(); return { ok: false, sentence: tr('fileFailed') } }
        return { ok: true, facts, sentence: tr('started')(facts.shortId, shortTaskRef(task.id)) }
      } catch {
        await undo()
        return { ok: false, sentence: tr('hostFailed') }
      }
    },

    async resume(sessionId: string) {
      const a0 = host.availability()
      if (!a0.ok) return { ok: false, sentence: a0.sentence }
      let rt: RuntimeHost
      try { rt = await getRuntime() } catch { return { ok: false, sentence: tr('hostFailed') } }
      let leased = false
      try {
        if (!(await rt.store.getSession(sessionId))) return { ok: false, sentence: tr('noSuchSession') }
        const lease = await rt.acquire(sessionId)
        if (!lease.ok) return { ok: false, sentence: lease.sentence }
        leased = true
        const repair = await repairInterruptedRun(
          { store: rt.store, content: rt.content, journal: rt.journal, runtimeVersion: rt.runtimeVersion, now },
          sessionId,
        )
        const opened = await openSession({ store: rt.store, content: rt.content }, sessionId)
        if (!opened) { await rt.release(sessionId).catch(() => {}); return { ok: false, sentence: tr('noSuchSession') } }
        attachDriver(rt, sessionId)
        driven.add(sessionId)
        const a = active(sessionId)
        const backlog: CodeEvent[] = []
        if (repair.repaired) backlog.push({ kind: 'notice', tone: 'info', sentence: `${tr('repaired')} ${repair.sentence}` })
        backlog.push({ kind: 'history', turns: historyOf(opened.messages) })
        a.backlog = backlog
        const facts = await factsOf(rt, sessionId)
        if (!facts) { driven.delete(sessionId); await rt.release(sessionId).catch(() => {}); return { ok: false, sentence: tr('noSuchSession') } }
        return { ok: true, facts, sentence: tr('resumed')(facts.shortId) }
      } catch {
        driven.delete(sessionId)
        if (leased) await rt.release(sessionId).catch(() => {})
        return { ok: false, sentence: tr('hostFailed') }
      }
    },

    subscribe(sessionId, listener) {
      const a = active(sessionId)
      a.listeners.add(listener)
      let closed = false
      let watcherClose: (() => void) | null = null
      const st: SubState = {
        calls: new Map(), inputs: new Map(), runByCall: new Map(), streamed: false, textPending: false, filledSeq: 0,
        attempts: new Map(), asked: new Set(), waited: new Map(),
      }

      void (async () => {
        let rt: RuntimeHost | null
        try { rt = await getRuntime() } catch { return }
        if (closed || rt === null) return
        const watcher = rt.hub.watch(sessionId)
        watcherClose = () => watcher.close()
        if (closed) { watcher.close(); return }
        // The resume backlog (history, a repair notice) goes first, then the live edge.
        const backlog = a.backlog
        a.backlog = undefined
        if (backlog) for (const e of backlog) { try { listener(e) } catch { /* ignore */ } }
        // The watcher is attached: NOW a held first message may run without racing its own reader.
        const first = a.pendingFirst
        if (first !== undefined) {
          a.pendingFirst = undefined
          queueMicrotask(() => { void host.submit(sessionId, first) })
        }
        try {
          for await (const frame of watcher) {
            if (closed) break
            try {
              await translate(rt, sessionId, st, frame, (e) => { try { listener(e) } catch { /* ignore */ } })
            } catch { /* one frame that cannot be translated must not end the stream */ }
          }
        } finally {
          watcher.close()
        }
      })()

      return () => {
        closed = true
        a.listeners.delete(listener)
        watcherClose?.()
      }
    },

    submit(sessionId, text) {
      const t = text.trim()
      if (!t) return { ok: false, sentence: tr('emptyTitle') }
      const rt = runtimeIfOpenSync()
      if (!rt) return { ok: false, sentence: tr('hostFailed') }
      const ack = rt.hub.submit(sessionId, { clientRef: crypto.randomUUID(), text: t })
      if (ack.status === 'refused') return { ok: false, sentence: refusalSentence(ack.code, ack.sentence) }
      emitLocal(sessionId, { kind: 'user', text: t, at: now().toISOString() })
      return { ok: true, sentence: tr('queued') }
    },

    answer(sessionId, questionId, choice) {
      const rt = runtimeIfOpenSync()
      if (!rt) return { ok: false, sentence: tr('hostFailed') }
      const label = askOptions.get(questionId)?.[choice]?.label
      if (label !== undefined) lastChoice.set(questionId, label)
      if (!rt.hub.answer(sessionId, questionId, { choice })) {
        lastChoice.delete(questionId)
        return { ok: false, sentence: tr('questionGone') }
      }
      return { ok: true, sentence: tr('answered') }
    },

    cancel(sessionId) {
      const a = sessions.get(sessionId)
      if (!a?.controller) return { ok: false, sentence: tr('nothingRunning') }
      a.controller.abort()
      return { ok: true, sentence: tr('cancelled') }
    },

    async end(sessionId) {
      const a = sessions.get(sessionId)
      a?.controller?.abort()
      const rt = await runtimeIfOpen()
      if (rt) {
        rt.hub.detachDriver(sessionId)
        await rt.release(sessionId).catch(() => {})
      }
      sessions.delete(sessionId)
      driven.delete(sessionId)
    },

    cycleMode(sessionId) {
      if (!driven.has(sessionId)) return { ok: false, sentence: tr('modeNoSession') }
      const rt = runtimeIfOpenSync()
      if (!rt) return { ok: false, sentence: tr('hostFailed') }
      let from: CodeModeId
      let record: ReturnType<ReturnType<RuntimeHost['policyOf']>['switchProfile']>
      try {
        const policy = rt.policyOf(sessionId)
        from = policy.profile()
        record = policy.switchProfile(nextMode(from))
      } catch {
        return { ok: false, sentence: tr('modeFailed') }
      }
      // B4.7 added no event type for this on purpose (runtime-b3-tool-catalogue D-T3.P4: "the switch
      // record carries its own code"), so the host journals the record as a line of its own. COUNTS
      // only, never the approvals' labels: a label is the question's own words ("commands starting
      // with `deploy --prod`"), i.e. conversation content, and a journal holds facts, not content (D5).
      let journaled = true
      try {
        const path = opts.modeJournalPath ?? join(dirname(rt.dbPath), 'profile-switches.jsonl')
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const line = { at: now().toISOString(), sessionId, ...record, kept: record.kept.length, dropped: record.dropped.length }
        appendFileSync(path, `${JSON.stringify(line)}\n`, { encoding: 'utf-8', mode: 0o600 })
      } catch {
        // A failed write costs the journal line, never the switch — and the sentence says so.
        journaled = false
      }
      const mode = record.to
      emitLocal(sessionId, { kind: 'mode', mode, direction: record.direction, dropped: record.dropped.length })
      emitRulesIfChanged(rt, sessionId)
      // The LOSS leads: the status line truncates from the right, and at 80 columns the mode sentence
      // alone fills it — while the mode is also in the header, the dropped rules are said nowhere else.
      const parts = [modeSentence(mode)]
      if (record.dropped.length > 0) parts.unshift(tr('rulesDropped')(record.dropped.length))
      if (!journaled) parts.push(tr('modeJournalFailed'))
      return { ok: true, mode, sentence: parts.join(' ') }
    },

    async promptHistory() {
      let rt: RuntimeHost
      try { rt = await getRuntime() } catch { return { ok: false, sentence: tr('historyFailed') } }
      try {
        // Candidates first (refs only, no bodies): the newest window of each of the newest sessions.
        const page = await rt.store.listSessions({ limit: PROMPT_HISTORY_SESSIONS })
        const refs: { sessionId: string; at: string; seq: number; sha: string }[] = []
        for (const s of page.sessions) {
          const msgs = await rt.store.listMessages(s.sessionId, { limit: 200 })
          for (const m of msgs.messages) if (m.role === 'user') refs.push({ sessionId: s.sessionId, at: m.createdAt, seq: m.seq, sha: m.content.sha256 })
        }
        // Newest first; a total order (time, then session, then seq) so equal timestamps never reshuffle.
        refs.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : b.seq - a.seq))
        const seen = new Set<string>()
        const prompts: CodePromptRecord[] = []
        let reads = 0
        for (const r of refs) {
          if (prompts.length >= PROMPT_HISTORY_CAP || reads >= PROMPT_HISTORY_READS) break
          reads += 1
          const body = await rt.content.get(r.sha).catch(() => null)
          if (body === null) continue
          let msg: ProviderMessage
          try { msg = JSON.parse(body) as ProviderMessage } catch { continue }
          const text = userTextOf(msg).trim()
          if (!text || seen.has(text)) continue
          seen.add(text)
          prompts.push({ text, at: r.at, sessionId: r.sessionId })
        }
        return { ok: true, prompts }
      } catch {
        return { ok: false, sentence: tr('historyFailed') }
      }
    },

    async editDraft(draft) {
      if (!opts.editor) return { ok: false, sentence: tr('noEditor') }
      try { return await opts.editor(draft) } catch { return { ok: false, sentence: tr('editorFailed') } }
    },

    async dispose() {
      for (const id of [...sessions.keys()]) await host.end(id)
      const rt = await runtimeIfOpen()
      runtimeP = null
      resolved = null
      await rt?.dispose().catch(() => {})
    },
  }

  return host
}
