import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { Root } from 'react-dom/client'

let createRoot: typeof import('react-dom/client').createRoot
let StatusChip: typeof import('./StatusChip').StatusChip
let markTask: typeof import('../../lib/tasks').markTask
let readNotifications: typeof import('../../lib/notifications').readNotifications
let answerReviewOverride: typeof import('../../lib/statusWrites').answerReviewOverride
let root: Root | undefined
let host: HTMLDivElement
let oldFetch: typeof fetch
let oldAct: unknown
beforeAll(async () => {
  oldFetch = globalThis.fetch
  GlobalRegistrator.register({ width: 390, height: 844 })
  oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
  StatusChip = (await import('./StatusChip')).StatusChip
  markTask = (await import('../../lib/tasks')).markTask
  readNotifications = (await import('../../lib/notifications')).readNotifications
  answerReviewOverride = (await import('../../lib/statusWrites')).answerReviewOverride
})
afterEach(async () => { answerReviewOverride(false); await act(async () => { root?.unmount() }); root = undefined; host?.remove(); globalThis.fetch = oldFetch })
afterAll(async () => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct; await GlobalRegistrator.unregister() })

test('a slow status POST disables only that control, shows a spinner, and clears after the response', async () => {
  let finish!: (r: Response) => void
  globalThis.fetch = (() => new Promise<Response>(resolve => { finish = resolve })) as unknown as typeof fetch
  host = document.createElement('div'); document.body.append(host)
  await act(async () => { root = createRoot(host); root.render(<><StatusChip taskId="t1" value="todo" lang="en" statuses={null} onPick={() => {}} /><StatusChip taskId="other" value="todo" lang="en" statuses={null} onPick={() => {}} /></>) })
  let request!: ReturnType<typeof markTask>
  await act(async () => { request = markTask('t1', 'in_progress') })
  expect(host.querySelectorAll('button')[0]!.disabled).toBe(true)
  expect(host.querySelectorAll('button')[1]!.disabled).toBe(false)
  expect(host.querySelector('[aria-busy="true"]')).not.toBeNull()
  expect(host.querySelector('.ag-working-spin')).not.toBeNull()
  await act(async () => { finish(Response.json({ ok: true })); await request })
  expect(host.querySelectorAll('button')[0]!.disabled).toBe(false)
})

test('write failure produces a local error toast even while offline', async () => {
  globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
  expect(await markTask('t1', 'in_progress')).toEqual({ ok: false })
  expect(readNotifications()[0]).toMatchObject({ type: 'error', code: 'tasks.status_failed' })
})

test('open-subtask review requires a separate explicit move-anyway decision', async () => {
  const bodies: unknown[] = []
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return bodies.length === 1 ? Response.json({ ok: false, message: 'open_subtasks', openSubtaskIds: ['s1'] }, { status: 422 }) : Response.json({ ok: true })
  }) as typeof fetch
  const request = markTask('t1', 'in_review')
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(bodies).toEqual([{ status: 'in_review' }])
  answerReviewOverride(true)
  expect(await request).toEqual({ ok: true })
  expect(bodies[1]).toEqual({ status: 'in_review', allowOpenSubtasks: true })
})
