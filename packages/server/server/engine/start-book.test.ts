import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startEngineBook } from './start-book'

describe('startEngineBook (the server\'s one boot of the hand-off book)', () => {
  test('calls the engine book\'s start hook exactly once', async () => {
    let calls = 0
    await startEngineBook({ book: { start: async () => { calls++ } } })
    expect(calls).toBe(1)
  })
  test('no engine, no book, or an engine without the hook: nothing happens and nothing throws', async () => {
    await startEngineBook(null)
    await startEngineBook(undefined)
    await startEngineBook({})
    await startEngineBook({ book: {} })
  })
  test('a failing boot is logged and never thrown', async () => {
    const lines: string[] = []
    await startEngineBook({ book: { start: async () => { throw new Error('corrupt') } } }, l => lines.push(l))
    expect(lines).toEqual(['[book] boot failed: corrupt'])
  })
})

describe('only the long-lived server boots the book', () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, '..', f), 'utf8')
  test('server/index.ts calls startEngineBook; no one-shot entry (cli.ts, engine/cli.ts, load.ts) does', () => {
    expect(read('index.ts')).toContain('startEngineBook(engine())')
    for (const f of ['../bin/cli.ts', 'engine/cli.ts', 'engine/load.ts']) expect(read(f)).not.toContain('startEngineBook')
  })
})
