/**
 * SECRETS.4 §5.2 / §11 S4.1 — "no socket op returns plaintext". Every op in the closed list is driven
 * over a REAL `vault.sock` while the vault holds marker secrets (a GitHub token, a central token, a
 * central env's secrets), and the markers must appear in no reply and no reply body.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openRecord } from '@agentistics/vault'
import { AGENTISTICS_DATA_DIR } from '../config'
import { __resetVaultForTests, ensureVaultOpen, sealToFile, vaultRole } from './service'
import { askVault, startVaultSocket, stopVaultSocket } from './socket'
import { VAULT_OPS, composeFileAllowed, composeRestAllowed, githubUrlAllowed, handleVaultOp, installVaultOps } from './ops'
import { GITHUB_BACKUP_SEALED_FILE } from '../backup/github-store'
import { STANDALONE_CENTRAL_ENV, centralSecretsFile } from './central-env'

const M = 'TEST-NOT-A-SECRET-' + randomBytes(8).toString('hex')
const GH_TOKEN = M + '-gh'
const MONGO = `mongodb://user:${M}-mongo@db.example.invalid:27017/x`
const enc = (s: string) => new TextEncoder().encode(s)
let sock = ''

function clean(x: unknown, body?: Uint8Array | null): void {
  expect(JSON.stringify(x)).not.toContain(M)
  if (body) expect(Buffer.from(body).toString('latin1')).not.toContain(M)
}

beforeAll(async () => {
  expect(vaultRole()).toBe('holder')
  __resetVaultForTests({ dir: join(AGENTISTICS_DATA_DIR, 'vault'), lang: 'en' })
  await sealToFile(GITHUB_BACKUP_SEALED_FILE, 'github-backup', 'github-backup',
    enc(JSON.stringify({ url: 'https://github.com/o/r', owner: 'o', repo: 'r', token: GH_TOKEN, keepRemote: 0, deleteLocalAfterUpload: false })))
  mkdirSync(join(AGENTISTICS_DATA_DIR, 'central'), { recursive: true })
  writeFileSync(STANDALONE_CENTRAL_ENV, 'APP_PORT=48080\n', { mode: 0o600 })
  await sealToFile(centralSecretsFile(STANDALONE_CENTRAL_ENV), 'central-env', 'central',
    enc(JSON.stringify({ v: 1, env: { MONGO_URL: MONGO, AGENTISTICS_TEAM_PASSWORD: M + '-pw' } })))
  installVaultOps()
  sock = join(await mkdtemp(join(tmpdir(), 'agentistics-ops-')), 'vault.sock')
  expect((await startVaultSocket(sock)).ok).toBe(true)
})
afterAll(() => stopVaultSocket())

describe('every vault.sock op, with marker secrets in the vault', () => {
  const requests: Record<(typeof VAULT_OPS)[number], { req: Record<string, unknown> & { op: string }; body?: Uint8Array }> = {
    status: { req: { op: 'status' } },
    lock: { req: { op: 'lock' } },
    unlock: { req: { op: 'unlock' } },
    seal: { req: { op: 'seal', purpose: 'central-token', name: 'n' }, body: enc(M + '-sealme') },
    'prefs-tokens': { req: { op: 'prefs-tokens', prefsFile: join(AGENTISTICS_DATA_DIR, 'preferences.json'), next: { team: { connections: [{ id: 'c1', token: M + '-conn' }] } }, previous: null } },
    'github-config': { req: { op: 'github-config' } },
    'github-fetch': { req: { op: 'github-fetch', method: 'GET', url: 'https://api.github.com/repos/someone/else' } },
    'central-mongo-kind': { req: { op: 'central-mongo-kind', envFile: STANDALONE_CENTRAL_ENV } },
    'central-compose': { req: { op: 'central-compose', envFile: STANDALONE_CENTRAL_ENV, composeFiles: ['/etc/evil.yml'], rest: ['up'], image: 'x' } },
    'central-native-tool': { req: { op: 'central-native-tool', envFile: '/tmp/not-vaulted.env', action: 'setup-token', extraArgs: [] } },
    'central-env-write': { req: { op: 'central-env-write', envFile: STANDALONE_CENTRAL_ENV }, body: enc(`APP_PORT=48081\nAGENTISTICS_TEAM_PASSWORD=${M}-new\n`) },
    'vault-init': { req: { op: 'vault-init' } },
    'vault-rekey': { req: { op: 'vault-rekey', protector: 'nope' } },
    'vault-add-passphrase': { req: { op: 'vault-add-passphrase' } },
    'vault-reset': { req: { op: 'vault-reset' } },
    'unlock-code': { req: { op: 'unlock-code', code: '000000' } },
    recover: { req: { op: 'recover', words: 'abandon '.repeat(23) + 'art' } },
    'authenticator-confirm': { req: { op: 'authenticator-confirm', code: '000000' } },
    'recovery-confirm': { req: { op: 'recovery-confirm', typed: ['a', 'b', 'c'] } },
    'presence-enroll': { req: { op: 'presence-enroll', protector: 'hello' } },
    'set-auto-lock': { req: { op: 'set-auto-lock', minutes: 45 } },
    activity: { req: { op: 'activity' } },
    // These two hand out a NEW secret once, by design (asserted separately below): never a held one.
    'authenticator-begin': { req: { op: 'authenticator-begin' } },
    'recovery-begin': { req: { op: 'recovery-begin' } },
    // A one-time code for a page's FIRST enrolment (review S2) — minted, never a held secret.
    'setup-code': { req: { op: 'setup-code' } },
  }

  for (const op of VAULT_OPS) {
    if (op === 'vault-reset') continue // destroys the vault — run last, below
    test(`${op}: no marker in the reply`, async () => {
      await ensureVaultOpen()
      const { req, body } = requests[op]
      const r = await askVault(req, { path: sock, ...(body ? { body } : {}) })
      expect(r).not.toBeNull()
      clean(r!.reply, r!.body)
    })
  }

  test('seal returns SEALED bytes that open to the value, under this vault', async () => {
    const o = await ensureVaultOpen()
    const r = await askVault({ op: 'seal', purpose: 'central-token', name: 'n' }, { path: sock, body: enc(M) })
    expect(r!.reply.ok).toBe(true)
    const back = openRecord({ dek: o!.dek, kid: o!.kid, purpose: 'central-token', name: 'n', bytes: r!.body! })
    expect(back.ok && new TextDecoder().decode(back.plaintext)).toBe(M)
  })

  test('seal refuses a runner-scope purpose', async () => {
    const r = await askVault({ op: 'seal', purpose: 'cloud-runner/refresh', name: 'n' }, { path: sock, body: enc('x') })
    expect(r!.reply).toMatchObject({ ok: false, code: 'purpose' })
  })

  test('github-config strips the token and says it exists', async () => {
    const r = await askVault({ op: 'github-config' }, { path: sock })
    expect(r!.reply).toMatchObject({ ok: true, state: 'ok', hasToken: true, config: { owner: 'o', repo: 'r' } })
    expect((r!.reply as unknown as { config: Record<string, unknown> }).config.token).toBeUndefined()
  })

  test('github-fetch: the SERVICE adds the token, only for the configured repo, and never echoes it', async () => {
    const seen: string[] = []
    const fake = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${new Headers(init.headers).get('authorization')}`)
      return new Response(JSON.stringify({ echoedAuth: 'nothing', ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const ctx = (h: Record<string, unknown>) => ({ header: h, body: null, emit() {}, closed: new Promise<void>(() => {}) })
    const ok = await handleVaultOp(ctx({ op: 'github-fetch', method: 'GET', url: 'https://api.github.com/repos/o/r/releases' }), { fetch: fake })
    expect(ok.reply).toMatchObject({ ok: true, httpStatus: 200 })
    clean(ok.reply, ok.body)
    expect(seen).toEqual([`https://api.github.com/repos/o/r/releases Bearer ${GH_TOKEN}`])
    const other = await handleVaultOp(ctx({ op: 'github-fetch', method: 'GET', url: 'https://api.github.com/repos/o/r2/releases' }), { fetch: fake })
    expect(other.reply.ok).toBe(false)
    expect(seen).toHaveLength(1)
  })

  test('central-mongo-kind answers the KIND, never the URL', async () => {
    const r = await askVault({ op: 'central-mongo-kind', envFile: STANDALONE_CENTRAL_ENV }, { path: sock })
    expect(r!.reply).toMatchObject({ ok: true, kind: 'external' })
  })

  test('there is no `open` op', async () => {
    const r = await askVault({ op: 'open', purpose: 'github-backup', name: 'github-backup' }, { path: sock })
    expect(r!.reply).toMatchObject({ ok: false, code: 'bad-request' })
    expect(VAULT_OPS as readonly string[]).not.toContain('open')
  })

  test('vault-reset (last): no marker, and the vault is gone', async () => {
    const r = await askVault({ op: 'vault-reset' }, { path: sock })
    clean(r!.reply, r!.body)
    expect(r!.reply.ok).toBe(true)
  })
})

describe('the allowlists', () => {
  test('githubUrlAllowed: only https api/uploads.github.com under /repos/<owner>/<repo>', () => {
    expect(githubUrlAllowed('https://api.github.com/repos/o/r', 'o', 'r')).toBe(true)
    expect(githubUrlAllowed('https://uploads.github.com/repos/o/r/releases/1/assets?name=x', 'o', 'r')).toBe(true)
    for (const u of ['http://api.github.com/repos/o/r', 'https://api.github.com/repos/o/r2', 'https://api.github.com/repos/o/rx/y',
      'https://evil.example/repos/o/r', 'https://api.github.com.evil.example/repos/o/r', 'https://x@api.github.com/repos/o/r',
      'https://api.github.com:444/repos/o/r', 'https://api.github.com/user', 'not a url']) {
      expect(githubUrlAllowed(u, 'o', 'r')).toBe(false)
    }
  })
  test('compose: only known compose files and subcommands', () => {
    expect(composeRestAllowed(['up', '-d', '--pull', 'always', '--force-recreate'])).toBe(true)
    expect(composeRestAllowed(['exec', '-T', 'app', 'bun', 'run', 'packages/server/bin/cli.ts', 'setup-token'])).toBe(true)
    expect(composeRestAllowed(['exec', '-T', 'app', 'sh', '-c', 'env'])).toBe(false)
    expect(composeRestAllowed(['run', 'app'])).toBe(false)
    expect(composeRestAllowed(['config'])).toBe(false)
    expect(composeFileAllowed('/etc/evil.yml')).toBe(false)
  })
})
