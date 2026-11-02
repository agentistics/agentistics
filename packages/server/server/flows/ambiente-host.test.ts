import { beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ambienteHostOps, carriesPort, defaultAmbienteDeps, purgeCopies, type AmbienteDeps } from './ambiente-host'
import type { ThrowawayState } from '../cli-run'
import { gitEnv } from '../backup/repo-probe'

// gitEnv() drops GIT_DIR/GIT_INDEX_FILE: under a git hook they point at the REAL repository, and these fixtures commit, branch and push.
const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: gitEnv() }).trim()
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))

/** A local origin --bare + a clone with a main commit, a second main commit, and a commit that lives only on a branch. */
function repo() {
  const origin = tmp('amb-origin-'), root = join(tmp('amb-root-'), 'r')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: gitEnv() })
  execFileSync('git', ['clone', '-q', origin, root], { env: gitEnv() })
  writeFileSync(join(root, 'a'), '1'); g(root, 'add', '.'); g(root, 'commit', '-qm', 'one')
  const c1 = g(root, 'rev-parse', 'HEAD')
  writeFileSync(join(root, 'a'), '2'); g(root, 'commit', '-qam', 'two')
  const c2 = g(root, 'rev-parse', 'HEAD')
  g(root, 'push', '-q', 'origin', 'main')
  g(root, 'checkout', '-qb', 'only-branch'); writeFileSync(join(root, 'b'), 'b'); g(root, 'add', '.'); g(root, 'commit', '-qm', 'branch')
  const cb = g(root, 'rev-parse', 'HEAD'); g(root, 'checkout', '-q', 'main')
  return { origin, root, c1, c2, cb }
}

function deps(over: Partial<AmbienteDeps> = {}): AmbienteDeps & { stopped: string[]; launched: string[][]; killed: number[] } {
  const stopped: string[] = [], launched: string[][] = [], killed: number[] = []
  const base = defaultAmbienteDeps()
  return {
    ...base, dataDir: tmp('amb-data-'), home: tmp('amb-home-'), env: { XDG_RUNTIME_DIR: '/run/user/1' }, platform: 'linux',
    hasSystemdRun: () => true, memAvailable: () => 8 * 1024 ** 3, ancestors: () => [], lockFds: () => [],
    registry: async () => [], accountRoots: async () => [], runOwned: () => [], pidsWithLock: () => [],
    readState: () => null, stopRun: async s => { stopped.push(s.name) }, launch: argv => { launched.push(argv); return 4242 },
    fetchVersionOk: async () => true, sleep: async () => {}, killLauncher: p => { killed.push(p) }, cliHead: () => ['/bin/agentop'], stopped, launched, killed, ...over,
  }
}
const state = (over: Partial<ThrowawayState> = {}): ThrowawayState => ({ name: 'amb-xyz', home: tmp('amb-runhome-'), apiPort: 48100, webPort: 48101, startedAt: '', command: [], ...over })
const refused = (r: unknown) => r as { refused?: boolean; code?: string }

describe('ambiente-repo / base / worktree (I1–I3)', () => {
  test('I1 repo comes from the registry only; unknown => AMB_REPO', async () => {
    const f = repo()
    const ops = ambienteHostOps(deps({ registry: async () => [{ id: 's', cwd: f.root, repo: { repo: 'meu', rootPath: f.root, worktree: false } }] }))
    expect(refused(await ops['ambiente-repo']({ repo: 'outro' })).code).toBe('AMB_REPO')
    expect(await ops['ambiente-repo']({ repo: 'meu' })).toMatchObject({ ok: true, rootPath: f.root })
    expect(refused(await ops['ambiente-base']({ root: f.root, base: '../../etc' })).code).toBe('AMB_BASE')
  })
  test('I2 base on main is accepted (default = origin/main tip); base only on a branch is refused; no remote => AMB_REMOTO', async () => {
    const f = repo(); const ops = ambienteHostOps(deps())
    expect(await ops['ambiente-base']({ root: f.root })).toMatchObject({ ok: true, sha: f.c2 })
    expect(await ops['ambiente-base']({ root: f.root, base: f.c1 })).toMatchObject({ ok: true, sha: f.c1 })
    expect(refused(await ops['ambiente-base']({ root: f.root, base: f.cb })).code).toBe('AMB_BASE')
    g(f.root, 'remote', 'set-url', 'origin', '/nonexistent/x.git')
    expect(refused(await ops['ambiente-base']({ root: f.root, base: f.c1 })).code).toBe('AMB_REMOTO')
  })
  test('I2/I3 worktree: new branch amb/<nome> at exactly B inside <root>/.worktrees/amb-<nome>; branch or folder in use refuses and creates nothing', async () => {
    const f = repo(); const ops = ambienteHostOps(deps())
    const ok = await ops['ambiente-worktree']({ root: f.root, nome: 'aaa', sha: f.c1 }) as { worktree: string; branch: string; head: string }
    expect(ok.worktree).toBe(join(f.root, '.worktrees', 'amb-aaa'))
    expect(ok.branch).toBe('amb/aaa')
    expect(g(ok.worktree, 'rev-parse', 'HEAD')).toBe(f.c1)
    expect(refused(await ops['ambiente-worktree']({ root: f.root, nome: 'aaa', sha: f.c1 })).code).toBe('AMB_BRANCH')
    g(f.root, 'branch', 'amb/bbb', f.c1)
    expect(refused(await ops['ambiente-worktree']({ root: f.root, nome: 'bbb', sha: f.c1 })).code).toBe('AMB_BRANCH')
    mkdirSync(join(f.root, '.worktrees', 'amb-ccc'), { recursive: true })
    expect(refused(await ops['ambiente-worktree']({ root: f.root, nome: 'ccc', sha: f.c1 })).code).toBe('AMB_PASTA')
    expect(g(f.root, 'branch', '--list', 'amb/ccc')).toBe('')
    expect(refused(await ops['ambiente-worktree']({ root: f.root, nome: 'Bad Name', sha: f.c1 })).code).toBe('AMB_ENTRADA')
  })
})

describe('preflight (I5–I7, I16)', () => {
  test('I5 no systemd-run / no XDG_RUNTIME_DIR / not linux => AMB_SEM_TETO', async () => {
    expect(refused(await ambienteHostOps(deps({ hasSystemdRun: () => false }))['ambiente-preflight']({})).code).toBe('AMB_SEM_TETO')
    expect(refused(await ambienteHostOps(deps({ env: {} }))['ambiente-preflight']({})).code).toBe('AMB_SEM_TETO')
    expect(refused(await ambienteHostOps(deps({ platform: 'darwin' }))['ambiente-preflight']({})).code).toBe('AMB_SEM_TETO')
  })
  test('I6 2.5 GiB available => AMB_MEMORIA at once, nothing on disk', async () => {
    const d = deps({ memAvailable: () => 2.5 * 1024 ** 3 })
    expect(refused(await ambienteHostOps(d)['ambiente-preflight']({})).code).toBe('AMB_MEMORIA')
    expect(existsSync(join(d.dataDir, 'flows'))).toBe(false)
  })
  test('I7 the third ambiente is refused (AMBIENTE_MAX = 2)', async () => {
    const ops = ambienteHostOps(deps())
    expect(await ops['ambiente-preflight']({ noAr: 1 })).toMatchObject({ ok: true })
    expect(refused(await ops['ambiente-preflight']({ noAr: 2 })).code).toBe('AMB_LIMITE')
  })
  test('I16 heavy env, flock ancestor or inherited fd => AMB_LOCK', async () => {
    expect(refused(await ambienteHostOps(deps({ env: { XDG_RUNTIME_DIR: '/r', AGENTISTICS_HEAVY_JOB: '1' } }))['ambiente-preflight']({})).code).toBe('AMB_LOCK')
    expect(refused(await ambienteHostOps(deps({ ancestors: () => ['flock -o /tmp/agentistics-heavy.lock x'] }))['ambiente-preflight']({})).code).toBe('AMB_LOCK')
    expect(refused(await ambienteHostOps(deps({ lockFds: () => [9] }))['ambiente-preflight']({})).code).toBe('AMB_LOCK')
  })
})

describe('run (I4, I15, I17)', () => {
  test('happy path launches --serve with --cwd/--seed-real and never wraps in heavy (I15)', async () => {
    const d = deps({ readState: () => state() }); const wt = tmp('amb-wt-')
    const r = await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: wt, semente: 'copia', comando: ['bun', 'run', 'dev'] }) as { ok?: boolean; run?: { apiPort: number }; saida?: string }
    expect(r.ok).toBe(true); expect(r.run?.apiPort).toBe(48100)
    const argv = d.launched[0]!
    expect(argv).toContain('--serve'); expect(argv).not.toContain('heavy')
    expect(argv[argv.indexOf('--cwd') + 1]).toBe(wt)
    expect(argv).toContain('--seed-real'); expect(argv).not.toContain('--seed-from')
    expect(argv.slice(0, 2)).toEqual(['/bin/agentop', 'run'])
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(['bun', 'run', 'dev'])
    expect(existsSync(r.saida!)).toBe(true)
  })
  test('I4 a portOffset landing on 47291/47292 is refused before launching; a run state with a real port is stopped (AMB_PORTA)', async () => {
    const d = deps(); const ops = ambienteHostOps(d)
    expect(refused(await ops['ambiente-run']({ id: 'amb-xyz', worktree: '/w', portOffset: 0 })).code).toBe('AMB_PORTA')
    expect(refused(await ops['ambiente-run']({ id: 'amb-xyz', worktree: '/w', portOffset: 1 })).code).toBe('AMB_PORTA')
    expect(d.launched.length).toBe(0)
    const d2 = deps({ readState: () => state({ apiPort: 47291, webPort: 47292 }) })
    expect(refused(await ambienteHostOps(d2)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_PORTA')
    expect(d2.stopped).toEqual(['amb-xyz'])
  })
  test('server never answers => AMB_SUBIR and the run is stopped', async () => {
    let t = 0
    const d = deps({ readState: () => state(), fetchVersionOk: async () => false, now: () => t, sleep: async ms => { t += ms } })
    expect(refused(await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_SUBIR')
    expect(d.stopped).toEqual(['amb-xyz'])
  })
  test('M1 a launcher whose run never registers is killed by its own pid; a state that shows up late is stopped', async () => {
    let t = 0
    const d = deps({ readState: () => null, now: () => t, sleep: async ms => { t += ms } })
    expect(refused(await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_SUBIR')
    expect(d.killed).toEqual([4242]); expect(d.stopped).toEqual([])
    let t3 = 0, reads = 0
    const d3 = deps({ readState: () => (reads++ > 0 && t3 > 20_000 ? state() : null), now: () => t3, sleep: async ms => { t3 += ms } })
    expect(refused(await ambienteHostOps(d3)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_SUBIR')
    expect(d3.killed).toEqual([4242]); expect(d3.stopped).toEqual(['amb-xyz'])
  })
  test('I10 a structured/ dir found after start => AMB_STRUCTURED, run stopped', async () => {
    const s = state(); mkdirSync(join(s.home, '.agentistics', 'structured'), { recursive: true })
    const d = deps({ readState: () => s })
    expect(refused(await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_STRUCTURED')
    expect(d.stopped).toEqual(['amb-xyz'])
  })
  test('I17 a pid of the run holding the heavy lock after start => AMB_LOCK, run stopped', async () => {
    const d = deps({ readState: () => state(), runOwned: () => [77], pidsWithLock: p => p })
    expect(refused(await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_LOCK')
    expect(d.stopped).toEqual(['amb-xyz'])
  })
})

describe('semente through the op (I9, B4)', () => {
  test('the op copies NOTHING inside the server process: it reports what the launcher will seed and leaves the real store and the ambiente folder untouched', async () => {
    const d = deps(); writeFileSync(join(d.dataDir, 'accounts.json'), '{}'); mkdirSync(join(d.dataDir, 'structured')); mkdirSync(join(d.dataDir, 'content')); writeFileSync(join(d.dataDir, 'content', 'c'), 'c')
    const r = await ambienteHostOps(d)['ambiente-semente']({ id: 'amb-xyz' }) as { copied: string[]; staging: unknown }
    expect(r.copied).toEqual(['content'])
    expect(existsSync(join(d.dataDir, 'flows'))).toBe(false)
    expect(refused(await ambienteHostOps(d)['ambiente-semente']({ id: '../x' })).code).toBe('AMB_ENTRADA')
  })
  test('B4 a semente:copia run hands the copy to the launcher (--seed-real) and waits for it far longer than a plain run', async () => {
    let t = 0
    const d = deps({ readState: () => (t >= 100_000 ? state() : null), now: () => t, sleep: async ms => { t += ms } })
    const r = await ambienteHostOps(d)['ambiente-run']({ id: 'amb-xyz', worktree: '/w', semente: 'copia' }) as { ok?: boolean }
    expect(r.ok).toBe(true); expect(d.launched[0]).toContain('--seed-real')
    let t2 = 0
    const d2 = deps({ readState: () => (t2 >= 100_000 ? state() : null), now: () => t2, sleep: async ms => { t2 += ms } })
    expect(refused(await ambienteHostOps(d2)['ambiente-run']({ id: 'amb-xyz', worktree: '/w' })).code).toBe('AMB_SUBIR')
  })
})

describe('B1 the data dir is the one the server resolves (AGENTISTICS_DIR)', () => {
  test('defaultAmbienteDeps().dataDir is config.AGENTISTICS_DATA_DIR, never an AGENTISTICS_DATA_DIR env var', async () => {
    const { AGENTISTICS_DATA_DIR } = await import('../config')
    const saved = process.env.AGENTISTICS_DATA_DIR
    process.env.AGENTISTICS_DATA_DIR = '/should/not/be/used'
    try { expect(defaultAmbienteDeps().dataDir).toBe(AGENTISTICS_DATA_DIR) } finally { if (saved === undefined) delete process.env.AGENTISTICS_DATA_DIR; else process.env.AGENTISTICS_DATA_DIR = saved }
  })
})

describe('MCP sentinel (I14)', () => {
  test('a real config rewritten with the ambiente port is restored byte for byte, the run stopped and the owner flagged; a change without the port is only logged', async () => {
    const d = deps(); const codex = join(d.home, '.codex', 'config.toml'); mkdirSync(join(d.home, '.codex'), { recursive: true })
    const orig = '[mcp_servers.agentistics]\nurl = "http://localhost:47291"\n'; writeFileSync(codex, orig)
    const gem = join(d.home, '.gemini', 'settings.json'); mkdirSync(join(d.home, '.gemini'), { recursive: true }); writeFileSync(gem, '{"a":1}')
    const ops = ambienteHostOps(d)
    expect(await ops['ambiente-mcp-antes']({ id: 'amb-xyz' })).toMatchObject({ ok: true })
    writeFileSync(codex, '[mcp_servers.agentistics]\nurl = "http://localhost:48100"\n')
    writeFileSync(gem, '{"a":2}')
    const out = d.readState = () => state()
    void out
    const r = await ops['ambiente-mcp-depois']({ id: 'amb-xyz', apiPort: 48100 }) as { code?: string; restored?: string[]; alertOwner?: boolean }
    expect(r.code).toBe('AMB_MCP'); expect(r.alertOwner).toBe(true)
    expect(readFileSync(codex, 'utf8')).toBe(orig)
    expect(readFileSync(gem, 'utf8')).toBe('{"a":2}')
    expect(readFileSync(join(d.dataDir, 'flows', 'ambientes', 'amb-xyz', 'diario.log'), 'utf8')).toContain('settings.json')
    expect(d.stopped).toEqual(['amb-xyz'])
  })
  test('B2 a config another process rewrote with a number that merely contains the port is NOT restored; the URL form is', async () => {
    expect(carriesPort(Buffer.from('{"lastSeen": 1762148100123}'), 48100)).toBe(false)
    expect(carriesPort(Buffer.from('http://localhost:481001/x'), 48100)).toBe(false)
    expect(carriesPort(Buffer.from('AGENTISTICS_API=http://localhost:48100'), 48100)).toBe(true)
    expect(carriesPort(Buffer.from('http://127.0.0.1:48100/'), 48100)).toBe(true)
    const d = deps(); const cj = join(d.home, '.claude.json'); writeFileSync(cj, '{"n":1}')
    const ops = ambienteHostOps(d)
    await ops['ambiente-mcp-antes']({ id: 'amb-bbb' })
    writeFileSync(cj, '{"n":2,"lastSeen":1762148100123}')
    expect(await ops['ambiente-mcp-depois']({ id: 'amb-bbb', apiPort: 48100 })).toMatchObject({ ok: true, restored: [] })
    expect(readFileSync(cj, 'utf8')).toBe('{"n":2,"lastSeen":1762148100123}')
    expect(d.stopped).toEqual([])
  })
  test('M3 plaintext copies are gone after the check (restored or not); manifest.json stays; parar purges leftovers', async () => {
    const d = deps(); const codex = join(d.home, '.codex', 'config.toml'); mkdirSync(join(d.home, '.codex'), { recursive: true }); writeFileSync(codex, 'key = "sk-secret"\n')
    const ops = ambienteHostOps(d); const dir = join(d.dataDir, 'flows', 'ambientes', 'amb-mmm', 'mcp-antes')
    await ops['ambiente-mcp-antes']({ id: 'amb-mmm' })
    expect(readdirSync(dir).some(n => n.endsWith('.copy'))).toBe(true)
    await ops['ambiente-mcp-depois']({ id: 'amb-mmm', apiPort: 48100 })
    expect(readdirSync(dir)).toEqual(['manifest.json'])
    writeFileSync(join(dir, '9.copy'), 'leftover'); await ops['ambiente-parar']({ id: 'amb-mmm' })
    expect(readdirSync(dir)).toEqual(['manifest.json'])
    purgeCopies('/nonexistent/x')
  })
  test('nothing changed => ok; a file that did not exist and now carries the port is removed', async () => {
    const d = deps(); const ops = ambienteHostOps(d)
    await ops['ambiente-mcp-antes']({ id: 'amb-yyy' })
    expect(await ops['ambiente-mcp-depois']({ id: 'amb-yyy', apiPort: 48100 })).toMatchObject({ ok: true, restored: [] })
    const copilot = join(d.home, '.copilot', 'mcp-config.json'); mkdirSync(join(d.home, '.copilot'), { recursive: true }); writeFileSync(copilot, '{"env":{"AGENTISTICS_API":"http://localhost:48100"}}')
    d.readState = () => state({ name: 'amb-yyy' })
    expect(refused(await ops['ambiente-mcp-depois']({ id: 'amb-yyy', apiPort: 48100 })).code).toBe('AMB_MCP')
    expect(existsSync(copilot)).toBe(false)
  })
})

describe('estado / processos do run', () => {
  test('estado: no state => not alive; state + answering server => alive with its ports', async () => {
    expect(await ambienteHostOps(deps())['ambiente-estado']({ id: 'amb-xyz' })).toEqual({ ok: true, alive: false })
    expect(await ambienteHostOps(deps({ readState: () => state() }))['ambiente-estado']({ id: 'amb-xyz' })).toMatchObject({ alive: true, apiPort: 48100 })
    expect(await ambienteHostOps(deps({ readState: () => state(), fetchVersionOk: async () => false }))['ambiente-estado']({ id: 'amb-xyz' })).toMatchObject({ alive: false })
  })
  test('processos-do-run counts only the run-owned pids whose cwd is inside the worktree', async () => {
    const wt = process.cwd()
    expect(await ambienteHostOps(deps({ runOwned: () => [process.pid] }))['ambiente-processos-do-run']({ home: '/h', worktree: wt })).toEqual({ ok: true, count: 1 })
    expect(await ambienteHostOps(deps({ runOwned: () => [process.pid] }))['ambiente-processos-do-run']({ home: '/h', worktree: '/nonexistent-wt' })).toEqual({ ok: true, count: 0 })
  })
})

describe('parar / sessoes / home (I20, descer gates)', () => {
  test('parar stops only the registered run; unknown run => ja-parado', async () => {
    const d = deps({ readState: n => n === 'amb-xyz' ? state() : null }); const ops = ambienteHostOps(d)
    expect(await ops['ambiente-parar']({ id: 'amb-xyz' })).toMatchObject({ ok: true, servidor: 'parado', porta: [48100, 48101] })
    expect(d.stopped).toEqual(['amb-xyz'])
    expect(await ops['ambiente-parar']({ id: 'amb-zzz' })).toMatchObject({ ok: true, servidor: 'ja-parado' })
    expect(refused(await ops['ambiente-parar']({ id: '../x' })).code).toBe('AMB_ENTRADA')
  })
  test('parar refuses success while run-owned pids remain', async () => {
    const d = deps({ readState: () => state(), runOwned: () => [5] })
    expect(refused(await ambienteHostOps(d)['ambiente-parar']({ id: 'amb-xyz' })).code).toBe('AMB_PARAR')
  })
  test('sessoes: only rows whose cwd is inside the worktree; endedAt is carried', async () => {
    const wt = tmp('amb-wt2-'); const sub = join(wt, 'pkg'); mkdirSync(sub)
    const d = deps({ registry: async () => [{ id: 'a', cwd: sub }, { id: 'b', cwd: wt, endedAt: 'x' }, { id: 'c', cwd: wt + '-other' }] })
    expect(await ambienteHostOps(d)['ambiente-sessoes']({ worktree: wt })).toEqual({ ok: true, sessions: [{ id: 'a' }, { id: 'b', endedAt: 'x' }] })
  })
  test('a git repository inside the ambiente HOME blocks descer', async () => {
    const home = tmp('amb-h-'); const ops = ambienteHostOps(deps())
    expect(await ops['ambiente-home-sem-repo']({ home })).toEqual({ ok: true })
    mkdirSync(join(home, 'proj', '.git'), { recursive: true })
    expect(refused(await ops['ambiente-home-sem-repo']({ home })).code).toBe('AMB_REPO_NO_HOME')
  })
})

describe('R2 every refusal after the server booted still runs the sentinel check and the copy cleanup', () => {
  /** A real config the "boot" rewrote with the ambiente's URL, then each refusal path; the file must come back and only manifest.json stay. */
  const rig = async (over: Partial<AmbienteDeps>) => {
    const st0 = state(); const d = deps({ readState: () => st0, ...over }); const cj = join(d.home, '.claude.json'); writeFileSync(cj, '{"n":1}')
    const ops = ambienteHostOps(d); await ops['ambiente-mcp-antes']({ id: 'amb-xyz' })
    const dir = join(d.dataDir, 'flows', 'ambientes', 'amb-xyz', 'mcp-antes')
    expect(readdirSync(dir).some(n => n.endsWith('.copy'))).toBe(true)
    writeFileSync(cj, '{"n":1,"mcp":"http://localhost:48100"}')
    const r = await ops['ambiente-run']({ id: 'amb-xyz', worktree: '/w' }) as { code?: string; restored?: string[]; alertOwner?: boolean }
    return { r, cj, dir, d }
  }
  const settled = (x: { cj: string; dir: string; r: { restored?: string[] } }) => { expect(readFileSync(x.cj, 'utf8')).toBe('{"n":1}'); expect(readdirSync(x.dir)).toEqual(['manifest.json']); expect(x.r.restored?.length).toBe(1) }
  test('AMB_SUBIR (server never answered)', async () => {
    let t = 0
    const x = await rig({ fetchVersionOk: async () => false, now: () => t, sleep: async ms => { t += ms } }); expect(x.r.code).toBe('AMB_MCP'); expect(x.d.stopped).toEqual(['amb-xyz']); settled(x)
  })
  test('AMB_PORTA (the run got a real port)', async () => {
    const x = await rig({ readState: () => state({ apiPort: 47291, webPort: 47292 }) }); expect(x.r.code).toBe('AMB_PORTA'); expect(x.d.stopped).toEqual(['amb-xyz'])
    expect(readdirSync(x.dir)).toEqual(['manifest.json'])  // the real port is not the ambiente's (48100) so nothing is restored, but the copies are gone
  })
  test('AMB_STRUCTURED', async () => {
    const st = state(); mkdirSync(join(st.home, '.agentistics', 'structured'), { recursive: true })
    const x = await rig({ readState: () => st }); expect(x.r.code).toBe('AMB_MCP'); expect(x.d.stopped).toEqual(['amb-xyz']); settled(x)
  })
  test('AMB_LOCK', async () => { const x = await rig({ pidsWithLock: () => [99], runOwned: () => [99] }); expect(x.r.code).toBe('AMB_MCP'); expect(x.d.stopped).toEqual(['amb-xyz']); settled(x) })
  test('AMB_SUBIR (the run never registered): copies purged', async () => {
    let t = 0
    const x = await rig({ readState: () => null, now: () => t, sleep: async ms => { t += ms } }); expect(x.r.code).toBe('AMB_SUBIR'); expect(readdirSync(x.dir)).toEqual(['manifest.json'])
  })
  test('early refusal (bad offset) purges too', async () => {
    const d = deps(); writeFileSync(join(d.home, '.claude.json'), '{}'); const ops = ambienteHostOps(d); await ops['ambiente-mcp-antes']({ id: 'amb-xyz' })
    const dir = join(d.dataDir, 'flows', 'ambientes', 'amb-xyz', 'mcp-antes')
    expect(refused(await ops['ambiente-run']({ id: 'amb-xyz', worktree: '/w', portOffset: 0 })).code).toBe('AMB_PORTA'); expect(readdirSync(dir)).toEqual(['manifest.json'])
  })
})
