import { describe, expect, test } from 'bun:test'
import { draftWithDictationTail, flushDictationIntoDraft } from './dictationSend'

describe('draftWithDictationTail', () => {
  test('typed text + tail → the tail appended exactly once', () => {
    const out = draftWithDictationTail('typed ', 'said this')
    expect(out).toBe('typed said this')
    expect(out.split('said this').length - 1).toBe(1)
  })
  test('empty tail → draft unchanged (byte for byte, trailing space kept)', () => {
    expect(draftWithDictationTail('typed ', '')).toBe('typed ')
    expect(draftWithDictationTail('typed ', '   ')).toBe('typed ')
  })
  test('spaces around the tail and at the end of the draft are normalised to one', () => {
    expect(draftWithDictationTail('typed   ', '  tail words  ')).toBe('typed tail words')
    expect(draftWithDictationTail('typed', 'tail')).toBe('typed tail')
  })
  test('empty draft → just the trimmed tail', () => {
    expect(draftWithDictationTail('', ' hello ')).toBe('hello')
    expect(draftWithDictationTail('  ', 'hello')).toBe('hello')
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('flushDictationIntoDraft', () => {
  test('appends the tail to the draft read AFTER the wait, writes it once, returns it', async () => {
    let draft = 'typed '
    const writes: string[] = []
    const d = deferred<string>()
    const guard = { current: false }
    const p = flushDictationIntoDraft(guard, { finish: () => d.promise, readDraft: () => draft, writeDraft: n => { writes.push(n); draft = n } })
    expect(guard.current).toBe(true)
    expect(writes).toEqual([]) // nothing touches the field before the tail arrives
    draft = 'typed more ' // the field moved while waiting: the tail joins what is there NOW
    d.resolve('tail')
    const r = await p
    expect(r).toEqual({ draft: 'typed more tail', changed: true })
    expect(writes).toEqual(['typed more tail'])
    expect(guard.current).toBe(false)
  })

  test('empty tail → no write, draft returned as is', async () => {
    const writes: string[] = []
    const r = await flushDictationIntoDraft({ current: false }, { finish: async () => '', readDraft: () => 'typed ', writeDraft: n => writes.push(n) })
    expect(r).toEqual({ draft: 'typed ', changed: false })
    expect(writes).toEqual([])
  })

  test('a rejecting finish releases the guard and keeps the draft', async () => {
    const guard = { current: false }
    const r = await flushDictationIntoDraft(guard, { finish: async () => { throw new Error('x') }, readDraft: () => 'typed', writeDraft: () => {} })
    expect(r).toEqual({ draft: 'typed', changed: false })
    expect(guard.current).toBe(false)
  })
})
