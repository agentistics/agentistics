import { describe, expect, test } from 'bun:test'
import {
  HOOK_SPECS,
  HOOK_EVENT,
  HOOK_VERSION,
  explainHookPlanError,
  hookCommand,
  hookInvocation,
  hookVersionOf,
  isAgentopHookCommand,
  parseHooksArgs,
  planHookInstall,
  planHookRemoval,
  readHookStatus,
} from './claude-hooks'

const CMD = hookCommand('agentop')

/** A settings file with somebody else's hook in it — the case that must survive everything. */
const foreign = () => ({
  env: { PLAYWRIGHT_BROWSER: 'firefox' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/u/.claude/hooks/rtk.sh' }] }],
  },
  model: 'opus',
})

describe('hookInvocation', () => {
  test('prefers the bare name on PATH, so an upgrade that moves the binary cannot break it', () => {
    expect(hookInvocation({ onPath: true, execPath: '/opt/agentop', script: undefined })).toBe('agentop')
  })

  test('pins the compiled binary when it is not on PATH', () => {
    expect(hookInvocation({ execPath: '/home/u/.local/bin/agentop' })).toBe('/home/u/.local/bin/agentop')
  })

  test('carries the interpreter when running from a source checkout', () => {
    expect(hookInvocation({ execPath: '/usr/bin/bun', script: '/repo/packages/server/bin/cli.ts' }))
      .toBe('/usr/bin/bun /repo/packages/server/bin/cli.ts')
  })

  test('quotes a path with a space in it', () => {
    expect(hookInvocation({ execPath: '/home/my user/bin/agentop' })).toBe('"/home/my user/bin/agentop"')
  })
})

describe('recognising our own command', () => {
  test('matches every shape install can produce', () => {
    for (const inv of ['agentop', '/home/u/.local/bin/agentop', '/usr/bin/bun /repo/bin/cli.ts', '"/home/my user/bin/agentop"']) {
      expect(isAgentopHookCommand(hookCommand(inv))).toBe(true)
    }
  })

  test('matches a hand-edited one that added a flag', () => {
    expect(isAgentopHookCommand('agentop hooks context --hook-version 1 --lang pt')).toBe(true)
  })

  test('does not match another tool, nor another agentop verb', () => {
    expect(isAgentopHookCommand('/home/u/.claude/hooks/rtk-rewrite.sh')).toBe(false)
    expect(isAgentopHookCommand('agentop session list')).toBe(false)
    expect(isAgentopHookCommand('mytool hooks context')).toBe(false)
  })

  test('reads the version out of the command, and reports its absence rather than guessing', () => {
    expect(hookVersionOf(CMD)).toBe(HOOK_VERSION)
    expect(hookVersionOf('agentop hooks context')).toBeNull()
  })
})

describe('planHookInstall', () => {
  test('creates the whole path on an empty settings file', () => {
    const r = planHookInstall({}, CMD)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.changed).toBe(true)
    const groups = (r.settings.hooks as any)[HOOK_EVENT]
    expect(groups).toHaveLength(1)
    expect(groups[0].hooks[0]).toEqual({ type: 'command', command: CMD, timeout: 10 })
  })

  test('treats a missing file (null/undefined) as an empty document', () => {
    for (const empty of [null, undefined]) {
      const r = planHookInstall(empty, CMD)
      expect(r.ok && r.changed).toBe(true)
    }
  })

  test('keeps every key and every foreign hook it did not write', () => {
    const before = foreign()
    const r = planHookInstall(before, CMD)
    if (!r.ok) throw new Error('unreachable')
    expect(r.settings.env).toEqual({ PLAYWRIGHT_BROWSER: 'firefox' })
    expect(r.settings.model).toBe('opus')
    expect((r.settings.hooks as any).PreToolUse).toEqual(before.hooks.PreToolUse)
    // …and the input is not mutated, so a caller that refuses to write still holds the original.
    expect(Object.keys(before.hooks)).toEqual(['PreToolUse'])
  })

  test('is idempotent: the second install changes nothing and hands back the same object', () => {
    const first = planHookInstall(foreign(), CMD)
    if (!first.ok) throw new Error('unreachable')
    const second = planHookInstall(first.settings, CMD)
    if (!second.ok) throw new Error('unreachable')
    expect(second.changed).toBe(false)
    expect(second.settings).toBe(first.settings)
  })

  test('joins an existing SessionStart array instead of replacing it', () => {
    const withOther = { hooks: { [HOOK_EVENT]: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }
    const r = planHookInstall(withOther, CMD)
    if (!r.ok) throw new Error('unreachable')
    const groups = (r.settings.hooks as any)[HOOK_EVENT]
    expect(groups).toHaveLength(2)
    expect(groups[0].hooks[0].command).toBe('other.sh')
  })

  test('an older entry is updated IN PLACE, keeping the keys a user added to it', () => {
    const old = {
      hooks: {
        [HOOK_EVENT]: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'agentop hooks context --hook-version 0', timeout: 42 }],
        }],
      },
    }
    const r = planHookInstall(old, CMD)
    if (!r.ok) throw new Error('unreachable')
    expect(r.changed).toBe(true)
    const groups = (r.settings.hooks as any)[HOOK_EVENT]
    expect(groups).toHaveLength(1)
    expect(groups[0].matcher).toBe('startup')
    expect(groups[0].hooks[0]).toEqual({ type: 'command', command: CMD, timeout: 42 })
  })

  test('refuses a document it cannot merge into, rather than replacing it', () => {
    expect(planHookInstall('nonsense', CMD)).toEqual({ ok: false, error: { code: 'settings-not-object' } })
    expect(planHookInstall({ hooks: 'yes' }, CMD)).toEqual({ ok: false, error: { code: 'hooks-not-object' } })
    expect(planHookInstall({ hooks: { [HOOK_EVENT]: {} } }, CMD))
      .toEqual({ ok: false, error: { code: 'event-not-array', event: HOOK_EVENT } })
    expect(explainHookPlanError({ code: 'settings-not-object' }, '/x/settings.json')).toContain('/x/settings.json')
  })
})

describe('planHookRemoval', () => {
  test('is the exact inverse of an install on a foreign file', () => {
    const before = foreign()
    const installed = planHookInstall(before, CMD)
    if (!installed.ok) throw new Error('unreachable')
    const removed = planHookRemoval(installed.settings)
    if (!removed.ok) throw new Error('unreachable')
    expect(removed.changed).toBe(true)
    expect(removed.settings).toEqual(before)
  })

  test('is the exact inverse on an empty file too — the containers it created are gone', () => {
    const installed = planHookInstall({}, CMD)
    if (!installed.ok) throw new Error('unreachable')
    const removed = planHookRemoval(installed.settings)
    if (!removed.ok) throw new Error('unreachable')
    expect(removed.settings).toEqual({})
  })

  test('keeps a group that also carries somebody else\'s hook', () => {
    const shared = {
      hooks: {
        [HOOK_EVENT]: [{
          matcher: 'startup',
          hooks: [{ type: 'command', command: 'other.sh' }, { type: 'command', command: CMD }],
        }],
      },
    }
    const r = planHookRemoval(shared)
    if (!r.ok) throw new Error('unreachable')
    const groups = (r.settings.hooks as any)[HOOK_EVENT]
    expect(groups).toHaveLength(1)
    expect(groups[0].matcher).toBe('startup')
    expect(groups[0].hooks).toEqual([{ type: 'command', command: 'other.sh' }])
  })

  test('removes every copy of ours, including a hand-duplicated one', () => {
    const twice = {
      hooks: {
        [HOOK_EVENT]: [
          { hooks: [{ type: 'command', command: CMD }] },
          { hooks: [{ type: 'command', command: 'agentop hooks context' }] },
        ],
      },
    }
    const r = planHookRemoval(twice)
    if (!r.ok) throw new Error('unreachable')
    expect(r.settings).toEqual({})
  })

  test('removing what was never installed changes nothing at all', () => {
    const before = foreign()
    const r = planHookRemoval(before)
    if (!r.ok) throw new Error('unreachable')
    expect(r.changed).toBe(false)
    expect(r.settings).toBe(before)
  })

  test('refuses a document it cannot read, rather than rewriting it', () => {
    expect(planHookRemoval({ hooks: 7 })).toEqual({ ok: false, error: { code: 'hooks-not-object' } })
  })
})

describe('readHookStatus', () => {
  test('reports nothing on a file that has none of ours', () => {
    expect(readHookStatus(foreign())).toEqual({ installed: false, commands: [], version: null, stale: false })
    expect(readHookStatus('junk').installed).toBe(false)
  })

  test('reports the installed command and its version', () => {
    const r = planHookInstall({}, CMD)
    if (!r.ok) throw new Error('unreachable')
    const st = readHookStatus(r.settings)
    expect(st).toEqual({ installed: true, commands: [CMD], version: HOOK_VERSION, stale: false })
  })

  test('an entry from another version, or one with no version at all, is stale', () => {
    const older = planHookInstall({}, hookCommand('agentop', HOOK_VERSION - 1))
    if (!older.ok) throw new Error('unreachable')
    expect(readHookStatus(older.settings).stale).toBe(true)

    const unversioned = { hooks: { [HOOK_EVENT]: [{ hooks: [{ type: 'command', command: 'agentop hooks context' }] }] } }
    expect(readHookStatus(unversioned)).toMatchObject({ installed: true, version: null, stale: true })
  })
})

describe('parseHooksArgs', () => {
  test('no verb, or an explicit ask, is help', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(parseHooksArgs(argv).kind).toBe('help')
    }
  })

  test('install and uninstall cover both halves by default', () => {
    expect(parseHooksArgs(['install'])).toEqual({ kind: 'install', hook: true, skill: true })
    expect(parseHooksArgs(['uninstall'])).toEqual({ kind: 'uninstall', hook: true, skill: true })
  })

  test('each --only flag narrows to one half', () => {
    expect(parseHooksArgs(['install', '--hook-only'])).toEqual({ kind: 'install', hook: true, skill: false })
    expect(parseHooksArgs(['install', '--skill-only'])).toEqual({ kind: 'install', hook: false, skill: true })
  })

  test('both --only flags together is refused, not resolved', () => {
    const r = parseHooksArgs(['install', '--hook-only', '--skill-only'])
    expect(r.kind).toBe('error')
  })

  test('an unknown option is an error rather than a silent no-op', () => {
    expect(parseHooksArgs(['install', '--force']).kind).toBe('error')
    expect(parseHooksArgs(['nope']).kind).toBe('error')
  })

  test('context accepts the version the installed hook passes back to it', () => {
    expect(parseHooksArgs(['context', '--hook-version', '1'])).toEqual({ kind: 'context' })
  })
})

// ---------------------------------------------------------------------------
// Two events, one merge implementation
// ---------------------------------------------------------------------------

describe('the Stop hook alongside SessionStart', () => {
  const START = 'agentop hooks context --hook-version 2'
  const STOP = 'agentop events emit --hook-version 2'

  test('installing both leaves both, under their own event keys', () => {
    const a = planHookInstall({}, START, 'SessionStart')
    expect(a.ok).toBe(true)
    const b = planHookInstall((a as { settings: any }).settings, STOP, 'Stop')
    expect(b.ok).toBe(true)
    const hooks = (b as { settings: any }).settings.hooks
    expect(hooks.SessionStart[0].hooks[0].command).toBe(START)
    expect(hooks.Stop[0].hooks[0].command).toBe(STOP)
  })

  test('each hook carries its OWN timeout — a per-turn hook may not cost ten seconds', () => {
    const a = planHookInstall({}, START, 'SessionStart') as { settings: any }
    const b = planHookInstall(a.settings, STOP, 'Stop') as { settings: any }
    expect(b.settings.hooks.SessionStart[0].hooks[0].timeout).toBe(10)
    expect(b.settings.hooks.Stop[0].hooks[0].timeout).toBe(5)
  })

  test('removing one leaves the other completely alone', () => {
    const a = planHookInstall({}, START, 'SessionStart') as { settings: any }
    const b = planHookInstall(a.settings, STOP, 'Stop') as { settings: any }
    const removed = planHookRemoval(b.settings, 'SessionStart') as { settings: any; changed: boolean }
    expect(removed.changed).toBe(true)
    expect(removed.settings.hooks.SessionStart).toBeUndefined()
    expect(removed.settings.hooks.Stop[0].hooks[0].command).toBe(STOP)
  })

  test('the matcher is NARROWED by event — a Stop entry moved under SessionStart is not ours to delete', () => {
    expect(isAgentopHookCommand(STOP, 'SessionStart')).toBe(false)
    expect(isAgentopHookCommand(STOP, 'Stop')).toBe(true)
    expect(isAgentopHookCommand(START, 'Stop')).toBe(false)
    expect(isAgentopHookCommand(START, 'SessionStart')).toBe(true)
    // With no event named, either of ours matches.
    expect(isAgentopHookCommand(STOP)).toBe(true)
    expect(isAgentopHookCommand(START)).toBe(true)
  })

  test('a v1 install (SessionStart only) reads as stale, so `install` brings it up to both', () => {
    const v1 = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'agentop hooks context --hook-version 1' }] }] } }
    expect(readHookStatus(v1, HOOK_VERSION, 'SessionStart').stale).toBe(true)
    expect(readHookStatus(v1, HOOK_VERSION, 'Stop').installed).toBe(false)
  })

  test('every spec has a distinct event and a distinct verb pair', () => {
    expect(new Set(HOOK_SPECS.map(s => s.event)).size).toBe(HOOK_SPECS.length)
    expect(new Set(HOOK_SPECS.map(s => s.verb.join(' '))).size).toBe(HOOK_SPECS.length)
    for (const spec of HOOK_SPECS) {
      expect(hookCommand('agentop', HOOK_VERSION, spec.event))
        .toBe(`agentop ${spec.verb[0]} ${spec.verb[1]} --hook-version ${HOOK_VERSION}`)
    }
  })

  test('an event agentop has no hook for is refused rather than fabricated', () => {
    expect(() => hookCommand('agentop', HOOK_VERSION, 'PreToolUse')).toThrow()
  })
})

describe('the engine\'s live-ingestion hooks (A5.1) are not ours to administer', () => {
  const INGEST = 'agentop ingest emit --harness claude --event Stop --hook-version 1'
  test('an `ingest emit` entry is never recognised as one of `agentop hooks`\' own', () => {
    expect(isAgentopHookCommand(INGEST)).toBe(false)
    expect(isAgentopHookCommand(INGEST, 'Stop')).toBe(false)
  })
  test('`agentop hooks uninstall` leaves an ingest entry on Stop exactly where it was', () => {
    const before = { hooks: { Stop: [{ hooks: [{ type: 'command', command: INGEST, timeout: 5 }] }] } }
    const installed = planHookInstall(structuredClone(before), CMD)
    if (!installed.ok) throw new Error('unreachable')
    const removed = planHookRemoval(installed.settings)
    if (!removed.ok) throw new Error('unreachable')
    expect(removed.settings).toEqual(before)
  })
})
