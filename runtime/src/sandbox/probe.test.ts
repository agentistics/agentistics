import { describe, expect, test } from 'bun:test'
import {
  DOCKER_PROBE_ARGV,
  INFORMATIONAL_NOTE,
  PRLIMIT_PROBE_ARGV,
  ULIMIT_PROBE_ARGV,
  USERNS_PROBE_ARGV,
  classifyDocker,
  parseUlimitFlags,
  probeSandbox,
  type CommandRunner,
  type RunResult,
} from './probe'

const exited = (exitCode: number, stdout = '', stderr = ''): RunResult => ({ kind: 'exited', exitCode, stdout, stderr })

/** A runner scripted by program name; anything unscripted is "not found". */
function scripted(map: Record<string, RunResult | (() => RunResult)>): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const run: CommandRunner = async (argv) => {
    calls.push([...argv])
    const r = map[argv[0] ?? '']
    if (r === undefined) return { kind: 'not-found' }
    return typeof r === 'function' ? r() : r
  }
  return { run, calls }
}

const HEALTHY = {
  prlimit: exited(0),
  sh: exited(0, 't v f n u p '),
  docker: exited(0, '29.3.0\n'),
  unshare: exited(0),
}

const texts = (m: Record<string, string>) => (p: string) => m[p] ?? null

describe('probeSandbox — docker outcomes', () => {
  test('absent binary', async () => {
    const { run } = scripted({ ...HEALTHY, docker: { kind: 'not-found' } })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker).toEqual({ status: 'unavailable', reason: 'binary-absent' })
  })

  test('daemon down', async () => {
    const stderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n'
    const { run } = scripted({ ...HEALTHY, docker: exited(1, '', stderr) })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker.status).toBe('unavailable')
    expect(p.docker.reason).toBe('daemon-down')
  })

  test('permission denied on the socket (checked before daemon-down, whose words it also contains)', async () => {
    const stderr =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/version": dial unix /var/run/docker.sock: connect: permission denied\n'
    const { run } = scripted({ ...HEALTHY, docker: exited(1, '', stderr) })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker.status).toBe('unavailable')
    expect(p.docker.reason).toBe('permission-denied')
  })

  test('ok reports the server version', async () => {
    const { run, calls } = scripted(HEALTHY)
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker).toEqual({ status: 'available', serverVersion: '29.3.0' })
    expect(calls).toContainEqual([...DOCKER_PROBE_ARGV])
  })

  test('exit 0 with an empty server version is not available', () => {
    expect(classifyDocker(exited(0, '')).status).toBe('unknown')
  })

  test('an unrecognised failure is unknown, never available', async () => {
    const { run } = scripted({ ...HEALTHY, docker: exited(1, '', 'something odd happened') })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker.status).toBe('unknown')
    expect(p.docker.reason).toBe('probe-failed')
  })

  test('a probe that crashed is unknown', async () => {
    const { run } = scripted({ ...HEALTHY, docker: { kind: 'crashed', message: 'boom' } })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker).toEqual({ status: 'unknown', reason: 'probe-failed', detail: 'boom' })
  })

  test('a timed-out probe is unknown', async () => {
    const { run } = scripted({ ...HEALTHY, docker: { kind: 'timed-out' } })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.docker).toEqual({ status: 'unknown', reason: 'timed-out' })
  })

  test('a runner that THROWS is contained: unknown, and probeSandbox resolves', async () => {
    const run: CommandRunner = async () => {
      throw new Error('runner exploded')
    }
    const p = await probeSandbox({ run, platform: 'linux', readText: () => { throw new Error('nope') } })
    expect(p.docker.status).toBe('unknown')
    expect(p.prlimit.status).toBe('unknown')
    expect(p.ulimit.status).toBe('unknown')
    expect(p.wsl).toBeNull()
    expect(p.informational.landlock.status).toBe('unknown')
  })
})

describe('probeSandbox — prlimit and ulimit', () => {
  test('both available on a healthy Linux, with the exact fixed argv', async () => {
    const { run, calls } = scripted(HEALTHY)
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.prlimit).toEqual({ status: 'available' })
    expect(p.ulimit.status).toBe('available')
    expect(p.ulimit.flags).toEqual({ cpu: '-t', addressSpace: '-v', fileSize: '-f', openFiles: '-n', processes: '-u' })
    expect(calls).toContainEqual([...PRLIMIT_PROBE_ARGV])
    expect(calls).toContainEqual([...ULIMIT_PROBE_ARGV])
  })

  test('prlimit absent', async () => {
    const { run } = scripted({ ...HEALTHY, prlimit: { kind: 'not-found' } })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.prlimit).toEqual({ status: 'unavailable', reason: 'not-found' })
  })

  test('prlimit refusing is unavailable with the stderr line', async () => {
    const { run } = scripted({ ...HEALTHY, prlimit: exited(1, '', 'prlimit: failed to set the NOFILE resource limit: Operation not permitted\n') })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.prlimit.status).toBe('unavailable')
    expect(p.prlimit.reason).toBe('refused')
    expect(p.prlimit.detail).toContain('Operation not permitted')
  })

  test('prlimit is not even asked off Linux', async () => {
    const { run, calls } = scripted(HEALTHY)
    const p = await probeSandbox({ run, platform: 'darwin', readText: texts({}) })
    expect(p.prlimit).toEqual({ status: 'unavailable', reason: 'not-linux' })
    expect(calls.some((c) => c[0] === 'prlimit')).toBe(false)
    expect(calls.some((c) => c[0] === 'unshare')).toBe(false)
  })

  test('no POSIX sh', async () => {
    const { run } = scripted({ ...HEALTHY, sh: { kind: 'not-found' } })
    const p = await probeSandbox({ run, platform: 'win32', readText: texts({}) })
    expect(p.ulimit).toEqual({ status: 'unavailable', reason: 'no-posix-sh' })
  })

  test('dash: -u rejected, -p is the process limit', () => {
    expect(parseUlimitFlags('t v f n p ').processes).toBe('-p')
  })

  test('bash: -u wins even though -p (pipe size) is readable', () => {
    expect(parseUlimitFlags('t v f n u p ').processes).toBe('-u')
  })

  test('a shell that accepts no flag is unavailable', async () => {
    const { run } = scripted({ ...HEALTHY, sh: exited(0, '') })
    const p = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(p.ulimit.status).toBe('unavailable')
    expect(p.ulimit.reason).toBe('refused')
  })
})

describe('probeSandbox — informational facts', () => {
  test('WSL from /proc/version, and the note is always present', async () => {
    const { run } = scripted(HEALTHY)
    const p = await probeSandbox({
      run,
      platform: 'linux',
      readText: texts({ '/proc/version': 'Linux version 5.15.167.4-microsoft-standard-WSL2 (...)' }),
    })
    expect(p.wsl).toBe(true)
    expect(p.informational.note).toBe(INFORMATIONAL_NOTE)
    expect(p.informational.note).toContain('Informational only')
  })

  test('plain Linux is not WSL; non-Linux is never WSL', async () => {
    const { run } = scripted(HEALTHY)
    expect((await probeSandbox({ run, platform: 'linux', readText: texts({ '/proc/version': 'Linux version 6.8.0-generic' }) })).wsl).toBe(false)
    expect((await probeSandbox({ run, platform: 'darwin', readText: texts({}) })).wsl).toBe(false)
  })

  test('landlock listed in the LSMs is available with abi null; unreadable securityfs is unknown', async () => {
    const { run } = scripted(HEALTHY)
    const listed = await probeSandbox({ run, platform: 'linux', readText: texts({ '/sys/kernel/security/lsm': 'lockdown,capability,landlock,yama\n' }) })
    expect(listed.informational.landlock.status).toBe('available')
    expect(listed.informational.landlock.abi).toBeNull()
    const absent = await probeSandbox({ run, platform: 'linux', readText: texts({ '/sys/kernel/security/lsm': 'capability,yama' }) })
    expect(absent.informational.landlock).toEqual({ status: 'unavailable', reason: 'not-enabled', abi: null })
    const unreadable = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(unreadable.informational.landlock.status).toBe('unknown')
  })

  test('user namespaces: exercised with the fixed unshare argv', async () => {
    const { run, calls } = scripted(HEALTHY)
    const ok = await probeSandbox({ run, platform: 'linux', readText: texts({}) })
    expect(ok.informational.userNamespaces).toEqual({ status: 'available' })
    expect(calls).toContainEqual([...USERNS_PROBE_ARGV])
    const { run: denied } = scripted({ ...HEALTHY, unshare: exited(1, '', 'unshare: unshare failed: Operation not permitted') })
    const no = await probeSandbox({ run: denied, platform: 'linux', readText: texts({}) })
    expect(no.informational.userNamespaces.status).toBe('unavailable')
    const { run: missing } = scripted({ ...HEALTHY, unshare: { kind: 'not-found' } })
    expect((await probeSandbox({ run: missing, platform: 'linux', readText: texts({}) })).informational.userNamespaces.status).toBe('unknown')
  })
})
