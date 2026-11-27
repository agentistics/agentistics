// The machine client against a fake Cloud held to the contract: every form it sends and every answer
// the fake gives validates against `packages/contract/openapi/machine-v1.yaml`, and every DPoP proof
// is verified the way the contract describes. No network. (v1.0.0's JSON fixtures are all metrics
// ingest, which this client does not do yet; `@agentistics/contract`'s own test covers them.)
import { beforeAll, describe, expect, test } from 'bun:test'
import { createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DPOP, PATHS } from '@agentistics/contract'
import { validate, type Schema } from '../../../contract/src/json-schema'
import { AGENTISTICS_DATA_DIR } from '../config'
import { __resetVaultForTests } from '../vault/service'
import { runCloud } from '../cli-cloud'
import { cloudCliIo } from '../vault/client'
import { MachineClient, PairingRequiredError, pollUntilFinal } from './client'
import { accessTokenHash } from './dpop'
import { CREDENTIAL_FILE, IDENTITY_FILE, loadCredential, loadOrCreateIdentity } from './identity'
import { handleCloudOp, type CloudDeps } from './ops'
import { cloudSealedStore } from '../vault/ops'
import { NO_CLOUD_URL, normalizeCloudUrl, resolveCloudUrl } from './url'

const spec = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../../contract/openapi/machine-v1.yaml'), 'utf8')) as any
const conforms = (name: string, value: unknown) => expect(validate(spec, spec.components.schemas[name] as Schema, value, name)).toEqual([])

const CLOUD = 'https://cloud.example.test'
const FLOWS = { metrics: true, sessionTitles: false, sessionSync: true, remoteAccess: false, backup: true }

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, any>

class FakeCloud {
  now = Date.parse('2026-10-02T12:00:00Z')
  readonly deviceCode = randomBytes(32).toString('base64url')
  readonly refreshToken = randomBytes(32).toString('base64url')
  readonly machineId = randomUUID()
  readonly workspaceId = randomUUID()
  readonly issued: string[] = []
  readonly seen: { path: string; method: string; form?: Record<string, string> }[] = []
  /** What the next polls answer before the approval goes through. */
  polls: string[] = ['authorization_pending', 'slow_down']
  revoked = false
  rejectNextToken = false
  down = false
  private jkt: string | null = null
  private readonly jtis = new Set<string>()

  readonly clock = () => this.now
  readonly fetch = async (req: Request): Promise<Response> => {
    if (this.down) throw new TypeError(`connect failed: ${req.headers.get('authorization') ?? ''}`)
    expect(req.redirect).toBe('error')
    const url = new URL(req.url)
    const path = url.pathname
    const form = path.startsWith('/oauth/') ? Object.fromEntries(new URLSearchParams(await req.text())) : undefined
    this.seen.push({ path, method: req.method, ...(form ? { form } : {}) })
    const bearer = req.headers.get('authorization')
    this.checkProof(req, url, form ? undefined : bearer?.replace(/^DPoP /, ''))

    if (path === PATHS.deviceAuthorization) {
      expect(bearer).toBeNull()
      conforms('DeviceAuthorizationForm', form)
      return this.json(200, 'DeviceAuthorization', {
        device_code: this.deviceCode, user_code: 'BCDF-GHJK', verification_uri: `${CLOUD}/pair`,
        verification_uri_complete: `${CLOUD}/pair?code=BCDF-GHJK`, expires_in: 600, interval: 5,
      })
    }
    if (path === PATHS.token) {
      expect(bearer).toBeNull()
      if (form!.grant_type === 'refresh_token') {
        conforms('RefreshTokenForm', form)
        expect(form!.refresh_token).toBe(this.refreshToken)
        if (this.revoked) return this.json(400, 'OAuthError', { error: 'invalid_grant' })
        return this.json(200, 'RefreshedToken', this.token())
      }
      conforms('DeviceCodeTokenForm', form)
      expect(form!.device_code).toBe(this.deviceCode)
      const error = this.polls.shift()
      if (error) return this.json(400, 'OAuthError', { error })
      return this.json(200, 'PairedToken', { ...this.token(), refresh_token: this.refreshToken })
    }
    if (this.revoked || this.rejectNextToken || bearer !== `DPoP ${this.issued.at(-1)}`) {
      this.rejectNextToken = false
      return this.json(401, 'MachineAuthError', { error: 'invalid_token' })
    }
    if (path === PATHS.disconnect && req.method === 'POST') return new Response(null, { status: 204 })
    if (path === PATHS.machine && req.method === 'GET') {
      const iso = new Date(this.now).toISOString()
      const fp = '0123 4567 89ab cdef 0123 4567 89ab cdef'
      return this.json(200, 'MachineSelf', {
        id: this.machineId, name: 'test-box', kind: 'device', ownerUserId: randomUUID(), signingFingerprint: fp,
        envelopeFingerprint: fp, flows: FLOWS, pairedAt: iso, lastRefreshAt: iso, revokedAt: null, workspaceId: this.workspaceId,
      })
    }
    return new Response('', { status: 404 })
  }

  private token() {
    this.issued.push(randomBytes(32).toString('base64url'))
    return { access_token: this.issued.at(-1)!, token_type: 'DPoP', expires_in: 900, machine_id: this.machineId, workspace_id: this.workspaceId, flows: FLOWS }
  }

  private json(status: number, schema: string, body: unknown): Response {
    conforms(schema, body)
    return Response.json(body, { status })
  }

  /** RFC 9449 as the contract states it: shape, signature, target, age, replay, `ath`, one key. */
  private checkProof(req: Request, url: URL, accessToken: string | undefined): void {
    const proof = req.headers.get('dpop')!
    expect(proof.length).toBeLessThanOrEqual(DPOP.maxProofBytes)
    const [h, p, s] = proof.split('.') as [string, string, string]
    const header = decode(h)
    const payload = decode(p)
    expect(header).toEqual({ typ: DPOP.typ, alg: DPOP.alg, jwk: { kty: 'OKP', crv: DPOP.crv, x: header.jwk.x } })
    const key = createPublicKey({ key: header.jwk, format: 'jwk' })
    expect(verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))).toBe(true)
    expect(payload.htm).toBe(req.method)
    expect(payload.htu).toBe(`${url.origin}${url.pathname}`)
    expect(Math.abs(payload.iat * 1000 - this.now)).toBeLessThanOrEqual(DPOP.proofSkewS * 1000)
    expect(payload.jti).toMatch(new RegExp(DPOP.jtiPattern))
    expect(this.jtis.has(payload.jti)).toBe(false)
    this.jtis.add(payload.jti)
    expect(payload.ath).toBe(accessToken === undefined ? undefined : accessTokenHash(accessToken))
    this.jkt ??= header.jwk.x
    expect(header.jwk.x).toBe(this.jkt)
  }
}

const tmp = () => mkdtemp(join(tmpdir(), 'agentistics-cloud-'))
const client = (cloud: FakeCloud, dir: string, cloudUrl = CLOUD) => new MachineClient({ cloudUrl, store: cloudSealedStore(dir), fetch: cloud.fetch, now: cloud.clock })
const noSleep = async () => {}

async function paired(cloud = new FakeCloud(), dir?: string) {
  const d = dir ?? await tmp()
  cloud.polls = []
  const c = client(cloud, d)
  const start = await c.startPairing({ name: 'test-box' })
  expect((await c.poll(start.deviceCode)).status).toBe('paired')
  return { cloud, dir: d, c }
}

function allBytes(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? allBytes(p) : e.isFile() ? readFileSync(p, 'latin1') : ''
  }).join('\n')
}

beforeAll(() => __resetVaultForTests({ dir: join(AGENTISTICS_DATA_DIR, 'vault'), lang: 'en' }))

describe('pairing', () => {
  test('golden exchange: start, pending, slow_down (+5 s), paired', async () => {
    const cloud = new FakeCloud()
    const dir = await tmp()
    const c = client(cloud, dir)
    const start = await c.startPairing({ name: 'test-box' })
    expect(start.userCode).toBe('BCDF-GHJK')
    const waits: number[] = []
    const result = await pollUntilFinal(start, () => c.poll(start.deviceCode), async (ms) => { waits.push(ms) })
    expect(result).toEqual({ status: 'paired', machineId: cloud.machineId, workspaceId: cloud.workspaceId, flows: FLOWS })
    expect(waits).toEqual([5000, 5000, 10000])
    expect((await loadCredential(cloudSealedStore(dir)))).toMatchObject({ cloudUrl: CLOUD, machineId: cloud.machineId, refreshToken: cloud.refreshToken })
  })

  test('a refusal and an expiry are final and store nothing', async () => {
    for (const [error, status] of [['access_denied', 'denied'], ['expired_token', 'expired']] as const) {
      const cloud = new FakeCloud()
      cloud.polls = [error]
      const dir = await tmp()
      const c = client(cloud, dir)
      const start = await c.startPairing({ name: 'x' })
      expect((await pollUntilFinal(start, () => c.poll(start.deviceCode), noSleep)).status).toBe(status)
      expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(false)
    }
  })

  test('polling stops when the code expires even if the Cloud keeps saying pending', async () => {
    let polls = 0
    const r = await pollUntilFinal({ interval: 5, expiresIn: 20 }, async () => { polls++; return { status: 'pending' } }, noSleep)
    expect([r.status, polls]).toEqual(['expired', 4])
  })

  test('the identity is created once and reused, even when asked twice at once', async () => {
    const dir = await tmp()
    const [a, b] = await Promise.all([loadOrCreateIdentity(cloudSealedStore(dir)), loadOrCreateIdentity(cloudSealedStore(dir))])
    expect(a.signingPublic).toBe(b.signingPublic)
    expect((await loadOrCreateIdentity(cloudSealedStore(dir))).signingPublic).toBe(a.signingPublic)
  })
})

describe('tokens', () => {
  test('the access token is reused, then refreshed before it expires', async () => {
    const { cloud, c } = await paired()
    const first = await c.accessToken()
    cloud.now += (900 - 61) * 1000
    expect(await c.accessToken()).toBe(first)
    cloud.now += 2_000
    expect(await c.accessToken()).not.toBe(first)
    expect(cloud.seen.filter((r) => r.form?.grant_type === 'refresh_token')).toHaveLength(1)
  })

  test('API requests carry the bound token and an ath proof; a new process refreshes first', async () => {
    const { cloud, dir } = await paired()
    const m = await client(cloud, dir).getMachine()
    expect(m.id).toBe(cloud.machineId)
    expect(cloud.seen.slice(-2).map((r) => r.path)).toEqual([PATHS.token, PATHS.machine])
  })

  test('invalid_token refreshes once and retries', async () => {
    const { cloud, c } = await paired()
    cloud.rejectNextToken = true
    expect((await c.getMachine()).id).toBe(cloud.machineId)
    expect(cloud.seen.slice(-3).map((r) => r.path)).toEqual([PATHS.machine, PATHS.token, PATHS.machine])
  })

  test('invalid_grant means pair again', async () => {
    const { cloud, dir } = await paired()
    cloud.revoked = true
    await expect(client(cloud, dir).getMachine()).rejects.toBeInstanceOf(PairingRequiredError)
  })

  test('the refresh token only ever goes to the Cloud that issued it', async () => {
    const { cloud, dir } = await paired()
    const urls: string[] = []
    const c = new MachineClient({ cloudUrl: 'https://elsewhere.example.test', store: cloudSealedStore(dir), now: cloud.clock, fetch: (req) => { urls.push(new URL(req.url).origin); return cloud.fetch(req) } })
    await c.getMachine()
    expect(new Set(urls)).toEqual(new Set([CLOUD]))
  })
})

describe('sealed at rest', () => {
  test('no private key, token or device code in any file written', async () => {
    const { cloud, dir, c } = await paired()
    const identity = await loadOrCreateIdentity(cloudSealedStore(dir))
    const secrets = [
      cloud.refreshToken, cloud.deviceCode, ...cloud.issued, await c.accessToken(), identity.envelope.privateKey,
      (identity.signingKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64'),
      (identity.signingKey.export({ format: 'jwk' }) as { d: string }).d,
    ]
    const written = allBytes(dir) + allBytes(AGENTISTICS_DATA_DIR)
    for (const s of secrets) expect(written).not.toContain(s)
    expect(readdirSync(dir).sort()).toEqual([CREDENTIAL_FILE, IDENTITY_FILE])
    for (const f of [CREDENTIAL_FILE, IDENTITY_FILE]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600)
  })

  test('a damaged file is refused and kept — never replaced, never read as "not paired"', async () => {
    const dir = await tmp()
    for (const f of [IDENTITY_FILE, CREDENTIAL_FILE]) writeFileSync(join(dir, f), 'junk', { mode: 0o600 })
    await expect(loadOrCreateIdentity(cloudSealedStore(dir))).rejects.toThrow()
    await expect(loadCredential(cloudSealedStore(dir))).rejects.toThrow()
    expect(readFileSync(join(dir, IDENTITY_FILE), 'utf8')).toBe('junk')
  })
})

describe('disconnect', () => {
  test('revokes at the Cloud and removes the credential, keeping the identity', async () => {
    const { cloud, dir, c } = await paired()
    expect(await c.disconnect()).toBe('disconnected')
    expect(cloud.seen.at(-1)).toMatchObject({ path: PATHS.disconnect, method: 'POST' })
    expect(readdirSync(dir)).toEqual([IDENTITY_FILE])
    await expect(c.accessToken()).rejects.toBeInstanceOf(PairingRequiredError)
  })

  test('an already revoked machine only loses the local copy', async () => {
    const { cloud, dir } = await paired()
    cloud.revoked = true
    expect(await client(cloud, dir).disconnect()).toBe('already-revoked')
    expect(readdirSync(dir)).toEqual([IDENTITY_FILE])
  })

  test('an unreachable Cloud keeps the credential', async () => {
    const { cloud, dir, c } = await paired()
    cloud.down = true
    await expect(c.disconnect()).rejects.toThrow()
    expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(true)
  })
})

describe('the Cloud URL', () => {
  test('https, or http on this computer only; no credentials, query or fragment', () => {
    expect(normalizeCloudUrl('https://cloud.example.test/')).toBe(CLOUD)
    expect(normalizeCloudUrl('https://example.test/cloud/')).toBe('https://example.test/cloud')
    expect(normalizeCloudUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    for (const bad of ['http://cloud.example.test', 'https://u:p@example.test', 'https://example.test/?a=1', 'https://example.test/#x', 'ftp://example.test', 'nope', '']) {
      expect(normalizeCloudUrl(bad)).toBeNull()
    }
  })

  test('the variable wins over the preference, and there is no default', () => {
    expect(resolveCloudUrl({ AGENTISTICS_CLOUD_URL: CLOUD }, { cloud: { url: 'https://other.test' } })).toEqual({ ok: true, url: CLOUD })
    expect(resolveCloudUrl({}, { cloud: { url: CLOUD } })).toEqual({ ok: true, url: CLOUD })
    expect(resolveCloudUrl({}, {})).toEqual({ ok: false, sentence: NO_CLOUD_URL })
  })
})

describe('agentop cloud (CLI over the service ops)', () => {
  function harness(cloud: FakeCloud, dir: string, url: string | null = CLOUD) {
    const lines: string[] = []
    const replies: unknown[] = []
    const deps: CloudDeps = { store: cloudSealedStore(dir), fetch: cloud.fetch, now: cloud.clock }
    const run = (...args: string[]) => runCloud(args, {
      env: url ? { AGENTISTICS_CLOUD_URL: url } : {},
      prefs: async () => ({}),
      ask: async ({ op, ...header }) => { const r = await handleCloudOp(op as never, header, deps); replies.push(r); return r },
      serviceDown: 'unused',
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
      sleep: noSleep,
    })
    return { run, lines, replies, text: () => lines.splice(0).join('\n') }
  }

  test('with no URL every command says so in one sentence and exits non-zero, asking nothing', async () => {
    const h = harness(new FakeCloud(), await tmp(), null)
    for (const args of [['login'], ['status'], ['logout'], ['logout', '--local']]) {
      expect(await h.run(...args)).toBe(1)
      expect(h.lines.splice(0)).toEqual([NO_CLOUD_URL])
    }
    expect(h.replies).toEqual([])
  })

  test('login, status, a second login refused, logout — and no reply carries a secret', async () => {
    const cloud = new FakeCloud()
    const dir = await tmp()
    const h = harness(cloud, dir)
    expect(await h.run('status')).toBe(1)
    expect(h.text()).toContain('Not connected')
    expect(await h.run('login', '--name', 'test\u001b[31m-box')).toBe(0)
    expect(h.text()).toContain('BCDF-GHJK')
    expect(cloud.seen.find((r) => r.path === PATHS.deviceAuthorization)!.form!.name).toBe('test[31m-box')
    expect(await h.run('status')).toBe(0)
    const said1 = h.text()
    expect(said1).toContain(cloud.machineId)
    expect(said1).toContain('backup on')
    expect(await h.run('login')).toBe(1)
    expect(h.text()).toContain('already connected')
    expect(await h.run('logout')).toBe(0)
    expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(false)
    const said = JSON.stringify(h.replies)
    for (const s of [cloud.refreshToken, cloud.deviceCode, ...cloud.issued]) expect(said).not.toContain(s)
  })

  test('a revoked machine may pair again; an unreachable Cloud keeps the credential unless --local', async () => {
    const { cloud, dir } = await paired()
    const h = harness(cloud, dir)
    cloud.revoked = true
    expect(await h.run('status')).toBe(1)
    expect(h.text()).toContain('pair again')
    cloud.revoked = false
    cloud.down = true
    expect(await h.run('logout')).toBe(1)
    const out = h.text()
    expect(out).toContain('could not be reached')
    expect(out).toContain('--local')
    expect(out).not.toContain('connect failed')
    expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(true)
    expect(await h.run('logout', '--local')).toBe(0)
    expect(existsSync(join(dir, CREDENTIAL_FILE))).toBe(false)
  })

  test('no service running is said in words, and bad arguments exit 2', async () => {
    const lines: string[] = []
    const deps = { env: { AGENTISTICS_CLOUD_URL: CLOUD }, prefs: async () => ({}), ask: async () => null, serviceDown: cloudCliIo().serviceDown, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
    expect(await runCloud(['status'], deps)).toBe(1)
    expect(lines.join()).toContain('agentop server')
    expect(await runCloud(['nope'], deps)).toBe(2)
  })
})
