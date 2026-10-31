import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowHostOps, triggerHostOps } from './host-ops'

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
  expect(await ops['cutucar-sessao']({ to: 'gone', body: 'x' })).toMatchObject({ refused: true, reason: 'ended' })
  expect(await ops['cutucar-sessao']({ to: '', body: 'x' })).toMatchObject({ refused: true })
  expect(await ops['aviso-ao-dono']({ text: 'Pedido p-1 sem dono' })).toEqual({ ok: true })
  expect(notices).toEqual(['Pedido p-1 sem dono'])
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
