import { beforeEach, describe, expect, test } from 'bun:test'
import {
  createPopGuard, guardNavigator, historyIndexOf, navigationKeepsStudio, navigationRetiresStudio,
  pathnameOf, unsavedLeaveText, type GuardableNavigator, type PopEventLike, type PoppableWindow,
} from './unsavedLeave'
import { reopenedSessionRoute } from './sessionRoute'
import { answerUnsaved, getUnsaved, holdIfUnsaved, reportUnsaved, resetUnsaved } from './unsavedBuffers'

beforeEach(() => resetUnsaved())

describe('navigationKeepsStudio', () => {
  const keys = ['agentop-3f5f', 'c0nv-id']
  test('the same session page, by either id, keeps it', () => {
    expect(navigationKeepsStudio('/sessions/agentop-3f5f', keys)).toBe(true)
    expect(navigationKeepsStudio('/sessions/c0nv-id/', keys)).toBe(true)
    expect(navigationKeepsStudio(`/sessions/${encodeURIComponent('agentop-3f5f')}`, keys)).toBe(true)
  })
  test('another session, the overview, the dedicated terminal and any other screen drop it', () => {
    expect(navigationKeepsStudio('/sessions/other', keys)).toBe(false)
    expect(navigationKeepsStudio('/sessions', keys)).toBe(false)
    expect(navigationKeepsStudio('/sessions/agentop-3f5f/terminal', keys)).toBe(false)
    expect(navigationKeepsStudio('/tasks', keys)).toBe(false)
    expect(navigationKeepsStudio('/', keys)).toBe(false)
  })
  test('a malformed escape is not a match', () => {
    expect(navigationKeepsStudio('/sessions/%E0%A4%A', keys)).toBe(false)
  })
})

describe('pathnameOf', () => {
  test('a resolved path object, a string with a query, and a query-only string', () => {
    expect(pathnameOf({ pathname: '/tasks', search: '?x', hash: '' }, '/sessions/a')).toBe('/tasks')
    expect(pathnameOf('/sessions/a?view=chat', '/x')).toBe('/sessions/a')
    expect(pathnameOf('?view=terminal', '/sessions/a')).toBe('/sessions/a')
  })
})

describe('navigationRetiresStudio', () => {
  test("a reopen of the open session, by the route helper's own state, retires it", () => {
    const { state } = reopenedSessionRoute('new-1', { id: 's1', harness: 'claude' }).options
    expect(navigationRetiresStudio(state, ['s1', 'conv'])).toBe(true)
  })
  test('a reopen of another row, a new session, and no state at all retire nothing', () => {
    expect(navigationRetiresStudio(reopenedSessionRoute('n', { id: 'other' }).options.state, ['s1'])).toBe(false)
    expect(navigationRetiresStudio({ creating: {} }, ['s1'])).toBe(false)
    expect(navigationRetiresStudio(undefined, ['s1'])).toBe(false)
    expect(navigationRetiresStudio({ retires: '' }, [''])).toBe(false)
  })
})

/** A history-shaped fake: `push`/`replace` record where they went and never use `this`. */
function fakeHistory() {
  const went: string[] = []
  const nav = {
    push: (to: { pathname: string }, _state?: unknown) => { went.push(`push ${to.pathname}`) },
    replace: (to: { pathname: string }, _state?: unknown) => { went.push(`replace ${to.pathname}`) },
  }
  return { nav: nav as unknown as GuardableNavigator, went, raw: nav }
}

describe('guardNavigator, wired to the unsaved store the way the page wires it', () => {
  const arm = (nav: GuardableNavigator, keys: string[]) => guardNavigator(
    nav,
    (to, state) => !navigationKeepsStudio(pathnameOf(to, '/sessions/s1'), keys)
      && !navigationRetiresStudio(state, keys),
    run => holdIfUnsaved('leave', run),
  )

  test('a reopen of THIS session passes unasked — its row is already retired, staying keeps nothing', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['README.md'])
    const r = reopenedSessionRoute('new-1', { id: 's1' })
    h.raw.push({ pathname: r.path }, r.options.state)
    expect(h.went).toEqual(['push /sessions/new-1'])
    expect(getUnsaved().question).toBeNull()
  })

  test('a reopen of ANOTHER row is held like any navigation — staying really keeps the buffers', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['README.md'])
    const r = reopenedSessionRoute('new-2', { id: 'other' })
    h.raw.push({ pathname: r.path }, r.options.state)
    expect(h.went).toEqual([])
    expect(getUnsaved().question).toEqual({ cause: 'leave' })
  })

  test('with nothing unsaved every navigation passes straight through', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    h.raw.push({ pathname: '/tasks' })
    expect(h.went).toEqual(['push /tasks'])
  })

  test('with a dirty buffer, leaving is HELD — the history does not move until the reader discards', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['README.md'])
    h.raw.push({ pathname: '/tasks' })
    expect(h.went).toEqual([])
    expect(getUnsaved().question).toEqual({ cause: 'leave' })
    answerUnsaved(true)
    expect(h.went).toEqual(['push /tasks'])
  })

  test('keeping editing leaves the history where it was', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['README.md'])
    h.raw.replace({ pathname: '/sessions/other' })
    answerUnsaved(false)
    expect(h.went).toEqual([])
  })

  test('a navigation that keeps this session page (the ?view= switch) is never held', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['README.md'])
    h.raw.replace({ pathname: '/sessions/s1' })
    expect(h.went).toEqual(['replace /sessions/s1'])
    expect(getUnsaved().question).toBeNull()
  })

  test('proceeding goes through the ORIGINAL method, so it cannot be held by its own guard', () => {
    const h = fakeHistory()
    arm(h.nav, ['s1'])
    reportUnsaved('studio', ['a'])
    h.raw.push({ pathname: '/tasks' })
    answerUnsaved(true)
    // Still dirty (the page has not unmounted yet) — and the navigation still happened once.
    expect(getUnsaved().files).toEqual(['a'])
    expect(h.went).toEqual(['push /tasks'])
  })

  test('restore puts the originals back, and never clobbers a newer wrapper', () => {
    const h = fakeHistory()
    const original = h.nav.push
    const restoreA = arm(h.nav, ['s1'])
    const wrapperA = h.nav.push
    const restoreB = arm(h.nav, ['s1'])
    const wrapperB = h.nav.push
    restoreA() // out of order: B is on top, so A must not touch it
    expect(h.nav.push).toBe(wrapperB)
    restoreB() // B steps aside to what it wrapped
    expect(h.nav.push).toBe(wrapperA)
    restoreA()
    expect(h.nav.push).toBe(original)
  })
})

describe('historyIndexOf', () => {
  test("reads the router's idx and nothing else", () => {
    expect(historyIndexOf({ usr: null, key: 'k', idx: 3 })).toBe(3)
    expect(historyIndexOf({ idx: '3' })).toBeNull()
    expect(historyIndexOf(null)).toBeNull()
  })
})

/**
 * A browser-shaped fake for `popstate` on `window`, reproducing what Chromium 151 was MEASURED to do
 * there: listeners run in REGISTRATION order whatever their capture flag, and one of them may stop the
 * rest. The ROUTER can be registered before or after the guard, which is the whole question.
 */
function fakeBrowser(paths: string[], at: number, routerFirst = false) {
  let index = at
  let routerIndex = at
  const routerSaw: number[] = []
  const listeners: Array<(e: PopEventLike) => void> = []
  const router = () => { routerIndex = index; routerSaw.push(index) }
  if (routerFirst) listeners.push(router)
  const win: PoppableWindow = {
    addEventListener: (_t, l) => { listeners.push(l) },
    removeEventListener: (_t, l) => { const i = listeners.indexOf(l); if (i !== -1) listeners.splice(i, 1) },
    history: { go: delta => { index += delta; pop() } },
    location: { get pathname() { return paths[index]! } },
  }
  function pop() {
    let stopped = false
    for (const l of [...listeners]) {
      l({ state: { idx: index }, stopImmediatePropagation: () => { stopped = true } })
      if (stopped) return
    }
  }
  const guard = createPopGuard(win)
  const unlisten = guard.listen()
  if (!routerFirst) listeners.push(router)
  return {
    guard, unlisten, routerSaw,
    back: () => win.history.go(-1),
    shown: () => routerIndex,
    where: () => paths[index],
  }
}

describe('createPopGuard', () => {
  const armFor = (b: ReturnType<typeof fakeBrowser>, keys: string[]) => b.guard.arm({
    lastIndex: b.shown,
    hold: pathname => !navigationKeepsStudio(pathname, keys),
    onHold: run => holdIfUnsaved('leave', run),
  })

  test('with nothing unsaved, Back reaches the router untouched', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    armFor(b, ['s1'])
    b.back()
    expect(b.routerSaw).toEqual([0])
    expect(b.where()).toBe('/tasks')
  })

  test('with a dirty buffer, Back is undone before the router hears it, and asked', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    armFor(b, ['s1'])
    reportUnsaved('studio', ['a.ts'])
    b.back()
    expect(b.routerSaw).toEqual([])
    expect(b.where()).toBe('/sessions/s1')
    expect(getUnsaved().question).toEqual({ cause: 'leave' })
  })

  test('"Leave anyway" replays the pop through the router, exactly once', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    armFor(b, ['s1'])
    reportUnsaved('studio', ['a.ts'])
    b.back()
    answerUnsaved(true)
    expect(b.routerSaw).toEqual([0])
    expect(b.where()).toBe('/tasks')
  })

  test('"Keep editing" leaves the page, the URL and the router where they were', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    armFor(b, ['s1'])
    reportUnsaved('studio', ['a.ts'])
    b.back()
    answerUnsaved(false)
    expect(b.routerSaw).toEqual([])
    expect(b.where()).toBe('/sessions/s1')
  })

  test('a pop to this same session page, one with no router index, and an unarmed guard all pass', () => {
    const b = fakeBrowser(['/sessions/s1', '/sessions/s1'], 1)
    armFor(b, ['s1'])
    reportUnsaved('studio', ['a.ts'])
    b.back()
    expect(b.routerSaw).toEqual([0])
    const c = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    c.guard.arm({ lastIndex: () => null, hold: () => true, onHold: run => holdIfUnsaved('leave', run) })
    c.back()
    expect(c.routerSaw).toEqual([0])
    const d = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    armFor(d, ['s1'])()
    d.back()
    expect(d.routerSaw).toEqual([0])
  })

  test('a stale disarm does not disarm the page that armed after it (StrictMode mounts twice)', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1)
    const first = armFor(b, ['s1'])
    armFor(b, ['s1'])
    first()
    reportUnsaved('studio', ['a.ts'])
    b.back()
    expect(b.routerSaw).toEqual([])
  })

  test('WHY main.tsx installs it: a guard registered AFTER the router is too late to hold anything', () => {
    const b = fakeBrowser(['/tasks', '/sessions/s1'], 1, true)
    armFor(b, ['s1'])
    reportUnsaved('studio', ['a.ts'])
    b.back()
    expect(b.routerSaw[0]).toBe(0)
  })

  test('a genuinely new pop that arrives before the undo\'s own popstate is not swallowed as if it were the undo', () => {
    // Two moves close together: the browser's own undo (from our first `history.go`) has not yet
    // fired its popstate when a second, unrelated navigation pops. A guard that treats "the next pop"
    // as its own undo — rather than checking it actually landed on the index it expects — would
    // consume this second, real navigation silently: nothing asked, nothing undone, the reader's own
    // Back simply does nothing.
    let listener: ((e: PopEventLike) => void) | null = null
    const goCalls: number[] = []
    const win: PoppableWindow = {
      addEventListener: (_t, l) => { listener = l },
      removeEventListener: () => { listener = null },
      history: { go: delta => { goCalls.push(delta) } },
      location: { pathname: '/sessions/s1' },
    }
    const guard = createPopGuard(win)
    guard.listen()
    let holdCalls = 0
    guard.arm({ lastIndex: () => 5, hold: () => { holdCalls++; return true }, onHold: run => holdIfUnsaved('leave', run) })
    reportUnsaved('studio', ['a.ts'])

    // The reader's Back: the browser has already moved to idx 4. The guard holds it and undoes it —
    // `history.go(1)` puts the URL back on 5 — expecting ITS OWN undo to land there.
    let stopped1 = false
    listener!({ state: { idx: 4 }, stopImmediatePropagation: () => { stopped1 = true } })
    expect(stopped1).toBe(true)
    expect(holdCalls).toBe(1)
    expect(goCalls).toEqual([1])

    // Before that undo's own popstate reaches this listener, a SECOND, unrelated pop arrives — the
    // browser moving to idx 6, nothing to do with the pending undo. It must be evaluated as its own
    // navigation, not consumed as the swallowed undo of the first.
    let stopped2 = false
    listener!({ state: { idx: 6 }, stopImmediatePropagation: () => { stopped2 = true } })
    expect(holdCalls).toBe(2)
    expect(stopped2).toBe(true)
    expect(goCalls).toEqual([1, -1])

    // The real undo for the FIRST pop finally arrives, landing on 5 exactly as expected — swallowed
    // silently, no re-ask, no extra `history.go` call.
    let stopped3 = false
    listener!({ state: { idx: 5 }, stopImmediatePropagation: () => { stopped3 = true } })
    expect(stopped3).toBe(true)
    expect(holdCalls).toBe(2)
    expect(goCalls).toEqual([1, -1])
  })
})

describe('unsavedLeaveText', () => {
  test('names the files and says what the confirm does, in both languages', () => {
    const en = unsavedLeaveText(['src/a.ts', 'b.md'], 'close', 'en')
    expect(en.message).toContain('2 files in the Studio')
    expect(en.message).toContain('a.ts, b.md')
    expect(en.confirm).toBe('Close anyway')
    expect(en.cancel).toBe('Keep editing')
    const pt = unsavedLeaveText(['a', 'b', 'c', 'd', 'e'], 'leave', 'pt')
    expect(pt.message).toContain('5 arquivos no Studio')
    expect(pt.message).toContain('a, b, c e mais 2')
    expect(pt.confirm).toBe('Sair mesmo assim')
    expect(unsavedLeaveText(['x'], 'leave', 'en').message).toContain('1 file in the Studio has')
  })
})
