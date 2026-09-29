/**
 * runtime-host.test.ts — the host seam's floor: every credential file the backup plan knows about is
 * refused by a native session's policy, and a relocated data dir is passed on.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globMatches } from '@agentistics/runtime'
import { omittedSecrets } from './backup/backup-plan'
import { hostPolicy, hostProtectedPaths, protectedPathsFromSecrets, readAgentsMd } from './runtime-host'

const env = { home: '/home/u', workspaceRoot: '/home/u/work/repo' }
const floored = (globs: readonly string[], path: string) => globs.some(g => globMatches(g, path, env))

describe('protectedPathsFromSecrets', () => {
  const globs = hostProtectedPaths()

  test('every non-agentistics secret row lands on the floor', () => {
    const rows = omittedSecrets().filter(r => !r.pattern.startsWith('.agentistics'))
    expect(rows.length).toBeGreaterThan(5)
    for (const r of rows) {
      const p = r.pattern.split('#')[0]!
      // A `contains` rule with no directory is checked where it actually lives: under a harness home.
      const sample = r.match === 'contains' && !p.includes('/') ? `/home/u/.claude/sessions/1${p}` : `/home/u/${p}`
      expect({ row: r.pattern, floored: floored(globs, sample) }).toEqual({ row: r.pattern, floored: true })
    }
  })

  test('the named harness credential files, spelled out', () => {
    for (const p of ['.claude/.credentials.json', '.codex/auth.json', '.gemini/oauth_creds.json', '.kimi-code/config.toml']) {
      expect(floored(globs, `/home/u/${p}`)).toBe(true)
    }
    expect(floored(globs, '/home/u/.copilot/tokens/abc')).toBe(true)
  })

  test('a workspace file that merely contains `.key` is NOT floored', () => {
    expect(floored(globs, '/home/u/work/repo/src/hotkey.keymap.ts')).toBe(false)
    expect(floored(globs, '/home/u/work/repo/README.md')).toBe(false)
  })

  test('only secret rows count, and the output is sorted and deduplicated', () => {
    const out = protectedPathsFromSecrets([
      { pattern: '.x/a', match: 'prefix', reason: 'regenerable', why: '' },
      { pattern: '.y/b', match: 'prefix', reason: 'secret', why: '' },
      { pattern: '.y/b', match: 'prefix', reason: 'secret', why: '' },
    ])
    expect(out).toEqual(['~/.y/b', '~/.y/b*', '~/.y/b*/**'])
  })
})

describe('hostPolicy', () => {
  test('a relocated data dir is floored; the default location still is', async () => {
    const p = hostPolicy({ home: '/home/u', dataDir: '/srv/agt', defaultDataDir: '/home/u/.agentistics', protectedPaths: [] })
    const ask = (path: string) => p.evaluate({
      call: { toolExecutionId: 'tx_1', toolName: 'file.read' }, kind: 'file' as const, permission: 'auto' as const,
      subjects: [{ action: 'read' as const, path }], workspaceRoot: '/home/u/work/repo',
    })
    expect((await ask('/srv/agt/provider-keys/anthropic.json')).decision).toBe('deny')
    expect((await ask('/home/u/.agentistics/provider-keys/anthropic.json')).decision).toBe('deny')
    expect((await ask('/home/u/work/repo/README.md')).decision).toBe('allow')
  })
})

describe('readAgentsMd (H2)', () => {
  function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'agents-md-'))
    const root = join(base, 'repo')
    const deep = join(root, 'packages', 'a')
    mkdirSync(deep, { recursive: true })
    return { base, root, deep, done: () => rmSync(base, { recursive: true, force: true }) }
  }

  test('root to cwd, in order; a missing file is no notice; nothing above the root is read', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.base, 'AGENTS.md'), 'ABOVE THE ROOT\n')
      writeFileSync(join(f.root, 'AGENTS.md'), 'root\n')
      writeFileSync(join(f.deep, 'AGENTS.md'), 'deep\n')
      const r = readAgentsMd(f.deep, { workspaceRoot: f.root })
      expect(r.sections.map(s => [s.path, s.text])).toEqual([
        [join(f.root, 'AGENTS.md'), 'root\n'],
        [join(f.deep, 'AGENTS.md'), 'deep\n'],
      ])
      expect(r.notices).toEqual([])
    } finally { f.done() }
  })

  test('a symlink resolving outside the workspace is refused UNREAD', () => {
    const f = fixture()
    try {
      const secret = join(f.base, 'secret.md')
      writeFileSync(secret, 'do not read\n')
      chmodSync(secret, 0o000) // were it read, the notice would be `unreadable`, not `outside-workspace`
      symlinkSync(secret, join(f.deep, 'AGENTS.md'))
      writeFileSync(join(f.root, 'AGENTS.md'), 'root\n')
      const r = readAgentsMd(f.deep, { workspaceRoot: f.root })
      expect(r.sections.map(s => s.text)).toEqual(['root\n'])
      expect(r.notices).toEqual([{ kind: 'outside-workspace', path: join(f.deep, 'AGENTS.md') }])
    } finally { f.done() }
  })

  test('a symlink staying inside the workspace is followed', () => {
    const f = fixture()
    try {
      writeFileSync(join(f.root, 'shared.md'), 'shared\n')
      symlinkSync(join(f.root, 'shared.md'), join(f.deep, 'AGENTS.md'))
      const r = readAgentsMd(f.deep, { workspaceRoot: f.root })
      expect(r.sections.map(s => s.text)).toEqual(['shared\n'])
    } finally { f.done() }
  })

  test('a directory named AGENTS.md is not a file; a huge file is read bounded and cut', () => {
    const f = fixture()
    try {
      mkdirSync(join(f.root, 'AGENTS.md'))
      writeFileSync(join(f.deep, 'AGENTS.md'), 'x'.repeat(99) + '\n' + 'y'.repeat(200_000))
      const r = readAgentsMd(f.deep, { workspaceRoot: f.root })
      expect(r.notices).toEqual([
        { kind: 'not-a-file', path: join(f.root, 'AGENTS.md') },
        { kind: 'cut-file', path: join(f.deep, 'AGENTS.md'), bytes: 200_100, keptBytes: 100 },
      ])
      expect(r.sections[0]!.text).toBe('x'.repeat(99) + '\n')
    } finally { f.done() }
  })

  test('cwd outside the given workspace root reads nothing and says so', () => {
    const f = fixture()
    try {
      const r = readAgentsMd(f.base, { workspaceRoot: f.root })
      expect(r).toEqual({ sections: [], truncated: false, notices: [{ kind: 'cwd-outside-workspace', path: f.base }] })
    } finally { f.done() }
  })
})
