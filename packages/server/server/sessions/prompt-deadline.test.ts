import { describe, expect, test } from 'bun:test'
import { withDeadline } from './prompt-deadline'

const after = <T>(ms: number, v: T) => new Promise<T>(r => setTimeout(() => r(v), ms))

describe('withDeadline', () => {
  test('a fast send settles inside the deadline', async () => {
    const out = await withDeadline(after(5, 'ok'), 200, () => { throw new Error('not late') })
    expect(out).toEqual({ settled: true, value: 'ok' })
  })

  test('a slow send releases the response at the deadline and reports its outcome later', async () => {
    const seen: unknown[] = []
    const t0 = Date.now()
    const out = await withDeadline(after(120, 'done'), 20, o => seen.push(o))
    expect(out).toEqual({ settled: false })
    expect(Date.now() - t0).toBeLessThan(100)
    await after(200, null)
    expect(seen).toEqual([{ value: 'done' }])
  })

  test('a late rejection is reported, never unhandled', async () => {
    const seen: unknown[] = []
    const work = new Promise<string>((_, rej) => setTimeout(() => rej(new Error('boom')), 60))
    expect((await withDeadline(work, 10, o => seen.push(o))).settled).toBe(false)
    await after(120, null)
    expect(seen).toHaveLength(1)
    expect((seen[0] as { error: Error }).error.message).toBe('boom')
  })

  test('a rejection inside the deadline still throws', async () => {
    await expect(withDeadline(Promise.reject(new Error('x')), 100, () => {})).rejects.toThrow('x')
  })
})
