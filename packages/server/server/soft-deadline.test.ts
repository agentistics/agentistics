import { describe, expect, test } from 'bun:test'
import { softDeadline } from './soft-deadline'
import type { TimerFns } from './with-timeout'

/** Timers the test fires by hand, so "the deadline passed" is a statement, not a race. */
function manualTimers() {
  const armed = new Map<number, () => void>()
  let next = 1
  const t: TimerFns = {
    set: fn => { const id = next++; armed.set(id, fn); return id },
    clear: h => { armed.delete(h as number) },
  }
  return { t, fire: () => { for (const [id, fn] of [...armed]) { armed.delete(id); fn() } }, armed }
}

describe('softDeadline', () => {
  test('work that beats the deadline is returned, the timer cleared, onLate never called', async () => {
    const m = manualTimers()
    let late = 0
    const r = await softDeadline(Promise.resolve(7), 1000, -1, () => { late++ }, m.t)
    expect(r).toEqual({ value: 7, late: false })
    expect(m.armed.size).toBe(0)
    expect(late).toBe(0)
  })

  test('past the deadline the fallback is returned and the work KEEPS RUNNING; onLate reports it', async () => {
    const m = manualTimers()
    let finish!: (v: number) => void
    const work = new Promise<number>(r => { finish = r })
    const outcomes: string[] = []
    const p = softDeadline(work, 1000, -1, o => { outcomes.push(o) }, m.t)
    m.fire()
    expect(await p).toEqual({ value: -1, late: true })
    expect(outcomes).toEqual([])
    finish(42)
    await work
    await Promise.resolve()
    expect(outcomes).toEqual(['resolved'])
  })

  test('a rejection is the fallback, never a throw — one unreadable repository cannot fail a build', async () => {
    const m = manualTimers()
    const r = await softDeadline(Promise.reject(new Error('git exploded')), 1000, 'none', () => {}, m.t)
    expect(r).toEqual({ value: 'none', late: false })
  })

  test('a late rejection is reported as rejected', async () => {
    const m = manualTimers()
    let fail!: (e: Error) => void
    const work = new Promise<number>((_, rej) => { fail = rej })
    const outcomes: string[] = []
    const p = softDeadline(work, 1000, 0, o => { outcomes.push(o) }, m.t)
    m.fire()
    await p
    fail(new Error('late'))
    await work.catch(() => {})
    await Promise.resolve()
    expect(outcomes).toEqual(['rejected'])
  })
})
