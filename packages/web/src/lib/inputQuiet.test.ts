import { afterEach, describe, expect, test } from 'bun:test'
import { MAX_WAIT_MS, QUIET_MS, markInputForTest, quietDelay, renderWhenInputQuiet, resetInputQuiet } from './inputQuiet'

afterEach(() => resetInputQuiet())

describe('quietDelay', () => {
  test('nobody typed: now', () => { expect(quietDelay(10_000, -Infinity, 10_000)).toBe(0) })
  test('typing a moment ago: wait until the input has been quiet', () => { expect(quietDelay(10_000, 9_800, 10_000)).toBe(QUIET_MS - 200) })
  test('never longer than the ceiling, however long the typing goes on', () => {
    expect(quietDelay(10_000 + MAX_WAIT_MS - 100, 10_000 + MAX_WAIT_MS - 50, 10_000)).toBe(100)
    expect(quietDelay(10_000 + MAX_WAIT_MS, 10_000 + MAX_WAIT_MS, 10_000)).toBe(0)
  })
})

describe('renderWhenInputQuiet', () => {
  test('renders at once when nobody is typing', () => {
    let n = 0
    renderWhenInputQuiet(() => { n++ })
    expect(n).toBe(1)
  })
  test('waits for the typing to stop, and only the latest of several refreshes renders', async () => {
    markInputForTest(Date.now())
    const seen: string[] = []
    renderWhenInputQuiet(() => seen.push('old'))
    renderWhenInputQuiet(() => seen.push('new'))
    expect(seen).toEqual([])
    await Bun.sleep(QUIET_MS + 150)
    expect(seen).toEqual(['new'])
  })
})
