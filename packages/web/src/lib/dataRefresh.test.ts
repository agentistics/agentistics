import { describe, expect, test } from 'bun:test'
import { IDLE_REFRESH_MS, startDataRefresh, WORKING_REFRESH_MS } from './dataRefresh'

function setup(working: boolean, initiallyHidden = false) {
  const document = Object.assign(new EventTarget(), { hidden: initiallyHidden })
  const window = new EventTarget()
  let now = 0, nextId = 0, reads = 0, pauses = 0, healthy = false
  const jobs = new Map<number, { at: number; run: () => void }>()
  const timers = {
    set: ((run: () => void, delay: number) => {
      const id = ++nextId; jobs.set(id, { at: now + delay, run }); return id
    }) as unknown as typeof setTimeout,
    clear: ((id: number) => jobs.delete(id)) as unknown as typeof clearTimeout,
  }
  const stop = startDataRefresh({
    working, document, window, timers,
    refresh: () => { reads++ }, pause: () => { pauses++ }, healthy: () => healthy,
  })
  return {
    stop, jobs, reads: () => reads, pauses: () => pauses,
    healthy: (value: boolean) => { healthy = value },
    visibility: (hidden: boolean) => { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')) },
    focus: () => window.dispatchEvent(new Event('focus')),
    advance: (ms: number) => {
      const until = now + ms
      for (;;) {
        const due = [...jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        now = due[1].at; jobs.delete(due[0]); due[1].run()
      }
      now = until
    },
  }
}

describe('useData automatic refresh policy', () => {
  test('working sessions refresh faster; idle sessions use the slower cadence', () => {
    const working = setup(true), idle = setup(false)
    working.advance(WORKING_REFRESH_MS - 1); idle.advance(WORKING_REFRESH_MS - 1)
    expect(working.reads()).toBe(0)
    working.advance(1); idle.advance(1)
    expect(working.reads()).toBe(1)
    expect(idle.reads()).toBe(0)
    idle.advance(IDLE_REFRESH_MS - WORKING_REFRESH_MS)
    expect(idle.reads()).toBe(1)
    working.stop(); idle.stop()
  })

  test('hiding cancels polling and pending load retries; returning reads immediately', () => {
    const p = setup(true)
    p.visibility(true)
    expect(p.pauses()).toBe(1)
    expect(p.jobs.size).toBe(0)
    p.focus(); p.advance(IDLE_REFRESH_MS * 5)
    expect(p.reads()).toBe(0)
    p.visibility(false)
    expect(p.reads()).toBe(1)
    p.advance(WORKING_REFRESH_MS)
    expect(p.reads()).toBe(2)
    p.stop()
  })

  test('a healthy stream avoids periodic full reads, but focus still reconciles missed events', () => {
    const p = setup(false)
    p.healthy(true); p.advance(IDLE_REFRESH_MS * 3)
    expect(p.reads()).toBe(0)
    p.focus()
    expect(p.reads()).toBe(1)
    p.healthy(false); p.advance(IDLE_REFRESH_MS)
    expect(p.reads()).toBe(2)
    p.stop()
  })

  test('a hidden mount has no timer; disposing removes timers and visibility/focus listeners', () => {
    const p = setup(false, true)
    expect(p.jobs.size).toBe(0)
    p.visibility(false)
    expect(p.reads()).toBe(1)
    p.stop(); p.focus(); p.visibility(false); p.advance(IDLE_REFRESH_MS)
    expect(p.reads()).toBe(1)
    expect(p.jobs.size).toBe(0)
  })

  test('switching activity replaces the old cadence without leaving a second timer', () => {
    const old = setup(false)
    old.stop()
    const active = setup(true)
    old.advance(IDLE_REFRESH_MS); active.advance(WORKING_REFRESH_MS)
    expect(old.reads()).toBe(0)
    expect(active.reads()).toBe(1)
    expect(active.jobs.size).toBe(1)
    active.stop()
  })
})
