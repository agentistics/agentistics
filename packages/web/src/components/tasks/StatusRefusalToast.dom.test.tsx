import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'

// A refused board edit must reach the SCREEN (toast) and the BELL, with the real store refreshing
// from the server the way the running app does — not only land in the in-memory list.
let createRoot: typeof import('react-dom/client').createRoot
let NotificationToasts: typeof import('../NotificationToasts').NotificationToasts
let MemoryRouter: typeof import('react-router-dom').MemoryRouter
let store: typeof import('../../lib/notifications')
let tasks: typeof import('../../lib/tasks')
const realFetch = globalThis.fetch
const oldES = globalThis.EventSource
const oldAct = (globalThis as any).IS_REACT_ACT_ENVIRONMENT
/** What the server has persisted (POST /api/notifications appends; GET returns the list). */
let serverList: unknown[] = []
let awayOn = false
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.EventSource = class { addEventListener() {} removeEventListener() {} close() {} } as never
  createRoot = (await import('react-dom/client')).createRoot
  NotificationToasts = (await import('../NotificationToasts')).NotificationToasts
  MemoryRouter = (await import('react-router-dom')).MemoryRouter
  store = await import('../../lib/notifications')
  tasks = await import('../../lib/tasks')
})
afterAll(async () => {
  globalThis.fetch = realFetch; globalThis.EventSource = oldES
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = oldAct
  await GlobalRegistrator.unregister()
})

function fakeServer(taskAnswer: () => Response | Promise<Response>) {
  serverList = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/away') return Response.json({ state: awayOn ? { version: 1, on: true, since: new Date().toISOString(), until: null, authorised: [], note: '' } : null })
    if (url.startsWith('/api/notifications')) {
      if (init?.method === 'POST') {
        // Like notifications-store.ts: the same code+meta keeps ONE row (same id), moved to the top with a fresh ts.
        const body = JSON.parse(String(init.body)) as { code?: string; meta?: unknown }
        const same = (serverList as { id: string; code?: string; meta?: unknown }[]).find(x => x.code === body.code && JSON.stringify(x.meta) === JSON.stringify(body.meta))
        serverList = [{ ...body, id: same?.id ?? `srv-${serverList.length + 1}`, ts: Date.now() + serverList.length, read: false }, ...serverList.filter(x => x !== same)]
      }
      return Response.json(serverList)
    }
    if (url.startsWith('/api/tasks/')) return taskAnswer()
    return new Response(null, { status: 503 })
  }) as unknown as typeof fetch
}

async function mount() {
  store.clearNotifications()
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><NotificationToasts lang="en" /></MemoryRouter>))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
const toasts = (h: HTMLElement) => h.querySelectorAll('[data-testid="notification-toast"]')

for (const [name, answer] of [
  ['422 refusal', () => Response.json({ ok: false, message: 'weird' }, { status: 422 })],
  ['network abort', () => { throw new TypeError('aborted') }],
] as const) {
  test(`status write: ${name} shows a toast and a bell entry that survive the server refresh`, async () => {
    fakeServer(answer)
    const { host, close } = await mount()
    try {
      await act(async () => { await tasks.markTask('t1', 'in_progress') })
      // The bell/SSE refresh the running app does right after any notification.
      await act(async () => { await store.refreshNotifications() })
      expect(toasts(host)).toHaveLength(1)
      expect(host.textContent).toContain('Could not change status')
      expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(true)
    } finally { await close() }
  })
}

test('edit refusal (priority/rename/date) shows a toast and a bell entry that survive the refresh', async () => {
  fakeServer(() => Response.json({ ok: false, message: 'owner_required' }, { status: 403 }))
  const { host, close } = await mount()
  try {
    await act(async () => { await tasks.editTask('t1', { priority: 'high' }) })
    await act(async () => { await store.refreshNotifications() })
    expect(toasts(host)).toHaveLength(1)
    expect(store.readNotifications()).toHaveLength(1)
  } finally { await close() }
})

test('the SAME refusal twice toasts twice (the server keeps one row with the same id and a fresh time)', async () => {
  fakeServer(() => Response.json({ ok: false, message: 'weird' }, { status: 422 }))
  const { host, close } = await mount()
  try {
    await act(async () => { await tasks.markTask('t1', 'in_progress') })
    expect(toasts(host)).toHaveLength(1)
    // The person dismisses the first toast, tries again, and is refused again.
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="dismiss"]')!.click())
    await act(async () => { await Bun.sleep(300) })
    expect(toasts(host)).toHaveLength(0)
    await act(async () => { await Bun.sleep(5); await tasks.markTask('t1', 'in_progress') })
    expect(toasts(host)).toHaveLength(1)
    expect(store.readNotifications().filter(n => n.code === 'tasks.status_failed')).toHaveLength(1)
  } finally { await close() }
})

// ROUND 2 — autonomous mode silences the fleet, never the answer to the person's own click.
async function withAway<T>(run: (host: HTMLElement) => Promise<T>): Promise<T> {
  awayOn = true
  const { refreshAway } = await import('../../lib/awayMode')
  const { host, close } = await mount()
  try {
    await act(async () => { await refreshAway() })
    return await run(host)
  } finally { awayOn = false; await close(); await act(async () => { await refreshAway() }) }
}

for (const [name, answer, expected] of [
  ['422 refusal', () => Response.json({ ok: false, message: 'done_needs_session' }, { status: 422 }), 'needs a session'],
  ['404 (task deleted)', () => Response.json({ ok: false, error: 'no_such_task' }, { status: 404 }), 'no longer exists'],
  ['network abort', () => { throw new TypeError('aborted') }, 'could not be reached'],
] as const) {
  test(`autonomous mode ON: a ${name} still toasts and the bell line names the reason`, async () => {
    fakeServer(answer)
    await withAway(async host => {
      await act(async () => { await tasks.markTask('t1', 'done') })
      await act(async () => { await store.refreshNotifications() })
      expect(toasts(host)).toHaveLength(1)
      expect(toasts(host)[0]!.textContent).toContain(expected)
      expect(toasts(host)[0]!.textContent).not.toMatch(/done_needs_session|no_such_task|\b404\b/)
      expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(true)
    })
  })
}

// FILIACAO.TOAST — an AUTOMATIC follow-up write (the delivery closing after its last part, done by the
// page, not by the person) is never a toast: the caller reports it in its own words, once.
test('a quiet (automatic) status write refused with done_needs_session does not toast nor ring the bell', async () => {
  fakeServer(() => Response.json({ ok: false, message: 'done_needs_session' }, { status: 422 }))
  const { host, close } = await mount()
  try {
    let out: unknown
    await act(async () => { out = await tasks.markTask('t1', 'done', { quiet: true }) })
    await act(async () => { await store.refreshNotifications() })
    expect(out).toEqual({ ok: false, reason: 'done_needs_session' })
    expect(toasts(host)).toHaveLength(0)
    expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(false)
  } finally { await close() }
})

test('the 422 and the abort lines are different sentences', () => {
  const line = (reason: string) => store.resolveNotification({ id: 'x', ts: 1, read: false, type: 'error', code: 'tasks.status_failed', meta: { reason, localAction: true } }, 'en').message
  expect(line('done_needs_session')).not.toBe(line('network_error'))
  expect(line('network_error')).toContain('could not be reached')
})

test('autonomous mode ON: a fleet notice (not a local action) still does NOT toast', async () => {
  fakeServer(() => new Response(null, { status: 503 }))
  await withAway(async host => {
    await act(async () => store.pushLocalNotification({ type: 'error', title: 'Fleet notice' }))
    await act(async () => { await store.refreshNotifications() })
    expect(toasts(host)).toHaveLength(0)
    expect(store.readNotifications().length).toBeGreaterThan(0)
  })
})

test('a HIDDEN tab never toasts, even for a local action', async () => {
  fakeServer(() => Response.json({ ok: false, message: 'weird' }, { status: 422 }))
  const { host, close } = await mount()
  const vis = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await tasks.markTask('t1', 'in_progress') })
    expect(toasts(host)).toHaveLength(0)
    expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(true)
  } finally {
    if (vis) Object.defineProperty(document, 'visibilityState', vis); else delete (document as any).visibilityState
    await close()
  }
})

// ROUND 3 — the rename/edit path: refused while autonomous mode is ON still toasts, in plain words.
for (const [name, answer, expected] of [
  ['404 (task deleted)', () => Response.json({ ok: false, error: 'no_such_task' }, { status: 404 }), 'no longer exists'],
  ['bare 404', () => new Response('', { status: 404 }), 'no longer exists'],
  ['code in message', () => Response.json({ ok: false, message: 'blocked_needs_reason' }, { status: 422 }), 'say why'],
] as const) {
  test(`autonomous mode ON: a refused edit (${name}) toasts and the bell line is readable`, async () => {
    fakeServer(answer)
    await withAway(async host => {
      await act(async () => { await tasks.editTask('t1', { title: 'new' }) })
      await act(async () => { await store.refreshNotifications() })
      expect(toasts(host)).toHaveLength(1)
      const text = toasts(host)[0]!.textContent ?? ''
      expect(text).toContain(expected)
      expect(text).not.toMatch(/no_such_task|blocked_needs_reason|\b404\b/)
      const bell = store.readNotifications().find(n => n.title === 'The change could not be saved' || n.message?.includes(expected))
      expect(bell).toBeDefined()
      expect(bell!.meta?.localAction).toBe(true)
    })
  })
}

test('an unknown refusal code is never shown raw: a sentence is kept, a bare code becomes the generic line', () => {
  const n = (body: Record<string, unknown>, status: number) => tasks.editRefusalNotice({ status, body }, false).message
  expect(n({ message: 'Title is too long for this board.' }, 422)).toBe('Title is too long for this board.')
  expect(n({ message: 'some_new_code' }, 422)).not.toContain('some_new_code')
  expect(n({}, 500)).not.toMatch(/500/)
})


// TOAST.390 — when the caller opens the "File a session" dialog for the refusal, the dialog IS the message:
// no toast (and no bell line) beside it. Any other refusal keeps its toast, in both languages.
async function mountLang(lang: 'en' | 'pt') {
  store.clearNotifications()
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><NotificationToasts lang={lang} /></MemoryRouter>))
  return { host, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
for (const lang of ['en', 'pt'] as const) {
  for (const [what, write] of [
    ['markTask', () => tasks.markTask('t1', 'done', { dialog: true })],
    ['patchSubtask', () => tasks.patchSubtask('t1', 's1', { status: 'done' }, { dialog: true })],
  ] as const) {
    test(`[${lang}] ${what}: done_needs_session with a dialog opening shows NO toast and no bell line`, async () => {
      fakeServer(() => Response.json({ ok: false, message: 'done_needs_session' }, { status: 422 }))
      const { host, close } = await mountLang(lang)
      try {
        let out: unknown
        await act(async () => { out = await write() })
        await act(async () => { await store.refreshNotifications() })
        expect(out).toEqual({ ok: false, reason: 'done_needs_session' })
        expect(toasts(host)).toHaveLength(0)
        expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(false)
      } finally { await close() }
    })
    test(`[${lang}] ${what}: a refusal that opens no dialog (another reason, or no dialog flag) still toasts`, async () => {
      for (const [message, opts] of [['group_field_conflict', true], ['done_needs_session', false]] as const) {
        fakeServer(() => Response.json({ ok: false, message }, { status: 422 }))
        const { host, close } = await mountLang(lang)
        try {
          await act(async () => {
            if (what === 'markTask') await tasks.markTask('t1', 'done', opts ? { dialog: true } : {})
            else await tasks.patchSubtask('t1', 's1', { status: 'done' }, opts ? { dialog: true } : {})
          })
          await act(async () => { await store.refreshNotifications() })
          expect(toasts(host)).toHaveLength(1)
          expect(store.readNotifications().some(n => n.code === 'tasks.status_failed')).toBe(true)
        } finally { await close() }
      }
    })
  }
}
