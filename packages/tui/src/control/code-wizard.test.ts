import { describe, expect, test } from 'bun:test'
import { lineText, lineWidth } from './code'
import { codeStrings } from './code-i18n'
import { openWizard, taskCreated, wizardHints, wizardKey, wizardLines, type WizardState } from './code-wizard'
import type { CodeDefaults, CodeTaskOption } from './code-types'

const t = codeStrings('en')

const TASKS: CodeTaskOption[] = [
  { id: 'a', ref: 't-0539', title: 'Parser: off-by-one on the last byte', status: 'in_progress', statusLabel: 'In progress' },
  { id: 'b', ref: 't-0412', title: 'Billing export as CSV', status: 'todo', statusLabel: 'To do' },
]

const DEFAULTS: CodeDefaults = {
  model: { id: 'claude-sonnet-5', source: 'flag' },
  cwd: '/home/someone/agentistics',
  workspaceRoot: '/home/someone/agentistics',
  provider: 'anthropic',
}

const NO_MODEL: CodeDefaults = {
  model: null,
  noModelSentence: 'No model is registered for anthropic yet — pass --model <id>.',
  cwd: '/home/someone/agentistics',
  workspaceRoot: '/home/someone/agentistics',
  provider: 'anthropic',
}

const loaded = (over: Partial<WizardState> = {}): WizardState => ({ ...openWizard('fix the parser'), tasks: TASKS, defaults: DEFAULTS, ...over })
const key = (input: string, over: Record<string, boolean> = {}) => ({ input, ...over })

describe('the P1 wizard: task, then review — nothing else', () => {
  test('two crumbs only; the P4 steps are not drawn', () => {
    const head = wizardLines(loaded(), t, 80).head.map(lineText).join('\n')
    expect(head).toContain('1 task')
    expect(head).toContain('2 review')
    for (const later of ['assistant', 'model', 'folder', 'prompt']) expect(head).not.toContain(later)
  })

  test('the task step cannot be skipped: esc closes, nothing starts', () => {
    const r = wizardKey(loaded(), key('', { escape: true }))
    expect(r.effect).toEqual({ kind: 'close' })
  })

  test('enter on a task moves to the review with that task', () => {
    const r = wizardKey(loaded({ cursor: 1 }), key('', { return: true }))
    expect(r.state.step).toBe('review')
    expect(r.state.task?.id).toBe('b')
  })

  test('the last row opens the inline title field; an empty title is refused in words', () => {
    const open = wizardKey(loaded({ cursor: TASKS.length }), key('', { return: true })).state
    expect(open.newTitle).toBe('')
    expect(wizardKey(open, key('', { return: true })).effect).toEqual({ kind: 'say', code: 'empty-title' })
    const typed = wizardKey(wizardKey(open, key('New ')).state, key('task')).state
    expect(typed.newTitle).toBe('New task')
    const r = wizardKey(typed, key('', { return: true }))
    expect(r.effect).toEqual({ kind: 'create-task', title: 'New task' })
    expect(r.state.busy).toBe(true)
    // esc in the field goes back to the list, not out of the wizard.
    expect(wizardKey(typed, key('', { escape: true })).state.newTitle).toBeNull()
  })

  test('a created task is picked and the review follows', () => {
    const created = taskCreated(loaded({ newTitle: 'New task', busy: true }), { id: 'c', ref: 't-0600', title: 'New task', status: 'todo', statusLabel: 'To do' })
    expect(created.step).toBe('review')
    expect(created.task?.ref).toBe('t-0600')
    expect(created.busy).toBe(false)
  })

  test('the arrows walk the tasks and the new-task row, wrapping', () => {
    const up = wizardKey(loaded(), key('', { upArrow: true })).state
    expect(up.cursor).toBe(TASKS.length)
  })

  test('the list failing to load still leaves a way on: a new task', () => {
    const st = { ...openWizard(), tasksError: 'The board could not be read.' }
    expect(wizardKey(st, key('', { return: true })).state.newTitle).toBe('')
    expect(wizardLines(st, t, 80).body.map(lineText).join('\n')).toContain('new task…')
  })
})

describe('review (NW-06)', () => {
  const review = (over: Partial<WizardState> = {}) => loaded({ step: 'review', task: TASKS[0]!, ...over })

  test('states task, assistant, model with its provenance, folder, first message and the no-sandbox line', () => {
    const text = wizardLines(review(), t, 100).body.map(lineText).join('\n')
    expect(text).toContain('t-0539 Parser: off-by-one on the last byte')
    expect(text).toContain('agentistics (native)')
    expect(text).toContain('claude-sonnet-5  from --model')
    expect(text).toContain('/home/someone/agentistics')
    expect(text).toContain('fix the parser')
    expect(text).toContain('▲ no sandbox: tools run as you in that folder; everything not allowlisted asks first')
    expect(wizardLines(review({ defaults: { ...DEFAULTS, model: { id: 'm', source: 'last-session' } } }), t, 100).body.map(lineText).join('\n')).toContain('from your last session')
    expect(wizardLines(review({ firstMessage: '' }), t, 100).body.map(lineText).join('\n')).toContain('none')
  })

  test('enter starts, filed under the task, with the first message', () => {
    const r = wizardKey(review(), key('', { return: true }))
    expect(r.effect).toEqual({ kind: 'start', taskId: 'a', model: 'claude-sonnet-5', cwd: '/home/someone/agentistics', firstMessage: 'fix the parser' })
  })

  test('with no model, enter REFUSES in the host’s words instead of starting', () => {
    const st = review({ defaults: NO_MODEL })
    expect(wizardKey(st, key('', { return: true })).effect).toEqual({ kind: 'refuse', sentence: NO_MODEL.noModelSentence! })
    expect(wizardLines(st, t, 100).body.map(lineText).join('\n')).toContain('pass --model')
    expect(wizardHints(st, t)).not.toContain(t.keyStart)
  })

  test('esc goes back to the task step', () => {
    expect(wizardKey(review(), key('', { escape: true })).state.step).toBe('task')
  })

  test('no line wider than its width', () => {
    for (const w of [30, 60, 80, 108]) {
      for (const st of [loaded(), review(), review({ defaults: NO_MODEL }), loaded({ newTitle: 'x'.repeat(200) }), openWizard()]) {
        const l = wizardLines(st, t, w)
        for (const line of [...l.head, ...l.body]) expect(lineWidth(line)).toBeLessThanOrEqual(w)
      }
    }
  })
})
