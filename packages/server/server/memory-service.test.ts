import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { memoryNotedEvent, type MemoryNotedData } from '@agentistics/core'
import { openJournal } from './journal/journal'
import { createMemoryService, statementBlob } from './memory-service'

function putBlob(dir: string, text: string): { sha256: string; bytes: number } {
  const sha = createHash('sha256').update(text).digest('hex')
  mkdirSync(join(dir, sha.slice(0, 2), sha.slice(2, 4)), { recursive: true })
  writeFileSync(join(dir, sha.slice(0, 2), sha.slice(2, 4), sha), text)
  return { sha256: sha, bytes: Buffer.byteLength(text) }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agt-mem-'))
  const contentDir = join(root, 'content')
  const journal = await openJournal({ path: join(root, 'journal.db') })
  const svc = createMemoryService({ journal: async () => journal, contentDir, adapterVersion: 'test@1', now: () => new Date('2026-10-03T12:00:00Z') })
  const note = async (d: Omit<MemoryNotedData, 'statement'> & { text: string }, at: string) => {
    const { text, ...rest } = d
    const statement = putBlob(contentDir, statementBlob(d.factId, text))
    await journal.append([memoryNotedEvent({ ...rest, statement }, { occurredAt: at, adapterVersion: 'test@1', sessionId: 'ses_1' })])
    return statement
  }
  return { journal, svc, note, contentDir }
}

describe('B6.6: the memory service', () => {
  test('recall: this repository\'s facts and the person\'s, never another repository\'s (rule 3)', async () => {
    const { svc, note } = await setup()
    await note({ factId: 'a', chainId: 'a', scope: 'repo', repoKey: 'github.com/o/one', category: 'convention', origin: 'person', text: 'Use bun test.' }, '2026-10-01T00:00:00Z')
    await note({ factId: 'b', chainId: 'b', scope: 'repo', repoKey: 'github.com/o/two', category: 'convention', origin: 'person', text: 'Use vitest.' }, '2026-10-01T00:00:00Z')
    await note({ factId: 'c', chainId: 'c', scope: 'person', category: 'preference', origin: 'person', text: 'Answers in Portuguese.' }, '2026-10-01T00:00:00Z')
    const one = await svc.recall({ repoKey: 'github.com/o/one' })
    expect(one.map(f => f.statement).sort()).toEqual(['Answers in Portuguese.', 'Use bun test.'])
    expect((await svc.recall({ repoKey: null })).map(f => f.statement)).toEqual(['Answers in Portuguese.'])
  })

  test('a superseding version replaces the recalled one; the old stays inspectable, closed (rule 7)', async () => {
    const { svc, note } = await setup()
    await note({ factId: 'a1', chainId: 'a', scope: 'repo', repoKey: 'r', category: 'decision', origin: 'person', text: 'Postgres.' }, '2026-10-01T00:00:00Z')
    await note({ factId: 'a2', chainId: 'a', supersedes: 'a1', scope: 'repo', repoKey: 'r', category: 'decision', origin: 'person', text: 'SQLite.' }, '2026-10-02T00:00:00Z')
    expect((await svc.recall({ repoKey: 'r' })).map(f => f.statement)).toEqual(['SQLite.'])
    const all = await svc.list()
    expect(all.find(f => f.factId === 'a1')).toMatchObject({ statement: 'Postgres.' })
    expect(all.find(f => f.factId === 'a1')!.validTo).not.toBeNull()
    expect(all.find(f => f.factId === 'a2')!.validTo).toBeNull()
  })

  test('forget deletes: no version recalled or listed, every statement gone from the content store (rule 6)', async () => {
    const { svc, note, contentDir } = await setup()
    const s1 = await note({ factId: 'a1', chainId: 'a', scope: 'repo', repoKey: 'r', category: 'pitfall', origin: 'model', text: 'Flaky test X.' }, '2026-10-01T00:00:00Z')
    const s2 = await note({ factId: 'a2', chainId: 'a', supersedes: 'a1', scope: 'repo', repoKey: 'r', category: 'pitfall', origin: 'model', text: 'Flaky test X, fixed by Y.' }, '2026-10-02T00:00:00Z')
    expect(await svc.forget('a')).toEqual({ ok: true, versions: 2 })
    expect(await svc.recall({ repoKey: 'r' })).toEqual([])
    expect(await svc.list()).toEqual([])
    for (const s of [s1, s2]) expect(existsSync(join(contentDir, s.sha256.slice(0, 2), s.sha256.slice(2, 4), s.sha256))).toBe(false)
    expect(await svc.forget('a')).toEqual({ ok: false, reason: 'not-found' })
  })
})
