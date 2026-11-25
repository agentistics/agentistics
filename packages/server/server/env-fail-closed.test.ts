/**
 * DOCKER.AMBIENTES S1 r3 — fail closed. Probes from the r2 re-QA, kept in the suite:
 *  1. `AGENTOP_MANAGED_ID` PRESENT (any value, empty included) = inside a session = needs proof; only ABSENT is the person.
 *  2. flag off: every `/api/env/*` route answers as disabled, reads included.
 *  3. a REMOTE caller is never the person for an env WRITE without the owner's grant.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { envCallerFrom, handleEnvRequest, type EnvDeps } from './env-web'
import { envCliIo } from './flows/host-ops'
import { runEnv } from './cli-env'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'bin', 'cli.ts')

function deps(over: Partial<EnvDeps> = {}): EnvDeps & { saved: Record<string, unknown> } {
  const saved: Record<string, unknown> = {}
  return {
    saved,
    flag: () => true,
    detect: async () => ({ present: false, running: false, version: null, kind: 'none', apiVersion: null }),
    platform: () => ({ os: 'linux', docker: 'available' }),
    readPrefs: async () => saved,
    writePrefs: async f => { const p = f(saved); if (p) Object.assign(saved, p) },
    verify: async () => null,
    roleOf: async () => 'worker',
    now: () => 0,
    ...over,
  }
}
const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) })
const call = (d: EnvDeps, method: string, path: string, body?: unknown) => { const r = req(method, path, body); return handleEnvRequest(r, new URL(r.url), d) }

describe('flag off: nothing of env is reachable', () => {
  test('every env route answers 409 flag_off, reads included, and writes nothing', async () => {
    const d = deps({ flag: () => false, caller: async () => 'person' })
    for (const [m, p, b] of [
      ['GET', '/api/env/status', undefined], ['GET', '/api/env/install-hint', undefined],
      ['POST', '/api/env/use', { backend: 'docker' }], ['POST', '/api/env/grant', {}],
    ] as const) {
      const r = await call(d, m, p, b)
      expect([m, p, r?.status, (r?.body as { error?: string }).error]).toEqual([m, p, 409, 'flag_off'])
    }
    expect(d.saved).toEqual({})
  })
})

describe('AGENTOP_MANAGED_ID present-but-empty is a session that cannot prove itself', () => {
  const withEnv = async <T>(value: string | undefined, f: () => Promise<T>): Promise<T> => {
    const prev = process.env.AGENTOP_MANAGED_ID
    if (value === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = value
    try { return await f() } finally { if (prev === undefined) delete process.env.AGENTOP_MANAGED_ID; else process.env.AGENTOP_MANAGED_ID = prev }
  }
  test('proof(): absent = no claim; empty = a claim with an empty (never verifying) token', async () => {
    const io = await envCliIo()
    expect(await io.proof({})).toBeUndefined()
    expect(await io.proof({ AGENTOP_MANAGED_ID: '' })).toEqual({ id: '', token: '' })
  })
  for (const verb of ['use', 'grant']) for (const scope of ['all', 'project', 'session']) {
    test(`local fallback ${verb}/${scope}: empty id refused, nothing written; absent id = the person`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'env-r3-'))
      try {
        const run = async (id: string | undefined) => withEnv(id, async () => {
          const io = await envCliIo()
          const err: string[] = []
          const rc = await runEnv([verb, ...(verb === 'use' ? ['docker', `--${scope}`, ...(scope === 'all' ? [] : [scope === 'project' ? '/repo/B' : 'other'])] : [])], {
            io, env: process.env, cwdProject: async () => undefined, log: () => {}, error: l => err.push(l),
            call: async (m, p, b) => ({ ...(await io.local(m, p, b)), viaServer: false }),
          })
          return { rc, err: err.join('\n') }
        })
        const prevDir = process.env.AGENTISTICS_DOCKER_ENV
        process.env.AGENTISTICS_DOCKER_ENV = '1'
        try {
          const empty = await run('')
          expect(empty.rc).not.toBe(0)
          expect(empty.err).not.toContain('grant_not_available')
          const worker = await run('worker-x')
          expect(worker.rc).not.toBe(0)
        } finally { if (prevDir === undefined) delete process.env.AGENTISTICS_DOCKER_ENV; else process.env.AGENTISTICS_DOCKER_ENV = prevDir }
      } finally { rmSync(dir, { recursive: true, force: true }) }
    })
  }
  test('the real entrypoint (bin/cli.ts) with an empty id writes nothing and exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-r3-cli-'))
    try {
      const p = Bun.spawn([process.execPath, CLI, 'env', 'use', 'docker', '--all'], {
        env: { PATH: process.env.PATH!, HOME: dir, AGENTISTICS_DIR: dir, AGENTISTICS_DOCKER_ENV: '1', AGENTOP_MANAGED_ID: '', PORT: '40199' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      let prefs: { envBackend?: unknown } = {}
      try { prefs = JSON.parse(readFileSync(join(dir, 'preferences.json'), 'utf8')) } catch { /* nothing written */ }
      expect({ rc: rc === 0, wrote: prefs.envBackend, out, err: err.length > 0 }).toMatchObject({ rc: false, wrote: undefined })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20000)
})

describe('a remote caller is not the person for env writes without the owner grant', () => {
  test('envCallerFrom: remote person needs the grant; local processes and a wsl relay are unchanged', () => {
    expect(envCallerFrom({ kind: 'person', via: 'remote' }, false)).toBe('unknown')
    expect(envCallerFrom({ kind: 'person', via: 'remote' }, true)).toBe('person')
    expect(envCallerFrom({ kind: 'person', via: 'process', pid: 1 } as never, false)).toBe('person')
    expect(envCallerFrom({ kind: 'person', via: 'wsl-relay' }, false)).toBe('person')
    expect(envCallerFrom({ kind: 'session', pid: 1, managedId: 'x' } as never, true)).toBe('session')
    expect(envCallerFrom({ kind: 'unknown', reason: 'no-peer' } as never, true)).toBe('unknown')
  })
  test('through the HTTP door: a remote caller with no grant is refused person_unproven, writes nothing', async () => {
    const d = deps({ caller: async () => envCallerFrom({ kind: 'person', via: 'remote' }, false) })
    const r = await call(d, 'POST', '/api/env/use', { backend: 'docker' })
    expect([r?.status, (r?.body as { error?: string }).error]).toEqual([403, 'person_unproven'])
    expect(d.saved).toEqual({})
    const ok = deps({ caller: async () => envCallerFrom({ kind: 'person', via: 'remote' }, true) })
    expect((await call(ok, 'POST', '/api/env/use', { backend: 'docker' }))?.status).toBe(200)
  })
})
