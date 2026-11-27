/**
 * Sending while dictating must send EVERYTHING that was said, exactly once (owner, 2026-11-27:
 * "quando eu tô falando na transcrição e eu aperto no botãozinho enviar ele simplesmente deleta tudo
 * que eu falei"). The recogniser is faked: it delivers interim and final results AFTER `stop()`,
 * which is what Chrome does with the audio it has not settled on yet.
 */
import { expect, test } from 'bun:test'
import { finishDictation, type FinishableRecognition } from './dictationFinish'

type Ev = Parameters<NonNullable<FinishableRecognition['onresult']>>[0]

function fakeRec() {
  const calls: string[] = []
  const rec: FinishableRecognition = {
    onresult: null, onend: null, onerror: null,
    stop: () => { calls.push('stop') },
    abort: () => { calls.push('abort') },
  }
  const result = (text: string, isFinal: boolean, resultIndex = 0): Ev =>
    ({ resultIndex, results: Object.assign([Object.assign([{ transcript: text }], { isFinal })], { length: 1 }) }) as never
  return { rec, calls, result }
}

test('a final result arriving AFTER stop is what gets sent — not lost, not aborted away', async () => {
  const { rec, calls, result } = fakeRec()
  const p = finishDictation(rec, 'hello wor', { timeoutMs: 1500 })
  expect(calls).toEqual(['stop'])
  rec.onresult?.(result('hello world', true))
  rec.onend?.()
  expect(await p).toBe('hello world')
  expect(calls).not.toContain('abort')
})

test('a recogniser that never finalises within the wait still yields the best text it had (the interim)', async () => {
  const { rec, calls } = fakeRec()
  const p = finishDictation(rec, 'falei tudo isso', { timeoutMs: 20 })
  expect(await p).toBe('falei tudo isso')
  expect(calls).toEqual(['stop', 'abort'])
})

test('a newer interim replaces the older one; finals accumulate', async () => {
  const { rec, result } = fakeRec()
  const p = finishDictation(rec, 'one', { timeoutMs: 20 })
  rec.onresult?.(result('one two', true))
  rec.onresult?.(result('three fo', false))
  expect(await p).toBe('one two three fo')
})

test('after it resolves, a late result or end cannot reach anybody (handlers detached)', async () => {
  const { rec, result } = fakeRec()
  const p = finishDictation(rec, '', { timeoutMs: 1500 })
  rec.onend?.()
  expect(await p).toBe('')
  expect(rec.onresult).toBeNull()
  expect(rec.onend).toBeNull()
  expect(rec.onerror).toBeNull()
  // Nothing to call — and the promise already settled once.
  void result
})

test('an error on the way down still hands back what was heard', async () => {
  const { rec } = fakeRec()
  const p = finishDictation(rec, 'meio da frase', { timeoutMs: 1500 })
  rec.onerror?.({ error: 'network' })
  expect(await p).toBe('meio da frase')
})

test('a stop that throws resolves at once with the interim', async () => {
  const rec: FinishableRecognition = { onresult: null, onend: null, onerror: null, stop: () => { throw new Error('x') } }
  expect(await finishDictation(rec, 'abc', { timeoutMs: 1500 })).toBe('abc')
})
