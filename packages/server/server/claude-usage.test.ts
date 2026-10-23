import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeAccessToken, CLAUDE_USAGE_URL, fetchClaudeUsage, startClaudeUsagePoll } from './claude-usage'

const NOW = Date.parse('2026-10-16T05:00:00Z')
const FAKE = 'fake-token-for-tests-only'
const cred = (o: Record<string, unknown> = {}) => JSON.stringify({ claudeAiOauth: { accessToken: FAKE, expiresAt: NOW + 3_600_000, scopes: ['user:inference', 'user:profile'], ...o } })
const usageBody = readFileSync(join(import.meta.dir, '..', '..', 'core', 'src', '__fixtures__', 'plan-limits-claude-usage.json'), 'utf8')

describe('claudeAccessToken', () => {
  test('a valid login yields its token', () => expect(claudeAccessToken(cred(), NOW)).toEqual({ token: FAKE }))
  test('no file / junk / no token → no-credential', () => {
    expect(claudeAccessToken(null, NOW)).toEqual({ skip: 'no-credential' })
    expect(claudeAccessToken('{', NOW)).toEqual({ skip: 'no-credential' })
    expect(claudeAccessToken(JSON.stringify({ mcpOAuth: {} }), NOW)).toEqual({ skip: 'no-credential' })
  })
  test('an expired (or about-to-expire) token is skipped, never refreshed', () => {
    expect(claudeAccessToken(cred({ expiresAt: NOW - 1 }), NOW)).toEqual({ skip: 'expired' })
    expect(claudeAccessToken(cred({ expiresAt: NOW + 30_000 }), NOW)).toEqual({ skip: 'expired' })
  })
  test('a login without the profile scope is skipped', () =>
    expect(claudeAccessToken(cred({ scopes: ['user:inference'] }), NOW)).toEqual({ skip: 'no-scope' }))
})

describe('fetchClaudeUsage', () => {
  const run = (res: () => Response | Promise<Response>, credential: string | null = cred()) => {
    const calls: { url: string; init: RequestInit }[] = []
    const p = fetchClaudeUsage({
      now: () => NOW,
      readCredential: async () => credential,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return res() },
    })
    return { p, calls }
  }
  test('a 200 becomes a claude record; the token goes only in the header', async () => {
    const { p, calls } = run(() => new Response(usageBody, { status: 200 }))
    const r = await p
    expect('limits' in r && r.limits.windows.map(w => w.usedPct)).toEqual([41, 6])
    expect(calls[0]!.url).toBe(CLAUDE_USAGE_URL)
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE}`)
    expect(JSON.stringify(r)).not.toContain(FAKE)
  })
  test('no credential → no request at all', async () => {
    const { p, calls } = run(() => new Response(usageBody), null)
    expect(await p).toEqual({ skip: 'no-credential' })
    expect(calls).toHaveLength(0)
  })
  test('429, 401, junk and network failure are codes, never a zero record or the token', async () => {
    expect(await run(() => new Response('', { status: 429 })).p).toEqual({ skip: 'rate-limited' })
    expect(await run(() => new Response('{}', { status: 401 })).p).toEqual({ skip: 'http' })
    expect(await run(() => new Response('<html>', { status: 200 })).p).toEqual({ skip: 'unparseable' })
    expect(await run(() => new Response('{}', { status: 200 })).p).toEqual({ skip: 'unparseable' })
    const failed = await run(() => { throw new Error(`boom ${FAKE}`) }).p
    expect(failed).toEqual({ skip: 'network' })
  })
})

describe('startClaudeUsagePoll — every Claude login, each attributed by its own root', () => {
  test('reads the default login AND each extra account root, ingesting each under its root', async () => {
    const OTHER = 'fake-token-of-the-second-login'
    const auths: string[] = []
    const ingested: Array<string | null> = []
    let done!: () => void
    const finished = new Promise<void>(r => { done = r })
    const stop = startClaudeUsagePoll({
      now: () => NOW,
      readCredential: async () => cred(),
      accountRoots: async () => ['/accounts/claude/r_second'],
      readCredentialAt: async root => (root === '/accounts/claude/r_second' ? cred({ accessToken: OTHER }) : null),
      fetchImpl: async (_url, init) => {
        auths.push((init.headers as Record<string, string>).Authorization!)
        return new Response(usageBody, { status: 200 })
      },
      ingest: async (_l, root) => { ingested.push(root); if (ingested.length === 2) done() },
    })
    await finished
    stop()
    // Before: only the default login was ever asked, so a second account read "waiting for a reading".
    expect(auths).toEqual([`Bearer ${FAKE}`, `Bearer ${OTHER}`])
    expect(ingested).toEqual([null, '/accounts/claude/r_second'])
  })
  test('a root with no credential costs no request and ingests nothing', async () => {
    const ingested: Array<string | null> = []
    let calls = 0
    let done!: () => void
    const finished = new Promise<void>(r => { done = r })
    const stop = startClaudeUsagePoll({
      now: () => NOW,
      readCredential: async () => cred(),
      accountRoots: async () => ['/accounts/claude/r_signed_out'],
      readCredentialAt: async () => { setTimeout(done, 0); return null },
      fetchImpl: async () => { calls++; return new Response(usageBody, { status: 200 }) },
      ingest: async (_l, root) => { ingested.push(root) },
    })
    await finished
    stop()
    expect(calls).toBe(1)
    expect(ingested).toEqual([null])
  })
})
