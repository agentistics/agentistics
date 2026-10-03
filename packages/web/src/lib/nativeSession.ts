/**
 * nativeSession.ts — PURE: the web's side of a NATIVE Agentistics session (UI.2/UI.3). The engine
 * serves `/api/runtime/sessions/**` (master spec §28); this file only builds what the web sends and
 * reads what it answers. No fetch here — the hooks own I/O.
 *
 * ## The harness id: a separate type, not a new `HarnessId`
 *
 * `'agentistics'` is `RunHarness` in core (`canonical/entities.ts`: `HarnessId | 'agentistics'`),
 * deliberately NOT a `HarnessId`: twenty-eight exhaustive `Record<HarnessId, …>` tables (core, web,
 * tui, server, the MCP list, the engine's integration registry) describe EXTERNAL harnesses — a
 * transcript dir, a spawn spec, an attention rule — none of which a native session has. Joining it
 * would fill those tables with entries that are false. The wizard's picker and the mark are keyed by
 * string already, so the native entry costs nothing there.
 *
 * ## The gate
 *
 * Shown only when `GET /api/engine` says an engine is present AND provides the native runtime — a
 * community build has none, and an entry that can only fail is not an option.
 */

import type { HarnessAnswer } from './wizardSteps'

export const NATIVE_HARNESS_ID = 'agentistics'
export const NATIVE_HARNESS_LABEL = 'Agentistics'

export function nativeRuntimeFrom(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false
  const s = status as { present?: unknown; manifest?: { provides?: { nativeRuntime?: unknown } } }
  return s.present === true && s.manifest?.provides?.nativeRuntime === true
}

export function nativeHarnessAnswer(models: { id: string; label: string }[]): HarnessAnswer {
  return {
    id: NATIVE_HARNESS_ID,
    label: NATIVE_HARNESS_LABEL,
    modelSuggestions: [],
    models,
    modelFreeText: true,
    supportsModel: true,
    modelRequired: true,
    efforts: [],
  }
}

/** The list the picker offers: the machine's harnesses, plus the native one when the engine has it. */
export function withNativeHarness(
  harnesses: HarnessAnswer[] | null,
  nativeRuntime: boolean,
  models: { id: string; label: string }[],
): HarnessAnswer[] | null {
  if (harnesses === null) return null
  if (!nativeRuntime) return harnesses
  return [...harnesses.filter(h => h.id !== NATIVE_HARNESS_ID), nativeHarnessAnswer(models)]
}

export interface ProviderChoice {
  id: string
  label: string
}

/**
 * Providers a native session can run on now — the engine's own rule (`defaultCheckCredential`): a
 * usable stored credential, a record stored keyless, or Ollama, the one local endpoint that never
 * needs one.
 */
export function configuredProviders(list: readonly { id: string; label: string; state: string; keyless?: boolean }[]): ProviderChoice[] {
  return list.filter(p => p.state === 'present' || p.keyless === true || p.id === 'ollama').map(p => ({ id: p.id, label: p.label }))
}

const base = (id: string) => `/api/runtime/sessions/${encodeURIComponent(id)}`

export const windowUrl = (id: string) => `${base(id)}/messages?limit=200`
export const messagesUrl = (id: string) => `${base(id)}/messages`
export const streamUrl = (id: string, from?: number) => `${base(id)}/stream${from !== undefined ? `?from=${from}` : ''}`
export const approveUrl = (id: string, execId: string) => `${base(id)}/tools/${encodeURIComponent(execId)}/approve`
export const cancelUrl = (id: string, runId: string) => `${base(id)}/runs/${encodeURIComponent(runId)}/cancel`
export const CREATE_URL = '/api/runtime/sessions'

export function createBody(a: {
  cwd: string; model: string; provider: string; title: string
  /** UI follow-up 2: the task (and subtask) the wizard's task step chose — the engine files there. */
  filing?: { taskId: string; subtaskId?: string } | null
}): Record<string, string> {
  return {
    cwd: a.cwd,
    model: a.model,
    ...(a.provider ? { provider: a.provider } : {}),
    ...(a.title.trim() ? { title: a.title.trim() } : {}),
    ...(a.filing ? { taskId: a.filing.taskId, ...(a.filing.subtaskId ? { subtaskId: a.filing.subtaskId } : {}) } : {}),
  }
}

/** PUT {taskId, subtaskId?} files (or moves) a native session on the board; DELETE unfiles it. */
export function filingUrl(id: string): string {
  return `${CREATE_URL}/${encodeURIComponent(id)}/filing`
}

const FILING_REASONS: Record<string, { en: string; pt: string }> = {
  blocked: { en: 'that subtask is blocked by another one', pt: 'essa subtarefa está bloqueada por outra' },
  no_such_task: { en: 'that task no longer exists', pt: 'essa tarefa não existe mais' },
  no_such_subtask: { en: 'that subtask no longer exists', pt: 'essa subtarefa não existe mais' },
  subtask_in_group: { en: 'a subtask inside a group cannot hold a session — file it on the group', pt: 'uma subtarefa dentro de um grupo não recebe sessão — arquive no grupo' },
  wrong_delivery: { en: 'that subtask belongs to another task', pt: 'essa subtarefa é de outra tarefa' },
  board_unavailable: { en: 'the board could not be reached', pt: 'o board não respondeu' },
}

/**
 * The filing's outcome as the person reads it, or null when there is nothing to say (filed, or no
 * filing asked). A refused filing leaves the session STARTED and unfiled — the sentence says both.
 */
export function filingSentence(filing: unknown, lang: 'pt' | 'en'): string | null {
  const f = (filing && typeof filing === 'object' ? filing : null) as { ok?: unknown; reason?: unknown } | null
  if (!f || f.ok !== false) return null
  const reason = typeof f.reason === 'string' ? f.reason : ''
  const words = FILING_REASONS[reason]
  if (lang === 'pt') return words ? `A sessão começou, mas não foi arquivada: ${words.pt}.` : `A sessão começou, mas não foi arquivada (${reason}).`
  return words ? `The session started, but was not filed: ${words.en}.` : `The session started, but was not filed (${reason}).`
}

/** The question a tool call's approval answers sits under that call's execution id. */
export function execIdOf(questionId: string): string {
  const i = questionId.indexOf(':')
  return i < 0 ? questionId : questionId.slice(0, i)
}

/** What a refused request says: the engine's own sentence when it gave one. */
export function refusalSentence(body: unknown, status: number, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  const b = (body && typeof body === 'object' ? body : {}) as { sentence?: unknown; error?: unknown }
  if (typeof b.sentence === 'string' && b.sentence) return b.sentence
  if (b.error === 'engine-absent') return pt ? 'Esta versão não tem o runtime nativo.' : 'This build has no native runtime.'
  return pt ? `O servidor recusou (${status}).` : `The server refused (${status}).`
}

/**
 * An approval option as the person reads it. The engine words its options in English ("Allow once",
 * "Allow for this session: …", "Deny"); the known ones are translated, anything else passes as is.
 */
export function optionLabel(label: string, lang: 'pt' | 'en'): string {
  if (lang !== 'pt') return label
  if (label === 'Allow once') return 'Permitir uma vez'
  if (label === 'Deny') return 'Negar'
  const s = /^Allow for this session: commands starting with (.+)$/.exec(label)
  if (s) return `Permitir nesta sessão: comandos que começam com ${s[1]}`
  const t = /^Allow for this session: (.+)$/.exec(label)
  if (t) return `Permitir nesta sessão: ${t[1]}`
  return label
}

/** The option that refuses (drawn apart from the ones that allow). */
export const isDenyOption = (label: string) => label === 'Deny'

/** `1.2 s`, `350 ms`. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}
