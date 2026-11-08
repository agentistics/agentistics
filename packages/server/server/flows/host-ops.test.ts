import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NUDGE_REPEAT_MS, STREAK_MAX_GAP_MS, flowHostOps, judgeStopped, resetStoppedStreaks, triggerHostOps } from './host-ops'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const repo = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'flow-git-')); roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: gitTestEnv() })
  git('init', '-b', 'fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
  writeFileSync(join(cwd, 'file'), 'fixture'); git('add', 'file'); git('commit', '-m', 'fixture')
  return { cwd, git }
}

test('git gates inspect clean and dirty trees without changing the index', async () => {
  const { cwd } = repo()
  const ops = flowHostOps()
  const index = join(cwd, '.git/index')
  const before = statSync(index).mtimeMs
  expect(await ops['arvore-limpa']({ cwd })).toEqual({ ok: true, cwd })
  expect(statSync(index).mtimeMs).toBe(before)
  writeFileSync(join(cwd, 'file'), 'dirty')
  expect(await ops['arvore-limpa']({ cwd })).toMatchObject({ refused: true, reason: 'working tree is dirty' })
  expect(statSync(index).mtimeMs).toBe(before)
})

test('remote gate refuses an unsaved branch and accepts the same HEAD saved locally', async () => {
  const { cwd, git } = repo()
  const remote = mkdtempSync(join(tmpdir(), 'flow-remote-')); roots.push(remote)
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe', env: gitTestEnv() })
  git('remote', 'add', 'origin', remote)
  const ops = flowHostOps()
  expect(await ops['trabalho-salvo']({ cwd })).toMatchObject({ refused: true, reason: 'local HEAD is not saved on origin' })
  git('push', 'origin', 'fixture')
  expect(await ops['trabalho-salvo']({ cwd })).toMatchObject({ ok: true, branch: 'fixture', evidence: 'ls-remote' })
})

test('cleanup dry run lists worktrees without deleting them', async () => {
  const { cwd } = repo()
  const before = statSync(cwd).ino
  const out = await flowHostOps()['limpeza-dry-run']({ cwd })
  expect(out).toMatchObject({ ok: true, dryRun: true, cwd, worktrees: [{ path: cwd, wouldRemove: false }] })
  expect(statSync(cwd).ino).toBe(before)
})

test('trigger host ops: the managed-session universe and a nudge through the composer path', async () => {
  const prompts: Array<[string, string]> = []
  const notices: string[] = []
  const ops = triggerHostOps({
    registry: async () => [
      { id: 'live', cwd: '/w/a', createdAt: '2026-10-29T00:00:00.000Z', taskId: 't-1', subtaskId: 's-1', parentSessionId: 'lead' },
      { id: 'gone', cwd: '/w/b', createdAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-29T01:00:00.000Z', taskId: 't-1' },
      { id: 'lead', cwd: '/w', createdAt: '2026-10-29T00:00:00.000Z', taskId: 't-1', conversationId: 'conv-l' },
    ],
    rows: async () => [{ id: 'live', state: 'working' }, { id: 'gone', state: 'working' }, { id: 'lead', conversationId: 'conv-l', state: 'waiting' }],
    roles: async () => row => (row.conversationId === 'conv-l' ? 'leader' : undefined),
    prompt: async (id, text) => { prompts.push([id, text]); return id === 'live' ? { ok: true } : { ok: false, message: 'ended' } },
    awayNotice: async text => { notices.push(text); return true },
    kill: async () => ({ ok: true }),
  })
  expect(await ops['sessoes-gerenciadas']()).toEqual({ sessions: [
    { id: 'live', cwd: '/w/a', alive: true, state: 'working', createdAt: '2026-10-29T00:00:00.000Z', taskId: 't-1', subtaskId: 's-1', parentSessionId: 'lead' },
    { id: 'gone', cwd: '/w/b', alive: false, state: 'working', createdAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-29T01:00:00.000Z', taskId: 't-1' },
    { id: 'lead', cwd: '/w', alive: true, state: 'waiting', createdAt: '2026-10-29T00:00:00.000Z', taskId: 't-1', conversationId: 'conv-l', role: 'leader' },
  ] })
  expect(await ops['cutucar-sessao']({ to: 'live', body: 'commit it', flow: 'trabalho-sem-commit' })).toEqual({ ok: true, to: 'live' })
  expect(prompts[0]).toEqual(['live', '[from flow trabalho-sem-commit · nudge]\ncommit it'])
  // FLUXO.AVISOS: an ENDED row is refused before anything is typed (the prompt path would follow/reopen it).
  const typedBefore = prompts.length
  expect(await ops['cutucar-sessao']({ to: 'gone', body: 'x' })).toMatchObject({ refused: true, failure: 'ended' })
  expect(prompts.length).toBe(typedBefore)
  expect(await ops['cutucar-sessao']({ to: '', body: 'x' })).toMatchObject({ refused: true })
  expect(await ops['aviso-ao-dono']({ text: 'Pedido p-1 sem dono' })).toEqual({ ok: true })
  expect(notices).toEqual(['Pedido p-1 sem dono'])
})

test('FLUXO.ENTREGA-DSL audit: the pedidos escalation to the owner is skipped while autonomous mode is on, kept when off', async () => {
  for (const away of [true, false]) {
    const notices: string[] = []
    const ops = triggerHostOps({
      registry: async () => [], rows: async () => [], roles: async () => () => undefined,
      prompt: async () => ({ ok: true }), awayNotice: async text => { notices.push(text); return true }, kill: async () => ({ ok: true }),
      autonomous: async () => away,
    })
    const out = await ops['aviso-ao-dono']({ text: 'Pedido p-1 sem dono' }, { step: 'h1-lembrar' })
    expect(out).toEqual(away ? { ok: true, skipped: 'pulado: modo autônomo' } : { ok: true })
    expect(notices).toEqual(away ? [] : ['Pedido p-1 sem dono'])
    // L3: a wait that ended with no leader to tell falls back to the owner — also skipped while autonomous mode is on.
    expect(await ops['aviso-ao-dono']({ text: 'A espera w-1 disparou' }, { step: 'wait-ended' })).toEqual(away ? { ok: true, skipped: 'pulado: modo autônomo' } : { ok: true })
    // An informational notice from another flow (an environment's MCP failure) is not a decision request: it always goes.
    expect(await ops['aviso-ao-dono']({ text: 'AMB_MCP' }, { step: 'ambiente-aviso-dono' })).toEqual({ ok: true })
  }
})

test('QA10: roles are re-read for every universe snapshot — a promotion and a demotion count at once', async () => {
  let stored: Record<string, string> = {}
  const ops = triggerHostOps({
    registry: async () => [{ id: 'a', cwd: '/w', createdAt: 'x' }, { id: 'b', cwd: '/w', createdAt: 'x', leader: true }],
    rows: async () => [{ id: 'a', state: 'waiting' }, { id: 'b', state: 'waiting' }],
    roles: async () => { const snap = { ...stored }; return row => snap[row.id] },
    prompt: async () => ({ ok: true }), awayNotice: async () => true, kill: async () => ({ ok: true }),
  })
  const roleOf = async (id: string) => (await ops['sessoes-gerenciadas']()).sessions.find(s => s.id === id)?.role
  expect(await roleOf('a')).toBeUndefined()
  expect(await roleOf('b')).toBe('leader') // spawn-time flag, nothing stored
  stored = { a: 'leader', b: 'worker' }
  expect(await roleOf('a')).toBe('leader')
  expect(await roleOf('b')).toBeUndefined()
})

test('LEADER-1: no owner-proof op exists; the HTTP door refuses any override with the SECRETS.4 sentence', async () => {
  const { flowRunInputs, OWNER_CREDENTIAL_REQUIRED } = await import('./status')
  expect(Object.keys(triggerHostOps({ registry: async () => [], rows: async () => [], roles: async () => () => undefined, prompt: async () => ({ ok: true }), awayNotice: async () => true, kill: async () => ({ ok: true }) }))).not.toContain('origem-do-dono')
  for (const bad of [{ taskId: 't', overrideBy: 'owner' }, { taskId: 't', override: { by: 'owner' } }, { taskId: 't', overrideReason: 'x' }]) {
    expect(flowRunInputs(bad)).toEqual({ ok: false, sentence: OWNER_CREDENTIAL_REQUIRED })
  }
  expect(OWNER_CREDENTIAL_REQUIRED).toBe('owner override needs the owner credential (SECRETS.4), not available yet')
  expect(flowRunInputs({ taskId: 't' })).toEqual({ ok: true, inputs: { taskId: 't' } })
  expect(flowRunInputs(null)).toEqual({ ok: true, inputs: {} })
})

test('SESSÕES.FECHAR: encerrar-sessao ends the named session through the kill verb, and refuses in words otherwise', async () => {
  const kills: string[] = []
  const ops = triggerHostOps({
    registry: async () => [], rows: async () => [], roles: async () => () => undefined,
    prompt: async () => ({ ok: true }), awayNotice: async () => true,
    kill: async id => { kills.push(id); return id === 'wk' ? { ok: true, message: 'ended' } : { ok: false, message: 'Session not found.' } },
  })
  expect(await ops['encerrar-sessao']({ sessionId: 'wk' })).toEqual({ ok: true, sessionId: 'wk', message: 'ended' })
  expect(await ops['encerrar-sessao']({ sessionId: 'nope' })).toEqual({ refused: true, reason: 'Session not found.', missing: ['session end'] })
  expect(await ops['encerrar-sessao']({})).toMatchObject({ refused: true, missing: ['sessionId'] })
  expect(kills).toEqual(['wk', 'nope'])
})

// N6: the "stopped" streak is only built from consecutive, recent, waiting polls.
const poll = (at: number, activity = 'waiting') => ({ polledAtMs: at, sessions: [{ id: 's1', status: 'running', activity }] })
test('stopped streak: first poll refuses, a second recent waiting poll confirms', () => {
  resetStoppedStreaks()
  expect(judgeStopped('s1', poll(1_000))).toMatchObject({ refused: true })
  expect(judgeStopped('s1', poll(1_000 + 15_000))).toEqual({ ok: true, sessionId: 's1', polls: 2 })
})
test('stopped streak: working in between resets it (waiting→working→waiting is not two)', () => {
  resetStoppedStreaks()
  judgeStopped('s1', poll(1_000))
  expect(judgeStopped('s1', poll(16_000, 'working'))).toMatchObject({ refused: true })
  expect(judgeStopped('s1', poll(31_000))).toMatchObject({ refused: true })
})
test('stopped streak: a stale earlier poll does not count as a confirmation', () => {
  resetStoppedStreaks()
  judgeStopped('s1', poll(1_000))
  expect(judgeStopped('s1', poll(1_000 + STREAK_MAX_GAP_MS + 1))).toMatchObject({ refused: true })
  expect(judgeStopped('s1', poll(1_000 + STREAK_MAX_GAP_MS + 1 + 15_000))).toMatchObject({ ok: true, polls: 2 })
})
test('stopped streak: the same poll read twice and unknown ids never confirm', () => {
  resetStoppedStreaks()
  judgeStopped('s1', poll(1_000))
  expect(judgeStopped('s1', poll(1_000))).toMatchObject({ refused: true })
  expect(judgeStopped('other', poll(2_000))).toMatchObject({ refused: true, reason: 'session was not found' })
})

// FLUXO.FECHAR: `parada` confirms on two polls, then the `fechar` re-check reads the SAME snapshot — still confirmed.
test('stopped streak: a re-check on the poll that already confirmed stays confirmed (the 35 refusals)', () => {
  resetStoppedStreaks()
  judgeStopped('s1', poll(1_000))
  expect(judgeStopped('s1', poll(16_000))).toMatchObject({ ok: true, polls: 2 })
  expect(judgeStopped('s1', poll(16_000))).toMatchObject({ ok: true, polls: 2 })
  expect(judgeStopped('s1', poll(31_000))).toMatchObject({ ok: true, polls: 3 })
})
test('stopped streak: the re-check refuses when the session is working on the next poll', () => {
  resetStoppedStreaks()
  judgeStopped('s1', poll(1_000))
  judgeStopped('s1', poll(16_000))
  expect(judgeStopped('s1', poll(31_000, 'working'))).toMatchObject({ refused: true })
  expect(judgeStopped('s1', poll(31_000))).toMatchObject({ refused: true })
})

// N2: cli-start (TUI, backup…) is imported on demand inside the op, never at module load.
test('host-ops does not statically import cli-start', async () => {
  const src = await Bun.file(new URL('./host-ops.ts', import.meta.url)).text()
  expect(src).not.toMatch(/^import[^\n]*['"]\.\.\/cli-start['"]/m)
  expect(src).toMatch(/await import\('\.\.\/cli-start'\)/)
})

// ── F2 LIMPEZA.REAL (host): alvo-worktree / remover-worktree ──────────────────────────────────────────────────────
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { worktreeHostOps, worktreeTarget, type WorktreeTargetDeps } from './host-ops'

type Row = Awaited<ReturnType<WorktreeTargetDeps['registry']>>[number]
const wtFixture = () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), 'lr-main-'))); roots.push(main)
  const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: gitTestEnv() }).toString()
  g(main, 'init', '-b', 'main'); g(main, 'config', 'user.email', 'f@example.invalid'); g(main, 'config', 'user.name', 'F')
  writeFileSync(join(main, 'f'), 'x'); g(main, 'add', 'f'); g(main, 'commit', '-m', 'one')
  const wt = join(main, '.wt-x'); g(main, 'worktree', 'add', '-b', 'feat/x', wt)
  const state = { rows: [] as Row[], procs: [] as string[] | null }
  const mk = (over: Partial<Row> = {}): Row => ({ id: 'S', cwd: wt, endedAt: '2026-11-02T00:00:00.000Z', repo: { repo: 'r', rootPath: main, worktree: true }, ...over })
  state.rows = [mk()]
  const deps: WorktreeTargetDeps = {
    registry: async () => state.rows,
    git: async (cwd, args) => g(cwd, ...args),
    procCwds: async () => state.procs,
  }
  return { main, wt: realpathSync(wt), g, state, mk, deps, ops: worktreeHostOps(deps) }
}
const rm = { sessionId: 'S' } as const

test('I3/I9/I1: a clean, ended session worktree is removed with plain `git worktree remove`; the branch and commits stay', async () => {
  const f = wtFixture()
  const t = await f.ops['alvo-worktree'](rm)
  expect(t).toMatchObject({ ok: true, shared: false, path: f.wt, branch: 'feat/x', liveProcesses: 0, liveSessions: [], processCheck: 'ok' })
  const head = f.g(f.wt, 'rev-parse', 'HEAD').trim()
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 'snap' })).toMatchObject({ ok: true, removed: true, path: f.wt })
  expect(existsSync(f.wt)).toBe(false)
  expect(f.g(f.main, 'rev-parse', 'feat/x').trim()).toBe(head)
})

test('I9: the host recomputes — a different path, a moved HEAD, a dirty tree or an extra input is refused and nothing is removed', async () => {
  const f = wtFixture()
  const head = f.g(f.wt, 'rev-parse', 'HEAD').trim()
  expect(await f.ops['remover-worktree']({ ...rm, path: f.main, head, snapshotId: 's' })).toMatchObject({ refused: true, reason: 'the requested path is not the registry worktree' })
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head: 'deadbeef', snapshotId: 's' })).toMatchObject({ refused: true, reason: 'HEAD changed since the snapshot' })
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's', force: true })).toMatchObject({ refused: true, reason: 'unexpected input force' })
  writeFileSync(join(f.wt, 'new.txt'), 'u')
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's' })).toMatchObject({ refused: true, reason: 'working tree is dirty' })
  expect(existsSync(f.wt)).toBe(true)
})

test('I1: no force path exists — a tracked edit makes the removal refuse and the folder survives', async () => {
  const f = wtFixture()
  const head = f.g(f.wt, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(f.wt, 'f'), 'changed')
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's' })).toMatchObject({ refused: true })
  expect(existsSync(f.wt)).toBe(true)
})

test('I5/I3: the main checkout, a missing `worktree` flag and a main-checkout cwd are shared — never a target', async () => {
  const f = wtFixture()
  f.state.rows = [f.mk({ cwd: f.main })]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ ok: true, shared: true, path: f.main })
  f.state.rows = [f.mk({ repo: { repo: 'r', rootPath: f.main, worktree: false } })]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ ok: true, shared: true })
  f.state.rows = [{ id: 'S', cwd: f.wt, endedAt: 'x' }]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ ok: true, shared: true })
  const head = f.g(f.main, 'rev-parse', 'HEAD').trim()
  expect(await f.ops['remover-worktree']({ ...rm, path: f.main, head, snapshotId: 's' })).toMatchObject({ refused: true })
  expect(existsSync(f.main)).toBe(true)
})

test('I3b: a recorded parent repository that is gone refuses', async () => {
  const f = wtFixture()
  f.state.rows = [f.mk({ repo: { repo: 'r', rootPath: join(f.main, 'nope'), worktree: true } })]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ refused: true, reason: 'the parent repository no longer exists' })
  f.state.rows = [f.mk({ repo: { repo: 'r', worktree: true } })]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ refused: true })
})

test('I3c/I3e: a locked worktree and a worktree with another worktree inside it are refused', async () => {
  const f = wtFixture()
  f.g(f.main, 'worktree', 'lock', f.wt)
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ refused: true, reason: 'the worktree is locked' })
  f.g(f.main, 'worktree', 'unlock', f.wt)
  f.g(f.main, 'worktree', 'add', '-b', 'feat/inner', join(f.wt, 'inner'))
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ refused: true, reason: 'another worktree lives inside this one' })
})

test('I4: a not-ended registry session inside the worktree, or a process with its cwd there, is reported live and blocks removal', async () => {
  const f = wtFixture()
  const head = f.g(f.wt, 'rev-parse', 'HEAD').trim()
  f.state.rows = [f.mk(), { id: 'other', cwd: join(f.wt, 'sub'), repo: undefined } as Row]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ liveSessions: ['other'] })
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's' })).toMatchObject({ refused: true, reason: 'a live session or process is inside the worktree' })
  f.state.rows = [f.mk()]
  f.state.procs = [f.wt]
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ liveProcesses: 1 })
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's' })).toMatchObject({ refused: true })
  f.state.procs = null
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ processCheck: 'skipped' })
  expect(existsSync(f.wt)).toBe(true)
})

test.skipIf(process.platform !== 'linux')('I4: the default process probe sees a real child whose cwd is inside the worktree', async () => {
  const f = wtFixture()
  const child = spawn('sleep', ['30'], { cwd: f.wt })
  try {
    const { defaultWorktreeTargetDeps } = await import('./host-ops')
    const t = await worktreeTarget('S', { ...defaultWorktreeTargetDeps(), registry: async () => f.state.rows })
    expect(t).toMatchObject({ kind: 'target' })
    expect((t as { liveProcesses: number }).liveProcesses).toBeGreaterThanOrEqual(1)
  } finally { child.kill() }
})

test('I9: a session without endedAt is not removable by the host either', async () => {
  const f = wtFixture()
  const head = f.g(f.wt, 'rev-parse', 'HEAD').trim()
  f.state.rows = [{ ...f.mk(), endedAt: undefined as unknown as string }]
  delete (f.state.rows[0] as { endedAt?: string }).endedAt
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head, snapshotId: 's' })).toMatchObject({ refused: true, reason: 'the session has not ended' })
  mkdirSync(join(f.wt, 'keep'), { recursive: true })
  expect(existsSync(f.wt)).toBe(true)
})

test('I3: a worktree folder already gone is reported as gone, with whether git still lists it', async () => {
  const f = wtFixture()
  execFileSync('rm', ['-rf', f.wt])
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ ok: true, shared: false, gone: true, listed: true })
  f.g(f.main, 'worktree', 'prune')
  expect(await f.ops['alvo-worktree'](rm)).toMatchObject({ ok: true, gone: true, listed: false })
  expect(await f.ops['remover-worktree']({ ...rm, path: f.wt, head: 'x', snapshotId: 's' })).toMatchObject({ refused: true, reason: 'the worktree folder is already gone' })
})

test('flowHostOps registers the two worktree ops', () => {
  expect(Object.keys(flowHostOps())).toEqual(expect.arrayContaining(['alvo-worktree', 'remover-worktree']))
})

// ── F3 DOCKER.DETECTAR (host) ─────────────────────────────────────────────────────────────────────────────────────
import { detectDocker, dockerHostOps, type DockerProbeDeps } from './host-ops'

/** A fake `docker`: answers by its argv; `null` models a binary that is not on PATH. */
const fakeDocker = (o: { installed?: boolean; running?: boolean; os?: string; wsl?: boolean; mount?: boolean }): DockerProbeDeps & { calls: string[][] } => {
  const calls: string[][] = []
  return {
    calls,
    isWsl: () => o.wsl ?? false,
    desktopMount: () => o.mount ?? false,
    docker: async args => {
      calls.push(args)
      if (o.installed === false) return null
      const fmt = args[2]
      if (fmt === '{{.Client.Version}}') return { code: 0, stdout: '27.3.1\n' }
      if (fmt === '{{.Server.Version}}') return o.running ? { code: 0, stdout: '27.3.1\n' } : { code: 1, stdout: '' }
      if (fmt === '{{.OperatingSystem}}') return { code: 0, stdout: `${o.os ?? 'Ubuntu 24.04'}\n` }
      return { code: 1, stdout: '' }
    },
  }
}

test('docker-detectar: absent binary -> none, nothing else probed', async () => {
  const d = fakeDocker({ installed: false })
  expect(await detectDocker(d)).toEqual({ present: false, running: false, version: null, kind: 'none' })
  expect(d.calls).toHaveLength(1)
})

test('docker-detectar: installed but daemon down -> present, not running, client version', async () => {
  expect(await detectDocker(fakeDocker({ running: false }))).toEqual({ present: true, running: false, version: '27.3.1', kind: 'native' })
})

test('docker-detectar: native engine running', async () => {
  expect(await detectDocker(fakeDocker({ running: true }))).toEqual({ present: true, running: true, version: '27.3.1', kind: 'native' })
})

test('docker-detectar: Docker Desktop in WSL2 running, and installed-but-stopped via the integration mount', async () => {
  expect(await detectDocker(fakeDocker({ running: true, os: 'Docker Desktop', wsl: true }))).toMatchObject({ running: true, kind: 'wsl2-desktop' })
  expect(await detectDocker(fakeDocker({ running: false, wsl: true, mount: true }))).toMatchObject({ present: true, running: false, kind: 'wsl2-desktop' })
  expect(await detectDocker(fakeDocker({ running: true, os: 'Docker Desktop', wsl: false }))).toMatchObject({ kind: 'desktop' })
})

test('docker-detectar: the op is read-only (only `docker version` / `docker info`) and returns ok', async () => {
  const d = fakeDocker({ running: true })
  expect(await dockerHostOps(d)['docker-detectar']()).toMatchObject({ ok: true, present: true, running: true })
  expect(d.calls.every(c => c[0] === 'version' || c[0] === 'info')).toBe(true)
})

test('docker-detectar: the real probe never throws on this machine', async () => {
  const r = await detectDocker()
  expect(typeof r.present).toBe('boolean')
  expect(['wsl2-desktop', 'desktop', 'native', 'none']).toContain(r.kind)
})

// ── FECHAR.CWD-COMPARTILHADO (host): alvo-trabalho ────────────────────────────────────────────────────────────────
import { workTarget, type WorkTargetDeps } from './host-ops'

const workFixture = () => {
  const f = wtFixture()
  const bareDir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-bare-'))); roots.push(bareDir)
  f.g(bareDir, 'clone', '--bare', f.main, bareDir + '/b.git')
  const bare = join(bareDir, 'b.git')
  f.g(bare, 'worktree', 'add', '-b', 'feat/own', join(bareDir, 'own'))
  const own = realpathSync(join(bareDir, 'own'))
  const state = { cwd: bare, stored: own as string | undefined }
  const deps: WorkTargetDeps = {
    session: async () => ({ cwd: state.cwd, conversationId: 'c1' }),
    storedCwd: async () => state.stored,
    git: async (cwd, args) => f.g(cwd, ...args),
  }
  return { ...f, bare, own, state, deps }
}

test('alvo-trabalho: a bare start cwd with the session\'s own linked worktree in the store identifies that worktree', async () => {
  const f = workFixture()
  expect(await workTarget('S', f.deps)).toMatchObject({ ok: true, bare: true, path: f.own })
})

test('alvo-trabalho: a shared main-checkout start cwd resolves the worktree the session moved into', async () => {
  const f = workFixture()
  f.state.cwd = f.main; f.state.stored = f.wt
  expect(await workTarget('S', f.deps)).toMatchObject({ ok: true, bare: false, path: f.wt })
})

test('alvo-trabalho: nothing identified is `none` — no store record, the start cwd itself, a main checkout, another repository', async () => {
  const f = workFixture()
  f.state.stored = undefined
  expect(await workTarget('S', f.deps)).toEqual({ ok: true, bare: true, cwd: f.bare })
  f.state.stored = f.bare
  expect(await workTarget('S', f.deps)).not.toHaveProperty('path')
  f.state.cwd = f.wt; f.state.stored = f.main // the main checkout is not a linked worktree
  expect(await workTarget('S', f.deps)).not.toHaveProperty('path')
  const other = workFixture()
  f.state.cwd = f.bare; f.state.stored = other.own // a worktree of a DIFFERENT repository is never accepted
  expect(await workTarget('S', f.deps)).not.toHaveProperty('path')
  f.state.stored = join(f.own, 'gone')
  expect(await workTarget('S', f.deps)).not.toHaveProperty('path')
})

test('alvo-trabalho (FLUXO.AVISOS): a start folder that is gone or is not a repository is SAID, never a plain ok', async () => {
  const f = workFixture()
  f.state.stored = undefined
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'wt-plain-'))); roots.push(plain)
  f.state.cwd = plain
  expect(await workTarget('S', f.deps)).toMatchObject({ ok: true, notRepo: true, cwd: plain })
  expect(await workTarget('S', f.deps)).not.toHaveProperty('gone')
  f.state.cwd = join(plain, 'removed-worktree')
  const gone = await workTarget('S', f.deps)
  expect(gone).toMatchObject({ ok: true, gone: true })
  expect(gone).not.toHaveProperty('notRepo')
  f.state.cwd = f.bare // a real repository carries neither flag
  const fine = await workTarget('S', f.deps)
  expect(fine).not.toHaveProperty('gone')
  expect(fine).not.toHaveProperty('notRepo')
})

test('alvo-trabalho: an unknown session refuses', async () => {
  const f = workFixture()
  expect(await workTarget('S', { ...f.deps, session: async () => null })).toMatchObject({ refused: true })
})

test('FLUXO.CARTAO: the same nudge to the same session is typed once an hour (waits excepted)', async () => {
  const prompts: string[] = []
  let at = 1_000
  const ops = triggerHostOps({
    registry: async () => [], rows: async () => [], roles: async () => () => undefined,
    prompt: async (_id, text) => { prompts.push(text); return { ok: true } },
    awayNotice: async () => true, kill: async () => ({ ok: true }),
  }, () => at)
  const nudge = (to: string, body: string, flow = 'trabalho-sem-commit') => ops['cutucar-sessao']({ to, body, flow })
  expect(await nudge('s1', 'commit it')).toEqual({ ok: true, to: 's1' })
  expect(await nudge('s1', 'commit it')).toMatchObject({ ok: true, deduped: true })
  expect(await nudge('s2', 'commit it')).toEqual({ ok: true, to: 's2' })
  expect(await nudge('s1', 'a different reason')).toEqual({ ok: true, to: 's1' })
  expect(prompts).toHaveLength(3)
  at += NUDGE_REPEAT_MS
  expect(await nudge('s1', 'commit it')).toEqual({ ok: true, to: 's1' })
  await nudge('s1', 'w-1 gen 1', 'wait'); await nudge('s1', 'w-1 gen 1', 'wait')
  expect(prompts.filter(p => p.startsWith('[from flow wait'))).toHaveLength(2)
})
