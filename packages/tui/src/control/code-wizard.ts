/**
 * code-wizard.ts — the P1 new-session wizard, PURE: its state, what each key does to it, and the
 * lines it draws.
 *
 * P1 is TWO steps, `task` then `review` (NW-01, NW-06). The assistant, model, folder and
 * first-message steps are P4 (NW-02…05) and are deliberately absent — not drawn as steps, not
 * drawn as crumbs: a crumb for a step that cannot be visited is a control that lies about the flow.
 * Until they exist the review states what the session WILL use (the native assistant, the model the
 * person gave and where it came from, the folder the tab was opened in) so nothing is chosen
 * silently.
 *
 * The task is REQUIRED (D-TUI-6): the task step cannot be skipped, and `esc` there closes the wizard
 * without starting anything — a session that exists only if someone remembers to file it later is
 * exactly the untracked work the rule exists to prevent.
 */

import { COLORS } from '../theme'
import type { CodeDefaults, CodeTaskOption } from './code-types'
import type { CodeStrings } from './code-i18n'
import { cellWidth, fitLine, lr, seg, truncateCells, wrapText, type Line } from './code'

export type WizardStep = 'task' | 'assistant' | 'model' | 'folder' | 'prompt' | 'review'

/** NW-02: an assistant this machine can start — the native one, or an installed harness. */
export interface WizardAssistant {
  id: string
  label: string
  note: string
  native: boolean
  /** The harness has a model flag (the native assistant always does). */
  supportsModel: boolean
}

/** NW-03: one model row — with its price, window and where they come from; `disabled` says why not. */
export interface WizardModel {
  /** `''` = the CLI's own default (no flag passed). */
  id: string
  /** NW-03: the keyed provider a NATIVE model runs on. */
  provider?: string
  label: string
  detail: string
  disabled?: string
}

/** NW-04: a place to work — a repository/folder, or a new worktree of a repository. */
export interface WizardFolder {
  path: string
  label: string
  note: string
  /** Create a worktree of `path` (a repository) first, and work there. */
  newWorktree?: boolean
}

export interface WizardState {
  step: WizardStep
  /** `null` while the host is still answering. */
  tasks: CodeTaskOption[] | null
  /** The host's refusal, in its own words, when the list could not be read. */
  tasksError: string | null
  /** Row under the cursor on the current list step; on `task`, `tasks.length` is `＋ new task…`. */
  cursor: number
  /** The inline title field, open (`''` or more) or closed (`null`). */
  newTitle: string | null
  /** The task picked (or just created) — what the review files the session under. */
  task: CodeTaskOption | null
  /** NW-05: carried from `agentop code "<prompt>"` or the home, editable on the prompt step. */
  firstMessage: string
  /** `null` while the host is still answering. */
  defaults: CodeDefaults | null
  /** A host call is in flight; keys other than `esc` are held. */
  busy: boolean
  assistants: WizardAssistant[] | null
  assistant: WizardAssistant | null
  models: WizardModel[] | null
  modelsError: string | null
  model: WizardModel | null
  folders: WizardFolder[] | null
  folder: WizardFolder | null
}

export function openWizard(firstMessage = ''): WizardState {
  return {
    step: 'task',
    tasks: null,
    tasksError: null,
    cursor: 0,
    newTitle: null,
    task: null,
    firstMessage,
    defaults: null,
    busy: false,
    assistants: null,
    assistant: null,
    models: null,
    modelsError: null,
    model: null,
    folders: null,
    folder: null,
  }
}

/** What a wizard key asks the screen to do beyond updating the wizard itself. */
export type WizardEffect =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'create-task'; title: string }
  /** An assistant was picked: the screen reads its models (native: the host's catalogue). */
  | { kind: 'load-models'; assistant: WizardAssistant }
  /** The native session — filed, in `cwd` (after creating the worktree when asked). */
  | { kind: 'start'; taskId: string; taskTitle: string; model: string; provider?: string; cwd: string; firstMessage?: string; worktree?: boolean }
  /** An installed harness under tmux — filed on the task the same way. */
  | { kind: 'spawn'; harness: string; label: string; taskId: string; taskTitle: string; model?: string; cwd: string; prompt?: string; worktree?: boolean }
  | { kind: 'say'; code: 'empty-title' | 'loading' }
  /** Refused: the host's (or the row's) own sentence, printed as it came. */
  | { kind: 'refuse'; sentence: string }

export interface WizardKey {
  input: string
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
}

export interface WizardResult {
  state: WizardState
  effect: WizardEffect
}

const keep = (state: WizardState, effect: WizardEffect = { kind: 'none' }): WizardResult => ({ state, effect })

/** Rows on the task step: every open task, then `＋ new task…`. */
export function taskRowCount(st: WizardState): number {
  return (st.tasks?.length ?? 0) + 1
}

function editTitle(v: string, k: WizardKey): string | null {
  if (k.backspace || k.delete) return v.slice(0, -1)
  if ((k.ctrl && k.input === 'u') || k.input === '\x15') return ''
  if (k.ctrl || k.meta || k.tab || k.upArrow || k.downArrow || k.return || k.escape) return null
  const printable = [...k.input.replace(/\r\n|\r|\n/g, ' ')].filter(ch => ch >= ' ' && ch !== '\x7f').join('')
  return printable ? v + printable : null
}

/** The steps this wizard walks, in order — `model` only for an assistant with a model flag. */
export function wizardSteps(st: Pick<WizardState, 'assistant'>): WizardStep[] {
  const skipModel = st.assistant !== null && !st.assistant.supportsModel
  return ['task', 'assistant', ...(skipModel ? [] : ['model' as const]), 'folder', 'prompt', 'review']
}

function stepAfter(st: WizardState, from: WizardStep): WizardStep {
  const steps = wizardSteps(st)
  return steps[Math.min(steps.length - 1, steps.indexOf(from) + 1)]!
}

function stepBefore(st: WizardState, from: WizardStep): WizardStep {
  const steps = wizardSteps(st)
  return steps[Math.max(0, steps.indexOf(from) - 1)]!
}

/** The cursor a step opens on: the current pick when there is one, else the first row. */
function cursorFor(st: WizardState, step: WizardStep): number {
  if (step === 'assistant') return Math.max(0, st.assistants?.findIndex(a => a.id === st.assistant?.id) ?? 0)
  if (step === 'model') return Math.max(0, st.models?.findIndex(m => m.id === st.model?.id) ?? 0)
  if (step === 'folder') return Math.max(0, st.folders?.findIndex(f => f.path === st.folder?.path && Boolean(f.newWorktree) === Boolean(st.folder?.newWorktree)) ?? 0)
  return 0
}

const go = (st: WizardState, step: WizardStep): WizardState => ({ ...st, step, cursor: cursorFor({ ...st, step }, step) })

function listKey<T>(st: WizardState, list: T[] | null, k: WizardKey): WizardState | null {
  const n = list?.length ?? 0
  if (n === 0) return null
  if (k.upArrow) return { ...st, cursor: (st.cursor + n - 1) % n }
  if (k.downArrow) return { ...st, cursor: (st.cursor + 1) % n }
  return null
}

/**
 * One key, folded. The host calls it names (`create-task`, `load-models`, `start`, `spawn`) are
 * returned as effects for the screen to perform; the screen reports back through `taskCreated`,
 * `withModels`, …
 */
export function wizardKey(st: WizardState, k: WizardKey): WizardResult {
  if (st.step === 'task') {
    if (st.newTitle !== null) {
      if (k.escape) return keep({ ...st, newTitle: null })
      if (st.busy) return keep(st)
      if (k.return) {
        const title = st.newTitle.trim()
        if (!title) return keep(st, { kind: 'say', code: 'empty-title' })
        return keep({ ...st, busy: true }, { kind: 'create-task', title })
      }
      const next = editTitle(st.newTitle, k)
      return next === null ? keep(st) : keep({ ...st, newTitle: next })
    }
    // `esc` on the task step CLOSES — there is no step before it, and skipping it is not an option.
    if (k.escape) return keep(st, { kind: 'close' })
    if (st.busy) return keep(st)
    const n = taskRowCount(st)
    if (k.upArrow) return keep({ ...st, cursor: (st.cursor + n - 1) % n })
    if (k.downArrow) return keep({ ...st, cursor: (st.cursor + 1) % n })
    if (k.return) {
      // The list could not be read: creating a task is still possible, and it is the only way on.
      if (st.tasks === null && st.tasksError) return keep({ ...st, newTitle: '' })
      if (st.tasks === null) return keep(st, { kind: 'say', code: 'loading' })
      if (st.cursor >= st.tasks.length) return keep({ ...st, newTitle: '' })
      const task = st.tasks[st.cursor]!
      return keep(go({ ...st, task }, 'assistant'))
    }
    return keep(st)
  }

  if (k.escape) return keep(go({ ...st, busy: false }, stepBefore(st, st.step)))
  if (st.busy) return keep(st)

  if (st.step === 'assistant') {
    const moved = listKey(st, st.assistants, k)
    if (moved) return keep(moved)
    if (!k.return) return keep(st)
    if (st.assistants === null) return keep(st, { kind: 'say', code: 'loading' })
    const assistant = st.assistants[st.cursor]
    if (!assistant) return keep(st)
    // A different assistant drops the model picked for the previous one.
    const changed = st.assistant?.id !== assistant.id
    const next: WizardState = { ...st, assistant, ...(changed ? { model: null, models: null, modelsError: null } : {}) }
    return keep(go(next, stepAfter(next, 'assistant')), changed ? { kind: 'load-models', assistant } : { kind: 'none' })
  }

  if (st.step === 'model') {
    const moved = listKey(st, st.models, k)
    if (moved) return keep(moved)
    if (!k.return) return keep(st)
    if (st.models === null && st.modelsError) return keep(st, { kind: 'refuse', sentence: st.modelsError })
    if (st.models === null) return keep(st, { kind: 'say', code: 'loading' })
    const model = st.models[st.cursor]
    if (!model) return keep(st)
    // NW-03: a disabled provider's row stays in the list and says why — it is never picked.
    if (model.disabled) return keep(st, { kind: 'refuse', sentence: model.disabled })
    return keep(go({ ...st, model }, 'folder'))
  }

  if (st.step === 'folder') {
    const moved = listKey(st, st.folders, k)
    if (moved) return keep(moved)
    if (!k.return) return keep(st)
    if (st.folders === null) return keep(st, { kind: 'say', code: 'loading' })
    const folder = st.folders[st.cursor]
    if (!folder) return keep(st)
    return keep(go({ ...st, folder }, 'prompt'))
  }

  if (st.step === 'prompt') {
    if (k.return) return keep(go(st, 'review'))
    const next = editTitle(st.firstMessage, k)
    return next === null ? keep(st) : keep({ ...st, firstMessage: next })
  }

  // review (NW-06)
  if (!k.return) return keep(st)
  if (!st.task) return keep(go(st, 'task'))
  if (!st.assistant) return keep(go(st, 'assistant'))
  if (!st.folder) return keep(go(st, 'folder'))
  const first = st.firstMessage.trim()
  const worktree = st.folder.newWorktree ? { worktree: true } : {}
  if (st.assistant.native) {
    const model = st.model?.id || st.defaults?.model?.id
    if (!model) return keep(st, { kind: 'refuse', sentence: st.defaults?.noModelSentence ?? '' })
    const provider = st.model?.id ? st.model.provider : st.defaults?.provider
    return keep({ ...st, busy: true }, {
      kind: 'start', taskId: st.task.id, taskTitle: st.task.title, model, ...(provider ? { provider } : {}),
      cwd: st.folder.path, ...(first ? { firstMessage: first } : {}), ...worktree,
    })
  }
  return keep({ ...st, busy: true }, {
    kind: 'spawn', harness: st.assistant.id, label: st.assistant.label, taskId: st.task.id, taskTitle: st.task.title,
    ...(st.model?.id ? { model: st.model.id } : {}), cwd: st.folder.path, ...(first ? { prompt: first } : {}), ...worktree,
  })
}

/** The screen read the assistant's models (or the host refused, in its words). */
export function withModels(st: WizardState, r: { models: WizardModel[] } | { sentence: string }): WizardState {
  if ('sentence' in r) return { ...st, models: null, modelsError: r.sentence }
  const models = r.models
  return { ...st, models, modelsError: null, cursor: st.step === 'model' ? Math.max(0, models.findIndex(m => !m.disabled)) : st.cursor }
}

/** What the wizard asks the control center for (it is built from `ControlHost`). */
export interface WizardServices {
  harnesses?(): Promise<{ id: string; label: string; supportsModel: boolean; modelSuggestions: string[]; defaultModel?: string }[]>
  nativeModels?(): Promise<{ models: WizardModel[] } | { sentence: string }>
  places?(): Promise<{ path: string; label: string; detail: string; repo?: string; source: string; worktree?: boolean }[]>
  createWorktree?(repo: string, name: string): Promise<{ ok: true; path: string; sentence: string } | { ok: false; sentence: string }>
  spawn?(req: { harness: string; cwd: string; taskId: string; task: string; model?: string; prompt?: string; label?: string }): Promise<{ ok: boolean; message: string; id?: string }>
  /** NW-06: land on the new row of a harness session (the `sessions` tab). */
  landOn?(id: string): void
}

/** NW-02: the native assistant first, then every installed harness the host can start. */
export function assistantRows(
  harnesses: readonly { id: string; label: string; supportsModel: boolean }[],
  o: { native: boolean; nativeLabel: string; nativeNote: string; harnessNote: string },
): WizardAssistant[] {
  return [
    ...(o.native ? [{ id: 'agentistics', label: o.nativeLabel, note: o.nativeNote, native: true, supportsModel: true }] : []),
    ...harnesses.map(h => ({ id: h.id, label: h.label, note: o.harnessNote, native: false, supportsModel: h.supportsModel })),
  ]
}

/**
 * NW-04: where it works — the folder the tab was opened in first, then the places the host knows
 * (recent first); each of the first `worktrees` repositories is followed by a "new worktree" row.
 */
export function folderRows(
  places: readonly { path: string; label: string; detail: string; repo?: string; source: string; worktree?: boolean }[],
  here: string | null,
  t: Pick<CodeStrings, 'newWorktreeOf' | 'newWorktreeNote'>,
  o: { max?: number; worktrees?: number } = {},
): WizardFolder[] {
  const max = o.max ?? 8
  let wt = o.worktrees ?? 2
  const seen = new Set<string>()
  const out: WizardFolder[] = []
  const ordered = [...places].sort((a, b) => Number(b.path === here) - Number(a.path === here))
  if (here && !ordered.some(p => p.path === here)) out.push({ path: here, label: here, note: '' }), seen.add(here)
  for (const p of ordered) {
    if (out.length >= max || seen.has(p.path)) continue
    seen.add(p.path)
    out.push({ path: p.path, label: p.detail || p.label, note: p.repo ?? '' })
    if (p.repo && !p.worktree && wt > 0) {
      wt--
      out.push({ path: p.path, label: t.newWorktreeOf(p.detail || p.label), note: t.newWorktreeNote, newWorktree: true })
    }
  }
  return out
}

/** The installed harness's own model rows: its CLI default first, then the suggestions it publishes. */
export function harnessModels(o: { defaultModel?: string; modelSuggestions: readonly string[] }, t: Pick<CodeStrings, 'cliDefault' | 'cliDefaultNote'>): WizardModel[] {
  return [
    { id: '', label: o.defaultModel ? `${t.cliDefault} (${o.defaultModel})` : t.cliDefault, detail: t.cliDefaultNote },
    ...o.modelSuggestions.map(m => ({ id: m, label: m, detail: '' })),
  ]
}

/** The host created the task: it is picked, and the wizard moves on to the review. */
export function taskCreated(st: WizardState, task: CodeTaskOption): WizardState {
  const tasks = [...(st.tasks ?? []), task]
  return { ...go({ ...st, tasks, newTitle: null, task, busy: false }, 'assistant') }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// drawing
// ═════════════════════════════════════════════════════════════════════════════════════════════

export interface WizardLines {
  /** Fixed at the top: the crumbs and the question. */
  head: Line[]
  /** The list (task step) or the summary (review). */
  body: Line[]
  /** Which body row is selected, so the screen can keep it in view with `windowOffset`. */
  selected: number | null
}

function crumbs(st: WizardState, t: CodeStrings, width: number): Line {
  const label: Record<WizardStep, string> = {
    task: t.stepTask, assistant: t.stepAssistant, model: t.stepModel, folder: t.stepFolder, prompt: t.stepPrompt, review: t.stepReview,
  }
  const steps = wizardSteps(st)
  const at = steps.indexOf(st.step)
  const line: Line = []
  steps.forEach((id, i) => {
    if (i > 0) line.push(seg('  '))
    if (i === at) line.push(seg(` ${i + 1} ${label[id]} `, { color: COLORS.text, bg: COLORS.border, bold: true }))
    else if (i < at) line.push(seg(`✓ ${label[id]}`, { color: COLORS.success }))
    else line.push(seg(`${i + 1} ${label[id]}`, { color: COLORS.muted }))
  })
  return fitLine(line, width)
}

/** A list step's rows: `▸` on the cursor, the label, its note muted (a disabled row dims whole). */
function listRows(rows: { label: string; note: string; dim?: boolean }[], cursor: number, width: number): Line[] {
  // The notes start in one column: labels padded to the widest (capped at half the width).
  const col = Math.min(Math.floor(width / 2), Math.max(0, ...rows.map(r => cellWidth(r.label))))
  return rows.map((r, i) => {
    const on = i === cursor
    const label = cellWidth(r.label) < col ? r.label + ' '.repeat(col - cellWidth(r.label)) : r.label
    return fitLine([
      seg(on ? '▸ ' : '  ', { color: COLORS.accent }),
      seg(label, { color: r.dim ? COLORS.muted : on ? COLORS.text : COLORS.label, bold: on && !r.dim }),
      seg(r.note ? `  ${r.note}` : '', { color: COLORS.muted }),
    ], width)
  })
}

/**
 * The wizard's lines at `width`. `folderShown` lets the screen shorten a home-relative path the pure
 * module cannot know about; absent, the folder is printed as the host gave it.
 */
export function wizardLines(st: WizardState, t: CodeStrings, width: number): WizardLines {
  const head: Line[] = [crumbs(st, t, width), []]
  if (st.step === 'task') {
    head.push(fitLine([seg(t.whichTask, { color: COLORS.text }), seg(` ${t.whichTaskNote}`, { color: COLORS.muted })], width))
    head.push([])
    if (st.newTitle !== null) {
      const room = Math.max(0, width - cellWidth(`＋ ${t.newTaskLabel} `) - 1)
      let shown = st.newTitle
      while (cellWidth(shown) > room) shown = shown.slice(1)
      return {
        head,
        body: [
          fitLine([seg('＋ ', { color: COLORS.accent }), seg(`${t.newTaskLabel} `, { color: COLORS.label }), seg(shown, { color: COLORS.text }), seg('▍', { color: COLORS.accent })], width),
          [],
          fitLine([seg(t.newTaskHelp, { color: COLORS.muted })], width),
        ],
        selected: 0,
      }
    }
    if (st.tasksError) {
      const body: Line[] = wrapText(st.tasksError, width).map(l => [seg(l, { color: COLORS.danger })])
      body.push([], fitLine([seg('▸ ', { color: COLORS.accent }), seg('＋ ', { color: COLORS.accent }), seg(t.newTaskRow, { color: COLORS.text, bold: true })], width))
      return { head, body, selected: body.length - 1 }
    }
    if (st.tasks === null) return { head, body: [fitLine([seg(t.loadingTasks, { color: COLORS.muted })], width)], selected: null }
    const body: Line[] = st.tasks.map((task, i) => {
      const on = i === st.cursor
      return lr(
        [seg(on ? '▸ ' : '  ', { color: COLORS.accent }), seg(task.ref, { color: COLORS.accent }), seg(` ${task.title}`, { color: on ? COLORS.text : COLORS.label, bold: on })],
        [seg(task.statusLabel, { color: COLORS.muted })],
        width,
        2,
      )
    })
    const onNew = st.cursor >= st.tasks.length
    body.push(fitLine([seg(onNew ? '▸ ' : '  ', { color: COLORS.accent }), seg('＋ ', { color: COLORS.accent }), seg(t.newTaskRow, { color: onNew ? COLORS.text : COLORS.label, bold: onNew })], width))
    if (st.tasks.length === 0) body.push([], fitLine([seg(t.noOpenTasks, { color: COLORS.muted })], width))
    return { head, body, selected: Math.min(st.cursor, st.tasks.length) }
  }

  if (st.step === 'assistant' || st.step === 'model' || st.step === 'folder') {
    const q = st.step === 'assistant'
      ? [seg(t.whichAssistant, { color: COLORS.text }), seg(` ${t.whichAssistantNote}`, { color: COLORS.muted })]
      : [seg(st.step === 'model' ? t.whichModel : t.whichFolder, { color: COLORS.text })]
    head.push(fitLine(q, width), [])
    if (st.step === 'assistant') {
      if (st.assistants === null) return { head, body: [fitLine([seg(t.loadingAssistants, { color: COLORS.muted })], width)], selected: null }
      if (st.assistants.length === 0) return { head, body: [fitLine([seg(t.noAssistants, { color: COLORS.danger })], width)], selected: null }
      return { head, body: listRows(st.assistants.map(a => ({ label: a.label, note: a.note })), st.cursor, width), selected: st.cursor }
    }
    if (st.step === 'model') {
      if (st.modelsError) return { head, body: wrapText(st.modelsError, width).map(l => [seg(l, { color: COLORS.danger })]), selected: null }
      if (st.models === null) return { head, body: [fitLine([seg(t.loadingModels, { color: COLORS.muted })], width)], selected: null }
      return { head, body: listRows(st.models.map(m => ({ label: m.label, note: m.disabled ?? m.detail, dim: Boolean(m.disabled) })), st.cursor, width), selected: st.cursor }
    }
    if (st.folders === null) return { head, body: [fitLine([seg(t.loadingFolders, { color: COLORS.muted })], width)], selected: null }
    return { head, body: listRows(st.folders.map(f => ({ label: f.label, note: f.note })), st.cursor, width), selected: st.cursor }
  }

  if (st.step === 'prompt') {
    head.push(fitLine([seg(t.firstMessageTitle, { color: COLORS.text })], width), [])
    const room = Math.max(1, width - 3)
    let shown = st.firstMessage
    while (cellWidth(shown) > room) shown = shown.slice(1)
    return {
      head,
      body: [
        fitLine([seg('› ', { color: COLORS.accent }), seg(shown, { color: COLORS.text }), seg('▍', { color: COLORS.accent })], width),
        [],
        fitLine([seg(t.firstMessageHint, { color: COLORS.muted })], width),
      ],
      selected: null,
    }
  }

  // review (NW-06)
  head.push(fitLine([seg(t.review, { color: COLORS.text, bold: true })], width))
  head.push([])
  const label = (s: string) => seg(s, { color: COLORS.label })
  const body: Line[] = []
  const task = st.task
  body.push(lr([label(t.fieldTask)], task ? [seg(task.ref, { color: COLORS.accent }), seg(` ${task.title}`, { color: COLORS.text })] : [seg('—', { color: COLORS.muted })], width, 2))
  const native = st.assistant?.native ?? true
  body.push(lr([label(t.fieldAssistant)], [seg(st.assistant?.label ?? t.assistantNative, { color: COLORS.text })], width, 2))
  const d = st.defaults
  const model = st.model ?? (d?.model ? { id: d.model.id, label: d.model.id, detail: d.model.source === 'flag' ? t.fromFlag : t.fromLastSession } : null)
  body.push(lr(
    [label(t.fieldModel)],
    model
      ? [seg(model.label, { color: COLORS.text }), seg(model.detail ? `  ${model.detail}` : '', { color: COLORS.muted })]
      : [seg(native ? t.na : t.cliDefault, { color: native ? COLORS.danger : COLORS.text })],
    width,
    2,
  ))
  const where = st.folder ? (st.folder.newWorktree ? st.folder.label : st.folder.path) : d?.cwd ?? t.loading
  body.push(lr([label(t.fieldFolder)], [seg(truncateCells(where, Math.max(1, width - cellWidth(t.fieldFolder) - 2)), { color: COLORS.text })], width, 2))
  const first = st.firstMessage.trim()
  body.push(lr([label(t.fieldFirst)], first ? [seg(first, { color: COLORS.text })] : [seg(t.none, { color: COLORS.muted })], width, 2))
  body.push([])
  // D-TUI-9: the no-sandbox line is part of the review, not a footnote — for the NATIVE assistant
  // (an installed harness runs under its own permission system, in tmux).
  if (native) for (const l of wrapText(t.noSandboxReview, width)) body.push([seg(l, { color: COLORS.accent, bold: true })])
  if (native && !model && d && d.noModelSentence) {
    body.push([])
    for (const l of wrapText(d.noModelSentence, width)) body.push([seg(l, { color: COLORS.danger })])
  }
  return { head, body: body.map(l => fitLine(l, width)), selected: null }
}

/**
 * SS-09: the SAME task step, as the `sessions` tab's "file under a task" picker — no crumbs (there is
 * no review step: picking a task files the session). Keys are `wizardKey`'s; leaving the task step with a
 * task picked means "file it there".
 */
export function filePickerLines(st: WizardState, t: CodeStrings, width: number): WizardLines {
  const w = wizardLines({ ...st, step: 'task' }, t, width)
  return { ...w, head: w.head.slice(2) }
}

/** Footer keys for the wizard, most important first. */
export function wizardHints(st: WizardState, t: CodeStrings): string[] {
  if (st.step === 'task') {
    if (st.newTitle !== null) return [t.keyCreate, t.keyBack]
    return [t.keyNext, t.keyChoose, t.keyClose]
  }
  if (st.step === 'prompt') return [t.keyNext, t.keyBack]
  if (st.step !== 'review') return [t.keyNext, t.keyChoose, t.keyBack]
  // `enter start` only when enter can start — otherwise the footer would promise a session the
  // review is about to refuse.
  const native = st.assistant?.native ?? true
  const canStart = Boolean(st.task && st.folder && (!native || st.model || st.defaults?.model))
  return [...(canStart ? [t.keyStart] : []), t.keyBack]
}
