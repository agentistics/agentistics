import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyExperimentalFromDisk } from './experimental-boot'
import { buildThrowawayEnv, isThrowawayEnvDrop, isThrowawaySwitch, keptEnvOf, parseArgs, throwawayFetchRefusal, THROWAWAY_ENV_ALLOW } from './cli-run'

const REAL = { HOME: '/real', PATH: '/bin' }
const build = (source: Record<string, string>, opts: { keep?: string[]; serve?: boolean } = {}) =>
  buildThrowawayEnv('/tmp/h', 'iso', 48100, 48101, { ...REAL, ...source }, { tmp: '/tmp/agr-x', ...opts })

describe('RUN.ISOLAMENTO r2: env rules', () => {
  test('the prefix rule is case-insensitive', () => {
    const env = build({ agentistics_flows: '1', Agentop_Managed_Id: 'x', Agentistics_Provider: '1' })
    expect(env.agentistics_flows).toBeUndefined()
    expect(env.Agentop_Managed_Id).toBeUndefined()
    expect(env.Agentistics_Provider).toBeUndefined()
  })
  test('the allow list is EXACT: a name that merely starts like an allowed one is dropped', () => {
    expect(isThrowawaySwitch('AGENTISTICS_REAPER_EXTRA')).toBe(true)
    expect(isThrowawaySwitch('AGENTISTICS_HEAVY_JOB_X')).toBe(true)
    expect(isThrowawaySwitch('AGENTISTICS_REAPE')).toBe(true)
    expect(isThrowawaySwitch('agentistics_reaper')).toBe(true)
    expect(isThrowawaySwitch('AGENTISTICS_REAPER')).toBe(false)
    expect(build({ AGENTISTICS_REAPER_EXTRA: '1' }).AGENTISTICS_REAPER_EXTRA).toBeUndefined()
  })
  test('git variables a hook leaks (they point git at the real checkout) are dropped', () => {
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_NOSYSTEM']
    const env = build(Object.fromEntries(names.map(k => [k, '/real'])))
    for (const k of names) expect(env[k]).toBeUndefined()
    expect(build({ GIT_AUTHOR_NAME: 'x' }).GIT_AUTHOR_NAME).toBe('x')
  })
  test('--keep-env may keep a git variable explicitly', () => {
    expect(build({ GIT_CONFIG_GLOBAL: '/g' }, { keep: ['GIT_CONFIG_GLOBAL'] }).GIT_CONFIG_GLOBAL).toBe('/g')
    expect(() => parseArgs(['--rm', '--keep-env', 'GIT_CONFIG_GLOBAL', '--', 'true'])).not.toThrow()
  })
  test('--keep-env REFUSES, with a sentence, every name that moves the store or config or that the run overwrites', () => {
    const refused = ['AGENTISTICS_DIR', 'AGENTISTICS_HOME', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'AGENTISTICS_FOO_DIR', 'AGENTISTICS_FOO_HOME',
      'AGENTISTICS_FOO_PATH', 'AGENTISTICS_FOO_FILE', 'AGENTISTICS_THROWAWAY', 'AGENTISTICS_THROWAWAY_SERVE', 'AGENTISTICS_THROWAWAY_API_PORT', 'AGENTISTICS_EXPERIMENTAL',
      'AGENTISTICS_SERVER_FOREGROUND', 'PORT', 'WEB_PORT', 'TMPDIR', 'CLAUDE_CONFIG_DIR']
    for (const name of refused) expect(() => parseArgs(['--rm', '--keep-env', name, '--', 'true'])).toThrow(/cannot be kept/)
  })
  test('the printed "kept env" list is exactly what the child really receives', () => {
    const source = { ...REAL, AGENTISTICS_FLOWS: '1', AGENTISTICS_PROVIDER: '2', GIT_CONFIG_GLOBAL: '/g' }
    const keep = ['AGENTISTICS_FLOWS', 'AGENTISTICS_PROVIDER', 'GIT_CONFIG_GLOBAL', 'AGENTISTICS_NOT_SET']
    const env = buildThrowawayEnv('/tmp/h', 'iso', 48100, 48101, source, { tmp: '/tmp/agr-x', keep })
    const kept = keptEnvOf(env, source, keep)
    expect(kept).toEqual(['AGENTISTICS_FLOWS', 'AGENTISTICS_PROVIDER', 'GIT_CONFIG_GLOBAL'])
    for (const k of kept) expect(env[k]).toBe(source[k as keyof typeof source])
    // a name the run overwrote is never reported as kept, even if someone slipped it past the parser
    const env2 = buildThrowawayEnv('/tmp/h', 'iso', 48100, 48101, { ...REAL, AGENTISTICS_DIR: '/real/.agentistics' }, { tmp: '/tmp/agr-x', keep: ['AGENTISTICS_DIR'] })
    expect(keptEnvOf(env2, { ...REAL, AGENTISTICS_DIR: '/real/.agentistics' }, ['AGENTISTICS_DIR'])).toEqual([])
    expect(env2.AGENTISTICS_DIR).not.toBe('/real/.agentistics')
  })
})

describe('RUN.ISOLAMENTO r2: the CLI guard refuses every loopback spelling of the real ports', () => {
  const serve = build({}, { serve: true })
  const plain = build({}, { serve: false })
  const forms = ['localhost', 'localhost.', 'LOCALHOST', 'Localhost.', 'api.localhost', '127.0.0.1', '127.0.0.2', '127.255.255.254', '127.1', '2130706433', '0x7f000001',
    '[::1]', '[0:0:0:0:0:0:0:1]', '[::ffff:127.0.0.1]', '[::ffff:127.0.0.9]', '0.0.0.0', '[::]', 'my-box', 'MY-BOX.']
  const HOST = 'my-box'
  const refusal = (e: Record<string, string | undefined>, url: string) => throwawayFetchRefusal(e, url, HOST)
  test('real ports, every host form, every scheme', () => {
    for (const h of forms) for (const scheme of ['http', 'https', 'ws', 'wss']) {
      for (const port of [47291, 47292]) expect(refusal(serve, `${scheme}://${h}:${port}/x`)).toMatch(/real agentop server/)
    }
  })
  test('credentials in the URL do not hide the host', () => {
    expect(refusal(serve, 'http://user:pw@localhost.:47291/x')).toMatch(/real agentop server/)
  })
  test('the run\'s own ports without --serve are refused for every loopback form too', () => {
    for (const h of forms) for (const scheme of ['http', 'ws']) {
      expect(refusal(plain, `${scheme}://${h}:48100/x`)).toBe('inside an agentop run without --serve: no server to talk to')
    }
  })
  test('with --serve the run\'s own port stays reachable on every form; other hosts and a 127 lookalike are untouched', () => {
    for (const h of forms) expect(refusal(serve, `http://${h}:48100/x`)).toBeNull()
    expect(refusal(serve, 'http://128.0.0.1:47291/x')).toBeNull()
    expect(refusal(serve, 'http://127.0.0.1.example.com:47291/x')).toBeNull()
    expect(refusal(serve, 'http://example.com:47291/x')).toBeNull()
    expect(refusal(serve, 'http://localhost:51234/x')).toBeNull()
    expect(refusal(serve, 'http://localhost/x')).toBeNull()
  })
  test('outside a run nothing is refused, whatever the form', () => {
    for (const h of forms) expect(refusal({}, `http://${h}:47291/x`)).toBeNull()
  })
})

describe('RUN.ISOLAMENTO r2: the help states the real scope', () => {
  test('usage says the guard covers the agentop CLI only', () => {
    const src = require('node:fs').readFileSync(new URL('./cli-run.ts', import.meta.url), 'utf8') as string
    expect(src).toMatch(/guards? the agentop CLI only/i)
    expect(src).not.toMatch(/never reaches the real server/i)
  })
})

describe('RUN.FLOWS-HERDADO: behaviour switches of the real app never reach a run', () => {
  test('AGENTISTICS_FLOWS inherited from the parent is gone from the child env', () => {
    expect(build({ AGENTISTICS_FLOWS: '1' }).AGENTISTICS_FLOWS).toBe('0')
  })
  test('every other feature switch the app applies is gone too, and the "applied" bookkeeping with them', () => {
    const switches = ['AGENTISTICS_ADAPTER_CHAT', 'AGENTISTICS_PROVIDER', 'AGENTISTICS_PROJECTIONS', 'AGENTISTICS_JOURNAL',
      'AGENTISTICS_CHAT_HISTORY_ENGINE', 'AGENTISTICS_MULTI_ACCOUNT', 'AGENTISTICS_EXPERIMENTAL_APPLIED', 'AGENTISTICS_FLOWS_PRIOR',
      'AGENTISTICS_AUTO_UPGRADE', 'AGENTISTICS_ALLOW_LOCAL_SHELL', 'AGENTISTICS_API', 'AGENTISTICS_FUTURE_SWITCH']
    const env = build(Object.fromEntries(switches.map(k => [k, '1'])))
    for (const k of switches) expect(env[k]).toBeUndefined()
    expect(env.AGENTISTICS_EXPERIMENTAL).toBe('0')
  })
  test('the real session identity does not travel into the run', () => {
    expect(build({ AGENTOP_MANAGED_ID: 'abc123' }).AGENTOP_MANAGED_ID).toBeUndefined()
  })
  test('what the run itself needs survives: the run knobs, the heavy marker, the protective narrowers', () => {
    const env = build({ AGENTISTICS_RUN_NO_WAIT: '1', AGENTISTICS_RUN_TMP_TAG: 'qa', AGENTISTICS_REAPER: '0', AGENTISTICS_GOVERNOR: '0' })
    expect(env.AGENTISTICS_RUN_NO_WAIT).toBe('1')
    expect(env.AGENTISTICS_RUN_TMP_TAG).toBe('qa')
    expect(env.AGENTISTICS_REAPER).toBe('0')
    expect(env.AGENTISTICS_GOVERNOR).toBe('0')
    expect(env.PATH).toBe('/bin')
  })
  test('--keep-env re-allows exactly the named switch', () => {
    const env = build({ AGENTISTICS_FLOWS: '1', AGENTISTICS_PROVIDER: '1' }, { keep: ['AGENTISTICS_FLOWS'] })
    expect(env.AGENTISTICS_FLOWS).toBe('1')
    expect(env.AGENTISTICS_PROVIDER).toBeUndefined()
  })
  test('--keep-env parses (repeatable) and refuses a store-moving variable', () => {
    expect(parseArgs(['--rm', '--keep-env', 'AGENTISTICS_FLOWS', '--keep-env', 'AGENTISTICS_PROVIDER', '--', 'true'])).toMatchObject({ keepEnv: ['AGENTISTICS_FLOWS', 'AGENTISTICS_PROVIDER'] })
    expect(parseArgs(['--rm', '--', 'true'])).toMatchObject({ keepEnv: [] })
    expect(() => parseArgs(['--rm', '--keep-env', 'AGENTISTICS_JOURNAL_DIR', '--', 'true'])).toThrow(/cannot be kept/)
    expect(() => parseArgs(['--rm', '--keep-env', 'lowercase', '--', 'true'])).toThrow(/--keep-env/)
    expect(() => parseArgs(['--rm', '--keep-env'])).toThrow(/--keep-env/)
  })
  test('the rule is a prefix rule with a reasoned allow list, not a hand list', () => {
    expect(isThrowawaySwitch('AGENTISTICS_BRAND_NEW')).toBe(true)
    expect(isThrowawayEnvDrop('AGENTISTICS_BRAND_NEW')).toBe(true)
    expect(isThrowawaySwitch('PATH')).toBe(false)
    for (const reason of Object.values(THROWAWAY_ENV_ALLOW)) expect(reason.length).toBeGreaterThan(10)
  })
})

describe('RUN.CLI-SERVIDOR-REAL: the CLI inside a run addresses the run, never the real server', () => {
  const serve = build({}, { serve: true })
  const plain = build({}, { serve: false })
  test('the run records its own server address and whether it has one', () => {
    expect(serve.AGENTISTICS_THROWAWAY_SERVE).toBe('1')
    expect(serve.AGENTISTICS_THROWAWAY_API_PORT).toBe('48100')
    expect(serve.AGENTISTICS_THROWAWAY_WEB_PORT).toBe('48101')
    expect(serve.PORT).toBe('48100')
    expect(plain.AGENTISTICS_THROWAWAY_SERVE).toBe('0')
  })
  test('outside a run nothing is refused', () => {
    expect(throwawayFetchRefusal({}, 'http://127.0.0.1:47291/api/fleet')).toBeNull()
  })
  test('inside a run a call to the real ports is refused, whatever the host spelling', () => {
    for (const url of ['http://127.0.0.1:47291/api/x', 'http://localhost:47292/', 'http://[::1]:47291/api/x']) {
      expect(throwawayFetchRefusal(serve, url)).toMatch(/real agentop server/)
    }
    expect(throwawayFetchRefusal(plain, 'http://localhost:47291/api/x')).toMatch(/real agentop server/)
  })
  test('with --serve the run\'s own port is allowed; an unrelated host is untouched', () => {
    expect(throwawayFetchRefusal(serve, 'http://127.0.0.1:48100/api/fleet')).toBeNull()
    expect(throwawayFetchRefusal(serve, 'https://api.github.com/x')).toBeNull()
    expect(throwawayFetchRefusal(serve, 'http://localhost:51234/x')).toBeNull()
  })
  test('without --serve the run\'s own port is refused with a sentence', () => {
    expect(throwawayFetchRefusal(plain, 'http://127.0.0.1:48100/api/fleet')).toBe('inside an agentop run without --serve: no server to talk to')
    expect(throwawayFetchRefusal(plain, 'http://localhost:48101/')).toBe('inside an agentop run without --serve: no server to talk to')
  })
})

describe('QA 2.225.0 R1: a copied store cannot switch the flows back on', () => {
  test('preferences with experimental + autonomous mode on: the run\'s server still boots with FLOWS 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agr-flows-r1-'))
    try {
      writeFileSync(join(dir, 'preferences.json'), JSON.stringify({ experimental: true, away: { on: true, since: new Date().toISOString() } }))
      const env: Record<string, string | undefined> = { ...build({}), AGENTISTICS_DIR: dir }
      expect(env.AGENTISTICS_FLOWS).toBe('0')
      applyExperimentalFromDisk(env)
      expect(env.AGENTISTICS_FLOWS).toBe('0')
      // Control: without the run's explicit 0 the same store turns them on (this is the hole R1 closes).
      const bare: Record<string, string | undefined> = { AGENTISTICS_DIR: dir }
      applyExperimentalFromDisk(bare)
      expect(bare.AGENTISTICS_FLOWS).toBe('1')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
