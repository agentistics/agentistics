import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newLimitProbeCache, readLimitProbe } from './account-switch-io'

let root = ''
let saved: string | undefined
const T0 = Date.UTC(2026, 9, 30, 12, 0)
const limitLine = JSON.stringify({ type: 'assistant', timestamp: new Date(T0).toISOString(), apiError: 'usage_limit_reached', apiErrorParams: { rate_limit_info: { resetsAt: (T0 + 3_600_000) / 1000 } }, message: { content: [{ text: 'limit' }] } })
const okLine = JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 1000).toISOString(), message: { content: [{ type: 'text', text: 'done' }] } })
const file = () => join(root, 'projects', '-w', 'conv-p.jsonl')
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'limit-probe-'))
  saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  mkdirSync(join(root, 'projects', '-w'), { recursive: true })
})
beforeEach(() => { rmSync(file(), { force: true }) }) // each test starts with no transcript (order-independent)
afterAll(() => { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; rmSync(root, { recursive: true, force: true }) })

const probe = (cache?: ReturnType<typeof newLimitProbeCache>) => readLimitProbe({ harness: 'claude', conversationId: 'conv-p', cwd: '/w' }, cache)

test('three answers: unread (no transcript), limited, clear — and the limited one carries the entry\'s time', async () => {
  expect(await probe()).toEqual({ kind: 'unread' })
  writeFileSync(file(), `${limitLine}\n`)
  expect(await probe()).toMatchObject({ kind: 'limited', state: { at: T0, resetsAt: T0 + 3_600_000 } })
  writeFileSync(file(), `${limitLine}\n${okLine}\n`)
  expect(await probe()).toEqual({ kind: 'clear' })
})

test('F7 — with a cache the tail is re-read only when the file\'s mtime changed', async () => {
  const cache = newLimitProbeCache()
  writeFileSync(file(), `${limitLine}\n`)
  const t1 = new Date('2026-10-30T12:00:00Z')
  utimesSync(file(), t1, t1)
  expect(await probe(cache)).toMatchObject({ kind: 'limited' })
  // the content changes but the mtime is put back: a cached answer is returned without reading the file
  writeFileSync(file(), `${limitLine}\n${okLine}\n`)
  utimesSync(file(), t1, t1)
  expect(await probe(cache)).toMatchObject({ kind: 'limited' })
  const t2 = new Date('2026-10-30T12:05:00Z')
  utimesSync(file(), t2, t2)
  expect(await probe(cache)).toEqual({ kind: 'clear' })
})
