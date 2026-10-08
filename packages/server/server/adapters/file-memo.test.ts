import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileMemo, versionOf } from './file-memo'

test('a file is parsed once per version, and a new version is parsed again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-memo-'))
  try {
    const f = join(dir, 'rollout.jsonl')
    writeFileSync(f, 'a\n')
    const memo = createFileMemo<{ lines: number } | null>()
    let parses = 0
    const read = async () => memo.get(f, await versionOf([f]), async () => { parses++; return { lines: (await Bun.file(f).text()).split('\n').length - 1 } })

    expect(await read()).toEqual({ lines: 1 })
    expect(await read()).toEqual({ lines: 1 })
    expect(parses).toBe(1)

    appendFileSync(f, 'b\n')
    expect(await read()).toEqual({ lines: 2 })
    expect(parses).toBe(2)
    expect(memo.size).toBe(1) // the new version REPLACED the old one

    // Same size, different mtime: still a new version.
    writeFileSync(f, 'c\nd\n')
    utimesSync(f, new Date(), new Date(Date.now() + 5000))
    await read()
    expect(parses).toBe(3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a caller stamping a field onto what it got does not reach the next caller', async () => {
  const memo = createFileMemo<{ git_remote?: string; n: number }>()
  const first = await memo.get('k', 'v1', async () => ({ n: 1 }))
  first.git_remote = 'stamped'
  const hit = await memo.get('k', 'v1', async () => { throw new Error('must not parse') })
  hit.n = 7
  expect(await memo.get('k', 'v1', async () => { throw new Error('must not parse') })).toEqual({ n: 1 })
})

test('the version covers every file and a missing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-memo-'))
  try {
    const a = join(dir, 'events.jsonl'), b = join(dir, 'workspace.yaml')
    writeFileSync(a, 'x')
    const before = await versionOf([a, b])
    expect(before.endsWith('|-')).toBe(true)
    writeFileSync(b, 'cwd: /p\n')
    expect(await versionOf([a, b])).not.toBe(before)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
