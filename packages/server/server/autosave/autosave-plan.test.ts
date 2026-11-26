import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AUTOSAVE_MAX_UNTRACKED_BYTES,
  AUTOSAVE_MIN_MEM_BYTES,
  autosaveRef,
  autosaveSlug,
  bundleNames,
  decideTree,
  dedupeTrees,
  defaultBundleDir,
  isSecretPath,
  isWslHost,
  needsLook,
  parseWindowsProfile,
  parseWorktreeList,
  planRetention,
  savedFingerprint,
  shouldRunRound,
  splitNul,
  untrackedToSave,
} from './autosave-plan'

describe('secret and size filter', () => {
  test('secret-shaped names are refused wherever they sit', () => {
    for (const p of ['.env', '.env.local', 'app/.env.production', 'deploy/ID_RSA', 'id_ed25519.pub', 'certs/server.pem', 'k/api.key',
      'my-secret.txt', 'aws_credentials', 'gh-token.json', '.npmrc', 'sub/.netrc', 'store.p12', 'vault.kdbx', '.git-credentials'])
      expect(isSecretPath(p), p).toBe(true)
    for (const p of ['src/index.ts', 'README.md', 'env.ts', 'docs/environment.md', 'keyboard.ts', 'monkey.txt'])
      expect(isSecretPath(p), p).toBe(false)
  })
  test('a secret-named DIRECTORY refuses everything under it (QA r1: secrets/prod.yaml went into the bundle)', () => {
    for (const p of ['secrets/prod.yaml', 'credentials/db.json', 'config/secrets/x.json', 'tokens/gh.txt', 'my-secrets/a.txt',
      'Secrets/PROD.yaml', 'ops/id_rsa_backup/key', 'app/.env.d/x', 'secrets\n/p', 'a/my\ntoken/x'])
      expect(isSecretPath(p), p).toBe(true)
  })
  test('at least as strict as the cron SECRET_RE (leader/wip/salvamento-auto.sh): whatever it refuses, this refuses', () => {
    // The cron's pattern verbatim (POSIX ERE, run with grep -qiE).
    const cron = /(^|\/)(\.env(\..*)?|.*secret.*|.*credential.*|.*token.*|.*\.pem|.*\.key|id_rsa.*|\.npmrc|\.netrc)$/i
    const sample = ['secrets/prod.yaml', 'credentials/db.json', 'config/secrets/x.json', 'tokens/gh.txt', 'a/b/my-token/c/d.txt',
      'x/id_rsa/y', 'id_rsa.pub', 'deep/dir/.env', '.env.x/y', 'a.pem', 'b/c.key', 'k.KEY', 'src/index.ts', 'README.md', 'keyboard.ts',
      'certs/x.pem/inner', 'TOKEN', 'nested/.npmrc', 'nested/.netrc']
    for (const p of sample) if (cron.test(p)) expect(isSecretPath(p), p).toBe(true)
  })
  test('untracked: keep the ordinary, drop secret / oversized / unreadable / nested repo — each with its reason', () => {
    const plan = untrackedToSave([
      { path: 'notes.md', size: 10 },
      { path: '.env', size: 10 },
      { path: 'big.bin', size: 6 * 1024 * 1024 },
      { path: 'edge.bin', size: AUTOSAVE_MAX_UNTRACKED_BYTES },
      { path: 'gone.txt', size: null },
      { path: 'vendor/lib/', size: 0 },
    ])
    expect(plan.keep).toEqual(['notes.md', 'edge.bin'])
    expect(plan.skipped).toEqual([
      { path: '.env', reason: 'secret' },
      { path: 'big.bin', reason: 'too-large' },
      { path: 'gone.txt', reason: 'unreadable' },
      { path: 'vendor/lib/', reason: 'nested-repo' },
    ])
  })
  test('the round module applies the filter (grep, like backup-plan.test.ts): removing it fails here', () => {
    const io = readFileSync(join(import.meta.dir, 'autosave-io.ts'), 'utf8')
    expect(io).toContain('untrackedToSave(entries)')
    expect(io).toContain("'--exclude-standard'")
    expect(io).toContain('GIT_OPTIONAL_LOCKS')
    expect(io).toContain('GIT_INDEX_FILE')
  })
})

describe('trees and names', () => {
  test('worktree porcelain: bare and prunable dropped', () => {
    const txt = 'worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.wt/a\nHEAD def\ndetached\n\nworktree /r/.wt/gone\nHEAD 1\nprunable gitdir file points to non-existent location\n\nworktree /bare\nbare\n'
    expect(parseWorktreeList(txt)).toEqual(['/r', '/r/.wt/a'])
    expect(dedupeTrees(['/a/', '/a', '/b'])).toEqual(['/a', '/b'])
    expect(splitNul('a\0b c\0')).toEqual(['a', 'b c'])
  })
  test('needsLook', () => {
    expect(needsLook({ dirty: false, ahead: 0 })).toBe(false)
    expect(needsLook({ dirty: true, ahead: 0 })).toBe(true)
    expect(needsLook({ dirty: false, ahead: 2 })).toBe(true)
  })
  test('slug: readable, stable, and distinct for paths that cut to the same prefix', () => {
    const s = autosaveSlug('/home/u/agentistics/.worktrees/saude-a1', '/home/u')
    expect(s).toMatch(/^agentistics_\.worktrees_saude-a1-[0-9a-f]{8}$/)
    expect(autosaveSlug('/home/u/agentistics/.worktrees/saude-a1', '/home/u')).toBe(s)
    const long = 'x'.repeat(150)
    expect(autosaveSlug(`/home/u/${long}a`, '/home/u')).not.toBe(autosaveSlug(`/home/u/${long}b`, '/home/u'))
    expect(autosaveRef(s).startsWith('refs/agentistics/autosave/')).toBe(true)
    expect(autosaveRef(s).startsWith('refs/heads/')).toBe(false)
    expect(bundleNames('s', '2026-11-26')).toEqual({ current: 's.bundle', temp: '.s.bundle.tmp', daily: 's.2026-11-26.bundle', dailyTemp: '.s.2026-11-26.bundle.tmp' })
  })
})

describe('fingerprint', () => {
  test('read back from the ref: clean save = HEAD itself, dirty save = parent + tree', () => {
    expect(savedFingerprint(null, 'h', 't')).toBeNull()
    expect(savedFingerprint({ commit: 'h', parent: 'p', tree: 't' }, 'h', 't')).toBe('h:t')
    expect(savedFingerprint({ commit: 'c', parent: 'h', tree: 'T2' }, 'h', 't')).toBe('h:T2')
  })
  test('decideTree: unchanged only while the bundle is still there', () => {
    const base = { head: 'h', headTree: 't', tree: 'T2', ahead: 0 }
    expect(decideTree({ ...base, saved: 'h:T2', bundlePresent: true })).toEqual({ save: false, why: 'unchanged' })
    expect(decideTree({ ...base, saved: 'h:T2', bundlePresent: false })).toEqual({ save: true, commitNeeded: true })
    expect(decideTree({ ...base, saved: 'h:T1', bundlePresent: true })).toEqual({ save: true, commitNeeded: true })
    // HEAD moved under the same tree content: a new save.
    expect(decideTree({ ...base, head: 'h2', saved: 'h:T2', bundlePresent: true })).toEqual({ save: true, commitNeeded: true })
    // Dirty only by filtered files, nothing unpushed: nothing to carry.
    expect(decideTree({ ...base, tree: 't', saved: null, bundlePresent: false })).toEqual({ save: false, why: 'nothing-saveable' })
    expect(decideTree({ ...base, tree: 't', ahead: 1, saved: null, bundlePresent: false })).toEqual({ save: true, commitNeeded: false })
  })
})

describe('round gate, retention, bundle dir', () => {
  test('low memory skips the scheduled round, never the critical one', () => {
    expect(shouldRunRound({ memAvailableBytes: AUTOSAVE_MIN_MEM_BYTES - 1, critical: false })).toEqual({ run: false, why: 'low-memory' })
    expect(shouldRunRound({ memAvailableBytes: AUTOSAVE_MIN_MEM_BYTES - 1, critical: true })).toEqual({ run: true })
    expect(shouldRunRound({ memAvailableBytes: null, critical: false })).toEqual({ run: true })
  })
  test('retention keeps the current bundle + the newest N days, drops stale temps of THIS slug only', () => {
    const days = Array.from({ length: 10 }, (_, i) => `s.2026-11-${String(10 + i).padStart(2, '0')}.bundle`)
    const files = ['s.bundle', ...days, '.s.bundle.tmp', '.s.2026-11-01.bundle.tmp', 'other.2026-01-01.bundle', '.other.bundle.tmp', 's-x.2026-01-01.bundle']
    const drop = planRetention(files, 's', 7)
    expect(drop.sort()).toEqual(['.s.2026-11-01.bundle.tmp', '.s.bundle.tmp', 's.2026-11-10.bundle', 's.2026-11-11.bundle', 's.2026-11-12.bundle'].sort())
    expect(planRetention(files, 's', 7, ['.s.bundle.tmp'])).not.toContain('.s.bundle.tmp')
  })
  test('bundle dir: WSL → the Windows profile (off the VM); else the data dir, said to be on the same disk', () => {
    expect(defaultBundleDir({ platform: 'linux', wsl: true, home: '/h', dataDir: '/h/.agentistics', windowsProfile: '/mnt/c/Users/b' }))
      .toEqual({ dir: '/mnt/c/Users/b/agentistics-autosave', offVm: true })
    expect(defaultBundleDir({ platform: 'linux', wsl: true, home: '/h', dataDir: '/h/.agentistics', windowsProfile: null }))
      .toEqual({ dir: '/h/.agentistics/autosave', offVm: false })
    expect(defaultBundleDir({ platform: 'darwin', wsl: false, home: '/h', dataDir: '/h/.agentistics/', windowsProfile: null }).offVm).toBe(false)
    expect(defaultBundleDir({ platform: 'win32', wsl: false, home: 'C:\\U', dataDir: 'x', windowsProfile: null, localAppData: 'C:\\U\\AppData\\Local' }).dir)
      .toBe('C:\\U\\AppData\\Local\\agentistics\\autosave')
    expect(parseWindowsProfile('C:\\Users\\bryan\r\n')).toBe('C:\\Users\\bryan')
    expect(parseWindowsProfile('%USERPROFILE%\r\n')).toBeNull()
    expect(isWslHost('Linux version 5.15.167.4-microsoft-standard-WSL2', {})).toBe(true)
    expect(isWslHost('Linux version 6.1', {})).toBe(false)
  })
})
