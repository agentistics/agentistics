import { describe, expect, test } from 'bun:test'
import { lineText, lineWidth } from './code'
import { codeStrings } from './code-i18n'
import {
  assistantRows, folderRows, harnessModels, openWizard, taskCreated, wizardHints, wizardKey, wizardLines, wizardSteps,
  withModels, type WizardAssistant, type WizardState,
} from './code-wizard'
import type { CodeDefaults, CodeTaskOption } from './code-types'

const t = codeStrings('en')

const TASKS: CodeTaskOption[] = [
  { id: 'a', ref: 't-0539', title: 'Parser: off-by-one on the last byte', status: 'in_progress', statusLabel: 'In progress' },
  { id: 'b', ref: 't-0412', title: 'Billing export as CSV', status: 'todo', statusLabel: 'To do' },
]
const DEFAULTS: CodeDefaults = {
  model: { id: 'claude-sonnet-5', source: 'flag' }, cwd: '/home/someone/agentistics', workspaceRoot: '/home/someone/agentistics', provider: 'anthropic',
}
const NO_MODEL: CodeDefaults = {
  model: null, noModelSentence: 'No model is registered for anthropic yet — pass --model <id>.',
  cwd: '/home/someone/agentistics', workspaceRoot: '/home/someone/agentistics', provider: 'anthropic',
}
const ASSISTANTS: WizardAssistant[] = assistantRows(
  [{ id: 'claude', label: 'Claude Code', supportsModel: true }, { id: 'kimi', label: 'Kimi Code', supportsModel: false }],
  { native: true, nativeLabel: 'agentistics (native)', nativeNote: 'streams here', harnessNote: 'tmux' },
)
const FOLDERS = folderRows([
  { path: '/home/someone/agentistics', label: 'agentistics', detail: '~/agentistics', repo: 'blpsoares/agentistics', source: 'cwd' },
  { path: '/home/someone/embark', label: 'embark', detail: '~/embark', repo: 'opvibes/embark', source: 'history' },
  { path: '/home/someone/notes', label: 'notes', detail: '~/notes', source: 'folder' },
], '/home/someone/agentistics', t)

const loaded = (over: Partial<WizardState> = {}): WizardState => ({
  ...openWizard('fix the parser'), tasks: TASKS, defaults: DEFAULTS, assistants: ASSISTANTS, folders: FOLDERS, ...over,
})
const key = (input: string, over: Record<string, boolean> = {}) => ({ input, ...over })
const enter = (st: WizardState) => wizardKey(st, key('', { return: true }))
const down = (st: WizardState, n = 1) => { let s = st; for (let i = 0; i < n; i++) s = wizardKey(s, key('', { downArrow: true })).state; return s }

describe('NW-01: the task (required)', () => {
  test('six crumbs; esc on the task step closes, nothing starts', () => {
    const l = wizardLines(loaded(), t, 90)
    expect(lineText(l.head[0]!)).toContain('1 task')
    expect(lineText(l.head[0]!)).toContain('6 review')
    expect(wizardKey(loaded(), key('', { escape: true })).effect).toEqual({ kind: 'close' })
  })
  test('enter on a task moves to the assistant; the last row opens the inline title; empty refused', () => {
    expect(enter(loaded()).state).toMatchObject({ step: 'assistant', task: TASKS[0] })
    const field = enter(down(loaded(), 2)).state
    expect(field.newTitle).toBe('')
    expect(enter(field).effect).toEqual({ kind: 'say', code: 'empty-title' })
  })
  test('a created task is picked and the assistant step follows', () => {
    const st = taskCreated({ ...loaded(), newTitle: 'New', busy: true }, { id: 'c', ref: 't-0600', title: 'New', status: 'todo', statusLabel: 'To do' })
    expect(st).toMatchObject({ step: 'assistant', busy: false, task: { id: 'c' } })
  })
})

describe('NW-02: the assistant — native + installed harnesses only', () => {
  test('native first, then the harnesses the host can start; picking one asks for its models', () => {
    expect(ASSISTANTS.map(a => [a.id, a.native])).toEqual([['agentistics', true], ['claude', false], ['kimi', false]])
    const st = enter(loaded()).state
    const r = enter(down(st))
    expect(r.state).toMatchObject({ step: 'model', assistant: { id: 'claude' } })
    expect(r.effect).toEqual({ kind: 'load-models', assistant: ASSISTANTS[1]! })
  })
  test('a harness with no model flag skips the model step', () => {
    const st = enter(down(enter(loaded()).state, 2)).state
    expect(st).toMatchObject({ step: 'folder', assistant: { id: 'kimi' } })
    expect(wizardSteps(st)).toEqual(['task', 'assistant', 'folder', 'prompt', 'review'])
  })
})

describe('NW-03: the model — price, window, provenance; a disabled provider says why', () => {
  test('a disabled row is listed and refuses with its own sentence; an enabled one moves to the folder', () => {
    const st = withModels(enter(enter(loaded()).state).state, { models: [
      { id: '', provider: 'anthropic', label: 'Anthropic', detail: '', disabled: 'Anthropic: not configured — ctrl+, adds a key.' },
      { id: 'llama3', provider: 'ollama', label: 'ollama · llama3', detail: '$0 / $0 per MTok · window N/A' },
    ] })
    expect(st.cursor).toBe(1)
    const lines = wizardLines(st, t, 100).body.map(lineText)
    expect(lines[0]).toContain('not configured')
    expect(enter({ ...st, cursor: 0 }).effect).toEqual({ kind: 'refuse', sentence: 'Anthropic: not configured — ctrl+, adds a key.' })
    expect(enter(st).state).toMatchObject({ step: 'folder', model: { id: 'llama3', provider: 'ollama' } })
  })
  test('the host refusing the catalogue is said on the step; a harness gets its CLI default first', () => {
    const st = withModels(enter(enter(loaded()).state).state, { sentence: 'The agentop service did not answer.' })
    expect(wizardLines(st, t, 100).body.map(lineText).join(' ')).toContain('did not answer')
    expect(enter(st).effect).toEqual({ kind: 'refuse', sentence: 'The agentop service did not answer.' })
    expect(harnessModels({ defaultModel: 'sonnet', modelSuggestions: ['opus'] }, t).map(m => [m.id, m.label])).toEqual([['', 'the CLI default (sonnet)'], ['opus', 'opus']])
  })
})

describe('NW-04: the folder — recent repositories + new worktree', () => {
  test('here first; each repository is followed by its "new worktree" row (two at most)', () => {
    expect(FOLDERS.map(f => [f.label, Boolean(f.newWorktree)])).toEqual([
      ['~/agentistics', false], ['~/agentistics  in a new worktree', true],
      ['~/embark', false], ['~/embark  in a new worktree', true], ['~/notes', false],
    ])
  })
})

describe('NW-05: the first message (optional) and NW-06: the review', () => {
  const toPrompt = () => enter(enter(withModels(enter(enter(loaded()).state).state, { models: [{ id: 'claude-sonnet-5', provider: 'anthropic', label: 'anthropic · claude-sonnet-5', detail: '$3 / $15' }] })).state).state
  test('the carried prompt is editable; enter continues to the review', () => {
    let st = toPrompt()
    expect(st.step).toBe('prompt')
    st = wizardKey(st, key('!')).state
    expect(st.firstMessage).toBe('fix the parser!')
    expect(enter(st).state.step).toBe('review')
    expect(wizardHints(st, t)).toEqual([t.keyNext, t.keyBack])
  })
  test('native review: no-sandbox line; enter starts on the picked provider, filed under the task', () => {
    const st = enter(toPrompt()).state
    const text = wizardLines(st, t, 100).body.map(lineText).join('\n')
    expect(text).toContain('agentistics (native)')
    expect(text).toContain('anthropic · claude-sonnet-5')
    expect(text).toContain('no sandbox')
    expect(enter(st).effect).toEqual({ kind: 'start', taskId: 'a', taskTitle: TASKS[0]!.title, model: 'claude-sonnet-5', provider: 'anthropic', cwd: '/home/someone/agentistics', firstMessage: 'fix the parser' })
  })
  test('a harness review spawns it (no no-sandbox line); a new worktree is asked for', () => {
    let st = enter(down(enter(loaded()).state, 2)).state // kimi → folder
    st = enter(down(st)).state // the worktree row
    st = enter(st).state // prompt → review
    expect(wizardLines(st, t, 100).body.map(lineText).join('\n')).not.toContain('no sandbox')
    expect(enter(st).effect).toEqual({ kind: 'spawn', harness: 'kimi', label: 'Kimi Code', taskId: 'a', taskTitle: TASKS[0]!.title, cwd: '/home/someone/agentistics', prompt: 'fix the parser', worktree: true })
  })
  test('native with no model anywhere refuses in the host words', () => {
    const st: WizardState = { ...loaded({ defaults: NO_MODEL }), step: 'review', task: TASKS[0]!, assistant: ASSISTANTS[0]!, folder: FOLDERS[0]! }
    expect(enter(st).effect).toEqual({ kind: 'refuse', sentence: NO_MODEL.noModelSentence! })
  })
  test('esc walks back one step at a time; every line fits its width', () => {
    const st = enter(toPrompt()).state
    expect(wizardKey(st, key('', { escape: true })).state.step).toBe('prompt')
    for (const w of [40, 76, 100]) for (const l of [...wizardLines(st, t, w).head, ...wizardLines(st, t, w).body]) expect(lineWidth(l)).toBeLessThanOrEqual(w)
  })
})
