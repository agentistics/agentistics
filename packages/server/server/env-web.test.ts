/**
 * DOCKER.AMBIENTES S1 — the decision table through a REAL `docker` lookup: a fake `docker` executable is the only
 * thing on PATH, `detectDocker()` runs unmodified against it (argv and exit codes, not a stubbed function), and
 * `envStatus` feeds the result to `decideEnvBackend`. Every row of SPEC §2.1 is one test below.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnvBackend, EnvBackendPrefs } from '@agentistics/core'
import { detectDocker } from './flows/host-ops'
import { envGrant, envInstall, envStatus, envUse, handleEnvRequest, platformOf, type EnvDeps } from './env-web'

const root = mkdtempSync(join(tmpdir(), 'env-web-test-'))
const withDocker = join(root, 'with-docker')
const emptyBin = join(root, 'empty')
const SAVED = { PATH: process.env.PATH, RUN: process.env.FAKE_RUNNING, API: process.env.FAKE_API, OS: process.env.FAKE_OS }

beforeAll(() => {
  mkdirSync(withDocker); mkdirSync(emptyBin)
  // A shell script that answers `docker version --format …` / `docker info --format …` from FAKE_* variables.
  const script = [
    '#!/bin/sh',
    'case "$*" in',
    '  *Client.Version*) echo 29.3.0 ;;',
    '  *Server.APIVersion*) [ "$FAKE_RUNNING" = 1 ] && echo "$FAKE_API" || exit 1 ;;',
    '  *Server.Version*) [ "$FAKE_RUNNING" = 1 ] && echo 29.3.0 || exit 1 ;;',
    '  *OperatingSystem*) echo "${FAKE_OS:-Ubuntu 24.04}" ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n')
  writeFileSync(join(withDocker, 'docker'), script)
  chmodSync(join(withDocker, 'docker'), 0o755)
})
afterAll(() => {
  process.env.PATH = SAVED.PATH
  for (const [k, v] of [['FAKE_RUNNING', SAVED.RUN], ['FAKE_API', SAVED.API], ['FAKE_OS', SAVED.OS]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(root, { recursive: true, force: true })
})

type Fake = { installed?: boolean; running?: boolean; api?: string; os?: string }
function fake(f: Fake): void {
  process.env.PATH = f.installed === false ? emptyBin : `${withDocker}:/usr/bin:/bin`
  process.env.FAKE_RUNNING = f.running ? '1' : '0'
  process.env.FAKE_API = f.api ?? '1.54'
  process.env.FAKE_OS = f.os ?? 'Ubuntu 24.04'
}

interface World { flag?: boolean; prefs?: EnvBackendPrefs; offeredFor?: string; role?: 'leader' | 'worker'; verified?: boolean; proc?: { platform: string; isWsl: boolean } }
function deps(w: World = {}): EnvDeps & { stored: { envBackend?: EnvBackendPrefs; envBackendOfferedFor?: string; envBackendChosenAt?: string } } {
  const stored: { envBackend?: EnvBackendPrefs; envBackendOfferedFor?: string; envBackendChosenAt?: string } = { ...(w.prefs ? { envBackend: w.prefs } : {}), ...(w.offeredFor ? { envBackendOfferedFor: w.offeredFor } : {}) }
  let last: Awaited<ReturnType<typeof detectDocker>> = { present: false, running: false, version: null, kind: 'none', apiVersion: null }
  const proc = w.proc ?? { platform: 'linux', isWsl: false }
  return {
    stored,
    flag: () => w.flag ?? true,
    detect: async () => (last = await detectDocker()),
    platform: () => platformOf(proc, last),
    readPrefs: async () => ({ ...stored }),
    writePrefs: async mutate => { const patch = mutate({ envBackend: stored.envBackend }); if (patch) Object.assign(stored, patch) },
    verify: async (id, token) => (w.verified === false || typeof id !== 'string' || token !== 'ok' ? null : id),
    roleOf: async () => w.role ?? 'worker',
    now: () => 1_760_000_000_000,
  }
}
const decide = async (f: Fake, w: World = {}, q: Parameters<typeof envStatus>[0] = {}) => { fake(f); return envStatus(q, deps(w)) }

describe('SPEC §2.1 — every row, through a fake `docker` on PATH', () => {
  test('row 1: flag off, any Docker, any preference -> namespace, nothing shown', async () => {
    for (const f of [{ running: true }, { running: false }, { installed: false }] as Fake[]) {
      const s = await decide(f, { flag: false, prefs: { all: 'docker' } })
      expect([s.decision.backend, s.decision.reason, s.decision.line]).toEqual(['namespace', 'flag-off', ''])
    }
  })
  test('row 2: running, no choice -> namespace + suggestion (CLI/MCP; the screen is S5)', async () => {
    const s = await decide({ running: true })
    expect([s.decision.backend, s.decision.reason, s.decision.suggest]).toEqual(['namespace', 'suggest-docker', 'use-docker'])
    expect(s.docker).toMatchObject({ present: true, running: true, apiVersion: '1.54', kind: 'native' })
  })
  test('row 3: running + choice docker -> docker (profile resolves to a catalogue image)', async () => {
    const s = await decide({ running: true }, { prefs: { all: 'docker' } }, { needs: ['bun'] })
    expect([s.decision.backend, s.decision.reason]).toEqual(['docker', 'chosen-docker'])
    expect(s.image).toMatchObject({ ok: true, key: 'bun-1.3' })
  })
  test('row 4: running + choice docker but no catalogue image for the profile -> namespace + "missing: git"', async () => {
    const s = await decide({ running: true }, { prefs: { all: 'docker' } }, { needs: ['git'] })
    expect([s.decision.backend, s.decision.reason]).toEqual(['namespace', 'no-image'])
    expect(s.decision.line).toContain('missing: git')
    expect(s.image).toEqual({ ok: false, missing: ['git'] })
  })
  test('row 5: running + choice namespace -> namespace, nothing shown', async () => {
    const s = await decide({ running: true }, { prefs: { all: 'namespace' } })
    expect([s.decision.backend, s.decision.reason, s.decision.line]).toEqual(['namespace', 'chosen-namespace', ''])
  })
  test('row 6: running but the platform is not validated (Docker Desktop) -> namespace + sentence, whatever was chosen', async () => {
    for (const prefs of [undefined, { all: 'docker' as EnvBackend }]) {
      const s = await decide({ running: true, os: 'Docker Desktop' }, { prefs })
      expect([s.decision.backend, s.decision.reason]).toEqual(['namespace', 'platform-unavailable'])
      expect(s.platform.docker).toBe('unavailable')
    }
    // macOS and Windows are unavailable even with a native-looking Engine answer.
    for (const platform of ['darwin', 'win32']) {
      const s = await decide({ running: true }, { proc: { platform, isWsl: false } })
      expect(s.decision.reason).toBe('platform-unavailable')
    }
  })
  test('row 7: present but stopped, no choice -> namespace + one warning', async () => {
    const s = await decide({ running: false })
    expect([s.decision.backend, s.decision.reason]).toEqual(['namespace', 'docker-stopped-offered'])
    expect(s.docker).toMatchObject({ present: true, running: false, apiVersion: null })
  })
  test('row 8: present but stopped + choice docker -> namespace on this run, with reason and action', async () => {
    const s = await decide({ running: false }, { prefs: { all: 'docker' } })
    expect([s.decision.backend, s.decision.reason]).toEqual(['namespace', 'docker-stopped-chosen'])
    expect(s.decision.line).toContain('Start Docker')
  })
  test('row 9: none, no choice -> namespace + install suggestion, and the install hint rides along', async () => {
    const s = await decide({ installed: false })
    expect([s.decision.backend, s.decision.reason, s.decision.suggest]).toEqual(['namespace', 'docker-missing-suggest-install', 'install-docker'])
    expect(s.install?.os).toBe('linux')
    expect(s.install?.officialUrl).toContain('docs.docker.com')
  })
  test('row 10: none + choice docker -> namespace + "Docker is no longer installed"', async () => {
    const s = await decide({ installed: false }, { prefs: { all: 'docker' } })
    expect([s.decision.backend, s.decision.reason]).toEqual(['namespace', 'docker-gone'])
  })
  test('row 11: running + choice docker + API 1.44 -> namespace + the version; 1.45 passes', async () => {
    const old = await decide({ running: true, api: '1.44' }, { prefs: { all: 'docker' } })
    expect([old.decision.backend, old.decision.reason]).toEqual(['namespace', 'api-too-old'])
    expect(old.decision.line).toContain('1.44')
    const edge = await decide({ running: true, api: '1.45' }, { prefs: { all: 'docker' } })
    expect(edge.decision.backend).toBe('docker')
  })
  test('apiVersion comes from `docker version --format {{.Server.APIVersion}}` and is null when the daemon is down', async () => {
    fake({ running: true, api: '1.54' }); expect((await detectDocker()).apiVersion).toBe('1.54')
    fake({ running: false }); expect((await detectDocker()).apiVersion).toBeNull()
    fake({ installed: false }); expect((await detectDocker()).apiVersion).toBeNull()
  })
  test('WSL2 with an Engine inside WSL is available; its install hint says so', async () => {
    const s = await decide({ installed: false }, { proc: { platform: 'linux', isWsl: true } })
    expect(s.platform).toEqual({ os: 'wsl2', docker: 'available' }) // an Engine inside WSL is the measured configuration
    expect(s.install?.os).toBe('wsl2')
    const run = await decide({ running: true }, { proc: { platform: 'linux', isWsl: true } })
    expect(run.platform).toEqual({ os: 'wsl2', docker: 'available' })
    expect(run.decision.reason).toBe('suggest-docker')
  })
})

describe('scope: only this session / this project / all sessions — end to end through the status', () => {
  const prefs: EnvBackendPrefs = { all: 'namespace', projects: { '/repo/a': 'docker' }, sessions: { s1: 'docker', s3: 'namespace' } }
  test('the most specific scope decides, and the status names which', async () => {
    const s1 = await decide({ running: true }, { prefs }, { session: 's1', project: '/repo/zzz' })
    expect([s1.decision.backend, s1.choice.source]).toEqual(['docker', 'session'])
    const p = await decide({ running: true }, { prefs }, { session: 's2', project: '/repo/a' })
    expect([p.decision.backend, p.choice.source]).toEqual(['docker', 'project'])
    const s3 = await decide({ running: true }, { prefs }, { session: 's3', project: '/repo/a' })
    expect([s3.decision.backend, s3.choice.source]).toEqual(['namespace', 'session'])
    const all = await decide({ running: true }, { prefs }, { session: 's9', project: '/repo/b' })
    expect([all.decision.backend, all.choice.source]).toEqual(['namespace', 'all'])
    const none = await decide({ running: true }, {}, { session: 's9' })
    expect([none.decision.reason, none.choice.source]).toEqual(['suggest-docker', 'none'])
  })
  test('`use` writes exactly the scope asked, and a later `all` does not erase a session choice', async () => {
    fake({ running: true })
    const d = deps()
    expect(await envUse({ backend: 'docker', scope: 'session', target: 'sX' }, d)).toMatchObject({ ok: true, scope: 'session', target: 'sX' })
    expect(await envUse({ backend: 'namespace', scope: 'project', target: '/r' }, d)).toMatchObject({ ok: true })
    expect(await envUse({ backend: 'docker' }, d)).toMatchObject({ ok: true, scope: 'all' })
    expect(d.stored.envBackend).toEqual({ all: 'docker', projects: { '/r': 'namespace' }, sessions: { sX: 'docker' } })
    expect(d.stored.envBackendChosenAt).toBe(new Date(1_760_000_000_000).toISOString())
  })
  test('a leader choosing "this session" with no target means its own; the person must name one', async () => {
    fake({ running: true })
    const leader = deps({ role: 'leader' })
    expect(await envUse({ backend: 'docker', scope: 'session', session: { id: 'L1', token: 'ok' } }, leader)).toMatchObject({ ok: true, target: 'L1' })
    expect(leader.stored.envBackend?.sessions).toEqual({ L1: 'docker' })
    expect(await envUse({ backend: 'docker', scope: 'session' }, deps())).toEqual({ ok: false, error: 'target_required' })
  })
  test('refusing (namespace) records the Docker state it was made against; the refusal lapses when that state changes', async () => {
    fake({ running: false })
    const d = deps()
    expect(await envUse({ backend: 'namespace' }, d)).toMatchObject({ ok: true })
    const recorded = d.stored.envBackendOfferedFor
    expect(recorded).toContain('stopped')
    // Same state: the refusal stands and nothing nags.
    fake({ running: false })
    const same = await envStatus({}, d)
    expect([same.refusalStale, same.choice.backend, same.alreadyOffered]).toEqual([false, 'namespace', true])
    // Docker started: the refusal was about the old state, so the suggestion comes back.
    fake({ running: true })
    const changed = await envStatus({}, d)
    expect([changed.refusalStale, changed.choice.backend, changed.decision.reason]).toEqual([true, undefined, 'suggest-docker'])
  })
})

describe('who may write: the person or a verified leader — never a worker', () => {
  test('`use` and `grant`: a worker (verified, role worker) is refused', async () => {
    fake({ running: true })
    const d = deps({ role: 'worker' })
    const proof = { id: 'W1', token: 'ok' }
    expect(await envUse({ backend: 'docker', session: proof }, d)).toEqual({ ok: false, error: 'leader_only' })
    expect(await envGrant({ session: proof }, d)).toEqual({ ok: false, error: 'leader_only' })
    expect(d.stored.envBackend).toBeUndefined()
  })
  test('an unverifiable session is refused as unverified, not treated as the person', async () => {
    fake({ running: true })
    const d = deps({ verified: false })
    expect(await envUse({ backend: 'docker', session: { id: 'W1', token: 'forged' } }, d)).toEqual({ ok: false, error: 'unverified_sender' })
    expect(await envGrant({ session: { id: 'W1', token: 'forged' } }, d)).toEqual({ ok: false, error: 'unverified_sender' })
    expect(await envUse({ backend: 'docker', session: { id: 'W1' } }, d)).toEqual({ ok: false, error: 'unverified_sender' })
  })
  test('the person (no proof) and a verified leader may choose', async () => {
    fake({ running: true })
    expect(await envUse({ backend: 'docker' }, deps())).toMatchObject({ ok: true })
    expect(await envUse({ backend: 'docker', session: { id: 'L1', token: 'ok' } }, deps({ role: 'leader' }))).toMatchObject({ ok: true })
  })
  test('`grant` for an allowed caller is a stated "not yet" (S2), never a silent success', async () => {
    expect(await envGrant({}, deps())).toEqual({ ok: false, error: 'grant_not_available' })
    expect(await envGrant({ session: { id: 'L1', token: 'ok' } }, deps({ role: 'leader' }))).toEqual({ ok: false, error: 'grant_not_available' })
  })
  test('the flag gates every write: off -> flag_off, nothing stored', async () => {
    fake({ running: true })
    const d = deps({ flag: false })
    expect(await envUse({ backend: 'docker' }, d)).toEqual({ ok: false, error: 'flag_off' })
    expect(await envGrant({}, d)).toEqual({ ok: false, error: 'flag_off' })
    expect(d.stored.envBackend).toBeUndefined()
  })
  test('bad input is refused with a code', async () => {
    fake({ running: true })
    expect(await envUse({ backend: 'podman' }, deps())).toEqual({ ok: false, error: 'bad_backend' })
    expect(await envUse({ backend: 'docker', scope: 'galaxy' }, deps())).toEqual({ ok: false, error: 'bad_scope' })
  })
})

describe('install hint: per operating system, and a mirror of the same text', () => {
  test('this machine by default, any system on request, junk refused', () => {
    const d = deps({ proc: { platform: 'darwin', isWsl: false } })
    const own = envInstall(undefined, d)
    expect(own).toMatchObject({ ok: true, detectedOs: 'macos', hint: { os: 'macos', validated: false } })
    for (const os of ['linux', 'wsl2', 'macos', 'windows']) expect(envInstall(os, d)).toMatchObject({ ok: true, hint: { os } })
    expect(envInstall('solaris', d)).toEqual({ ok: false, error: 'bad_os' })
  })
})

describe('the HTTP door (`handleEnvRequest`)', () => {
  const call = async (method: string, path: string, body: unknown, d: EnvDeps) => {
    const req = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
    return handleEnvRequest(req, new URL(req.url), d)
  }
  test('status, install, use, grant; status codes follow the refusal', async () => {
    fake({ running: true })
    const d = deps({ role: 'worker' })
    expect((await call('GET', '/api/env/status?session=s1&needs=bun', undefined, d))?.status).toBe(200)
    expect((await call('GET', '/api/env/install?os=wsl2', undefined, d))?.body).toMatchObject({ ok: true, hint: { os: 'wsl2' } })
    expect((await call('GET', '/api/env/install?os=zz', undefined, d))?.status).toBe(400)
    expect((await call('POST', '/api/env/use', { backend: 'docker', session: { id: 'W1', token: 'ok' } }, d))?.status).toBe(403)
    expect((await call('POST', '/api/env/use', { backend: 'docker', session: { id: 'W1', token: 'x' } }, d))?.status).toBe(401)
    expect((await call('POST', '/api/env/grant', {}, d))?.status).toBe(501)
    expect((await call('POST', '/api/env/use', { backend: 'docker' }, deps({ flag: false })))?.status).toBe(409)
    expect((await call('POST', '/api/env/use', { backend: 'docker' }, d))?.status).toBe(200)
    expect(await call('GET', '/api/env/nope', undefined, d)).toBeNull()
    expect(await call('DELETE', '/api/env/use', undefined, d)).toBeNull()
  })
})
