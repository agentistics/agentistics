import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { headerIdOf, listGeminiFamilies } from './gemini-family-io'

const U = '550dc3a6-6fb8-42b5-9ad3-22dc68f74e88'
const header = JSON.stringify({ sessionId: U, projectHash: 'h', startTime: '2026-10-09T11:02:06.822Z', kind: 'main' })

describe('headerIdOf', () => {
  it('reads a journal header', () => { expect(headerIdOf(header)).toBe(U) })
  it('refuses a message record, a $set patch, a partial line and junk', () => {
    expect(headerIdOf(JSON.stringify({ id: 'x', type: 'user', sessionId: U }))).toBeNull()
    expect(headerIdOf(JSON.stringify({ $set: { sessionId: U } }))).toBeNull()
    expect(headerIdOf(header.slice(0, 30))).toBeNull()
    expect(headerIdOf('')).toBeNull()
  })
})

describe('listGeminiFamilies', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gemini-fam-io-'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session-2026-10-09T11-02-550dc3a6.jsonl'), header + '\n{"$set":{"sessionId":"x"}}\n')
    await writeFile(join(dir, 'session-2026-10-09T11-03-550dc3a6.jsonl'), '{"id":"u2","type":"user","content":[{"text":"hi"}]}\n')
    await writeFile(join(dir, 'session-2026-10-09T08-00-bbbbbbbb.jsonl'), JSON.stringify({ sessionId: 'bbbbbbbb-0000-4000-8000-000000000000', projectHash: 'h' }) + '\n')
    await writeFile(join(dir, 'notes.txt'), 'x')
  })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('groups the directory into conversations', async () => {
    const fams = await listGeminiFamilies(dir)
    expect(fams.map(f => f.members).sort()).toEqual([
      ['session-2026-10-09T08-00-bbbbbbbb.jsonl'],
      ['session-2026-10-09T11-02-550dc3a6.jsonl', 'session-2026-10-09T11-03-550dc3a6.jsonl'],
    ])
  })

  it('narrows to one suffix without reading the rest', async () => {
    const fams = await listGeminiFamilies(dir, { suffix: '550DC3A6' })
    expect(fams).toHaveLength(1)
    expect(fams[0]!.id).toBe(U)
  })

  it('a missing directory is no conversations, not a throw', async () => {
    expect(await listGeminiFamilies(join(dir, 'nope'))).toEqual([])
  })
})
