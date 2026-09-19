import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyGitFile, isWorktreeDir, scanDirectories } from './dir-scan'

/**
 * `classifyGitFile` — PURE. Content strings measured against real git 2.53
 * (`git worktree add` / `git submodule add`), not invented.
 */
describe('classifyGitFile — the kind is what the file SAYS, never that it is a file at all', () => {
  it('a real worktree gitdir line', () => {
    // Measured verbatim from `cat <worktree>/.git` after `git worktree add`.
    expect(classifyGitFile(
      'gitdir: /home/dev/agentistics/.git/worktrees/wt-check\n',
    )).toBe('worktree')
  })

  it('THE REPORTED BUG: a real submodule gitdir line is NOT a worktree', () => {
    // Measured verbatim from `cat <submodule>/.git` after `git submodule add` — a submodule's
    // `.git` is a FILE too, and `isFile()` alone cannot tell the two apart.
    expect(classifyGitFile('gitdir: ../.git/modules/subdir\n')).toBe('other')
  })

  it('garbage content is not a worktree', () => {
    expect(classifyGitFile('not a gitdir line at all')).toBe('other')
    expect(classifyGitFile('')).toBe('other')
    expect(classifyGitFile('gitdir:')).toBe('other')
  })

  it('a `gitdir:` line that names neither pattern is not a worktree', () => {
    // A relocated repository, a future git format, anything this was never checked against — the
    // ABSENCE of the worktree marker, never assumed present by default.
    expect(classifyGitFile('gitdir: /some/other/place\n')).toBe('other')
  })

  it('is insensitive to CRLF and missing trailing newline — only the path decides', () => {
    expect(classifyGitFile('gitdir: /r/.git/worktrees/x\r\n')).toBe('worktree')
    expect(classifyGitFile('gitdir: /r/.git/worktrees/x')).toBe('worktree')
  })
})

/**
 * THE REPORTED BUG (worktree): a git worktree's own `.git` is a FILE (`gitdir:
 * <main>/.git/worktrees/<name>`), never a directory. The old check (`entries.some(e => e.name ===
 * '.git')`) only asked whether an entry BY THAT NAME existed, so a worktree walked in came back
 * `repo: true` — the walk's own way of saying "this is a repository's main checkout" — and it went
 * on to read as a repository throughout the wizard.
 *
 * THE REVIEW FINDING (submodule): a git SUBMODULE's `.git` is ALSO a file
 * (`gitdir: ../.git/modules/<name>`), and checking only `isFile()` — never the CONTENT — called a
 * submodule a worktree too, which is factually wrong: a submodule is its own independent
 * repository, not "a second place to work in this one".
 */
describe('scanDirectories — repo vs worktree vs submodule, from the SAME readdir', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dir-scan-'))
    // A real checkout: `.git` is a directory.
    await mkdir(join(root, 'main-checkout', '.git'), { recursive: true })
    // A linked worktree: `.git` is a FILE whose content names `.git/worktrees/`.
    await mkdir(join(root, 'a-worktree'), { recursive: true })
    await writeFile(join(root, 'a-worktree', '.git'), 'gitdir: /somewhere/.git/worktrees/a-worktree\n')
    // A submodule: `.git` is ALSO a FILE, but its content names `.git/modules/` instead.
    await mkdir(join(root, 'a-submodule'), { recursive: true })
    await writeFile(join(root, 'a-submodule', '.git'), 'gitdir: ../.git/modules/a-submodule\n')
    // A `.git` FILE with garbage content — neither pattern, and not even a `gitdir:` line.
    await mkdir(join(root, 'garbage-git'), { recursive: true })
    await writeFile(join(root, 'garbage-git', '.git'), 'not a real git file\n')
    // Neither a repo nor a worktree nor a submodule.
    await mkdir(join(root, 'plain-folder'), { recursive: true })
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('flags a real checkout as repo, and NOT as a worktree', async () => {
    const out = await scanDirectories(root, 1)
    const main = out.find(d => d.name === 'main-checkout')
    expect(main).toMatchObject({ repo: true, worktree: false })
  })

  it('flags a linked worktree as worktree, and NEVER as repo', async () => {
    const out = await scanDirectories(root, 1)
    const wt = out.find(d => d.name === 'a-worktree')
    // THIS is the line that would have failed before the fix: the old code set `repo: true` here,
    // because it never looked past the entry's NAME.
    expect(wt).toMatchObject({ repo: false, worktree: true })
  })

  it('THE REVIEW FINDING: flags a submodule as repo, and NEVER as worktree', async () => {
    const out = await scanDirectories(root, 1)
    const sub = out.find(d => d.name === 'a-submodule')
    // A `.git`-FILE-only check would have set `worktree: true` here — the misclassification the
    // reviewer verified live with a real `git submodule add`.
    expect(sub).toMatchObject({ repo: true, worktree: false })
  })

  it('a `.git` file with unrecognised content reads as a plain repository, never a worktree', async () => {
    const out = await scanDirectories(root, 1)
    const g = out.find(d => d.name === 'garbage-git')
    expect(g).toMatchObject({ repo: true, worktree: false })
  })

  it('flags a plain folder as neither', async () => {
    const out = await scanDirectories(root, 1)
    const plain = out.find(d => d.name === 'plain-folder')
    expect(plain).toMatchObject({ repo: false, worktree: false })
  })
})

describe('isWorktreeDir — the same distinction, for a path the walk never visited', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'is-worktree-'))
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await mkdir(join(root, 'worktree'), { recursive: true })
    await writeFile(join(root, 'worktree', '.git'), 'gitdir: /main/.git/worktrees/worktree\n')
    await mkdir(join(root, 'submodule'), { recursive: true })
    await writeFile(join(root, 'submodule', '.git'), 'gitdir: ../.git/modules/submodule\n')
    await mkdir(join(root, 'garbage'), { recursive: true })
    await writeFile(join(root, 'garbage', '.git'), 'garbage\n')
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('is true for a `.git` FILE whose content names a worktree', async () => {
    expect(await isWorktreeDir(join(root, 'worktree'))).toBe(true)
  })

  it('THE REVIEW FINDING: is false for a `.git` FILE whose content names a submodule', async () => {
    expect(await isWorktreeDir(join(root, 'submodule'))).toBe(false)
  })

  it('is false for a `.git` FILE with unrecognised content', async () => {
    expect(await isWorktreeDir(join(root, 'garbage'))).toBe(false)
  })

  it('is false for a real checkout — its `.git` is a directory', async () => {
    expect(await isWorktreeDir(join(root, 'repo'))).toBe(false)
  })

  it('never throws on a directory with no `.git` at all', async () => {
    expect(await isWorktreeDir(root)).toBe(false)
  })

  it('never throws on a directory that does not exist', async () => {
    expect(await isWorktreeDir(join(root, 'gone'))).toBe(false)
  })
})
