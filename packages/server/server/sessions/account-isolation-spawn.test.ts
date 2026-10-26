import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ISOLATION_ENV } from '../account-isolation'
import { planSpawn } from './spawn-spec'
import { newSessionArgs } from './tmux-cli'
import { durableStore } from './structured-durable'
import { savedOf, structuredSpawnOf } from './structured-backend'
import { applyAccountToPlan, resumeAccountEnvironment } from './account-plan'
import type { HarnessId } from '@agentistics/core'
import type { BackendSpawn } from './types'

for (const [harness, variable] of Object.entries(ISOLATION_ENV)) {
  if (!variable) continue
  for (const resume of [false, true]) test(`${harness}: ${resume ? 'resume' : 'fresh'} preserves explicit default vs extra account`, () => {
    const request = { harness: harness as HarnessId, cwd: '/w', ...(resume ? { resumeId: '11111111-2222-3333-4444-555555555555' } : {}) }
    const home = planSpawn({ ...request, account: { root: null } })
    const extra = planSpawn({ ...request, account: { root: '/accounts/other' } })
    expect(home.ok && extra.ok).toBe(true)
    if (!home.ok || !extra.ok) return
    expect(home.plan.unsetEnv).toEqual([variable])
    expect(home.plan.env?.[variable]).toBeUndefined()
    expect(extra.plan.env?.[variable]).toBe('/accounts/other')
    expect(extra.plan.unsetEnv).toBeUndefined()
    expect(resumeAccountEnvironment({}, home.plan, harness as HarnessId)).toEqual({ unsetEnv: [variable] })
    expect(resumeAccountEnvironment({}, extra.plan, harness as HarnessId)).toEqual({ env: { [variable]: '/accounts/other' } })
    const legacy = planSpawn(request)
    expect(legacy.ok && legacy.plan.unsetEnv).toBeUndefined()
  })
}

test('a default account on a harness without isolation remains supported', () => {
  const result = planSpawn({ harness: 'antigravity', cwd: '/w', account: { root: null } })
  expect(result.ok).toBe(true)
  expect(result.ok && result.plan.unsetEnv).toBeUndefined()
})

test('a login override replaces the default-account removal', () => {
  const plan = planSpawn({ harness: 'claude', cwd: '/w', account: { root: null } })
  if (!plan.ok) throw new Error('plan failed')
  applyAccountToPlan(plan.plan, { env: { CLAUDE_CONFIG_DIR: '/login' } })
  expect(plan.plan.env?.CLAUDE_CONFIG_DIR).toBe('/login')
  expect(plan.plan.unsetEnv).toBeUndefined()
})

// Unix sockets cap their path near 108 bytes and a throwaway run's TMPDIR is long, so the relay and tmux
// sockets live under a short /tmp directory instead of os.tmpdir().
const shortTmp = (prefix: string) => mkdtempSync(join('/tmp', prefix))
const parentEnv = () => ({ ...process.env, CLAUDE_CONFIG_DIR: '/accounts/inherited-other' })
// The child lingers after printing: one that exits at once can finish before the server reaches the relay
// socket, and the pipe then ends without an exit code (a child racing its own relay, not what is tested here).
const command = [process.execPath, '-e', 'console.log(process.env.CLAUDE_CONFIG_DIR ?? "ABSENT"); setTimeout(() => {}, 1500)']
function request(root: string | null, dir: string): BackendSpawn {
  const result = planSpawn({ harness: 'claude', cwd: dir, account: { root } })
  if (!result.ok) throw new Error('plan failed')
  return { id: 'isolation-test', cwd: dir, argv: command, env: result.plan.env, unsetEnv: result.plan.unsetEnv }
}

for (const root of [null, '/accounts/selected-extra']) {
  test(`structured relay: inherited other login, selected ${root ?? 'default'}`, async () => {
    const dir = shortTmp('iso-r-')
    const original = process.env.CLAUDE_CONFIG_DIR
    const store = durableStore(join(dir, 'structured'))
    let transport: ReturnType<typeof store.create> | undefined
    try {
      process.env.CLAUDE_CONFIG_DIR = parentEnv().CLAUDE_CONFIG_DIR
      const req = request(root, dir)
      const spawn = structuredSpawnOf(req, 'claude')
      const saved = savedOf(req, 'claude', spawn)
      transport = store.create(req.id, saved)
      const pipe = transport.launch(command[0]!, command.slice(1), dir, spawn.env)
      let out = ''
      for await (const chunk of pipe.source) out += chunk
      expect(await pipe.exited).toBe(0)
      expect(out.trim()).toBe(root ?? 'ABSENT')
      // A new server reads the same removal from disk before replay/resume to TUI.
      const restored = durableStore(join(dir, 'structured')).saved(req.id)
      expect(restored?.backend.unsetEnv).toEqual(req.unsetEnv)
      const launch = JSON.parse(readFileSync(join(dir, 'structured', req.id, 'launch.json'), 'utf8'))
      expect(launch.unsetEnv).toEqual(req.unsetEnv)
    } finally {
      if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = original
      transport?.detach()
      await store.terminate('isolation-test')
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)

  test(`tmux pane: inherited other login, selected ${root ?? 'default'}`, async () => {
    const dir = shortTmp('iso-t-')
    const socket = `iso-${crypto.randomUUID().slice(0, 8)}`
    try {
      const req = request(root, dir)
      const output = join(dir, 'root.txt')
      const argv = [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1], process.env.CLAUDE_CONFIG_DIR ?? "ABSENT")', output]
      const args = newSessionArgs({ ...req, argv, socket })
      const child = Bun.spawn(['tmux', '-f', '/dev/null', ...args], { env: { ...parentEnv(), TMUX_TMPDIR: dir }, stdout: 'pipe', stderr: 'pipe' })
      const error = await new Response(child.stderr).text()
      expect(await child.exited, error).toBe(0)
      const deadline = Date.now() + 3000
      let value: string | undefined
      while (Date.now() < deadline) {
        try { value = readFileSync(output, 'utf8'); break } catch { await Bun.sleep(20) }
      }
      expect(value).toBe(root ?? 'ABSENT')
      // The sole pane exits with the script; its private tmux server exits automatically.
    } finally {
      await Bun.spawn(['tmux', '-L', socket, 'kill-server'], { env: { ...process.env, TMUX_TMPDIR: dir }, stdout: 'ignore', stderr: 'ignore' }).exited
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)
}
