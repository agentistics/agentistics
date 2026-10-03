import { describe, expect, test } from 'bun:test'
import {
  isAgentopServerArgv,
  managedByAgentopUnit,
  planServerRestart,
  type ServerProc,
} from './server-restart-plan'

const SERVICE_CGROUP = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentop-server.service'
const ROOT_CGROUP = '0::/'
const proc = (pid: number, argv: string[], cgroup = ROOT_CGROUP): ServerProc => ({ pid, argv, cgroup })

describe('isAgentopServerArgv — the process IS `agentop server`, judged on its argv', () => {
  test('the installed binary running `server`, with or without flags', () => {
    expect(isAgentopServerArgv(['/home/u/.local/bin/agentop', 'server'])).toBe(true)
    expect(isAgentopServerArgv(['/home/u/.local/bin/agentop', 'server', '--port', '5000'])).toBe(true)
    expect(isAgentopServerArgv(['C:\\Users\\u\\agentop.exe', 'server'])).toBe(true)
  })
  test('everything `pgrep -f "agentop.*(server|start)"` used to kill, and must not', () => {
    // 2026-10-03: the old pattern matched any command line with `agentop` before `server` or
    // `start` — the cockpit, `agentop session start`, a `journalctl -u agentop-server`, an editor
    // with the unit file open.
    expect(isAgentopServerArgv(['/home/u/.local/bin/agentop', 'start'])).toBe(false)
    expect(isAgentopServerArgv(['/home/u/.local/bin/agentop', 'session', 'start', '--bg'])).toBe(false)
    expect(isAgentopServerArgv(['journalctl', '--user', '-u', 'agentop-server'])).toBe(false)
    expect(isAgentopServerArgv(['vim', '/home/u/.config/systemd/user/agentop-server.service'])).toBe(false)
    expect(isAgentopServerArgv(['sh', '-c', 'nohup /home/u/.local/bin/agentop server --bg'])).toBe(false)
    expect(isAgentopServerArgv([])).toBe(false)
  })
  test('`--bg` is a launcher that exits at once, not the server', () => {
    expect(isAgentopServerArgv(['/home/u/.local/bin/agentop', 'server', '--bg'])).toBe(false)
  })
  test('a source checkout (`bun bin/cli.ts server`) counts too', () => {
    expect(isAgentopServerArgv(['/home/u/.bun/bin/bun', '/repo/packages/server/bin/cli.ts', 'server'])).toBe(true)
  })
})

describe('managedByAgentopUnit — read off /proc/<pid>/cgroup', () => {
  test('a process inside an agentop systemd unit belongs to the service manager', () => {
    expect(managedByAgentopUnit(SERVICE_CGROUP)).toBe(true)
    expect(managedByAgentopUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentop-central.service')).toBe(true)
  })
  test('the root cgroup, a tmux scope, or a terminal session does not', () => {
    expect(managedByAgentopUnit(ROOT_CGROUP)).toBe(false)
    expect(managedByAgentopUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/agentop-tmux-1790000.scope')).toBe(false)
    expect(managedByAgentopUnit('0::/user.slice/user-1000.slice/session-3.scope')).toBe(false)
  })
})

describe('planServerRestart — the service manager decides, never pgrep', () => {
  const self = { selfPid: 900 }

  test('installed and active → the service manager restarts it', () => {
    const plan = planServerRestart({ ...self, unitInstalled: true, unitActive: true, procs: [proc(10, ['/b/agentop', 'server'], SERVICE_CGROUP)] })
    expect(plan).toEqual({ kind: 'service' })
  })

  test('THE INCIDENT: installed, but the manager could not be asked → nothing is killed, nothing spawned', () => {
    // 2026-10-03 00:38: `systemctl --user is-active` did not answer `active` from where the upgrade
    // ran, so it fell through to `pgrep`, SIGTERMed the unit's own server and spawned a detached one
    // outside the unit. The unit then crash-looped 190 times against it.
    const plan = planServerRestart({ ...self, unitInstalled: true, unitActive: null, procs: [proc(10, ['/b/agentop', 'server'], SERVICE_CGROUP)] })
    expect(plan).toEqual({ kind: 'manager-unreachable' })
  })

  test('installed but stopped → nothing to restart, nothing started', () => {
    expect(planServerRestart({ ...self, unitInstalled: true, unitActive: false, procs: [] })).toEqual({ kind: 'none' })
  })

  test('installed, and a server is running OUTSIDE it → reported, never killed', () => {
    const plan = planServerRestart({ ...self, unitInstalled: true, unitActive: false, procs: [proc(11, ['/b/agentop', 'server'])] })
    expect(plan).toEqual({ kind: 'outside-service', pids: [11] })
    // …even when the unit is active beside it.
    const both = planServerRestart({ ...self, unitInstalled: true, unitActive: true, procs: [proc(10, ['/b/agentop', 'server'], SERVICE_CGROUP), proc(11, ['/b/agentop', 'server'])] })
    expect(both).toEqual({ kind: 'outside-service', pids: [11] })
  })

  test('no service manager → a detached handover of the unmanaged servers', () => {
    const plan = planServerRestart({ ...self, unitInstalled: false, unitActive: null, procs: [proc(12, ['/b/agentop', 'server'])] })
    expect(plan).toEqual({ kind: 'detached', pids: [12] })
  })

  test('no service manager, no server → nothing', () => {
    expect(planServerRestart({ ...self, unitInstalled: false, unitActive: null, procs: [] })).toEqual({ kind: 'none' })
  })

  test('a process under an agentop unit is never handed over by hand, even with no unit file here', () => {
    const plan = planServerRestart({ ...self, unitInstalled: false, unitActive: null, procs: [proc(13, ['/b/agentop', 'server'], SERVICE_CGROUP)] })
    expect(plan).toEqual({ kind: 'none' })
  })

  test('this process is never a target; non-server processes are ignored', () => {
    const plan = planServerRestart({
      ...self, unitInstalled: false, unitActive: null,
      procs: [proc(900, ['/b/agentop', 'server']), proc(14, ['/b/agentop', 'start'])],
    })
    expect(plan).toEqual({ kind: 'none' })
  })

  test('the PARENT is a target: the dashboard spawns the upgrade from the server it must restart', () => {
    const plan = planServerRestart({ ...self, unitInstalled: false, unitActive: null, procs: [proc(899, ['/b/agentop', 'server'])] })
    expect(plan).toEqual({ kind: 'detached', pids: [899] })
  })
})

import { parseIsActive } from './server-restart-plan'

describe('parseIsActive — silence is not "stopped"', () => {
  test('the words systemctl prints', () => {
    expect(parseIsActive('active\n')).toBe(true)
    expect(parseIsActive('activating')).toBe(true)
    expect(parseIsActive('inactive')).toBe(false)
    expect(parseIsActive('failed')).toBe(false)
  })
  test('no answer (no reachable bus) is UNKNOWN', () => {
    expect(parseIsActive('')).toBeNull()
    expect(parseIsActive('Failed to connect to bus: No such file or directory')).toBeNull()
  })
})

import { serviceFindings } from './server-restart-plan'

describe('serviceFindings — what `agentop doctor` says about the service', () => {
  const GUARDED = '[Unit]\nStartLimitIntervalSec=300\nStartLimitBurst=5\n[Service]\nType=simple\nExecStart=/b/agentop server\nRestartPreventExitStatus=75\n'

  test('the incident shape: the data dir is held by a server outside the unit', () => {
    const f = serviceFindings({ unitText: GUARDED, unitActive: false, holder: { pid: 3825199, cgroup: '0::/' } })
    expect(f).toHaveLength(1)
    expect(f[0]!.status).toBe('warn')
    expect(f[0]!.detail).toContain('3825199')
    expect(f[0]!.detail).toContain('systemctl --user restart agentop-server')
  })

  test('the service holding its own data dir is healthy', () => {
    const f = serviceFindings({ unitText: GUARDED, unitActive: true, holder: { pid: 10, cgroup: '0::/user.slice/user@1000.service/app.slice/agentop-server.service' } })
    expect(f).toEqual([{ status: 'pass', label: 'agentop server runs under its service', detail: expect.stringContaining('pid 10') }])
  })

  test('an installed unit without the restart guards is named, with the command that adds them', () => {
    const old = '[Unit]\n[Service]\nType=simple\nExecStart=/b/agentop server\n'
    const f = serviceFindings({ unitText: old, unitActive: true, holder: { pid: 10, cgroup: '0::/x/agentop-server.service' } })
    expect(f.some(x => x.status === 'warn' && x.detail.includes('agentop restart server'))).toBe(true)
  })

  test('no unit: nothing to say about a service', () => {
    expect(serviceFindings({ unitText: null, unitActive: null, holder: { pid: 1, cgroup: '0::/' } })).toEqual([])
  })
})
