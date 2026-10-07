import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyGitFile, isWholeDiskRoot, isWorktreeDir, scanDirectories, shouldPruneDirectory } from './dir-scan'

describe('classifyGitFile', () => {
  it('recognises worktrees but not submodules or garbage', () => {
    expect(classifyGitFile('gitdir: /home/dev/.git/worktrees/x\n')).toBe('worktree')
    expect(classifyGitFile('gitdir: ../.git/modules/x\n')).toBe('other')
    expect(classifyGitFile('garbage')).toBe('other')
    expect(classifyGitFile('gitdir: /r/.git/worktrees/x\r\n')).toBe('worktree')
  })
})

describe('scanDirectories — repo vs worktree vs submodule', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dir-scan-'))
    await mkdir(join(root, 'main-checkout', '.git'), { recursive: true })
    await mkdir(join(root, 'a-worktree'), { recursive: true })
    await writeFile(join(root, 'a-worktree', '.git'), 'gitdir: /somewhere/.git/worktrees/a-worktree\n')
    await mkdir(join(root, 'a-submodule'), { recursive: true })
    await writeFile(join(root, 'a-submodule', '.git'), 'gitdir: ../.git/modules/a-submodule\n')
    await mkdir(join(root, 'garbage-git'), { recursive: true })
    await writeFile(join(root, 'garbage-git', '.git'), 'not a real git file\n')
    await mkdir(join(root, 'plain-folder'), { recursive: true })
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })
  it('classifies real checkout, worktree, submodule, garbage, and folder', async () => {
    const out = await scanDirectories(root, 1)
    expect(out).toContainEqual(expect.objectContaining({ name: 'main-checkout', repo: true, worktree: false }))
    expect(out).toContainEqual(expect.objectContaining({ name: 'a-worktree', repo: false, worktree: true }))
    expect(out).toContainEqual(expect.objectContaining({ name: 'a-submodule', repo: true, worktree: false }))
    expect(out).toContainEqual(expect.objectContaining({ name: 'garbage-git', repo: true, worktree: false }))
    expect(out).toContainEqual(expect.objectContaining({ name: 'plain-folder', repo: false, worktree: false }))
  })
})

describe('isWorktreeDir', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'is-worktree-'))
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    await writeFile(join(root, 'worktree', '.git'), 'gitdir: /main/.git/worktrees/worktree\n')
    await mkdir(join(root, 'submodule'), { recursive: true })
    await writeFile(join(root, 'submodule', '.git'), 'gitdir: ../.git/modules/submodule\n')
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })
  it('recognises only a linked worktree', async () => {
    expect(await isWorktreeDir(join(root, 'worktree'))).toBe(true)
    expect(await isWorktreeDir(join(root, 'submodule'))).toBe(false)
    expect(await isWorktreeDir(join(root, 'repo'))).toBe(false)
    expect(await isWorktreeDir(join(root, 'gone'))).toBe(false)
  })
})

describe('disk project scan bounds', () => {
  let root = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentistics-dir-scan-'))
    await mkdir(join(root, 'keep', 'nested'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'should-not-visit'), { recursive: true })
    await mkdir(join(root, 'Program Files', 'should-not-visit'), { recursive: true })
  })
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
  test('recognises whole-disk roots and system directories', () => {
    expect(isWholeDiskRoot('/mnt/c')).toBe(true)
    expect(isWholeDiskRoot('C:\\')).toBe(true)
    expect(isWholeDiskRoot('/home/dev')).toBe(false)
    expect(shouldPruneDirectory('Program Files')).toBe(true)
    expect(shouldPruneDirectory('node_modules')).toBe(true)
    expect(shouldPruneDirectory('System Volume Information')).toBe(true)
  })
  test('respects depth and skip list', async () => {
    const rows = await scanDirectories(root, { depth: 1, timeBudgetMs: 1_000 })
    expect(rows.map(row => row.path)).toContain(join(root, 'keep'))
    expect(rows.map(row => row.path)).not.toContain(join(root, 'keep', 'nested'))
    expect(rows.some(row => row.path.includes('node_modules'))).toBe(false)
    expect(rows.some(row => row.path.includes('Program Files'))).toBe(false)
  })
  test('returns without walking when the time budget is exhausted', async () => {
    expect(await scanDirectories(root, { depth: 4, timeBudgetMs: 0 })).toEqual([])
  })
})
