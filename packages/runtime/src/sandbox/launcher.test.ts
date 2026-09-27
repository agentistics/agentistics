import { describe, expect, test } from 'bun:test'
import type { SandboxState, SpawnPlan } from '../tools/contract'
import { createSandboxLauncher } from './launcher'
import { INFORMATIONAL_NOTE, type SandboxProbe } from './probe'
import { SANDBOX_SENTENCES } from './sentences'
import { isInside, ulimitArgv, ulimitValue } from './wrap-argv'

function probe(over: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: 'linux',
    wsl: false,
    prlimit: { status: 'available' },
    ulimit: { status: 'available', flags: { cpu: '-t', addressSpace: '-v', fileSize: '-f', openFiles: '-n', processes: '-p' } },
    docker: { status: 'available', serverVersion: '29.3.0' },
    informational: {
      note: INFORMATIONAL_NOTE,
      landlock: { status: 'unknown', reason: 'securityfs-unreadable', abi: null },
      userNamespaces: { status: 'available' },
    },
    ...over,
  }
}

const TRICKY = ['printf', '%s\n', 'a b', "it's", '"quoted"', '$(rm -rf /)', '; echo pwned']
const plan = (over: Partial<SpawnPlan> = {}): SpawnPlan => ({ argv: TRICKY, cwd: '/work/repo/sub', env: {}, ...over })
const LIMITS = { cpuSeconds: 30, addressSpaceBytes: 1073741824, fileSizeBytes: 10485760, processes: 64, openFiles: 256 }

function ok(r: SpawnPlan | { refused: string }): SpawnPlan {
  if ('refused' in r) throw new Error(`unexpected refusal: ${r.refused}`)
  return r
}
function refused(r: SpawnPlan | { refused: string }): string {
  if (!('refused' in r)) throw new Error(`expected a refusal, got ${JSON.stringify(r.argv)}`)
  return r.refused
}

describe('sentences', () => {
  test('all four states exist in EN and PT, non-empty and distinct', () => {
    const states: SandboxState[] = ['none', 'filesystem-only', 'container', 'unavailable']
    for (const s of states) {
      expect(SANDBOX_SENTENCES[s].en.length).toBeGreaterThan(20)
      expect(SANDBOX_SENTENCES[s].pt.length).toBeGreaterThan(20)
      expect(SANDBOX_SENTENCES[s].en).not.toBe(SANDBOX_SENTENCES[s].pt)
    }
    expect(Object.keys(SANDBOX_SENTENCES).sort()).toEqual([...states].sort())
  })

  test('the honest floor for none names reading, network and arbitrary code, and the policy', () => {
    const en = SANDBOX_SENTENCES.none.en
    expect(en).toMatch(/read anything this account can read/)
    expect(en).toMatch(/network/)
    expect(en).toMatch(/arbitrary code/)
    expect(en).toMatch(/one approval/)
    expect(en).toMatch(/policy/)
  })

  test('each contained state says what is NOT contained; no reassurance words', () => {
    expect(SANDBOX_SENTENCES['filesystem-only'].en).toMatch(/network is NOT restricted/)
    expect(SANDBOX_SENTENCES.container.en).toMatch(/workspace itself is NOT protected/)
    for (const s of Object.values(SANDBOX_SENTENCES)) {
      expect(s.en).not.toMatch(/\b(safe|secure|protected from everything|fully isolated)\b/i)
    }
  })
})

describe('requested: none', () => {
  test('state none, argv untouched', () => {
    const l = createSandboxLauncher({ requested: 'none', probe: probe() })
    expect(l.state).toBe('none')
    expect(l.sentence).toBe(SANDBOX_SENTENCES.none.en)
    expect(ok(l.wrap(plan())).argv).toEqual(TRICKY)
  })

  test('configured limits are said to be NOT applied', () => {
    const l = createSandboxLauncher({ requested: 'none', limits: { openFiles: 64 }, probe: probe() })
    expect(l.sentence).toMatch(/not applied/)
    expect(l.unappliedLimits).toEqual(['openFiles'])
  })

  test('an empty argv is refused', () => {
    const l = createSandboxLauncher({ requested: 'none', probe: probe() })
    expect(refused(l.wrap(plan({ argv: [] })))).toMatch(/empty argv/)
  })
})

describe('requested: rlimit', () => {
  test('prlimit: exact argv, state none, sentence says limits are not containment', () => {
    const l = createSandboxLauncher({ requested: 'rlimit', limits: LIMITS, probe: probe() })
    expect(l.state).toBe('none')
    expect(l.mechanism).toBe('prlimit')
    expect(ok(l.wrap(plan())).argv).toEqual([
      'prlimit', '--cpu=30', '--as=1073741824', '--fsize=10485760', '--nproc=64', '--nofile=256', '--', ...TRICKY,
    ])
    expect(l.sentence).toContain(SANDBOX_SENTENCES.none.en)
    expect(l.sentence).toMatch(/not containment: nothing restricts what can be read or reached/)
    expect(l.sentence).toMatch(/CPU time 30 s/)
    expect(l.sentence).toMatch(/address space 1 GiB/)
  })

  test('ulimit fallback: the argv arrives POSITIONALLY after a fixed script', () => {
    const l = createSandboxLauncher({ requested: 'rlimit', limits: LIMITS, probe: probe({ prlimit: { status: 'unavailable', reason: 'not-found' } }) })
    expect(l.mechanism).toBe('ulimit')
    const argv = ok(l.wrap(plan())).argv
    expect(argv).toEqual([
      'sh', '-c',
      'ulimit -t 30 && ulimit -v 1048576 && ulimit -f 20480 && ulimit -p 64 && ulimit -n 256 && exec "$@"',
      'sh', ...TRICKY,
    ])
    // Nothing of the command reached the script.
    for (const piece of TRICKY) expect(argv[2]).not.toContain(piece === '%s\n' ? 'printf' : piece)
  })

  test('ulimit units: -v KiB and -f 512-byte blocks, rounded down with a floor of 1', () => {
    expect(ulimitValue('addressSpaceBytes', 1024 * 1024)).toBe(1024)
    expect(ulimitValue('fileSizeBytes', 1000)).toBe(1)
    expect(ulimitValue('fileSizeBytes', 1535)).toBe(2)
    expect(ulimitValue('cpuSeconds', 7)).toBe(7)
  })

  test('a limit the shell cannot express is NAMED, and skipped in the argv', () => {
    const flags = { cpu: '-t' as const, addressSpace: null, fileSize: '-f' as const, openFiles: '-n' as const, processes: null }
    const l = createSandboxLauncher({
      requested: 'rlimit',
      limits: LIMITS,
      probe: probe({ prlimit: { status: 'unavailable', reason: 'not-found' }, ulimit: { status: 'available', flags } }),
    })
    expect(l.unappliedLimits).toEqual(['addressSpaceBytes', 'processes'])
    expect(l.sentence).toMatch(/Not applied.*address space, process count/)
    expect(ok(l.wrap(plan())).argv[2]).toBe('ulimit -t 30 && ulimit -f 20480 && ulimit -n 256 && exec "$@"')
    expect(ulimitArgv({}, flags, ['true'])).toEqual(['sh', '-c', 'exec "$@"', 'sh', 'true'])
  })

  test('no mechanism at all → unavailable, refused', () => {
    const l = createSandboxLauncher({
      requested: 'rlimit',
      limits: LIMITS,
      probe: probe({ prlimit: { status: 'unavailable', reason: 'not-linux' }, ulimit: { status: 'unavailable', reason: 'no-posix-sh' } }),
    })
    expect(l.state).toBe('unavailable')
    expect(l.unavailableReason).toBe('no-rlimit-mechanism')
    expect(refused(l.wrap(plan()))).toBe(l.sentence)
    expect(l.sentence).toMatch(/refused/)
  })

  test('an invalid limit makes the request unavailable rather than silently skipped', () => {
    const l = createSandboxLauncher({ requested: 'rlimit', limits: { openFiles: -3 }, probe: probe() })
    expect(l.state).toBe('unavailable')
    expect(l.unavailableReason).toBe('invalid-limits')
  })
})

describe('requested: docker', () => {
  const docker = { image: 'agentistics/sandbox:1', workspaceRoot: '/work/repo', user: { uid: 1000, gid: 1000 } }

  test('exact argv; env names on the argv, env VALUES only in the spawn env', () => {
    const l = createSandboxLauncher({ requested: 'docker', docker, probe: probe() })
    expect(l.state).toBe('container')
    const env = { SECRET_TOKEN: 's3cr3t value', PATH: '/usr/bin', HOME: '/home/u', DOCKER_HOST: 'unix:///x', LANG: 'C.UTF-8' }
    const out = ok(l.wrap(plan({ env })))
    expect(out.argv).toEqual([
      'docker', 'run', '--rm', '-i', '--init',
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '256',
      '--memory', '2g',
      '--user', '1000:1000',
      '-v', '/work/repo:/work/repo',
      '-w', '/work/repo/sub',
      '--read-only', '--tmpfs', '/tmp',
      '-e', 'LANG',
      '-e', 'SECRET_TOKEN',
      'agentistics/sandbox:1', ...TRICKY,
    ])
    for (const v of Object.values(env)) expect(out.argv.join('\u0000')).not.toContain(v)
    expect(out.env).toEqual(env)
    expect(out.cwd).toBe('/work/repo/sub')
    expect(l.sentence).toContain(SANDBOX_SENTENCES.container.en)
    expect(l.sentence).toMatch(/no network/)
  })

  test('bridge network, writable root and --ulimit mapping are reflected in argv and sentence', () => {
    const l = createSandboxLauncher({
      requested: 'docker',
      docker: { ...docker, network: 'bridge', readOnlyRoot: false, memory: '512m', pidsLimit: 32 },
      limits: { cpuSeconds: 10, processes: 5, openFiles: 64 },
      probe: probe(),
    })
    const argv = ok(l.wrap(plan({ argv: ['true'] }))).argv
    expect(argv).toContain('bridge')
    expect(argv).not.toContain('--read-only')
    expect(argv.join(' ')).toContain('--ulimit cpu=10 --ulimit nofile=64')
    expect(argv.join(' ')).not.toContain('nproc')
    expect(l.unappliedLimits).toEqual(['processes'])
    expect(l.sentence).toMatch(/HAS network access/)
    expect(l.sentence).toMatch(/filesystem is writable/)
  })

  test('a cwd outside the workspace is REFUSED, not wrapped (and a sibling prefix is outside)', () => {
    const l = createSandboxLauncher({ requested: 'docker', docker, probe: probe() })
    expect(refused(l.wrap(plan({ cwd: '/etc' })))).toMatch(/outside the workspace/)
    expect(refused(l.wrap(plan({ cwd: '/work/repo-other' })))).toMatch(/outside the workspace/)
    expect(refused(l.wrap(plan({ cwd: '/work/repo/../secrets' })))).toMatch(/outside the workspace/)
    expect(ok(l.wrap(plan({ cwd: '/work/repo' }))).argv).toContain('/work/repo')
    expect(isInside('/work/repo', '/work/repo/..foo')).toBe(true)
  })

  test('requested but unavailable → state unavailable, refused with the reason in words', () => {
    const cases: Array<[SandboxProbe['docker'], string, RegExp]> = [
      [{ status: 'unavailable', reason: 'binary-absent' }, 'docker-binary-absent', /not installed/],
      [{ status: 'unavailable', reason: 'daemon-down' }, 'docker-daemon-down', /daemon is not running/],
      [{ status: 'unavailable', reason: 'permission-denied' }, 'docker-permission-denied', /no permission/],
      [{ status: 'unknown', reason: 'timed-out' }, 'docker-unknown', /not assumed to work/],
    ]
    for (const [d, reason, words] of cases) {
      const l = createSandboxLauncher({ requested: 'docker', docker, probe: probe({ docker: d }) })
      expect(l.state).toBe('unavailable')
      expect(l.unavailableReason).toBe(reason as never)
      expect(l.runsUnsandboxed).toBe(false)
      const msg = refused(l.wrap(plan()))
      expect(msg).toContain(SANDBOX_SENTENCES.unavailable.en)
      expect(msg).toMatch(words)
      expect(msg).toMatch(/refused until it is available/)
      expect(l.sentencePt).toContain(SANDBOX_SENTENCES.unavailable.pt)
    }
  })

  test('fallbackUnsandboxed runs the command AND says it is running unsandboxed', () => {
    const l = createSandboxLauncher({
      requested: 'docker',
      docker,
      probe: probe({ docker: { status: 'unavailable', reason: 'daemon-down' } }),
      fallbackUnsandboxed: true,
    })
    expect(l.state).toBe('unavailable')
    expect(l.runsUnsandboxed).toBe(true)
    expect(ok(l.wrap(plan())).argv).toEqual(TRICKY)
    expect(l.sentence).toMatch(/WITHOUT a sandbox/)
    expect(l.sentence).toMatch(/daemon is not running/)
    expect(l.sentence).not.toMatch(/refused until/)
    expect(l.sentencePt).toMatch(/SEM sandbox/)
  })

  test('fallback still applies the resource limits it can, and says so', () => {
    const l = createSandboxLauncher({
      requested: 'docker',
      docker,
      limits: { openFiles: 64 },
      probe: probe({ docker: { status: 'unavailable', reason: 'binary-absent' } }),
      fallbackUnsandboxed: true,
    })
    expect(l.mechanism).toBe('prlimit')
    expect(ok(l.wrap(plan({ argv: ['true'] }))).argv).toEqual(['prlimit', '--nofile=64', '--', 'true'])
    expect(l.sentence).toMatch(/not containment/)
  })

  test('bad container settings are unavailable, not guessed around', () => {
    const bad = [
      { ...docker, image: '' },
      { ...docker, image: '--privileged' },
      { ...docker, workspaceRoot: 'relative/path' },
      { ...docker, workspaceRoot: '/a:b' },
      { ...docker, memory: 'lots' },
    ]
    for (const d of bad) {
      const l = createSandboxLauncher({ requested: 'docker', docker: d, probe: probe() })
      expect(l.state).toBe('unavailable')
      expect(l.unavailableReason).toBe('docker-invalid-config')
    }
    expect(createSandboxLauncher({ requested: 'docker', probe: probe() }).unavailableReason).toBe('docker-not-configured')
  })

  test('an env name docker cannot carry is refused', () => {
    const l = createSandboxLauncher({ requested: 'docker', docker, probe: probe() })
    expect(refused(l.wrap(plan({ env: { 'BAD-NAME': 'x' } })))).toMatch(/environment variable name/)
  })
})

describe('filesystem-only is reserved', () => {
  test('no request produces it in v1', () => {
    const produced = new Set<SandboxState>()
    for (const requested of ['none', 'rlimit', 'docker'] as const) {
      produced.add(createSandboxLauncher({ requested, limits: LIMITS, docker: { image: 'x', workspaceRoot: '/w', user: { uid: 1, gid: 1 } }, probe: probe() }).state)
      produced.add(createSandboxLauncher({ requested, probe: probe({ docker: { status: 'unavailable', reason: 'binary-absent' } }) }).state)
    }
    expect(produced.has('filesystem-only')).toBe(false)
  })
})
