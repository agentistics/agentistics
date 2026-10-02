import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { parseFrozenList, parseNameStatus } from './frozen-paths'
import { capReport, checkPush, checkRemotes, engineOnlyCommits, evaluatePush, issueBody, issueTitle, MAX_REPORT_LINES, parsePushLines, planRange, type GitRun, type PushRef } from './push-guard'

const LIST = parseFrozenList(readFileSync(join(import.meta.dir, '../../../.github/frozen-engine-paths.txt'), 'utf8'))
const Z = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('checkPush', () => {
  test('refuses an add or modify of a frozen path, naming it', () => {
    for (const status of ['A', 'M'] as const) {
      const v = checkPush([{ status, path: 'packages/runtime/src/x.ts' }], LIST, 'fix/x')
      expect(v.ok).toBe(false)
      expect(v.offences[0]!.sentence).toContain('packages/runtime/src/x.ts')
    }
  })
  test('refuses every engine-layout path', () => {
    for (const path of ['engine/src/a.ts', 'runtime/src/a.ts', 'engine/test/a.ts', 'public.pin']) {
      expect(checkPush([{ status: 'A', path }], LIST).ok).toBe(false)
    }
  })
  test('engine.pin and ordinary paths are allowed', () => {
    expect(checkPush([{ status: 'M', path: 'engine.pin' }, { status: 'A', path: 'packages/web/src/a.ts' }, { status: 'A', path: 'packages/engine-api/src/a.ts' }], LIST).ok).toBe(true)
  })
  test('deletions are allowed (ES.4 delete-only), a modify beside them is not', () => {
    expect(checkPush([{ status: 'D', path: 'packages/runtime/src/x.ts' }, { status: 'D', path: 'engine/src/a.ts' }], LIST).ok).toBe(true)
    const v = checkPush([{ status: 'D', path: 'packages/runtime/src/x.ts' }, { status: 'M', path: 'runtime/src/y.ts' }], LIST)
    expect(v.offences.map(o => o.path)).toEqual(['runtime/src/y.ts'])
  })
})

describe('planRange', () => {
  test('an existing branch diffs remote..local', () => {
    expect(planRange({ localRef: 'r', localSha: A, remoteRef: 'r', remoteSha: B })).toEqual({ kind: 'diff', base: B, head: A })
  })
  test('a new branch compares against origin/main', () => {
    expect(planRange({ localRef: 'r', localSha: A, remoteRef: 'r', remoteSha: Z })).toEqual({ kind: 'new-branch', head: A, against: 'origin/main' })
  })
  test('a branch deletion is skipped', () => {
    expect(planRange({ localRef: '(delete)', localSha: Z, remoteRef: 'r', remoteSha: B })).toEqual({ kind: 'skip', why: 'delete' })
  })
})

describe('parsePushLines', () => {
  test('reads git stdin and drops junk', () => {
    expect(parsePushLines(`refs/heads/a ${A} refs/heads/a ${Z}\n\nbad\n`)).toEqual([{ localRef: 'refs/heads/a', localSha: A, remoteRef: 'refs/heads/a', remoteSha: Z }])
  })
})


describe('the wider check', () => {
  test('a remote pointing at the engine repo is refused, others pass', () => {
    expect(checkRemotes([{ name: 'origin', url: 'git@github.com:agentistics/agentistics.git' }])).toEqual([])
    expect(checkRemotes([{ name: 'eng', url: 'https://github.com/agentistics/agentistics-engine.git' }])[0]).toContain('"eng"')
  })
  test('engine-only commits = in engine main, not in public main', () => {
    expect(engineOnlyCommits(['a', 'b', 'c'], new Set(['a', 'b']), new Set(['b']))).toEqual(['a'])
  })
  test('a report is capped at 20 lines', () => {
    const out = capReport(Array.from({ length: 50 }, (_, i) => `l${i}`))
    expect(out).toHaveLength(MAX_REPORT_LINES)
    expect(out.at(-1)).toBe('… and 31 more.')
  })
  test('issue body lists paths+commits and says detection, not prevention', () => {
    const b = issueBody('feat/x', 'a'.repeat(40), [{ path: 'engine/src/a.ts', commit: 'abc1234', ref: 'refs/heads/feat/x' }])
    expect(b).toContain('`engine/src/a.ts` (commit abc1234)')
    expect(b).toContain('detection, not prevention')
    expect(issueTitle('feat/x')).toBe('Engine paths on public branch feat/x')
  })
})

// Fixture repos: real git, a temp public clone and a temp engine clone.
describe('evaluatePush over fixture repos', () => {
  const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...a], { cwd, env: gitTestEnv() })
  const run = (cwd: string): GitRun => a => { const r = sh(cwd, ...a); return { code: r.exitCode, out: r.stdout.toString() } }
  const commit = (d: string, file: string, msg: string) => {
    mkdirSync(join(d, file, '..'), { recursive: true }); writeFileSync(join(d, file), msg); sh(d, 'add', '-A'); sh(d, 'commit', '-qm', msg)
    return sh(d, 'rev-parse', 'HEAD').stdout.toString().trim()
  }
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'pg-')); sh(d, 'init', '-q', '-b', 'main'); const base = commit(d, 'README', 'base')
    sh(d, 'update-ref', 'refs/remotes/origin/main', base); return d
  }
  const ref = (sha: string): PushRef => ({ localRef: 'refs/heads/b', localSha: sha, remoteRef: 'refs/heads/b', remoteSha: Z })

  test('clean range passes quietly; a planted engine path on a new branch is named', () => {
    const d = mk(); sh(d, 'checkout', '-qb', 'b')
    const ok = commit(d, 'src/a.ts', 'fine')
    expect(evaluatePush([ref(ok)], { frozen: LIST, git: run(d) }, parseNameStatus)).toMatchObject({ ok: true, lines: [] })
    const bad = commit(d, 'engine/src/x.ts', 'leak')
    const ev = evaluatePush([ref(bad)], { frozen: LIST, git: run(d) }, parseNameStatus)
    expect(ev.ok).toBe(false)
    expect(ev.lines[0]).toContain('engine/src/x.ts')
    expect(ev.hits[0]!.commit.length).toBeGreaterThanOrEqual(7)
  })
  test('a remote to the engine repo refuses an otherwise clean push', () => {
    const d = mk(); sh(d, 'checkout', '-qb', 'b'); const c = commit(d, 'a', 'x')
    sh(d, 'remote', 'add', 'eng', 'https://github.com/agentistics/agentistics-engine.git')
    expect(evaluatePush([ref(c)], { frozen: LIST, git: run(d), checkRemote: true }, parseNameStatus).ok).toBe(false)
  })
  test('a commit on the engine main but not the public main is refused; an absent engine clone skips', () => {
    const d = mk(); const e = mkdtempSync(join(tmpdir(), 'pg-e-'))
    sh(e, 'init', '-q', '-b', 'main'); sh(e, 'commit', '-q', '--allow-empty', '-m', 'seed')
    sh(d, 'checkout', '-qb', 'b'); const c = commit(d, 'a', 'shared')
    sh(e, 'fetch', '-q', d, 'b'); sh(e, 'update-ref', 'refs/remotes/origin/main', c)
    const withEngine = evaluatePush([ref(c)], { frozen: LIST, git: run(d), engineGit: run(e) }, parseNameStatus)
    expect(withEngine.ok).toBe(false)
    expect(withEngine.lines[0]).toContain('engine')
    expect(evaluatePush([ref(c)], { frozen: LIST, git: run(d) }, parseNameStatus).ok).toBe(true)
  })
})
