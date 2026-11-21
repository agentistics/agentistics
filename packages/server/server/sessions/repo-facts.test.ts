import { describe, expect, it } from 'bun:test'
import {
  NEGATIVE_TTL_MS, decideRepoFacts, repoFactsFresh, resolveRepoFacts,
} from './repo-facts'

describe('decideRepoFacts', () => {
  it('reports nothing at all outside a repository', () => {
    expect(decideRepoFacts({ remote: '', gitDir: '', commonDir: '' })).toEqual({ worktree: false })
  })

  it('names the repository by its REMOTE, which is what a worktree shares with its checkout', () => {
    // The directory names deliberately differ — that is the point of a worktree — so the remote is
    // the only key that provably identifies the two as one project.
    const main = decideRepoFacts({
      remote: 'git@github.com:blpsoares/agentistics.git',
      gitDir: '/home/d/agentistics/.git',
      commonDir: '/home/d/agentistics/.git',
    })
    const wt = decideRepoFacts({
      remote: 'https://github.com/blpsoares/agentistics',
      gitDir: '/home/d/agentistics/.git/worktrees/session-monitor',
      commonDir: '/home/d/agentistics/.git',
    })
    expect(main.repo).toBe('blpsoares/agentistics')
    expect(wt.repo).toBe('blpsoares/agentistics')
    // And the folder the project is CALLED here is the main checkout either way — that is what the
    // "by project" grouping keys on, so a worktree does not file itself as its own project.
    expect(main.root).toBe('agentistics')
    expect(wt.root).toBe('agentistics')
  })

  it('calls a LINKED worktree one, and the main checkout not one', () => {
    // `--git-dir` and `--git-common-dir` differ exactly inside a linked worktree. That is the
    // canonical test, and the only one that does not depend on a path convention anyone can rename.
    expect(decideRepoFacts({
      remote: '', gitDir: '/r/.git/worktrees/x', commonDir: '/r/.git',
    }).worktree).toBe(true)
    expect(decideRepoFacts({
      remote: '', gitDir: '/r/.git', commonDir: '/r/.git',
    }).worktree).toBe(false)
  })

  it('falls back to the MAIN checkout folder when there is no remote', () => {
    // `--show-toplevel` would answer with the worktree's own directory, which is exactly the name
    // that must not become the grouping key.
    expect(decideRepoFacts({
      remote: '', gitDir: '/home/d/agentistics/.git/worktrees/session-monitor',
      commonDir: '/home/d/agentistics/.git',
    })).toEqual({
      repo: 'agentistics', root: 'agentistics', rootPath: '/home/d/agentistics', worktree: true,
    })
  })

  it('carries the normalized HOST of the remote, and none for a remote with no host', () => {
    expect(decideRepoFacts({ remote: 'git@GitLab.com:o/r.git', gitDir: '/r/.git', commonDir: '/r/.git' }))
      .toMatchObject({ repo: 'o/r', host: 'gitlab.com' })
    expect(decideRepoFacts({ remote: '/some/local/path', gitDir: '/r/.git', commonDir: '/r/.git' }).host).toBeUndefined()
  })

  it('ignores a remote git cannot key on, rather than inventing a name from it', () => {
    expect(decideRepoFacts({
      remote: '/some/local/path', gitDir: '/r/.git', commonDir: '/r/.git',
    }).repo).toBe('r')
  })

  it('keeps the main checkout PATH, not only its folder name', () => {
    // The cascade needs the directory the branches are measured from. `root` is a NAME, and
    // string-matching a name back against a cwd is a guess that goes wrong the moment a segment
    // repeats along the path (`~/agentistics/packages/agentistics`). The path is already computed
    // here to take the basename off — it was simply thrown away.
    const wt = decideRepoFacts({
      remote: 'git@github.com:blpsoares/agentistics.git',
      gitDir: '/home/d/agentistics/.git/worktrees/session-monitor',
      commonDir: '/home/d/agentistics/.git',
    })
    // The COMMON git dir's parent, so a linked worktree resolves to the MAIN checkout — exactly
    // what `root` already does, and the whole reason the branches are relative to it.
    expect(wt.rootPath).toBe('/home/d/agentistics')
    expect(wt.root).toBe('agentistics')
  })

  it('has no root PATH outside a repository', () => {
    expect(decideRepoFacts({ remote: '', gitDir: '', commonDir: '' }).rootPath).toBeUndefined()
  })
})

describe('resolveRepoFacts', () => {
  const WT = { repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true }

  it('prefers what git says NOW over anything recorded', () => {
    const moved = { repo: 'blpsoares/other', root: 'other', worktree: false }
    expect(resolveRepoFacts({ live: moved, recorded: WT, exists: true }))
      .toEqual({ ...moved, missing: false, source: 'live' })
  })

  it('keeps a DELETED worktree filed under the project it was a worktree of', () => {
    // The bug this exists for: `.claude/worktrees/member-connect-rotate` is removed with the
    // session still registered, every `git -C` fails, and the last path segment became a project
    // of its own standing beside the one it belongs to.
    expect(resolveRepoFacts({ live: { worktree: false }, recorded: WT, exists: false }))
      .toEqual({ ...WT, missing: true, source: 'recorded' })
  })

  it('says MISSING rather than naming a repository it cannot name', () => {
    // No recorded facts (a row written by an older build, or a directory that never was a repo).
    // The path names nothing, so the folder name at the end of it is a guess — and the caller is
    // told to say so in words instead of grouping under it.
    expect(resolveRepoFacts({ live: { worktree: false }, exists: false }))
      .toEqual({ worktree: false, missing: true, source: 'none' })
  })

  it('does not call a directory that merely is not a repository missing', () => {
    // `~/aipe` is a real folder outside git. Its own name IS a real name for it, and grouping by it
    // is correct — this must not land in the same bucket as a path that resolves to nothing.
    expect(resolveRepoFacts({ live: { worktree: false }, exists: true }))
      .toEqual({ worktree: false, missing: false, source: 'none' })
  })

  it('falls back to the recorded repo when git goes quiet on a directory that is still there', () => {
    // git not installed in this container, an index lock, a filesystem unmounted mid-poll: none of
    // those are evidence that the repository recorded at spawn was wrong.
    expect(resolveRepoFacts({ live: { worktree: false }, recorded: WT, exists: true }))
      .toEqual({ ...WT, missing: false, source: 'recorded' })
  })

  it('ignores a recorded entry that names no repository', () => {
    expect(resolveRepoFacts({ live: { worktree: false }, recorded: { worktree: false }, exists: false }))
      .toEqual({ worktree: false, missing: true, source: 'none' })
  })
})

describe('repoFactsFresh', () => {
  const positive = { facts: { repo: 'a/b', root: 'b', worktree: false }, atMs: 0 }
  const negative = { facts: { worktree: false }, atMs: 0 }

  it('reuses a POSITIVE answer forever — a directory does not change repository', () => {
    expect(repoFactsFresh(positive, NEGATIVE_TTL_MS * 1000)).toBe(true)
  })

  it('lets a NEGATIVE answer expire, so a recreated worktree is recognised', () => {
    // The defect: the first poll of a cwd whose worktree was deleted cached "no repository", and
    // that cwd stayed repo-less for the life of the process even after the worktree came back.
    expect(repoFactsFresh(negative, NEGATIVE_TTL_MS - 1)).toBe(true)
    expect(repoFactsFresh(negative, NEGATIVE_TTL_MS)).toBe(false)
  })
})
