/**
 * The padlock's memory over a FAKE clock (NAVEGADOR S3): held promises, their deadlines, the waiters and
 * the browser stopping. No real timer runs.
 */
import { describe, expect, test } from 'bun:test'
import { BrowserLocks } from './browser-lock-host'
import { AUTO_LOCK_MS } from './browser-lock'

function clock() {
  let now = 1_800_000_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    deps: {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id },
      clearTimer: (t: unknown) => { timers.delete(t as number) },
    },
    get now() { return now },
    advance(ms: number) {
      now += ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        due[1].fn()
      }
    },
    pending: () => timers.size,
  }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('BrowserLocks', () => {
  test('locked: an action proceeds at once; a read proceeds whatever the mode', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    expect(await l.gate('s-a', 'click', { isRead: false, holdMs: 50_000 })).toEqual({ proceed: true })
    l.setLock('s-a', 'unlocked', 'person')
    expect(await l.gate('s-a', 'snapshot', { isRead: true, holdMs: 50_000 })).toEqual({ proceed: true })
    expect(l.view('s-a')).toMatchObject({ mode: 'unlocked', held: 0 })
  })

  test('unlocked: the action is HELD; the person locks → it resolves "not done" and never proceeds', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    let done: unknown = null
    void l.gate('s-a', 'click', { isRead: false, holdMs: 50_000 }).then(r => { done = r })
    await tick()
    expect(done).toBeNull()
    expect(l.view('s-a').held).toBe(1)
    c.advance(20_000)
    await tick()
    expect(done).toBeNull()
    const r = l.setLock('s-a', 'locked', 'person', { title: 'T', url: 'http://u/' })
    expect(r.changed).toBe(true)
    await tick()
    expect(done).toMatchObject({ proceed: false, result: { ok: true, performed: false, reason: 'person_returned' } })
    expect(c.pending()).toBe(0) // the deadline timer was cleared
  })

  test('unlocked: the deadline answers "not done — wait_unlock" and the padlock stays open', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    let done: any = null
    void l.gate('s-a', 'type', { isRead: false, holdMs: 50_000 }).then(r => { done = r })
    c.advance(49_999)
    await tick()
    expect(done).toBeNull()
    c.advance(1)
    await tick()
    expect(done).toMatchObject({ proceed: false, result: { ok: false, performed: false, error: 'person_driving' } })
    expect(l.view('s-a')).toMatchObject({ mode: 'unlocked', held: 0 })
  })

  test('two held actions with different deadlines each answer at their own', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    const out: string[] = []
    void l.gate('s-a', 'click', { isRead: false, holdMs: 30_000 }).then(() => out.push('long'))
    void l.gate('s-a', 'press', { isRead: false, holdMs: 10_000 }).then(() => out.push('short'))
    c.advance(10_000); await tick()
    expect(out).toEqual(['short'])
    c.advance(20_000); await tick()
    expect(out).toEqual(['short', 'long'])
  })

  test('one session\'s padlock never touches another\'s', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    expect(await l.gate('s-b', 'click', { isRead: false, holdMs: 50_000 })).toEqual({ proceed: true })
    expect(l.view('s-b').mode).toBe('locked')
  })

  test('wait_unlock: answers when the person locks; at its deadline otherwise; at once when locked', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    expect(await l.waitUnlock('s-a', 10_000, 50_000)).toMatchObject({ locked: true, waitedMs: 0 })
    l.setLock('s-a', 'unlocked', 'person')
    let a: any = null
    void l.waitUnlock('s-a', undefined, 50_000).then(r => { a = r })
    c.advance(12_000)
    l.setLock('s-a', 'locked', 'person')
    await tick()
    expect(a).toMatchObject({ ok: true, locked: true, waitedMs: 12_000 })
    l.setLock('s-a', 'unlocked', 'person')
    let b: any = null
    void l.waitUnlock('s-a', 5_000, 50_000).then(r => { b = r })
    c.advance(5_000); await tick()
    expect(b).toMatchObject({ ok: true, locked: false, waitedMs: 5_000 })
    expect(c.pending()).toBe(0)
  })

  test('the browser stops: held actions and waiters answer, the padlock is locked again', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    let held: any = null
    let waited: any = null
    void l.gate('s-a', 'navigate', { isRead: false, holdMs: 50_000 }).then(r => { held = r })
    void l.waitUnlock('s-a', undefined, 50_000).then(r => { waited = r })
    l.browserStopped('s-a', 'idle')
    await tick()
    expect(held).toMatchObject({ proceed: false, result: { error: 'browser_closed' } })
    expect(waited).toMatchObject({ locked: true })
    expect(l.view('s-a').mode).toBe('locked')
    expect(c.pending()).toBe(0)
    l.browserStopped('s-unknown', 'idle') // nothing known: nothing happens
  })

  test('auto-lock: unlocked, unwatched and untouched for 15 min locks by itself; a viewer keeps it', async () => {
    const c = clock()
    const l = new BrowserLocks(c.deps)
    l.setLock('s-a', 'unlocked', 'person')
    l.setLock('s-b', 'unlocked', 'person')
    c.advance(AUTO_LOCK_MS)
    expect(l.autoLock(k => (k === 's-b' ? 1 : 0), () => undefined)).toEqual(['s-a'])
    expect(l.view('s-a')).toMatchObject({ mode: 'locked', autoLockedAt: c.now })
    expect(l.view('s-b').mode).toBe('unlocked')
    l.personInput('s-b')
    expect(l.unlockedKeys()).toEqual(['s-b'])
  })
})
