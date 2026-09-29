import { describe, expect, test } from 'bun:test'
import {
  AGENTS_MD_FILE_CAP,
  AGENTS_MD_TOTAL_CAP,
  agentsMdChain,
  collectAgentsMd,
} from './agents-md'

describe('agentsMdChain', () => {
  test('root first, cwd last, every directory between', () => {
    expect(agentsMdChain('/w/repo', '/w/repo/packages/a/src')).toEqual([
      '/w/repo', '/w/repo/packages', '/w/repo/packages/a', '/w/repo/packages/a/src',
    ])
  })
  test('cwd === root asks the root alone', () => {
    expect(agentsMdChain('/w/repo', '/w/repo/')).toEqual(['/w/repo'])
  })
  test('cwd outside the root, or a sibling sharing a prefix, has no chain', () => {
    expect(agentsMdChain('/w/repo', '/w')).toBeNull()
    expect(agentsMdChain('/w/repo', '/w/repo-other/x')).toBeNull()
    expect(agentsMdChain('/w/repo', '/w/repo/../elsewhere')).toBeNull()
  })
})

describe('collectAgentsMd', () => {
  test('the caps are the stated numbers', () => {
    expect(AGENTS_MD_FILE_CAP).toBe(32 * 1024)
    expect(AGENTS_MD_TOTAL_CAP).toBe(64 * 1024)
  })

  test('keeps reading order, skips absent and empty files with no notice', () => {
    const r = collectAgentsMd([
      { dir: '/w', text: 'root rules\n' },
      { dir: '/w/a' },
      { dir: '/w/a/b', text: '  \n\t\n' },
      { dir: '/w/a/b/c', text: 'deep rules\n' },
    ])
    expect(r.sections.map(s => s.path)).toEqual(['/w/AGENTS.md', '/w/a/b/c/AGENTS.md'])
    expect(r.sections[0]).toEqual({ path: '/w/AGENTS.md', text: 'root rules\n', bytes: 11 })
    expect(r.notices).toEqual([])
    expect(r.truncated).toBe(false)
  })

  test('bytes are UTF-8 bytes, not characters', () => {
    const r = collectAgentsMd([{ dir: '/w', text: 'ção\n' }])
    expect(r.sections[0]!.bytes).toBe(6)
  })

  test('a file over the per-file cap is cut on a line boundary, with a notice naming it', () => {
    const text = 'line one\nline two\nline three\n' // 9 + 9 + 11 bytes
    const r = collectAgentsMd([{ dir: '/w', text }], { file: 20, total: 1000 })
    expect(r.sections[0]!.text).toBe('line one\nline two\n')
    expect(r.sections[0]!.bytes).toBe(18)
    expect(r.notices).toEqual([{ kind: 'cut-file', path: '/w/AGENTS.md', bytes: 29, keptBytes: 18}])
    expect(r.truncated).toBe(true)
  })

  test('the total is spent root first: the deeper file is cut, the next one dropped', () => {
    const r = collectAgentsMd([
      { dir: '/w', text: 'aaaa\nbbbb\n' },      // 10
      { dir: '/w/x', text: 'cccc\ndddd\n' },    // 10, only 7 left -> 5 kept
      { dir: '/w/x/y', text: 'eeee\n' },        // nothing left
    ], { file: 100, total: 17 })
    expect(r.sections.map(s => s.text)).toEqual(['aaaa\nbbbb\n', 'cccc\n'])
    expect(r.notices).toEqual([
      { kind: 'cut-total', path: '/w/x/AGENTS.md', bytes: 10, keptBytes: 5},
      { kind: 'dropped-total', path: '/w/x/y/AGENTS.md', bytes: 5, keptBytes: 0 },
    ])
    expect(r.sections.reduce((n, s) => n + s.bytes, 0)).toBeLessThanOrEqual(17)
  })

  test('a budget smaller than the first line keeps nothing and says so', () => {
    const r = collectAgentsMd([
      { dir: '/w', text: '12345678\n' },
      { dir: '/w/x', text: 'a longer first line\nnext\n' },
    ], { file: 100, total: 12 })
    expect(r.sections.map(s => s.path)).toEqual(['/w/AGENTS.md'])
    expect(r.notices).toEqual([{ kind: 'dropped-total', path: '/w/x/AGENTS.md', bytes: 25, keptBytes: 0 }])
  })

  test('when not one whole line fits, nothing is kept — never a fragment of a line', () => {
    const r = collectAgentsMd([{ dir: '/w', text: 'one enormous line with no newline' }], { file: 10, total: 100 })
    expect(r.sections).toEqual([])
    expect(r.notices).toEqual([{ kind: 'dropped-file', path: '/w/AGENTS.md', bytes: 33, keptBytes: 0 }])
    expect(r.truncated).toBe(true)
  })

  test('the host read only a prefix: the real size is reported', () => {
    const r = collectAgentsMd([{ dir: '/w', text: 'one\ntwo\nthr', size: 90_000 }], { file: 10, total: 100 })
    expect(r.notices).toEqual([{ kind: 'cut-file', path: '/w/AGENTS.md', bytes: 90_000, keptBytes: 8}])
  })

  test('a host refusal is carried through as a notice, in chain order', () => {
    const r = collectAgentsMd([
      { dir: '/w', refused: 'outside-workspace' },
      { dir: '/w/a', text: 'ok\n' },
      { dir: '/w/a/b', refused: 'unreadable' },
    ])
    expect(r.sections.map(s => s.path)).toEqual(['/w/a/AGENTS.md'])
    expect(r.notices).toEqual([
      { kind: 'outside-workspace', path: '/w/AGENTS.md' },
      { kind: 'unreadable', path: '/w/a/b/AGENTS.md' },
    ])
    expect(r.truncated).toBe(false)
  })
})
