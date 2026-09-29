import { test, expect, describe } from 'bun:test'
import {
  awaitReplacement,
  managerUnreachable,
  parseUnitShow,
  pidUnderUnit,
  SERVICE_MANAGERS,
  availableServiceManagers,
  bootCaveat,
  defaultServiceManager,
  launchdLabel,
  launchdPlist,
  launchdPlistName,
  pm2DeleteArgs,
  pm2StartArgs,
  serviceManagerOptions,
  systemdUnit,
  migrateUnitKillMode,
  migrateUnitPath,
  systemdPathLine,
  type ServiceManagerFacts,
  type ServiceSpec,
} from './service-manager'

function facts(over: Partial<ServiceManagerFacts> = {}): ServiceManagerFacts {
  return { platform: 'linux', systemctl: true, launchctl: false, pm2: false, ...over }
}

const FOREGROUND: ServiceSpec = {
  name: 'agentop-server',
  description: 'agentop server (agentistics autostart)',
  command: '/usr/local/bin/agentop server',
  keepsRunning: true,
}

const RETURNS: ServiceSpec = {
  name: 'agentop-central',
  description: 'agentop central (agentistics autostart)',
  command: 'docker compose -f /home/u/agentistics/docker/central.yml up -d',
  keepsRunning: false,
}

test('each platform offers its own manager and refuses the other by platform, not by absence', () => {
  const linux = serviceManagerOptions(facts({ platform: 'linux', launchctl: true }))
  expect(linux.find(o => o.id === 'launchd')).toEqual({ id: 'launchd', available: false, reason: 'wrong-platform' })

  const mac = serviceManagerOptions(facts({ platform: 'darwin', systemctl: true, launchctl: true }))
  expect(mac.find(o => o.id === 'systemd')).toEqual({ id: 'systemd', available: false, reason: 'wrong-platform' })
  expect(mac.find(o => o.id === 'launchd')?.available).toBe(true)
})

test('the right platform with the tool missing is not-installed, which is a different fix', () => {
  const opt = serviceManagerOptions(facts({ platform: 'linux', systemctl: false })).find(o => o.id === 'systemd')
  expect(opt).toEqual({ id: 'systemd', available: false, reason: 'not-installed' })
})

// pm2 is the answer on a host whose init system this product does not speak, so it must never be
// refused on platform — that is precisely the case where it is the only option left.
test('pm2 is offered on any platform, gated only on being installed', () => {
  for (const platform of ['linux', 'darwin', 'win32', 'freebsd']) {
    expect(availableServiceManagers(facts({ platform, systemctl: false, launchctl: false, pm2: true })))
      .toContain('pm2')
    expect(serviceManagerOptions(facts({ platform, pm2: false })).find(o => o.id === 'pm2')?.reason)
      .toBe('not-installed')
  }
})

// Filing agentop into someone's pm2 list is their decision: it shows up in every `pm2 ls` and is
// caught by `pm2 restart all`.
test('pm2 never wins by default while a native manager is available', () => {
  expect(defaultServiceManager(facts({ platform: 'linux', systemctl: true, pm2: true }))).toBe('systemd')
  expect(defaultServiceManager(facts({ platform: 'darwin', systemctl: false, launchctl: true, pm2: true }))).toBe('launchd')
  expect(defaultServiceManager(facts({ platform: 'darwin', launchctl: false, pm2: true }))).toBe('pm2')
  expect(defaultServiceManager(facts({ platform: 'win32', systemctl: false, pm2: false }))).toBeNull()
})

// THE bug this module exists for: a command that returns cannot be Type=simple, or the unit reads
// inactive(dead) one second after a perfectly successful start.
test('a returning command becomes a oneshot that stays active; a foreground one stays simple', () => {
  const oneshot = systemdUnit(RETURNS)
  expect(oneshot).toContain('Type=oneshot')
  expect(oneshot).toContain('RemainAfterExit=yes')
  expect(oneshot).not.toContain('Restart=on-failure')

  const simple = systemdUnit(FOREGROUND)
  expect(simple).toContain('Type=simple')
  expect(simple).toContain('Restart=on-failure')
  expect(simple).not.toContain('RemainAfterExit')
})

test('the same distinction drives launchd KeepAlive and pm2 autorestart', () => {
  const paths = { stdoutPath: '/tmp/a.log', stderrPath: '/tmp/a.err' }
  expect(launchdPlist(FOREGROUND, paths)).toContain('<key>KeepAlive</key>\n  <true/>')
  expect(launchdPlist(RETURNS, paths)).toContain('<key>KeepAlive</key>\n  <false/>')

  expect(pm2StartArgs(RETURNS)).toContain('--no-autorestart')
  expect(pm2StartArgs(FOREGROUND)).not.toContain('--no-autorestart')
})

test('a launchd agent is labelled and named consistently', () => {
  expect(launchdLabel(RETURNS)).toBe('com.agentistics.agentop-central')
  expect(launchdPlistName(RETURNS)).toBe('com.agentistics.agentop-central.plist')
})

test('pm2 delete is the exact inverse of pm2 start', () => {
  expect(pm2DeleteArgs(RETURNS)).toEqual(['pm2', 'delete', 'agentop-central'])
  expect(pm2StartArgs(RETURNS).slice(0, 2)).toEqual(['pm2', 'start'])
  expect(pm2StartArgs(RETURNS)).toContain(RETURNS.name)
})

// A plist is XML: a command holding an ampersand or a quote must not be able to produce a file
// launchd refuses to parse.
test('plist values are XML-escaped', () => {
  const spec: ServiceSpec = { ...RETURNS, command: 'sh -c "a && b" </dev/null' }
  const out = launchdPlist(spec, { stdoutPath: '/tmp/a&b.log', stderrPath: '/tmp/e.err' })
  expect(out).toContain('a &amp;&amp; b')
  expect(out).toContain('&lt;/dev/null')
  expect(out).toContain('/tmp/a&amp;b.log')
  expect(out).not.toMatch(/<string>[^<]*"[^<]*<\/string>/)
})

test('every manager states what the user must still do for a reboot to bring it back', () => {
  const seen = new Set(SERVICE_MANAGERS.map(bootCaveat))
  expect(seen).toEqual(new Set(['linger', 'login-only', 'pm2-startup']))
})

// THE SESSIONS MUST SURVIVE THE SERVICE. systemd's default KillMode kills the unit's whole cgroup,
// and a tmux server started by `agentop server` lives in it — so every `agentop restart`, and every
// `agentop upgrade` (which restarts each running service onto the new binary), took the whole fleet
// with it. Measured 2026-09-08: seven sessions' last heartbeat at 08:53:17, `Stopping agentop
// server` at 08:53:31.
test('a long-running unit stops only its own process, never the sessions it hosts', () => {
  const simple = systemdUnit(FOREGROUND)
  expect(simple).toContain('KillMode=process')

  // A oneshot's command has already returned; it owns no children to spare.
  expect(systemdUnit(RETURNS)).not.toContain('KillMode')
})

// The rule reaches nobody it exists for unless it reaches the unit ALREADY on disk: a machine that
// hit the bug has the old unit, and nothing rewrote it.
test('an installed unit is migrated in place, keeping every line it already had', () => {
  const old = [
    '[Unit]', 'Description=agentop server (agentistics autostart)', '',
    '[Service]', 'Environment=PATH=/home/u/.local/bin:/usr/bin',
    'Type=simple', 'ExecStart=/home/u/.local/bin/agentop server',
    'Restart=on-failure', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')

  const next = migrateUnitKillMode(old)
  expect(next).not.toBeNull()
  expect(next).toContain('KillMode=process')
  // The PATH took a measurement to get right and the ExecStart names the user's own binary.
  expect(next).toContain('Environment=PATH=/home/u/.local/bin:/usr/bin')
  expect(next).toContain('ExecStart=/home/u/.local/bin/agentop server')
  expect(next).toContain('WantedBy=default.target')

  // Idempotent: running it again changes nothing.
  expect(migrateUnitKillMode(next!)).toBeNull()
})

test('migration declines anything it was not asked to decide', () => {
  // A oneshot owns no children.
  expect(migrateUnitKillMode(systemdUnit(RETURNS))).toBeNull()
  // An explicit KillMode is somebody's decision, even when it is the default.
  expect(migrateUnitKillMode('[Service]\nType=simple\nExecStart=/x\nKillMode=control-group\n')).toBeNull()
  // Nothing to anchor on.
  expect(migrateUnitKillMode('[Service]\nType=simple\n')).toBeNull()
  expect(migrateUnitKillMode('not a unit file at all')).toBeNull()
})

// ── Environment=PATH: quoted, and migrated onto units that predate it ──────────────────────────

const OLD_SERVER_UNIT = [
  '[Unit]', 'Description=agentop server', '',
  '[Service]',
  'Type=simple',
  'ExecStart=/home/u/.local/bin/agentop server',
  '# A session is not part of the service — see systemdUnit().',
  'KillMode=process',
  'Restart=on-failure', 'RestartSec=5', '',
  '[Install]', 'WantedBy=default.target', '',
].join('\n')

const WSL_PATH = '/home/u/.local/bin:/usr/bin:/mnt/c/Program Files/nodejs:/mnt/c/Users/u/AppData/Local/agy/bin'

test('the PATH line is QUOTED — systemd splits a bare value at the first space', () => {
  // On WSL the interactive PATH always carries `/mnt/c/Program Files/...`; written bare, systemd
  // kept `/mnt/c/Program` and dropped every directory after it, Windows-installed harnesses included.
  expect(systemdPathLine('/a:/mnt/c/Program Files/x')).toBe('Environment="PATH=/a:/mnt/c/Program Files/x"')
  expect(systemdUnit(FOREGROUND, WSL_PATH)).toContain(`Environment="PATH=${WSL_PATH}:`)
  expect(systemdUnit(FOREGROUND, WSL_PATH)).not.toMatch(/^Environment=PATH=/m)
})

test('the PATH line escapes what systemd would otherwise interpret', () => {
  expect(systemdPathLine('/a"b')).toBe('Environment="PATH=/a\\"b"')
  expect(systemdPathLine('/a\\b')).toBe('Environment="PATH=/a\\\\b"')
  // `%` is a unit specifier: `%h` would silently become the home directory.
  expect(systemdPathLine('/a%hb')).toBe('Environment="PATH=/a%%hb"')
})

test('migrateUnitPath gives a unit with no PATH the INTERACTIVE caller\'s PATH', () => {
  // The reported machine: a unit from before the PATH fix, only ever migrated for KillMode, so
  // every session the browser started died in the second it was spawned.
  const next = migrateUnitPath(OLD_SERVER_UNIT, '/home/u/.local/bin:/home/u/.bun/bin:/usr/bin')
  expect(next).not.toBeNull()
  expect(next).toContain('Environment="PATH=/home/u/.local/bin:/home/u/.bun/bin:/usr/bin:')
  // Every line the user had is still there.
  for (const line of OLD_SERVER_UNIT.split('\n').filter(Boolean)) expect(next).toContain(line)
  // And it lands in [Service], before the command it is for.
  expect(next!.indexOf('Environment=')).toBeGreaterThan(next!.indexOf('[Service]'))
  expect(next!.indexOf('Environment=')).toBeLessThan(next!.indexOf('ExecStart='))
  // Idempotent.
  expect(migrateUnitPath(next!, '/home/u/other/bin')).toBeNull()
})

test('migrateUnitPath never records systemd\'s own minimal PATH', () => {
  // A restart driven from INSIDE the service reads this PATH. Writing it would record the very
  // thing the line exists to replace, and then block the real repair forever — a PATH line exists.
  const systemdDefault = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/snap/bin'
  expect(migrateUnitPath(OLD_SERVER_UNIT, systemdDefault)).toBeNull()
  expect(migrateUnitPath(OLD_SERVER_UNIT, undefined)).toBeNull()
})

test('migrateUnitPath re-quotes the bare line an older agentop wrote, keeping its value', () => {
  const bare = OLD_SERVER_UNIT.replace('[Service]\n', `[Service]\nEnvironment=PATH=${WSL_PATH}\n`)
  const next = migrateUnitPath(bare, '/somewhere/else')
  expect(next).toContain(`Environment="PATH=${WSL_PATH}"`)
  expect(next).not.toContain('/somewhere/else')
  expect(migrateUnitPath(next!, '/somewhere/else')).toBeNull()
})

test('migrateUnitPath leaves a PATH somebody else set, and units it does not own', () => {
  const bareNoSpace = OLD_SERVER_UNIT.replace('[Service]\n', '[Service]\nEnvironment=PATH=/opt/bin:/usr/bin\n')
  expect(migrateUnitPath(bareNoSpace, '/home/u/.local/bin')).toBeNull()
  const quoted = OLD_SERVER_UNIT.replace('[Service]\n', '[Service]\nEnvironment="PATH=/opt/my bin"\n')
  expect(migrateUnitPath(quoted, '/home/u/.local/bin')).toBeNull()
  // A oneshot's command has returned; it spawns nothing.
  expect(migrateUnitPath(systemdUnit(RETURNS, '/usr/bin'), '/home/u/.local/bin')).toBeNull()
  expect(migrateUnitPath('not a unit file at all', '/home/u/.local/bin')).toBeNull()
})

test('both migrations compose on the same pre-fix unit', () => {
  const ancient = OLD_SERVER_UNIT.replace('# A session is not part of the service — see systemdUnit().\nKillMode=process\n', '')
  const once = migrateUnitPath(migrateUnitKillMode(ancient)!, '/home/u/.local/bin')!
  expect(once).toContain('KillMode=process')
  expect(once).toContain('Environment="PATH=/home/u/.local/bin:')
  expect(migrateUnitKillMode(once)).toBeNull()
  expect(migrateUnitPath(once, '/home/u/.local/bin')).toBeNull()
})

// --- verifying a restart by what is SERVING, never by an exit code ---------------------------

describe('managerUnreachable', () => {
  test('recognises the ways `systemctl --user` says it cannot talk to a manager', () => {
    expect(managerUnreachable('Failed to connect to bus: No medium found')).toBe(true)
    expect(managerUnreachable('Failed to connect to user scope bus via local transport: No such file or directory')).toBe(true)
    expect(managerUnreachable('System has not been booted with systemd as init system (PID 1). Can\'t operate.')).toBe(true)
    expect(managerUnreachable('spawn systemctl ENOENT')).toBe(true)
  })
  test('does not mistake an ordinary unit failure for an unreachable manager', () => {
    expect(managerUnreachable('Unit agentop-server.service not found.')).toBe(false)
    expect(managerUnreachable('')).toBe(false)
  })
})

describe('parseUnitShow', () => {
  test('reads MainPID and ActiveState off `systemctl show`', () => {
    expect(parseUnitShow('MainPID=200\nActiveState=active')).toEqual({ mainPid: 200, state: 'active' })
  })
  test('MainPID=0 means no process, and junk reads as unknown rather than as a pid', () => {
    expect(parseUnitShow('MainPID=0\nActiveState=inactive')).toEqual({ mainPid: null, state: 'inactive' })
    expect(parseUnitShow('nonsense')).toEqual({ mainPid: null, state: 'unknown' })
  })
})

describe('pidUnderUnit', () => {
  test('the unit\'s own process, or a descendant of it, is under the unit', async () => {
    const parents: Record<number, number> = { 210: 205, 205: 200, 200: 1 }
    const parentOf = async (p: number) => parents[p] ?? null
    expect(await pidUnderUnit(200, 200, parentOf)).toBe(true)
    expect(await pidUnderUnit(210, 200, parentOf)).toBe(true)
    expect(await pidUnderUnit(999, 200, parentOf)).toBe(false)
  })
  test('a unit with no main process owns nothing, and a cyclic table cannot loop', async () => {
    expect(await pidUnderUnit(555, null, async () => 1)).toBe(false)
    expect(await pidUnderUnit(1, 200, async (p) => (p === 1 ? 2 : 1))).toBe(false)
  })
})

describe('awaitReplacement', () => {
  const clock = () => { let t = 0; return { sleep: async (ms: number) => { t += ms }, now: () => t } }
  test('replaced: a different pid answers', async () => {
    const c = clock(); let n = 0
    const v = await awaitReplacement({ pid: 200, answering: true },
      async () => (++n < 3 ? { pid: 200, answering: true } : { pid: 300, answering: true }),
      { timeoutMs: 10_000, intervalMs: 1_000, ...c })
    expect(v).toEqual({ kind: 'replaced', before: 200, after: 300 })
  })
  test('unchanged: the same pid is still serving when the window ends', async () => {
    const v = await awaitReplacement({ pid: 200, answering: true },
      async () => ({ pid: 200, answering: true }), { timeoutMs: 3_000, intervalMs: 1_000, ...clock() })
    expect(v).toEqual({ kind: 'unchanged', pid: 200 })
  })
  test('silent: nothing answers when the window ends', async () => {
    const v = await awaitReplacement({ pid: 200, answering: true },
      async () => ({ pid: null, answering: false }), { timeoutMs: 3_000, intervalMs: 1_000, ...clock() })
    expect(v).toEqual({ kind: 'silent', before: 200 })
  })
  test('a new pid that does not answer yet is not a success', async () => {
    const v = await awaitReplacement({ pid: 200, answering: true },
      async () => ({ pid: 300, answering: false }), { timeoutMs: 3_000, intervalMs: 1_000, ...clock() })
    expect(v.kind).toBe('silent')
  })
  test('nothing was running before: any answering pid is a start', async () => {
    const v = await awaitReplacement({ pid: null, answering: false },
      async () => ({ pid: 300, answering: true }), { timeoutMs: 3_000, intervalMs: 1_000, ...clock() })
    expect(v).toEqual({ kind: 'replaced', before: null, after: 300 })
  })
  test('the budget is bounded: it stops observing once spent', async () => {
    let calls = 0
    await awaitReplacement({ pid: 200, answering: true },
      async () => { calls++; return { pid: 200, answering: true } }, { timeoutMs: 3_000, intervalMs: 1_000, ...clock() })
    expect(calls).toBeLessThanOrEqual(5)
  })
})
