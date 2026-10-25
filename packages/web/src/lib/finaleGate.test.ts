import { afterEach, describe, expect, test } from 'bun:test'
import { afterFinale, endFinale, finaleActive, setFinaleForTest, sinceUpdate } from './finaleGate'

afterEach(() => setFinaleForTest({ active: false, updatedAt: null }))

describe('finaleGate', () => {
  test('an ordinary boot: nothing is held and there is no update to be lenient about', () => {
    setFinaleForTest({ active: false, updatedAt: null })
    let ran = 0
    afterFinale(() => { ran++ })
    expect(ran).toBe(1)
    expect(sinceUpdate()).toBeNull()
  })

  test('while the finale is up the work waits, and runs once when it leaves', () => {
    setFinaleForTest({ active: true, updatedAt: 1000 })
    let ran = 0
    afterFinale(() => { ran++ })
    expect(ran).toBe(0)
    endFinale()
    expect(finaleActive()).toBe(false)
    expect(ran).toBe(1)
    endFinale()
    expect(ran).toBe(1)
  })

  test('a cancelled wait never runs', () => {
    setFinaleForTest({ active: true, updatedAt: 1000 })
    let ran = 0
    const cancel = afterFinale(() => { ran++ })
    cancel()
    endFinale()
    expect(ran).toBe(0)
  })

  test('the time since the update keeps counting after the finale left', () => {
    setFinaleForTest({ active: true, updatedAt: 1000 })
    endFinale()
    expect(sinceUpdate(31_000)).toBe(30_000)
  })
})
