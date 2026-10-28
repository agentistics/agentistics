import { afterAll, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { buildThrowawayEnv, isRealAgentopPort, releaseThrowawayPorts, reserveThrowawayPorts, runRun, createRunTmp, removeRunTmp, RUN_TMP_PREFIX, SOCKET_PATH_MAX } from './cli-run'
import { insideHeavyLock } from './resources/mem-guard'

const testHome = mkdtempSync(join(tmpdir(), 'agentop-run-ports-'))
const originalHome = process.env.HOME
process.env.HOME = testHome
afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  rmSync(testHome, { recursive: true, force: true })
})

const canBindLocalhost = await new Promise<boolean>(resolve => {
  const server = createServer()
  server.once('error', () => resolve(false))
  server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
})
const integration = canBindLocalhost ? test : test.skip

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to obtain a test port')
  const port = address.port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

function runCli(home: string, args: string[]) {
  return new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, ['packages/server/bin/cli.ts', 'run', ...args], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    child.once('exit', code => resolve({ code, out }))
  })
}

describe('agentop run --rm', () => {
  test('TMPDIR is short enough for a Unix socket even under a long throwaway home', () => {
    const home = join('/home/mithrandir/.cache/agentistics-throwaway', 'qa-codex-galeria-with-a-long-name-abcdef12-XXXXXX')
    const tmp = createRunTmp()
    try {
      const env = buildThrowawayEnv(home, 'x', 48100, 48101, { HOME: '/h' }, { tmp })
      expect(env.TMPDIR).toBe(tmp)
      expect(tmp).toMatch(/^\/tmp\/agr-[A-Za-z0-9]{6}$/)
      expect(statSync(tmp).mode & 0o777).toBe(0o700)
      expect(Buffer.byteLength(`${tmp}/org.chromium.Chromium.AbCdEf/SingletonSocket`)).toBeLessThanOrEqual(SOCKET_PATH_MAX)
    } finally { removeRunTmp(tmp) }
    const env = buildThrowawayEnv(home, 'x', 48100, 48101, { HOME: '/h' }, { tmp: '/tmp/agr-AbCdEf' })
    expect(env.TMUX_TMPDIR).toBe(env.TMPDIR)
    expect(Buffer.byteLength(`${env.TMPDIR}/org.chromium.Chromium.AbCdEf/SingletonSocket`)).toBeLessThanOrEqual(SOCKET_PATH_MAX)
  })

  test('the run TMPDIR is created exclusively: never reuses a pre-existing dir or symlink', () => {
    const a = createRunTmp(), b = createRunTmp()
    try {
      expect(a).not.toBe(b)
      // a planted symlink at any agr- name is never what mkdtemp hands back
      const outside = mkdtempSync(join(tmpdir(), 'agentop-run-outside-'))
      const link = `${RUN_TMP_PREFIX}planted${process.pid}`
      symlinkSync(outside, link)
      try {
        const c = createRunTmp()
        expect(c).not.toBe(link)
        expect(lstatSync(c).isSymbolicLink()).toBe(false)
        removeRunTmp(c)
        // removal never follows the link: the link goes, the target and its content stay
        writeFileSync(join(outside, 'keep'), 'x')
        removeRunTmp(link)
        expect(existsSync(link)).toBe(false)
        expect(existsSync(join(outside, 'keep'))).toBe(true)
      } finally { rmSync(link, { force: true }); rmSync(outside, { recursive: true, force: true }) }
    } finally { removeRunTmp(a); removeRunTmp(b) }
  })

  test('removeRunTmp only removes agr- dirs directly under /tmp', () => {
    const foreign = mkdtempSync(join(tmpdir(), 'agentop-run-foreign-'))
    try {
      removeRunTmp(foreign); removeRunTmp(`${RUN_TMP_PREFIX}../${foreign}`); removeRunTmp(undefined)
      expect(existsSync(foreign)).toBe(true)
    } finally { rmSync(foreign, { recursive: true, force: true }) }
  })

  test('state.tmp is removed when the command cannot be spawned', async () => {
    const before = new Set(readdirSync('/tmp').filter(n => n.startsWith('agr-')))
    const { code } = await runCli(testHome, ['--rm', '--', '/nonexistent/bin/xyz'])
    expect(code).not.toBe(0)
    expect(readdirSync('/tmp').filter(n => n.startsWith('agr-') && !before.has(n))).toEqual([])
  })

  test('children of a run that holds the heavy lock are told so', () => {
    expect(buildThrowawayEnv('/t', 'x', 1, 2, {}, { heavyHeld: true }).AGENTISTICS_HEAVY_JOB).toBe('1')
    expect(buildThrowawayEnv('/t', 'x', 1, 2, {}).AGENTISTICS_HEAVY_JOB).toBeUndefined()
    expect(insideHeavyLock(buildThrowawayEnv('/t', 'x', 1, 2, {}, { heavyHeld: true }), [])).toBe(true)
    for (const v of ['0', '', 'true', 'yes']) expect(insideHeavyLock({ AGENTISTICS_HEAVY_JOB: v }, [])).toBe(false)
  })

  test('pins the original Volta installation while isolating HOME and run state', () => {
    const sourceHome = join(testHome, 'volta-owner')
    mkdirSync(join(sourceHome, '.volta'), { recursive: true })
    const source = { HOME: sourceHome, PATH: '/tools/bin:/usr/bin', AGENTISTICS_DIR: '/original/state' }
    const env = buildThrowawayEnv('/throwaway', 'test-env', 48100, 48101, source)
    expect(env.VOLTA_HOME).toBe(join(sourceHome, '.volta'))
    expect(env.HOME).toBe('/throwaway')
    expect(env.USERPROFILE).toBe('/throwaway')
    expect(env.AGENTISTICS_DIR).toBe('/throwaway/.agentistics')
    expect(env.TMPDIR).toMatch(/^\/tmp\/agr-/)
    expect(env.TMUX_TMPDIR).toBe(env.TMPDIR)
    expect(env.PORT).toBe('48100')
    expect(env.WEB_PORT).toBe('48101')
    expect(env.AGENTISTICS_THROWAWAY).toBe('test-env')
    expect(env.PATH).toBe(source.PATH)
    expect(source.HOME).toBe(sourceHome)
    expect(source).not.toHaveProperty('VOLTA_HOME')
  })

  test('preserves an explicit custom VOLTA_HOME', () => {
    const env = buildThrowawayEnv('/throwaway', 'custom-volta', 48100, 48101, { HOME: testHome, VOLTA_HOME: '/custom/volta' })
    expect(env.VOLTA_HOME).toBe('/custom/volta')
  })

  test('finds Volta through USERPROFILE when HOME is absent', () => {
    const sourceHome = join(testHome, 'volta-profile')
    mkdirSync(join(sourceHome, '.volta'), { recursive: true })
    const env = buildThrowawayEnv('/throwaway', 'profile', 48100, 48101, { USERPROFILE: sourceHome })
    expect(env.VOLTA_HOME).toBe(join(sourceHome, '.volta'))
  })

  test('does not invent a Volta installation when the original home has none', () => {
    const env = buildThrowawayEnv('/throwaway', 'no-volta', 48100, 48101, { HOME: join(testHome, 'no-volta') })
    expect(env).not.toHaveProperty('VOLTA_HOME')
  })

  test('never selects the real API or web ports', () => {
    expect(isRealAgentopPort(47291)).toBe(true)
    expect(isRealAgentopPort(47292)).toBe(true)
    expect(isRealAgentopPort(47290)).toBe(false)
    expect(isRealAgentopPort(47293)).toBe(false)
  })

  integration('gives concurrent allocations distinct port sets', async () => {
    const base = await availablePort()
    const [first, second] = await Promise.all([reserveThrowawayPorts(base), reserveThrowawayPorts(base)])
    try {
      expect(first.apiPort).not.toBe(second.apiPort)
      expect(first.webPort).not.toBe(second.webPort)
      expect([first.apiPort, first.webPort].some(port => port === second.apiPort || port === second.webPort)).toBe(false)
    } finally {
      releaseThrowawayPorts(first.reservationPaths)
      releaseThrowawayPorts(second.reservationPaths)
    }
  })

  integration('reclaims a reservation owned by a dead PID', async () => {
    const stale = await reserveThrowawayPorts(await availablePort())
    releaseThrowawayPorts(stale.reservationPaths)
    mkdirSync(stale.reservationPaths[0]!, { recursive: true, mode: 0o700 })
    writeFileSync(join(stale.reservationPaths[0]!, 'reservation.json'), JSON.stringify({ pid: 999_999_999 }), { mode: 0o600 })
    const reclaimed = await reserveThrowawayPorts(stale.apiPort)
    try {
      expect(reclaimed.apiPort).toBe(stale.apiPort)
      expect(reclaimed.webPort).toBe(stale.webPort)
    } finally {
      releaseThrowawayPorts(reclaimed.reservationPaths)
    }
  })

  integration('skips a port that is already bound', async () => {
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', () => resolve()))
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('failed to obtain a test port')
    try {
      const ports = await reserveThrowawayPorts(address.port)
      try { expect(ports.apiPort).not.toBe(address.port) } finally { releaseThrowawayPorts(ports.reservationPaths) }
    } finally {
      await new Promise<void>(resolve => occupied.close(() => resolve()))
    }
  })

  integration('does not mutate a fake real home and removes the throwaway home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-real-'))
    const realFile = join(home, '.claude.json')
    await Bun.write(realFile, '{"real":true}')
    const before = statSync(realFile).mtimeMs
    const result = await runCli(home, ['--rm', '--name', 'test-cleanup', '--ttl', '30s', '--', 'sh', '-c', 'test -d "$HOME/.agentistics" && test -d "$HOME/.claude"'])
    expect(result.code).toBe(0)
    expect(statSync(realFile).mtimeMs).toBe(before)
    expect(result.out).toContain('removed')
    expect(result.out).toContain('api:')
    expect(result.out).toContain('web:')
  }, 15_000)

  integration('TTL kills a command and still removes its home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-ttl-'))
    const result = await runCli(home, ['--rm', '--name', 'test-ttl', '--ttl', '1s', '--', 'sleep', '30'])
    expect(result.code).not.toBe(0)
    const lines = result.out.split('\n')
    const removed = lines.find(line => line.startsWith('removed '))
    expect(removed).toBeTruthy()
    const removedHome = removed!.slice('removed '.length)
    expect(() => readFileSync(join(removedHome, '.agentistics', 'missing'))).toThrow()
  }, 10_000)

  integration('refuses a --port-offset that lands on the real ports', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-offset-'))
    for (const offset of ['0', '1']) {
      const result = await runCli(home, ['--rm', '--name', `test-offset-${offset}`, '--port-offset', offset, '--', 'true'])
      expect(result.code).toBe(2)
      expect(result.out).toContain('refused')
    }
  }, 15_000)

  integration('SIGTERM stops the command and removes the throwaway home before exiting', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agentop-run-sig-'))
    const child = spawn(process.execPath, ['packages/server/bin/cli.ts', 'run', '--rm', '--name', 'test-sig', '--', 'sleep', '30'], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { out += data })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    for (let i = 0; i < 100 && !out.includes('stop:'); i++) await Bun.sleep(100)
    await Bun.sleep(500)
    child.kill('SIGTERM')
    expect(await exited).toBe(143)
    expect(out).toContain('removed ')
  }, 15_000)
})

describe('agentop run --help', () => {
  for (const flag of ['--help', '-h']) {
    test(`${flag} prints usage and exits 0`, async () => {
      const lines: string[] = []
      const orig = console.log
      console.log = (...a: unknown[]) => { lines.push(a.join(' ')) }
      try { expect(await runRun([flag])).toBe(0) } finally { console.log = orig }
      expect(lines.join('\n')).toContain('Usage: agentop run')
    })
  }
})
