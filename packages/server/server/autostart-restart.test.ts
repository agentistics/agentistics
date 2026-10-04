/**
 * `restartAutostart` may only say "Restarted" once the thing serving has CHANGED.
 *
 * Measured 2026-09-27 (WSL): systemd was PID 1 but the user had no session, so `systemctl --user`
 * could not reach its bus, and the running `agentop server` was a foreground process outside the
 * unit. `agentop restart server` still printed "Restarted agentop-server — it now runs the current
 * code and config." with the same PID serving and the env var the owner meant to add absent. An
 * exit code is a fact about systemd's command queue, not about who answers the port.
 *
 * Nothing here runs a real `systemctl`: the service manager and the process table are fakes
 * injected through `RestartDeps`, and the unit directory is a throwaway one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { restartAutostart, type RestartDeps } from './autostart'
import { cliStrings } from './cli-i18n'

const UNIT = [
  '[Unit]', 'Description=agentop server', '',
  '[Service]', 'Type=exec', 'ExecStart=/usr/bin/agentop server', 'KillMode=process', '',
  '[Install]', 'WantedBy=default.target', '',
].join('\n')

// `os.homedir()` ignores a HOME set at runtime, so the unit directory is injected: pointing HOME at
// a temp dir would silently read (and could rewrite) the real ~/.config/systemd/user.
let unitDir = ''
beforeAll(() => { unitDir = mkdtempSync(join(tmpdir(), 'restart-verify-')) })
afterAll(() => { rmSync(unitDir, { recursive: true, force: true }) })
beforeEach(() => {
  for (const m of ['server', 'watch']) writeFileSync(join(unitDir, `agentop-${m}.service`), UNIT)
})

interface World {
  /** What `systemctl --user show` prints, or a failure. */
  show: { code: number; stdout: string; stderr: string }
  restartCode: number
  /** The listener on the port, as observed — a function of how many restarts have happened. */
  serving: (restarts: number) => { pid: number | null; answering: boolean }
}

function fake(world: World) {
  const calls: string[][] = []
  let restarts = 0
  let clock = 0
  const deps: RestartDeps = {
    run: async (cmd) => {
      calls.push(cmd)
      if (cmd.includes('show')) return world.show
      if (cmd.includes('restart')) { restarts += 1; return { code: world.restartCode, stdout: '', stderr: '' } }
      return { code: 0, stdout: '', stderr: '' }
    },
    observe: async () => world.serving(restarts),
    parentOf: async () => null,
    // NEVER the real `reclaimStrayServer`: it probes the real data dir's lock and could stop the
    // machine's own server. The default here proves nothing, so nothing is taken back.
    reclaim: async () => ({ kind: 'unproven', pid: 0 }),
    strings: cliStrings('en'),
    unitDir,
    timeoutMs: 5_000,
    intervalMs: 1_000,
    sleep: async (ms) => { clock += ms },
    now: () => clock,
  }
  return { deps, calls, verbs: () => calls.map(c => c[2] ?? '') }
}

const showOk = (mainPid: number, state = 'active') =>
  ({ code: 0, stdout: `MainPID=${mainPid}\nActiveState=${state}`, stderr: '' })

describe('restartAutostart — the claim is verified by observation', () => {
  test('the manager is unreachable → refuses in a sentence naming the cause, changes nothing', async () => {
    const bus = 'Failed to connect to bus: No medium found'
    const w = fake({
      show: { code: 1, stdout: '', stderr: bus },
      restartCode: 1,
      serving: () => ({ pid: 111, answering: true }),
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain(bus)
    expect(res.message).toContain('agentop server')
    expect(res.message).not.toContain('Restarted')
    expect(w.verbs()).not.toContain('restart')
    expect(w.verbs()).not.toContain('daemon-reload')
  })

  test('the manager "succeeds" but the process serving the port is unchanged → not "Restarted"', async () => {
    const w = fake({
      show: showOk(200),
      restartCode: 0,
      serving: () => ({ pid: 200, answering: true }),
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain('Restarted')
    expect(res.message).toContain('pid 200')
    expect(res.message).toContain('nothing was replaced')
  })

  test('a foreground server holds the port outside the unit → refuses BEFORE restarting, names the pid and the command', async () => {
    const w = fake({
      show: showOk(0, 'inactive'),
      restartCode: 0,
      serving: () => ({ pid: 555, answering: true }),
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('pid 555')
    expect(res.message).toContain('not managed')
    expect(res.message).toContain('kill 555')
    expect(res.message).not.toContain('Restarted')
    expect(w.verbs()).not.toContain('restart')
  })

  test('the unit really replaced the process → "Restarted", with the pid before and after', async () => {
    const w = fake({
      show: showOk(200),
      restartCode: 0,
      serving: (n) => n === 0 ? { pid: 200, answering: true } : { pid: 300, answering: true },
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Restarted agentop-server')
    expect(res.message).toContain('200')
    expect(res.message).toContain('300')
  })

  test('the new process is a child of the unit (a wrapper) → still counts as under the unit', async () => {
    const w = fake({
      show: showOk(200),
      restartCode: 0,
      serving: (n) => n === 0 ? { pid: 210, answering: true } : { pid: 310, answering: true },
    })
    w.deps.parentOf = async (pid) => (pid === 210 ? 200 : null)
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(true)
  })

  test('nothing was running and the unit started it → says "Started", not "Restarted"', async () => {
    const w = fake({
      show: showOk(0, 'inactive'),
      restartCode: 0,
      serving: (n) => n === 0 ? { pid: null, answering: false } : { pid: 300, answering: true },
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Started agentop-server')
    expect(res.message).not.toContain('Restarted')
  })

  test('the restart was accepted but nothing ever answers → refuses, and does not call it a restart', async () => {
    const w = fake({
      show: showOk(200),
      restartCode: 0,
      serving: (n) => n === 0 ? { pid: 200, answering: true } : { pid: null, answering: false },
    })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).not.toContain('Restarted')
    expect(res.message).toContain('did not come back')
  })

  test('the same refusal reads in Portuguese', async () => {
    const w = fake({
      show: showOk(0, 'inactive'),
      restartCode: 0,
      serving: () => ({ pid: 555, answering: true }),
    })
    w.deps.strings = cliStrings('pt')
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('pid 555')
    expect(res.message).toContain('não é gerenciado')
    expect(res.message).not.toContain('not managed')
  })

  test('watch has no port: it is judged by the unit\'s own MainPID', async () => {
    let restarts = 0
    const calls: string[][] = []
    let clock = 0
    const res = await restartAutostart('watch', {
      run: async (cmd) => {
        calls.push(cmd)
        if (cmd.includes('show')) return showOk(restarts === 0 ? 40 : 41)
        if (cmd.includes('restart')) restarts += 1
        return { code: 0, stdout: '', stderr: '' }
      },
      reclaim: async () => ({ kind: 'none' }),
      strings: cliStrings('en'),
      unitDir,
      sleep: async (ms) => { clock += ms },
      now: () => clock,
      intervalMs: 1_000,
      timeoutMs: 5_000,
    })
    expect(res.message).toContain('Restarted agentop-watch')
    expect(res.ok).toBe(true)
    expect(res.message).toContain('40')
    expect(res.message).toContain('41')
  })

  test('a server outside the unit that is PROVABLY ours is stopped, and the unit is restarted onto it (2026-10-04)', async () => {
    let stopped = false
    const w = fake({
      show: showOk(0, 'failed'),
      restartCode: 0,
      serving: (n) => n === 0 ? (stopped ? { pid: null, answering: false } : { pid: 555, answering: true }) : { pid: 600, answering: true },
    })
    w.deps.reclaim = async () => { stopped = true; return { kind: 'reclaimed', pid: 555 } }
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(true)
    expect(res.message).toContain('Stopped agentop server pid 555')
    expect(res.message).toContain('Started agentop-server')
    // A unit left failed by the refused start is cleared before the restart, or it never retries.
    const verbs = w.verbs()
    expect(verbs.indexOf('reset-failed')).toBeGreaterThan(-1)
    expect(verbs.indexOf('reset-failed')).toBeLessThan(verbs.indexOf('restart'))
  })

  test('a reclaim that stopped a DIFFERENT pid than the listener proves nothing → still refused', async () => {
    const w = fake({
      show: showOk(0, 'inactive'),
      restartCode: 0,
      serving: () => ({ pid: 555, answering: true }),
    })
    w.deps.reclaim = async () => ({ kind: 'reclaimed', pid: 777 })
    const res = await restartAutostart('server', w.deps)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('pid 555')
    expect(w.verbs()).not.toContain('restart')
  })
})
