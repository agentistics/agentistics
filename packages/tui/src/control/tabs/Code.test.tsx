import React from 'react'
import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { Code } from './Code'
import { controlStrings } from '../i18n'
import type { ActionResult } from '../types'
import type { CodeAsk, CodeEvent, CodeHost, CodeLaunch, CodeSessionFacts } from '../code-types'

/**
 * The wiring half of the `code` tab: the pure modules decide what a key MEANS (`code.test.ts`), and
 * these press the keys against the real screen and check that the host was asked for exactly that
 * — the answer with the option the person picked, a denial on `esc`, a start filed under the task
 * chosen, a subscription before anything is sent.
 */

const ESC = '\x1b'
const plain = (f: string | undefined) => (f ?? '').replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms))

const FACTS: CodeSessionFacts = {
  sessionId: 'ses_abcd', shortId: 'abcd', title: 'parser fix',
  task: { id: 'task-1', ref: 't-0539', title: 'Parser fix' },
  cwd: '/repo', workspaceRoot: '/repo', model: 'claude-sonnet-5', provider: 'anthropic', mode: 'default',
}

const ASK: CodeAsk = {
  id: 'q1', kind: 'permission', toolName: 'shell', title: 'Allow?', why: ['no rule'],
  command: { command: 'bun test', cwd: '/repo' }, checkpoint: false,
  options: [{ label: 'Allow once' }, { label: 'Allow for this session' }, { label: 'Deny' }], denyIndex: 2,
}

interface Calls { [k: string]: unknown[][] }

function fakeHost(script: CodeEvent[] = []): { host: CodeHost; calls: Calls } {
  const calls: Calls = {}
  const log = (k: string, ...a: unknown[]) => { (calls[k] ??= []).push(a) }
  const host: CodeHost = {
    dispose: async () => {},
    availability: () => ({ ok: true }),
    defaults: async () => ({ model: { id: 'claude-sonnet-5', source: 'flag' }, cwd: '/repo', workspaceRoot: '/repo', provider: 'anthropic' }),
    openTasks: async () => ({ ok: true, tasks: [{ id: 'task-1', ref: 't-0539', title: 'Parser fix', status: 'todo', statusLabel: 'To do' }] }),
    createTask: async title => { log('createTask', title); return { ok: true, task: { id: 'task-9', ref: 't-0999', title, status: 'todo', statusLabel: 'To do' } } },
    start: async input => { log('start', input); return { ok: true, facts: FACTS, sentence: 'Started.' } },
    resume: async id => { log('resume', id); return { ok: true, facts: FACTS, sentence: 'Resumed.' } },
    subscribe: (id, listener) => { log('subscribe', id); for (const e of script) listener(e); return () => log('unsubscribe', id) },
    submit: (id, text) => { log('submit', id, text); return { ok: true } },
    answer: (id, q, choice) => { log('answer', id, q, choice); return { ok: true, sentence: `answered ${choice}` } },
    cancel: id => { log('cancel', id); return { ok: true, sentence: 'cancelled' } },
    end: async id => { log('end', id) },
    cycleMode: id => { log('cycleMode', id); return { ok: true, mode: 'accept-edits', sentence: 'Mode edits: file writes inside the workspace are allowed; the shell still asks.' } },
    promptHistory: async () => {
      log('promptHistory')
      return { ok: true, prompts: [
        { text: 'run the core tests', at: '2026-09-28T14:00:00Z', sessionId: 'ses_1' },
        { text: 'fix the parser', at: '2026-09-28T12:00:00Z', sessionId: 'ses_2' },
      ] }
    },
    editDraft: async draft => { log('editDraft', draft); return { ok: true, text: `${draft} (edited)`, sentence: 'Brought the draft back from $EDITOR.' } },
  }
  return { host, calls }
}

function mount(host: CodeHost | undefined, launch?: CodeLaunch) {
  const said: ActionResult[] = []
  const tabs: number[] = []
  const written: string[] = []
  const attention: number[] = []
  let helps = 0
  const app = render(
    <Code
      code={host}
      launch={launch}
      lang="en"
      strings={controlStrings('en')}
      width={108}
      height={30}
      isActive
      onChrome={() => {}}
      onSay={r => said.push(r)}
      onTab={s => tabs.push(s)}
      onAttention={n => attention.push(n)}
      onHelp={() => { helps++ }}
      writeTerminal={b => written.push(b)}
      inTmux={false}
    />,
  )
  return { app, said, tabs, written, attention, helps: () => helps }
}

describe('Code tab — wiring', () => {
  test('no runtime: says so in words', async () => {
    const { app } = mount(undefined)
    await tick()
    expect(plain(app.lastFrame())).toContain('The native runtime is not available in this build.')
    app.unmount()
  })

  test('a resume launch opens the session and subscribes', async () => {
    const { host, calls } = fakeHost()
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick()
    expect(calls.resume).toEqual([['ses_abcd']])
    expect(calls.subscribe).toEqual([['ses_abcd']])
    expect(plain(app.lastFrame())).toContain('session parser fix')
    app.unmount()
  })

  test('digits answer with the option picked; esc answers the policy’s own Deny', async () => {
    const { host, calls } = fakeHost([{ kind: 'ask', ask: ASK }])
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick(150)
    expect(plain(app.lastFrame())).toContain('permission · shell')
    app.stdin.write('2')
    await tick()
    expect(calls.answer).toEqual([['ses_abcd', 'q1', 1]])
    app.stdin.write(ESC)
    await tick()
    expect(calls.answer?.[1]).toEqual(['ses_abcd', 'q1', 2])
    app.unmount()
  })

  test('keys that arrive before a re-render are all kept (fast typing, key repeat)', async () => {
    // Regression (code-tab.e2e.test.ts): the handler read the draft from the render's closure, so
    // every keystroke delivered before React re-rendered extended the same old draft and a typed
    // prompt arrived as its last letter.
    const { host, calls } = fakeHost()
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick()
    for (const ch of 'fix it') app.stdin.write(ch)
    app.stdin.write('\r')
    await tick()
    expect(calls.submit).toEqual([['ses_abcd', 'fix it']])
    app.unmount()
  })

  test('typing then enter submits; [ ] change tab only on an empty draft', async () => {
    const { host, calls } = fakeHost()
    const { app, tabs } = mount(host, { resume: 'ses_abcd' })
    await tick()
    app.stdin.write(']')
    await tick()
    expect(tabs).toEqual([1])
    app.stdin.write('hi')
    await tick()
    app.stdin.write(']')
    await tick()
    expect(tabs).toEqual([1])
    app.stdin.write('\r')
    await tick()
    expect(calls.submit).toEqual([['ses_abcd', 'hi]']])
    app.unmount()
  })

  test('the wizard: a prompt launch opens at the task step, and the start is filed under the task picked', async () => {
    const { host, calls } = fakeHost()
    const { app, said } = mount(host, { prompt: 'fix it' })
    await tick(120)
    expect(plain(app.lastFrame())).toContain('Which task is this session for?')
    // task → assistant (native) → model (the tab's default) → folder (here) → first message → review
    for (const expected of ['Which assistant?', 'Which model?', 'Where does it work?', 'First message', 'Review']) {
      app.stdin.write('\r')
      await tick()
      expect(plain(app.lastFrame())).toContain(expected)
    }
    app.stdin.write('\r')
    await tick(120)
    expect(calls.start).toEqual([[{ taskId: 'task-1', model: 'claude-sonnet-5', provider: 'anthropic', cwd: '/repo', firstMessage: 'fix it' }]])
    expect(calls.subscribe).toEqual([['ses_abcd']])
    expect(said.some(r => r.message === 'Started.')).toBe(true)
    app.unmount()
  })

  test('an unknown command is refused in a sentence, not ignored', async () => {
    const { host } = fakeHost()
    const { app, said } = mount(host, { resume: 'ses_abcd' })
    await tick()
    app.stdin.write('/nope')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(said.some(r => !r.ok && r.message.includes('/nope'))).toBe(true)
    app.unmount()
  })

  test('shift+tab asks the host for the next mode; its sentence is said and the header follows', async () => {
    const { host, calls } = fakeHost()
    const { app, said } = mount(host, { resume: 'ses_abcd' })
    await tick()
    expect(plain(app.lastFrame())).toContain('mode ask')
    app.stdin.write(`${ESC}[Z`)
    await tick()
    expect(calls.cycleMode).toEqual([['ses_abcd']])
    expect(said.some(r => r.ok && r.message.startsWith('Mode edits'))).toBe(true)
    expect(plain(app.lastFrame())).toContain('mode edits')
    app.unmount()
  })

  test('tab (= ctrl+i) swaps the panel to the inspector, ctrl+t to the timeline', async () => {
    const { host } = fakeHost([
      { kind: 'user', text: 'hi', at: '2026-09-28T14:00:00Z' },
      { kind: 'run-started', runId: 'r', at: '2026-09-28T14:00:00Z' },
      { kind: 'usage', usage: { runId: 'r', model: 'claude-sonnet-5', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUSD: 0.001 } },
      { kind: 'run-ended', runId: 'r', status: 'completed', sentence: '', at: '2026-09-28T14:00:03Z' },
    ])
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick(150)
    app.stdin.write('\t')
    await tick()
    expect(plain(app.lastFrame())).toContain('▸inspector')
    expect(plain(app.lastFrame())).toContain('TURN 1')
    app.stdin.write('\x14')
    await tick()
    expect(plain(app.lastFrame())).toContain('▸timeline')
    expect(plain(app.lastFrame())).toContain('WHERE THE TIME WENT')
    app.unmount()
  })

  test('ctrl+r opens the prompt history; enter puts the pick in the composer and sends NOTHING', async () => {
    const { host, calls } = fakeHost()
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick()
    app.stdin.write('\x12')
    await tick()
    expect(plain(app.lastFrame())).toContain('prompt history')
    app.stdin.write('parser')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(calls.submit).toBeUndefined()
    expect(plain(app.lastFrame())).toContain('› fix the parser')
    app.unmount()
  })

  test('ctrl+g hands the draft to $EDITOR and puts back what was saved — never sent', async () => {
    const { host, calls } = fakeHost()
    const { app } = mount(host, { resume: 'ses_abcd' })
    await tick()
    app.stdin.write('draft')
    await tick()
    app.stdin.write('\x07')
    await tick()
    expect(calls.editDraft).toEqual([['draft']])
    expect(calls.submit).toBeUndefined()
    expect(plain(app.lastFrame())).toContain('› draft (edited)')
    app.unmount()
  })

  test('with a permission open, ctrl+g and ctrl+r refuse in words and GL-02 counts the question', async () => {
    const { host, calls } = fakeHost([{ kind: 'ask', ask: ASK }])
    const { app, said, attention } = mount(host, { resume: 'ses_abcd' })
    await tick(150)
    app.stdin.write('\x07')
    await tick()
    app.stdin.write('\x12')
    await tick()
    expect(calls.editDraft).toBeUndefined()
    expect(calls.promptHistory).toBeUndefined()
    expect(said.filter(r => !r.ok && r.message.startsWith('Answer the permission first'))).toHaveLength(2)
    expect(attention[attention.length - 1]).toBe(1)
    app.unmount()
  })

  test('/copy writes the last finished answer as OSC 52 through the frame gate, and says how much', async () => {
    const { host } = fakeHost([
      { kind: 'user', text: 'hi', at: 'x' },
      { kind: 'run-started', runId: 'r', at: 'x' },
      { kind: 'delta', runId: 'r', text: 'hello there' },
      { kind: 'run-ended', runId: 'r', status: 'completed', sentence: '', at: 'x' },
    ])
    const { app, said, written } = mount(host, { resume: 'ses_abcd' })
    await tick(150)
    app.stdin.write('/copy')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(written).toEqual([`\x1b]52;c;${btoa('hello there')}\x07`])
    expect(said.some(r => r.ok && r.message.startsWith('Copied 11 characters (OSC 52).'))).toBe(true)
    app.unmount()
  })

  test('/copy with no finished answer says so; ? on an empty draft opens help', async () => {
    const { host } = fakeHost()
    const { app, said, written, helps } = mount(host, { resume: 'ses_abcd' })
    await tick()
    app.stdin.write('/copy')
    await tick()
    app.stdin.write('\r')
    await tick()
    expect(written).toEqual([])
    expect(said.some(r => !r.ok && r.message === 'Nothing to copy yet — no answer has finished.')).toBe(true)
    app.stdin.write('?')
    await tick()
    expect(helps()).toBe(1)
    app.unmount()
  })
})
