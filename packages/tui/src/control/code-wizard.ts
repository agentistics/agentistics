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

export type WizardStep = 'task' | 'review'

export interface WizardState {
  step: WizardStep
  /** `null` while the host is still answering. */
  tasks: CodeTaskOption[] | null
  /** The host's refusal, in its own words, when the list could not be read. */
  tasksError: string | null
  /** Row under the cursor on the task step; `tasks.length` is the `＋ new task…` row. */
  cursor: number
  /** The inline title field, open (`''` or more) or closed (`null`). */
  newTitle: string | null
  /** The task picked (or just created) — what the review files the session under. */
  task: CodeTaskOption | null
  /** Carried from `agentop code "<prompt>"` or from the composer, sent right after the start. */
  firstMessage: string
  /** `null` while the host is still answering. */
  defaults: CodeDefaults | null
  /** A host call is in flight; keys other than `esc` are held. */
  busy: boolean
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
  }
}

/** What a wizard key asks the screen to do beyond updating the wizard itself. */
export type WizardEffect =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'create-task'; title: string }
  | { kind: 'start'; taskId: string; model: string; cwd: string; firstMessage?: string }
  | { kind: 'say'; code: 'empty-title' | 'loading' }
  /** The review refuses to start: the host's own sentence, printed as it came. */
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

/**
 * One key, folded. The host calls it names (`create-task`, `start`) are returned as effects for the
 * screen to perform; the screen then reports back through `taskCreated` / `wizardBusy`.
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
      return keep({ ...st, task, step: 'review' })
    }
    return keep(st)
  }

  // review
  if (k.escape) return keep({ ...st, step: 'task', busy: false })
  if (st.busy) return keep(st)
  if (k.return) {
    if (!st.task) return keep({ ...st, step: 'task' })
    if (!st.defaults) return keep(st, { kind: 'say', code: 'loading' })
    if (!st.defaults.model) return keep(st, { kind: 'refuse', sentence: st.defaults.noModelSentence ?? '' })
    const first = st.firstMessage.trim()
    return keep({ ...st, busy: true }, {
      kind: 'start',
      taskId: st.task.id,
      model: st.defaults.model.id,
      cwd: st.defaults.cwd,
      ...(first ? { firstMessage: first } : {}),
    })
  }
  return keep(st)
}

/** The host created the task: it is picked, and the wizard moves on to the review. */
export function taskCreated(st: WizardState, task: CodeTaskOption): WizardState {
  const tasks = [...(st.tasks ?? []), task]
  return { ...st, tasks, cursor: tasks.length - 1, newTitle: null, task, step: 'review', busy: false }
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
  const steps: Array<{ id: WizardStep; label: string }> = [
    { id: 'task', label: t.stepTask },
    { id: 'review', label: t.stepReview },
  ]
  const at = steps.findIndex(s => s.id === st.step)
  const line: Line = []
  steps.forEach((s, i) => {
    if (i > 0) line.push(seg('  '))
    if (i === at) line.push(seg(` ${i + 1} ${s.label} `, { color: COLORS.text, bg: COLORS.border, bold: true }))
    else if (i < at) line.push(seg(`✓ ${s.label}`, { color: COLORS.success }))
    else line.push(seg(`${i + 1} ${s.label}`, { color: COLORS.muted }))
  })
  return fitLine(line, width)
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

  // review (NW-06)
  head.push(fitLine([seg(t.review, { color: COLORS.text, bold: true })], width))
  head.push([])
  const label = (s: string) => seg(s, { color: COLORS.label })
  const body: Line[] = []
  const task = st.task
  body.push(lr([label(t.fieldTask)], task ? [seg(task.ref, { color: COLORS.accent }), seg(` ${task.title}`, { color: COLORS.text })] : [seg('—', { color: COLORS.muted })], width, 2))
  body.push(lr([label(t.fieldAssistant)], [seg(t.assistantNative, { color: COLORS.text })], width, 2))
  const d = st.defaults
  if (!d) {
    body.push(lr([label(t.fieldModel)], [seg(t.loading, { color: COLORS.muted })], width, 2))
    body.push(lr([label(t.fieldFolder)], [seg(t.loading, { color: COLORS.muted })], width, 2))
  } else {
    body.push(lr(
      [label(t.fieldModel)],
      d.model
        ? [seg(d.model.id, { color: COLORS.text }), seg(`  ${d.model.source === 'flag' ? t.fromFlag : t.fromLastSession}`, { color: COLORS.muted })]
        : [seg(t.na, { color: COLORS.danger })],
      width,
      2,
    ))
    body.push(lr([label(t.fieldFolder)], [seg(truncateCells(d.cwd, Math.max(1, width - cellWidth(t.fieldFolder) - 2)), { color: COLORS.text })], width, 2))
  }
  const first = st.firstMessage.trim()
  body.push(lr([label(t.fieldFirst)], first ? [seg(first, { color: COLORS.text })] : [seg(t.none, { color: COLORS.muted })], width, 2))
  body.push([])
  // D-TUI-9: the no-sandbox line is part of the review, not a footnote.
  for (const l of wrapText(t.noSandboxReview, width)) body.push([seg(l, { color: COLORS.accent, bold: true })])
  if (d && !d.model && d.noModelSentence) {
    body.push([])
    for (const l of wrapText(d.noModelSentence, width)) body.push([seg(l, { color: COLORS.danger })])
  }
  return { head, body: body.map(l => fitLine(l, width)), selected: null }
}

/**
 * SS-09: the SAME task step, as the `sessions` tab's "file under a task" picker — no crumbs (there is
 * no review step: picking a task files the session). Keys are `wizardKey`'s; reaching `review` with a
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
  // `enter start` only when enter can start — otherwise the footer would promise a session the
  // review is about to refuse.
  const canStart = Boolean(st.defaults?.model && st.task)
  return [...(canStart ? [t.keyStart] : []), t.keyBack]
}
