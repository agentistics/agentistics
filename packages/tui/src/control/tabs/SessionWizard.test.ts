import { describe, expect, it } from 'bun:test'
import { wizSourceWord } from './SessionWizard'

const s = {
  wizSourceWorktree: 'worktree',
  wizSourceCwd: 'you are here',
  wizSourceTyped: 'typed',
  wizSourceHistory: 'worked here before',
  wizSourceRepo: 'git repo',
}

/**
 * THE REVIEW NIT: the terminal wizard still called a linked worktree "git repo" — its `source`
 * stays `'repo'` (see `project-source.ts`'s doc note), so only reading `ProjectOption.worktree`
 * first can tell the two apart here.
 */
describe('wizSourceWord', () => {
  it('a linked worktree reads "worktree", never "git repo" — even though source is still repo', () => {
    expect(wizSourceWord({ source: 'repo', worktree: true }, s)).toBe('worktree')
  })

  it('a plain repository (not a worktree) keeps reading "git repo", exactly as before', () => {
    expect(wizSourceWord({ source: 'repo', worktree: false }, s)).toBe('git repo')
    expect(wizSourceWord({ source: 'repo' }, s)).toBe('git repo')
  })

  it('a submodule — source repo, worktree false — is unaffected, same as a plain repository', () => {
    // dir-scan.ts's classifyGitFile already refuses to set worktree:true for a submodule; this
    // only asserts the word-picking side of that keeps working once it does not.
    expect(wizSourceWord({ source: 'repo', worktree: false }, s)).toBe('git repo')
  })

  it('every other source is unaffected by the worktree flag', () => {
    expect(wizSourceWord({ source: 'cwd', worktree: false }, s)).toBe('you are here')
    expect(wizSourceWord({ source: 'typed', worktree: false }, s)).toBe('typed')
    expect(wizSourceWord({ source: 'history', worktree: false }, s)).toBe('worked here before')
    expect(wizSourceWord({ source: 'folder', worktree: false }, s)).toBe('')
  })
})
