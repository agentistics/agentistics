import { gitTestEnv } from '@agentistics/core/gitTestEnv'
import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowHostOps } from './host-ops'

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
