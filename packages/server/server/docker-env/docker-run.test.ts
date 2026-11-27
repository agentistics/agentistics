/**
 * DOCKER.AMBIENTES S2 — the §3.3 orchestration against a FAKE `docker` binary (`fake-docker.testing.ts`), asserting the
 * exact argv it was given and the order `create → inspect → start`. No real Docker is touched here.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENV_IMAGES } from '@agentistics/core'
import { runInDocker, GIB } from './docker-run'
import { readLedger } from './ledger'

const FAKE_TS = join(import.meta.dir, 'fake-docker.testing.ts')
setDefaultTimeout(60_000)
let FAKE = ''
const BUN = ENV_IMAGES.find(i => i.key === 'bun-1.3')!

let dir: string, data: string, repo: string, log: string, state: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentistics-s2-unit-'))
  data = join(dir, 'data'); repo = join(dir, 'repo'); log = join(dir, 'docker.log'); state = join(dir, 'state.json')
  mkdirSync(data); mkdirSync(repo)
  spawnSync('git', ['init', '-q', repo])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['packages/*'] }))
  mkdirSync(join(repo, 'packages', 'core'), { recursive: true })
  writeFileSync(join(repo, 'packages', 'core', 'package.json'), '{}')
  writeFileSync(join(repo, '.env'), 'TOKEN=SENTINELA-ENV')
  writeFileSync(state, '{}')
  // the fake runs under THIS bun, by absolute path (a PATH lookup of `bun` may hit a version-manager shim)
  FAKE = join(dir, 'docker')
  writeFileSync(FAKE, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_TS}' "$@"\n`, { mode: 0o755 })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, AGENTISTICS_DOCKER_BIN: FAKE, AGENTISTICS_FAKE_DOCKER_LOG: log, AGENTISTICS_FAKE_DOCKER_STATE: state, GITHUB_TOKEN: 'SENTINELA-GH' })
const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
const st = (): any => JSON.parse(readFileSync(state, 'utf8'))
const setState = (patch: object) => writeFileSync(state, JSON.stringify({ ...st(), ...patch }))
const run = (over: Partial<Parameters<typeof runInDocker>[0]> = {}) => runInDocker({
  command: ['bun', 'test'], cwd: repo, ttlSec: 60, dataDir: data, env: env(), memAvailable: () => 10 * GIB, memTotal: () => 12 * GIB, log: () => {}, ...over,
})

describe('docker backend orchestration (fake docker)', () => {
  test('per-run: create → inspect → start, exact security argv, volumes proven then removed, nothing built', async () => {
    const r = await run()
    expect(r).toMatchObject({ ran: true, code: 0, perRun: true })
    const c = calls()
    expect(c.some(a => a[0] === 'build' || a[0] === 'buildx' || a.includes('build'))).toBe(false)
    const createAt = c.findIndex(a => a[0] === 'create' && a.some(x => /-cmd-/.test(x)))
    const create = c[createAt]!
    for (const [f, v] of [['--network', 'none'], ['--entrypoint', '/opt/agentistics/exec-wrap'], ['--cap-drop', 'ALL'], ['--user', `${process.getuid!()}:${process.getgid!()}`]] as const) expect(create[create.indexOf(f) + 1]).toBe(v)
    expect(create).toContain('--read-only')
    expect(create.join(' ')).not.toMatch(/docker\.sock|(^| )-p |--publish/)
    expect(create.slice(-3)).toEqual(['60', 'bun', 'test'])
    // the nm mounts are read-only
    const nm = create.filter(x => x.includes('-nm-'))
    expect(nm.length).toBe(2)
    expect(nm.every(x => x.endsWith(',readonly'))).toBe(true)
    // the .env of the worktree is masked
    expect(create).toContain(`type=bind,source=/dev/null,target=${repo}/.env,readonly`)
    const id = Object.entries(st().containers).find(([, v]: any) => v.argv.includes(create[3]))![0]
    const inspectAt = c.findIndex(a => a[0] === 'inspect' && a[1] === id)
    const startAt = c.findIndex(a => a[0] === 'start' && a.includes(id))
    expect(createAt).toBeLessThan(inspectAt)
    expect(inspectAt).toBeLessThan(startAt)
    // the env file was deleted after create, and never carried the launcher's secret
    expect(existsSync(create[create.indexOf('--env-file') + 1]!)).toBe(false)
    expect(readFileSync(log, 'utf8')).not.toMatch(/SENTINELA/)
    // volumes: inspect said "no such volume" BEFORE each create; removed at the end (per-run)
    for (const kind of ['scratch', 'nm']) {
      const vc = c.findIndex(a => a[0] === 'volume' && a[1] === 'create' && a[a.length - 1]!.includes(`-${kind}-`))
      const name = c[vc]!.at(-1)!
      expect(c.findIndex(a => a[0] === 'volume' && a[1] === 'inspect' && a[2] === name)).toBeLessThan(vc)
      expect(c.some(a => a[0] === 'volume' && a[1] === 'rm' && a[2] === name)).toBe(true)
    }
    expect(Object.keys(st().volumes)).toEqual([])
    expect(c.some(a => a[0] === 'pull' && a[1] === BUN.ref)).toBe(true)
    const ledger = readLedger(data)
    const s = Object.values(ledger.sessions)[0]!
    expect(s.state).toBe('removido')
    expect(Object.keys(s.execs)).toEqual([])
    expect(s.containers.filter(x => x.nmWritable).every(x => x.kind === 'init')).toBe(true)
  })

  test('a container whose inspect differs from its plan is removed by id and never started', async () => {
    setState({ tamper: { network: 'bridge' } })
    const r = await run()
    expect(r).toMatchObject({ ran: false, fallback: false })
    expect((r as any).reason).toMatch(/NetworkMode/)
    const c = calls()
    expect(c.some(a => a[0] === 'start')).toBe(false)
    expect(c.some(a => a[0] === 'rm' && a[1] === '-f')).toBe(true)
  })

  test('the image entrypoint swapped by the daemon is refused before start', async () => {
    setState({ tamper: { path: '/usr/local/bin/docker-entrypoint.sh' } })
    expect((await run() as any).reason).toMatch(/Path/)
    expect(calls().some(a => a[0] === 'start')).toBe(false)
  })

  test('an image whose ONBUILD is not empty, or whose digest is not the catalogue one, falls back to the namespace', async () => {
    setState({ images: { [BUN.ref]: { onBuild: ['RUN x'] } } })
    expect(await run()).toMatchObject({ ran: false, fallback: true })
    setState({ images: { [BUN.ref]: { digest: 'oven/bun@sha256:' + 'f'.repeat(64) } } })
    const r = await run()
    expect(r).toMatchObject({ ran: false, fallback: true })
    expect(calls().some(a => a[0] === 'create')).toBe(false)
  })

  test('env.yml with a digest / FROM / build falls back with the sentence and creates nothing', async () => {
    for (const text of ['image: oven/bun@sha256:' + 'a'.repeat(64), 'FROM node', 'build: .']) {
      mkdirSync(join(repo, '.agentistics'), { recursive: true })
      writeFileSync(join(repo, '.agentistics', 'env.yml'), text)
      const r = await run()
      expect(r).toMatchObject({ ran: false, fallback: true })
      expect((r as any).reason).toMatch(/namespace/)
    }
    expect(calls().length).toBe(0)
  })

  test('a pre-existing volume name ⇒ volume_preexistente, nothing created for it, not adopted', async () => {
    // a proven session, so the volume name is predictable
    writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: 'sessA' }]))
    const inst = (await import('./ledger')).installId(data).slice(0, 8)
    setState({ volumes: { [`agentistics-${inst}-scratch-sessA`]: { labels: { owner: 'user' }, createdAt: '2020-01-01T00:00:00Z' } } })
    const r = await run({ env: { ...env(), AGENTOP_MANAGED_ID: 'sessA' }, tmuxPanes: () => `agentop-sessA\t${process.pid}\n` })
    expect(r).toMatchObject({ ran: false, code: 4 })
    expect((r as any).reason).toMatch(/volume_preexistente/)
    expect(calls().some(a => a[0] === 'volume' && a[1] === 'create')).toBe(false)
    expect(st().volumes[`agentistics-${inst}-scratch-sessA`].labels).toEqual({ owner: 'user' })
  })

  test('a volume that comes back with foreign labels (P11 silent create) ⇒ volume_nao_nosso', async () => {
    setState({ foreignOnCreate: true })
    const r = await run()
    expect((r as any).reason).toMatch(/volume_nao_nosso/)
    expect(calls().some(a => a[0] === 'create' && a.some(x => /-cmd-/.test(x)))).toBe(false)
  })

  test('a proven session keeps its volumes between commands; a forged id+cwd runs per-run and never touches them', async () => {
    writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: 'sessA', cwd: repo }, { id: 'sessB', cwd: repo }]))
    const a = await run({ env: { ...env(), AGENTOP_MANAGED_ID: 'sessA' }, tmuxPanes: () => `agentop-sessA\t${process.pid}\n` })
    expect(a).toMatchObject({ ran: true, sessionId: 'sessA', perRun: false })
    const kept = Object.keys(st().volumes)
    expect(kept.length).toBe(2)
    // a second command reuses them (no new volume create)
    const before = calls().filter(x => x[0] === 'volume' && x[1] === 'create').length
    await run({ env: { ...env(), AGENTOP_MANAGED_ID: 'sessA' }, tmuxPanes: () => `agentop-sessA\t${process.pid}\n` })
    expect(calls().filter(x => x[0] === 'volume' && x[1] === 'create').length).toBe(before)
    // forged: claims sessB (same cwd) but sessB's root is not our ancestor
    const f = await run({ env: { ...env(), AGENTOP_MANAGED_ID: 'sessB' }, tmuxPanes: () => 'agentop-sessB\t999999\n' })
    expect(f).toMatchObject({ ran: true, perRun: true })
    expect(Object.keys(st().volumes).sort()).toEqual(kept.sort())
    expect(Object.keys(readLedger(data).sessions)).not.toContain('sessB')
  })

  test('a session being cleaned admits no command (AMB_LIMPANDO)', async () => {
    writeFileSync(join(data, 'managed-sessions.json'), JSON.stringify([{ id: 'sessA' }]))
    const { withLedger, emptySession } = await import('./ledger')
    withLedger(data, l => { l.sessions.sessA = { ...emptySession(false, new Date().toISOString()), state: 'limpando' } })
    const r = await run({ env: { ...env(), AGENTOP_MANAGED_ID: 'sessA' }, tmuxPanes: () => `agentop-sessA\t${process.pid}\n` })
    expect((r as any).reason).toMatch(/AMB_LIMPANDO/)
    expect(calls().some(a => a[0] === 'create')).toBe(false)
  })

  test('not enough memory refuses before any docker call', async () => {
    const r = await run({ memAvailable: () => 4 * GIB })
    expect(r).toMatchObject({ ran: false, fallback: false, code: 3 })
    expect(calls().length).toBe(0)
  })

  test('the disk watchdog kills the command and says the overshoot', async () => {
    setState({ sleepMs: 3000 })
    const lines: string[] = []
    // every volume reports 5 GB
    const orig = st(); writeFileSync(state, JSON.stringify({ ...orig, sizeAll: true }))
    const r = await run({ diskEveryMs: 300, diskLimits: { sessionMax: 1, freeFloor: 0 }, log: s => lines.push(s) })
    expect(r).toMatchObject({ ran: true })
    const c = calls()
    expect(c.some(a => a[0] === 'kill' && a[1] === '--signal' && a[2] === 'TERM')).toBe(true)
    expect(lines.join('\n')).toMatch(/ceiling; the command was stopped.*overshoot/s)
  })

  test('the opt helpers are written read-only and exec-wrap applies the TTL inside', async () => {
    await run()
    const opt = join(data, 'docker', 'opt')
    expect(readdirSync(opt).sort()).toEqual(['exec-wrap', 'fwd.mjs'])
    expect(readFileSync(join(opt, 'exec-wrap'), 'utf8')).toMatch(/exec timeout -s TERM -k 10 "\$ttl" "\$@"/)
  })
})
