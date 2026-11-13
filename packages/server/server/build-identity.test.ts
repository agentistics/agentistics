import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSlotBuild, readBuildIdentity, type GitRun } from './build-identity.ts'
import { gitRunnerIn, resolveBuild, versionPayload } from './build-info.ts'
import { renderSlot } from '../scripts/engine-slot.ts'
import { parseVersionCache } from './version.ts'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'

const NOW = new Date('2026-11-13T12:00:00.000Z')
const SHA = 'c'.repeat(40), TREE = 'd'.repeat(40)
const fakeGit: GitRun = a => {
  if (a[0] === 'rev-parse' && a[1] === 'HEAD') return `${SHA}\n`
  if (a[0] === 'rev-parse' && a[1] === 'HEAD^{tree}') return `${TREE}\n`
  if (a[0] === 'config') return 'git@github.com:Org/Repo.git\n'
  return null
}

describe('build identity', () => {
  test('reads normalized repoKey, sha, tree and builtAt from git', () => {
    expect(readBuildIdentity(fakeGit, NOW)).toEqual({ repoKey: 'github.com/Org/Repo', sha: SHA, tree: TREE, builtAt: NOW.toISOString(), capabilities: [] })
  })
  test('without git every git field is null (and the tree is never asked without a sha)', () => {
    const asked: string[][] = []
    const b = readBuildIdentity(a => { asked.push(a); return null }, NOW)
    expect(b).toEqual({ repoKey: null, sha: null, tree: null, builtAt: NOW.toISOString(), capabilities: [] })
    expect(asked.some(a => a[1] === 'HEAD^{tree}')).toBe(false)
  })
  test('a checkout with no origin has a sha and a null repoKey', () => {
    const b = readBuildIdentity(a => (a[0] === 'config' ? null : fakeGit(a)), NOW)
    expect(b.repoKey).toBeNull(); expect(b.sha).toBe(SHA)
  })
  test('a local-path remote normalizes to no key, not to an empty string', () => {
    expect(readBuildIdentity(a => (a[0] === 'config' ? '/srv/git/x.git\n' : fakeGit(a)), NOW).repoKey).toBeNull()
  })
  test('a real git runner outside a repository answers nulls', () => {
    const d = mkdtempSync(join(tmpdir(), 'nogit-'))
    try { expect(readBuildIdentity(gitRunnerIn(d, gitTestEnv()), NOW)).toMatchObject({ repoKey: null, sha: null, tree: null }) } finally { rmSync(d, { recursive: true, force: true }) }
  })
  test('a real git runner reads a real repository', () => {
    const d = mkdtempSync(join(tmpdir(), 'git-'))
    try {
      const g = (...a: string[]) => Bun.spawnSync(['git', '-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdout: 'ignore', stderr: 'ignore', env: gitTestEnv() })
      g('init', '-q'); g('remote', 'add', 'origin', 'https://github.com/o/r.git'); writeFileSync(join(d, 'f'), 'x'); g('add', 'f'); g('commit', '-qm', 'c')
      const b = readBuildIdentity(gitRunnerIn(d, gitTestEnv()), NOW)
      expect(b.repoKey).toBe('github.com/o/r'); expect(b.sha).toMatch(/^[0-9a-f]{40}$/); expect(b.tree).toMatch(/^[0-9a-f]{40}$/)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('slot generation', () => {
  const src = { kind: 'null' } as const
  test('with a build, the slot exports it as data (and still exports the engine)', () => {
    const text = renderSlot(src, '/x/server', readBuildIdentity(fakeGit, NOW))
    expect(text).toContain('export const build = ')
    expect(text).toContain(SHA)
    expect(text).toContain('export const createEngine')
  })
  test('without a build (stub / community stub) the slot has none', () => {
    expect(renderSlot(src, '/x/server')).not.toContain('export const build')
  })
  test('without git the baked build is all-null but present', () => {
    const text = renderSlot(src, '/x/server', readBuildIdentity(() => null, NOW))
    expect(text).toContain('"repoKey":null'); expect(text).toContain('"sha":null')
  })
})

describe('resolveBuild (what /api/version answers)', () => {
  const baked = { repoKey: 'k', sha: 's', tree: 't', builtAt: 'b', capabilities: ['x'] }
  test('a baked build wins over a live read', () => {
    expect(resolveBuild(baked, { checkout: true, run: fakeGit, now: NOW })).toEqual(baked)
  })
  test('dev (no baked build, in a checkout) reads git live', () => {
    expect(resolveBuild(undefined, { checkout: true, run: fakeGit, now: NOW }).sha).toBe(SHA)
  })
  test('no baked build and no checkout: nulls, never a guess', () => {
    expect(resolveBuild(undefined, { checkout: false, run: fakeGit, now: NOW })).toMatchObject({ repoKey: null, sha: null, tree: null })
  })
  test('a malformed baked value is refused whole', () => {
    expect(parseSlotBuild({ ...baked, capabilities: 'x' })).toBeNull()
    expect(parseSlotBuild({ ...baked, sha: 5 })).toBeNull()
    expect(parseSlotBuild(null)).toBeNull()
  })
})

describe('/api/version payload is additive', () => {
  const info = { current: '2.211.0', latest: '2.212.0', hasUpdate: true, critical: false, fetchedAt: 1, releases: [{ tag: 'v2.212.0', published_at: 'x' }] }
  test('every old field is byte-identical; only `build` is new', () => {
    const build = readBuildIdentity(fakeGit, NOW)
    const out = versionPayload(info, 'x', build)
    const { build: b, upgradable, ...rest } = out
    expect(rest).toEqual(info); expect(upgradable).toBe('x'); expect(b).toEqual(build)
  })
  test('the old shape still parses: the cache parser ignores the new key', () => {
    const body = JSON.stringify(versionPayload(info, null, readBuildIdentity(fakeGit, NOW)))
    expect(parseVersionCache(body)?.latest).toBe('2.212.0')
  })
})
