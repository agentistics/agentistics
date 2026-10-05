/**
 * H1 (2.103.2 review): a git read that FAILED must never be remembered as "no repository", and a
 * session must never be written over a stored record that had a remote WITHOUT one — a per-connection
 * denylist naming the repository would then classify it as the `none` bucket and push it.
 */
import { describe, expect, test } from 'bun:test'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SessionMeta } from '@agentistics/core'
import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { getGitRemote, isAuthoritativeNoRemote } from './git'
import { keepStoredRemote, loadConsolidated, writeConsolidated } from './consolidate'
import { sessionShared } from './share-rules'

const run = promisify(execFile)

// A git hook (pre-commit) exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE: a `git init` or `git -C dir`
// run under them would act on the repository being committed, not on the temp one. `gitTestEnv()` is the
// repo's one scrub (gitTestEnv.lint.test.ts); `getGitRemote` runs in-process, so scrub process.env too.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k]
const gitSync = (args: string[]) => execFileSync('git', args, { env: gitTestEnv() })

describe('isAuthoritativeNoRemote — only git saying "no such key" is an answer', () => {
  test('exit 1 from `git config --get` on a repo with no origin is authoritative', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h1-norem-'))
    try {
      gitSync(['init', '-q', dir])
      const err = await run('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { env: gitTestEnv() }).catch(e => e)
      expect(isAuthoritativeNoRemote(err)).toBe(true)
      // …and the real function says undefined for it
      expect(await getGitRemote(dir)).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test('a timeout kill, a spawn failure and exit 128 are failures of the read, not answers', async () => {
    const killed = await run('sleep', ['5'], { timeout: 50 }).catch(e => e)
    expect(isAuthoritativeNoRemote(killed)).toBe(false)
    const spawnFail = await run('definitely-not-a-binary-h1', []).catch(e => e)
    expect(isAuthoritativeNoRemote(spawnFail)).toBe(false)
    expect(isAuthoritativeNoRemote(Object.assign(new Error('x'), { code: 128 }))).toBe(false)
    expect(isAuthoritativeNoRemote(Object.assign(new Error('x'), { code: 'EAGAIN' }))).toBe(false)
    expect(isAuthoritativeNoRemote(null)).toBe(false)
  })
})

describe('getGitRemote still answers and memoizes a real remote', () => {
  test('reads origin once the repository has one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'h1-rem-'))
    try {
      gitSync(['init', '-q', dir])
      gitSync(['-C', dir, 'remote', 'add', 'origin', 'git@github.com:acme/secret.git'])
      expect(await getGitRemote(dir)).toBe('github.com/acme/secret')
      expect(await getGitRemote(dir)).toBe('github.com/acme/secret')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

const meta = (over: Partial<SessionMeta>): SessionMeta => ({
  session_id: 'h1-' + Math.random().toString(36).slice(2), project_path: '/work/secret', start_time: '2026-10-05T00:00:00Z',
  harness: 'claude', ...over,
} as SessionMeta)

describe('a session is never written WITHOUT the remote its stored record had', () => {
  test('keepStoredRemote: absence never overwrites, presence always wins', () => {
    const base = meta({})
    expect(keepStoredRemote(base, JSON.stringify({ git_remote: 'github.com/acme/secret' })).git_remote).toBe('github.com/acme/secret')
    expect(keepStoredRemote({ ...base, git_remote: 'github.com/acme/other' }, JSON.stringify({ git_remote: 'github.com/acme/secret' })).git_remote).toBe('github.com/acme/other')
    expect(keepStoredRemote(base, null).git_remote).toBeUndefined()
    expect(keepStoredRemote(base, 'not json').git_remote).toBeUndefined()
  })

  test('denylisted repo: after a transient git failure the stored session still has its remote, so it is NOT shared', async () => {
    const withRemote = meta({ git_remote: 'github.com/acme/secret' })
    await writeConsolidated([withRemote])
    // the next build's git read failed: the same session arrives with no remote
    const { git_remote: _drop, ...failed } = withRemote
    await writeConsolidated([failed as SessionMeta])
    const stored = (await loadConsolidated()).get(withRemote.session_id)!
    expect(stored.git_remote).toBe('github.com/acme/secret')
    const deny = { mode: 'denylist' as const, sources: new Set(['repo:github.com/acme/secret']) }
    expect(sessionShared(stored, deny)).toBe(false)
    // and the failure mode it prevents: without the remote the same rule shares it
    expect(sessionShared(failed as SessionMeta, deny)).toBe(true)
  })
})
