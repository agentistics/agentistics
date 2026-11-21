import { describe, expect, test } from 'bun:test'
import { buildThrowawayEnv, isThrowawayEnvDrop, isThrowawaySwitch, parseArgs, throwawayFetchRefusal, THROWAWAY_ENV_ALLOW } from './cli-run'

const REAL = { HOME: '/real', PATH: '/bin' }
const build = (source: Record<string, string>, opts: { keep?: string[]; serve?: boolean } = {}) =>
  buildThrowawayEnv('/tmp/h', 'iso', 48100, 48101, { ...REAL, ...source }, { tmp: '/tmp/agr-x', ...opts })

describe('RUN.FLOWS-HERDADO: behaviour switches of the real app never reach a run', () => {
  test('AGENTISTICS_FLOWS inherited from the parent is gone from the child env', () => {
    expect(build({ AGENTISTICS_FLOWS: '1' }).AGENTISTICS_FLOWS).toBeUndefined()
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
