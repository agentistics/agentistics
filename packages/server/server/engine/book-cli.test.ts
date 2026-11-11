import { describe, expect, test } from 'bun:test'
import type { EngineCommand, EngineStatus } from '@agentistics/engine-api'
import { BOOK_ABSENT_SENTENCE, ENGINE_ABSENT_EXIT, isEngineVerb, resolveEngineVerb } from './cli'

const present = { present: true } as unknown as EngineStatus
const bookCmd: EngineCommand = {
  verb: 'book',
  summary: { en: 'book', pt: 'livro' },
  help: { en: 'book', pt: 'livro' },
  run: async () => 0,
} as unknown as EngineCommand

describe('agentop book', () => {
  test('is a recognised engine verb', () => {
    expect(isEngineVerb('book')).toBe(true)
  })

  test('without an engine it refuses with the sentence, in both languages', () => {
    for (const lang of ['en', 'pt'] as const) {
      const d = resolveEngineVerb('book', { present: false, reason: 'community-build' }, [], lang)
      expect('refuse' in d && d.refuse).toBe('book not available in this build')
    }
    expect(BOOK_ABSENT_SENTENCE).toBe('book not available in this build')
    expect(ENGINE_ABSENT_EXIT).toBe(2)
  })

  test('an engine present but without a book command also refuses with the sentence', () => {
    const other = [{ ...bookCmd, verb: 'flow' }] as EngineCommand[]
    const d = resolveEngineVerb('book', present, other, 'en')
    expect('refuse' in d && d.refuse).toBe('book not available in this build')
  })

  test('with a book command it runs through to the engine command', async () => {
    const calls: string[][] = []
    const cmd = { ...bookCmd, run: async (args: string[]) => { calls.push(args); return 0 } } as unknown as EngineCommand
    const d = resolveEngineVerb('book', present, [cmd], 'en')
    expect('run' in d).toBe(true)
    if ('run' in d) {
      expect(await d.run.run(['page', 'x'], { out: () => {}, err: () => {} })).toBe(0)
      expect(calls).toEqual([['page', 'x']])
    }
  })
  // The bin's own dispatch is proved by RUNNING it: book-wiring.test.ts.
})
