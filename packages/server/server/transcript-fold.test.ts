import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscriptFold } from './transcript-fold'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'fold-')); dirs.push(d); return d }

function counter() {
  let folded = 0
  const fold = createTranscriptFold<{ ids: string[] }>({
    init: () => ({ ids: [] }),
    fold: (s, l) => { folded++; s.ids.push(String(l.id)) },
    weigh: s => s.ids.length * 10,
  }, { maxEntries: 2, maxWeight: 1000 })
  return { fold, folded: () => folded }
}

describe('createTranscriptFold', () => {
  test('a file is parsed once; a grown file folds ONLY its new lines', async () => {
    const f = join(tmp(), 'a.jsonl')
    writeFileSync(f, '{"id":1}\n{"id":2}\n')
    const c = counter()
    expect((await c.fold.get(f))!.ids).toEqual(['1', '2'])
    expect((await c.fold.get(f))!.ids).toEqual(['1', '2'])
    expect(c.folded()).toBe(2)
    appendFileSync(f, '{"id":3}\n')
    expect((await c.fold.get(f))!.ids).toEqual(['1', '2', '3'])
    expect(c.folded()).toBe(3)
  })

  test('a half-written last line waits for its newline', async () => {
    const f = join(tmp(), 'a.jsonl')
    writeFileSync(f, '{"id":1}\n{"id":')
    const c = counter()
    expect((await c.fold.get(f))!.ids).toEqual(['1'])
    appendFileSync(f, '2}\n')
    expect((await c.fold.get(f))!.ids).toEqual(['1', '2'])
  })

  test('a shrunk or rewritten file is read again from the start', async () => {
    const f = join(tmp(), 'a.jsonl')
    writeFileSync(f, '{"id":1}\n{"id":2}\n')
    const c = counter()
    await c.fold.get(f)
    writeFileSync(f, '{"id":9}\n')
    expect((await c.fold.get(f))!.ids).toEqual(['9'])
    writeFileSync(f, '{"id":7}\n')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    expect((await c.fold.get(f))!.ids).toEqual(['7'])
  })

  test('the cache is bounded (entries and weight), least recently used first; malformed lines skipped', async () => {
    const d = tmp()
    const c = counter()
    for (const n of ['a', 'b', 'c']) { writeFileSync(join(d, n), '{"id":1}\nnot json\n[1]\n'); await c.fold.get(join(d, n)) }
    expect(c.fold.size()).toBe(2)
    expect((await c.fold.get(join(d, 'c')))!.ids).toEqual(['1'])
    expect(await c.fold.get(join(d, 'missing'))).toBeNull()
  })
})
