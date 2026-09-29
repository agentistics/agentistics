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
  cwd: '/repo', workspaceRoot: '/repo', model: 'claude-sonnet-5', provider: 'anthropic', mode: 'ask',
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
  }
  return { host, calls }
}

function mount(host: CodeHost | undefined, launch?: CodeLaunch) {
  const said: ActionResult[] = []
  const tabs: number[] = []
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
    />,
  )
  return { app, said, tabs }
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
    app.stdin.write('\r')
    await tick()
    expect(plain(app.lastFrame())).toContain('Review')
    app.stdin.write('\r')
    await tick(120)
    expect(calls.start).toEqual([[{ taskId: 'task-1', model: 'claude-sonnet-5', cwd: '/repo', firstMessage: 'fix it' }]])
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
})
