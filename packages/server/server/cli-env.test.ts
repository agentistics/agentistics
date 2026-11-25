import { describe, expect, test } from 'bun:test'
import { describeInstall, describeStatus, parseEnvArgs, runEnv, type EnvCliDeps } from './cli-env'
import { installHint } from '@agentistics/core'

describe('parseEnvArgs', () => {
  test('use: default scope is all; --session / --project take a value or the ambient session / repository', () => {
    expect(parseEnvArgs(['use', 'docker'])).toEqual({ kind: 'use', body: { backend: 'docker', scope: 'all' } })
    expect(parseEnvArgs(['use', 'namespace', '--all'])).toEqual({ kind: 'use', body: { backend: 'namespace', scope: 'all' } })
    expect(parseEnvArgs(['use', 'docker', '--session', 'abc123'])).toEqual({ kind: 'use', body: { backend: 'docker', scope: 'session', target: 'abc123' } })
    expect(parseEnvArgs(['use', 'docker', '--session'], { AGENTOP_MANAGED_ID: 'mine' })).toEqual({ kind: 'use', body: { backend: 'docker', scope: 'session', target: 'mine' } })
    expect(parseEnvArgs(['use', 'docker', '--project', '/r/a'])).toEqual({ kind: 'use', body: { backend: 'docker', scope: 'project', target: '/r/a' } })
    expect(parseEnvArgs(['use', 'docker', '--project'], {}, '/r/cwd')).toEqual({ kind: 'use', body: { backend: 'docker', scope: 'project', target: '/r/cwd' } })
  })
  test('use: refuses what it cannot place, in words', () => {
    expect(parseEnvArgs(['use', 'podman']).kind).toBe('error')
    expect(parseEnvArgs(['use']).kind).toBe('error')
    const noSession = parseEnvArgs(['use', 'docker', '--session'])
    expect(noSession).toMatchObject({ kind: 'error' })
    expect((noSession as { message: string }).message).toContain('session id')
    expect(parseEnvArgs(['use', 'docker', '--project']).kind).toBe('error')
    expect(parseEnvArgs(['use', 'docker', '--bogus']).kind).toBe('error')
  })
  test('status carries the ambient session and repository, and its filters', () => {
    expect(parseEnvArgs(['status'], { AGENTOP_MANAGED_ID: 's1' }, '/r')).toEqual({ kind: 'status', json: false, query: { session: 's1', project: '/r' } })
    expect(parseEnvArgs(['status', '--json', '--needs', 'git, bun', '--image', 'bun-1.3', '--session', 'x'])).toEqual({
      kind: 'status', json: true, query: { session: 'x', needs: ['git', 'bun'], image: 'bun-1.3' },
    })
  })
  test('install: --os and --json; unknown arguments refused', () => {
    expect(parseEnvArgs(['install-hint'])).toEqual({ kind: 'install-hint', json: false })
    expect(parseEnvArgs(['install-hint', '--os', 'macos', '--json'])).toEqual({ kind: 'install-hint', json: true, os: 'macos' })
    expect(parseEnvArgs(['install-hint', '--now']).kind).toBe('error')
  })
  test('grant is recognised (the role gate lives on the server); unknown verbs and no verb give usage', () => {
    expect(parseEnvArgs(['grant', 'repo', 'install-hint']).kind).toBe('grant')
    expect(parseEnvArgs(['frob']).kind).toBe('error')
    expect(parseEnvArgs([]).kind).toBe('error')
  })
})

describe('what is printed', () => {
  test('describeInstall states the cost, the steps, the page — and that nothing is installed for you', () => {
    const text = describeInstall(installHint('macos'), 'linux').join('\n')
    expect(text).toContain('Docker Desktop')
    expect(text).toContain('Estimate')
    expect(text).toContain('1. ')
    expect(text).toContain('https://docs.docker.com/desktop/setup/install/mac-install/')
    expect(text).toContain('for macos; this machine is linux')
    expect(text).toContain('installs nothing and runs no sudo')
    expect(describeInstall(installHint('linux'), 'linux').join('\n')).not.toContain('this machine is')
  })
  test('describeStatus names the flag, Docker, the system, the backend and its reason', () => {
    const lines = describeStatus({
      flag: false, docker: { present: false, running: false, version: null, kind: 'none', apiVersion: null }, platform: { os: 'linux', docker: 'available' },
      decision: { backend: 'namespace', reason: 'flag-off', line: '', suggest: null, docker: false }, refusalStale: false,
      choice: { backend: undefined, source: 'none' }, prefs: {}, image: { ok: false, missing: ['git'] }, catalogue: ['bun-1.3'], offeredFor: 'k', alreadyOffered: false,
    }).join('\n')
    expect(lines).toContain('docker-env flag: off')
    expect(lines).toContain('docker: not installed')
    expect(lines).toContain('backend: namespace (flag-off)')
    expect(lines).toContain('none for this project (git)')
  })
})

describe('runEnv', () => {
  const run = async (args: string[], reply: { status: number; body: unknown; viaServer?: boolean }, env: Record<string, string | undefined> = {}) => {
    const out: string[] = []; const err: string[] = []; const calls: unknown[][] = []
    const deps: EnvCliDeps = {
      env, cwdProject: async () => undefined, log: l => out.push(l), error: l => err.push(l),
      call: async (m, p, b) => { calls.push([m, p, b]); return { status: reply.status, body: reply.body, viaServer: reply.viaServer ?? true } },
    }
    return { code: await runEnv(args, deps), out, err, calls }
  }
  test('use: posts the scoped choice and says what it did; in a session it carries that session\'s identity', async () => {
    const r = await run(['use', 'docker', '--project', '/r'], { status: 200, body: { ok: true, backend: 'docker', scope: 'project', target: '/r' } })
    expect(r.code).toBe(0)
    expect(r.out[0]).toBe('environment backend: docker for project /r')
    expect(r.calls[0]).toEqual(['POST', '/api/env/use', { backend: 'docker', scope: 'project', target: '/r' }])
  })
  test('a refusal is printed with its reason and exits 1 (a worker is told why)', async () => {
    const r = await run(['use', 'docker'], { status: 403, body: { ok: false, error: 'leader_only' } })
    expect(r.code).toBe(1)
    expect(r.err[0]).toContain('leader_only')
    expect(r.err[0]).toContain('a worker may not')
    expect((await run(['use', 'docker'], { status: 409, body: { ok: false, error: 'flag_off' } })).err[0]).toContain('docker-env')
  })
  test('status --json prints the server\'s answer; install prints the hint; the answered-locally note appears', async () => {
    const j = await run(['status', '--json'], { status: 200, body: { flag: true } })
    expect(JSON.parse(j.out[0]!)).toEqual({ flag: true })
    const i = await run(['install-hint'], { status: 200, body: { ok: true, hint: installHint('wsl2'), detectedOs: 'wsl2' }, viaServer: false })
    expect(i.out.join('\n')).toContain('Docker Engine inside WSL')
    expect(i.calls[0]).toEqual(['GET', '/api/env/install-hint', undefined])
    expect((await run(['install-hint', '--os', 'zz'], { status: 400, body: { error: 'bad_os' } })).code).toBe(1)
  })
  test('no verb prints the usage and exits 0; a bad one exits 2', async () => {
    expect((await run([], { status: 200, body: {} })).code).toBe(0)
    expect((await run(['use', 'podman'], { status: 200, body: {} })).code).toBe(2)
  })
})
