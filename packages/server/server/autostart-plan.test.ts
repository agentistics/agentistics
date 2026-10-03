import { describe, expect, test } from 'bun:test'
import {
  formatStatusLines, lingerOutcome, lingerPlan, parseLinger, portHeldVerdict, statusLines,
  autostartRepairPlan, KEEPALIVE_LOCK, startupScript, startupState, STARTUP_FILE_NAME, type StartupState, validDistro, wslTaskCommand, wslTaskIsStale, wslTaskCreateOutcome, wslTaskPlan, wslTaskRemoveOutcome,
} from './autostart-plan'
import { systemdUnit } from './service-manager'

describe('linger', () => {
  test('parseLinger', () => {
    expect(parseLinger('Linger=yes\n')).toBe('yes')
    expect(parseLinger('Linger=no')).toBe('no')
    expect(parseLinger('')).toBe('unknown')
  })
  test('bus missing + linger off → enable-linger with argv, no shell', () => {
    const p = lingerPlan({ busSocket: false, linger: 'no' }, 'ana')
    expect(p).toEqual({ action: 'enable-linger', argv: ['loginctl', 'enable-linger', 'ana'] })
  })
  test('linger already on → nothing to do', () => {
    expect(lingerPlan({ busSocket: false, linger: 'yes' }, 'ana').action).toBe('none')
  })
  test('bus present and linger unknown → nothing to do', () => {
    expect(lingerPlan({ busSocket: true, linger: 'unknown' }, 'ana').action).toBe('none')
  })
  test('bus present but linger off → still enabled (boot needs it)', () => {
    expect(lingerPlan({ busSocket: true, linger: 'no' }, 'ana').action).toBe('enable-linger')
  })
  test('refused linger is NOT active and names the exact command and reason', () => {
    const plan = lingerPlan({ busSocket: false, linger: 'no' }, 'ana')
    const v = lingerOutcome(plan, { code: 1, stderr: 'Access denied' }, 'ana')
    expect(v.active).toBe(false)
    expect(v.message).toContain('NOT active')
    expect(v.message).toContain('Access denied')
    expect(v.message).toContain('sudo loginctl enable-linger ana')
  })
  test('accepted linger is active', () => {
    const plan = lingerPlan({ busSocket: false, linger: 'no' }, 'ana')
    expect(lingerOutcome(plan, { code: 0, stderr: '' }, 'ana').active).toBe(true)
  })
})

describe('WSL logon task', () => {
  test('create / remove / query argv are arrays with the task name', () => {
    const p = wslTaskPlan('Ubuntu-22.04')
    if (!p.ok) throw new Error('expected ok')
    expect(p.name).toBe('Agentistics autostart (Ubuntu-22.04)')
    expect(p.create).toEqual([
      'schtasks.exe', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED',
      '/TN', 'Agentistics autostart (Ubuntu-22.04)',
      '/TR', wslTaskCommand('Ubuntu-22.04'),
    ])
    expect(p.remove).toEqual(['schtasks.exe', '/Delete', '/F', '/TN', 'Agentistics autostart (Ubuntu-22.04)'])
    expect(p.query[1]).toBe('/Query')
  })
  test('hostile or missing distro names are refused, never interpolated', () => {
    for (const bad of ['a b', 'x"; calc', 'a&b', '$(id)', '', undefined, '-d']) {
      expect(validDistro(bad)).toBe(false)
      expect(wslTaskPlan(bad).ok).toBe(false)
    }
  })
  test('create failure says what is lost; success says what happens', () => {
    expect(wslTaskCreateOutcome('T', 0, '').ok).toBe(true)
    const f = wslTaskCreateOutcome('T', 1, 'ACCESS DENIED')
    expect(f.ok).toBe(false)
    expect(f.message).toContain('ACCESS DENIED')
  })
  test('removing an absent task is idempotent success', () => {
    expect(wslTaskRemoveOutcome('T', 1, 'ERROR: The system cannot find the file specified.').ok).toBe(true)
    expect(wslTaskRemoveOutcome('T', 1, 'Access is denied').ok).toBe(false)
    expect(wslTaskRemoveOutcome('T', 0, '').ok).toBe(true)
  })
})

describe('port guard', () => {
  test('free port runs; held port steps aside with one sentence', () => {
    expect(portHeldVerdict(47291, null)).toEqual({ run: true })
    const v = portHeldVerdict(47291, 1234)
    expect(v.run).toBe(false)
    if (!v.run) { expect(v.message).toContain('1234'); expect(v.message.split('\n')).toHaveLength(1) }
  })
  test('the unit carries ExecCondition so a skip is not a failure loop', () => {
    const u = systemdUnit({ name: 'agentop-server', description: 'x', command: '/bin/agentop server', keepsRunning: true, condition: '/bin/agentop autostart guard server' })
    expect(u).toContain('ExecCondition=/bin/agentop autostart guard server')
    expect(u.indexOf('ExecCondition')).toBeLessThan(u.indexOf('ExecStart='))
  })
})

describe('status lines', () => {
  const base = { busSocket: false, linger: 'no' as const, user: 'ana', unitActive: 'inactive', unitEnabled: 'enabled', wsl: null }
  test('each failing fact carries its fix', () => {
    const lines = statusLines({ ...base, wsl: { distro: 'Ubuntu', taskPresent: false } })
    expect(lines.map(l => l.label)).toEqual(['systemd user linger', 'systemd user bus', 'agentop-server unit', 'Windows logon entry'])
    expect(lines.every(l => !l.ok && l.fix)).toBe(true)
    expect(formatStatusLines(lines)).toContain('fix: sudo loginctl enable-linger ana')
  })
  test('healthy machine has no fixes; non-WSL has no task line', () => {
    const lines = statusLines({ ...base, busSocket: true, linger: 'yes', unitActive: 'active' })
    expect(lines).toHaveLength(3)
    expect(lines.every(l => l.ok && !l.fix)).toBe(true)
  })
})

describe('WSL keep-alive and the upgrade repair', () => {
  test('the task keeps the distro alive: hidden, one instance (flock -n), never /bin/true', () => {
    const c = wslTaskCommand('Ubuntu-22.04')
    expect(c).toContain('-WindowStyle Hidden')
    expect(c).toContain('flock')
    expect(c).toContain(KEEPALIVE_LOCK)
    expect(c).toContain("'sleep'".replace("'sleep'", '/bin/sleep'))
    expect(c).toContain("'infinity'")
    expect(c).not.toContain('/bin/true')
    expect(c.length).toBeLessThan(261) // schtasks /TR limit
  })
  test('the old one-shot task reads as stale; the keep-alive does not', () => {
    expect(wslTaskIsStale('Task To Run: wsl.exe -d Ubuntu --exec /bin/true')).toBe(true)
    expect(wslTaskIsStale(`Task To Run: ${wslTaskCommand('Ubuntu')}`)).toBe(false)
  })
  const base = { wsl: true, unitEnabled: true, taskPresent: true, taskStale: false }
  test('not WSL: nothing', () => expect(autostartRepairPlan({ ...base, wsl: false }).action).toBe('none'))
  test('upgraded machine with no autostart: enable, with one plain line', () => {
    const r = autostartRepairPlan({ ...base, unitEnabled: false, taskPresent: false })
    expect(r.action).toBe('enable')
    if (r.action === 'enable') expect(r.line.split('\n')).toHaveLength(1)
  })
  test('missing or stale task: refresh it', () => {
    expect(autostartRepairPlan({ ...base, taskPresent: false }).action).toBe('refresh-task')
    expect(autostartRepairPlan({ ...base, taskStale: true }).action).toBe('refresh-task')
  })
  test('current: untouched; unqueryable task: never guessed', () => {
    expect(autostartRepairPlan(base).action).toBe('none')
    expect(autostartRepairPlan({ ...base, taskPresent: null }).action).toBe('none')
  })
})

describe('WSL Startup-folder fallback', () => {
  test('the script is the one already on the owner\'s machine, byte for byte', () => {
    expect(startupScript('Ubuntu-22.04')).toBe(
      'Set sh = CreateObject("WScript.Shell")\r\nsh.Run "wsl.exe -d Ubuntu-22.04 --exec sleep infinity", 0, False\r\n')
    expect(STARTUP_FILE_NAME).toBe('agentistics-wsl-keepalive.vbs')
  })
  test('state: missing, stale and current, so writing it is idempotent', () => {
    expect(startupState(null, 'U')).toBe('missing')
    expect(startupState('Set sh = x', 'U')).toBe('stale')
    expect(startupState(startupScript('U'), 'U')).toBe('current')
    expect(startupState(startupScript('U'), 'Other')).toBe('stale')
  })
  test('a current startup entry satisfies the repair plan even when the task is refused', () => {
    const f = { wsl: true, unitEnabled: true, taskPresent: false, taskStale: false }
    expect(autostartRepairPlan({ ...f, startup: 'current' }).action).toBe('none')
    expect(autostartRepairPlan({ ...f, startup: 'missing' }).action).toBe('refresh-task')
    expect(autostartRepairPlan({ ...f, startup: 'stale' }).action).toBe('refresh-task')
    expect(autostartRepairPlan({ ...f, startup: null, taskPresent: null }).action).toBe('none')
  })
  test('status counts the startup entry as a registered logon entry', () => {
    const base = { busSocket: true, linger: 'yes' as const, user: 'a', unitActive: 'active', unitEnabled: 'enabled' }
    const row = (startup: StartupState) =>
      statusLines({ ...base, wsl: { distro: 'U', taskPresent: false, startup } }).at(-1)!
    expect(row('current').ok).toBe(true)
    expect(row('missing').ok).toBe(false)
  })
})
