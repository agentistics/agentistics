import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  isOpencodeV2, linkOpencodeV2Processes, opencodeStateDir, opencodeTabSessions, parseOpencodeTabs, readOpencodeTabs, opencodeV2Activity, opencodeV2Status, parseActive,
  parseServiceRecord, parseSessions, readOpencodeV2ProcessSessions, readOpencodeV2Sessions, resetOpencodeV2, type OpencodeV2Session,
} from './opencode-v2-api'
import { analyzeOpencodeV2Status } from '../health'
import type { HealthIssue } from '@agentistics/core'

// Recorded on opencode 2.2.5 (engine fixture `__fixtures__/v2.2.5/sessions.json`): wsA holds one session, wsB four.
const RECORDED = JSON.parse(await Bun.file(new URL('./__fixtures__/opencode-v2.2.5/sessions.json', import.meta.url)).text()) as unknown
const WS_A = '/dev/shm/oc2/api/wsA'
const WS_B = '/dev/shm/oc2/api/wsB'
const SES_A = 'ses_e53f5546fffed0rljfb5dmhJxm'
const T0 = 1793887743086 // wsA's session was created here

const state = (service: unknown = { id: 'x', version: '2.2.5', url: 'http://127.0.0.1:49374', pid: 1, password: 'pw' }): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oc2-state-'))
  if (service) writeFileSync(join(dir, 'service.json'), JSON.stringify(service))
  return dir
}
const res = (body: unknown, ok = true) => Promise.resolve({ ok, json: async () => body })
beforeEach(() => resetOpencodeV2())

describe('pure parsing of the recorded 2.2.5 responses', () => {
  test('sessions: id, directory and times are read', () => {
    const s = parseSessions(RECORDED)
    expect(s).toHaveLength(5)
    expect(s.find(x => x.id === SES_A)).toMatchObject({ directory: WS_A, created: T0 })
    expect(parseSessions({ data: [{ id: 'ses_x' }, 7, null] })).toEqual([])
  })
  test('active: only running ids', () => {
    expect([...parseActive({ data: { ses_1: { type: 'running' }, ses_2: { type: 'idle' } } })]).toEqual(['ses_1'])
    expect(parseActive({ data: {} }).size).toBe(0)
    expect(parseActive(null).size).toBe(0)
  })
  test('service record and state dir', () => {
    expect(parseServiceRecord('{"url":"http://127.0.0.1:49374/","password":"p"}')).toEqual({ url: 'http://127.0.0.1:49374', password: 'p' })
    expect(parseServiceRecord('{"url":"x"}')).toBeNull()
    expect(parseServiceRecord('nope')).toBeNull()
    expect(opencodeStateDir('/home/u/.local/share/opencode', {})).toBe('/home/u/.local/state/opencode')
    expect(opencodeStateDir('/x/opencode', { XDG_STATE_HOME: '/s' })).toBe('/s/opencode')
  })
})

describe('linkOpencodeV2Processes — refuses every ambiguity', () => {
  const sessions = parseSessions(RECORDED)
  const proc = (pid: number, cwd: string, startedMs: number) => ({ pid, cwd, startedMs })
  test('one session in the folder, created after the process started → linked', () => {
    expect(linkOpencodeV2Processes([proc(1, WS_A, T0 - 20_000)], sessions).get(1)).toBe(SES_A)
  })
  test('several sessions touched after the start in one folder → no answer', () => {
    expect(linkOpencodeV2Processes([proc(1, WS_B, T0 - 300_000)], sessions).size).toBe(0)
  })
  test('no session yet (all older than the start) → no answer', () => {
    expect(linkOpencodeV2Processes([proc(1, WS_A, T0 + 10 * 60_000)], sessions).size).toBe(0)
  })
  test('two TUIs in one folder → neither', () => {
    expect(linkOpencodeV2Processes([proc(1, WS_A, T0 - 5_000), proc(2, WS_A, T0 - 6_000)], sessions).size).toBe(0)
  })
  test('another folder is not a candidate; a process without a start time links nothing', () => {
    expect(linkOpencodeV2Processes([proc(1, '/elsewhere', T0 - 5_000), { pid: 2, cwd: WS_A }], sessions).size).toBe(0)
  })
  test('a session a managed row already drives is not a candidate for a TUI; a subagent never is', () => {
    expect(linkOpencodeV2Processes([proc(1, WS_A, T0 - 5_000)], sessions, new Set([SES_A])).size).toBe(0)
    const child: OpencodeV2Session = { id: 'ses_child', directory: WS_A, created: T0 + 1, updated: T0 + 1, parentId: SES_A }
    expect(linkOpencodeV2Processes([proc(1, WS_A, T0 - 5_000)], [...sessions, child]).get(1)).toBe(SES_A)
  })
})

describe('IO through a fake fetch', () => {
  test('lists sessions with Basic auth and caches the answer', async () => {
    let calls = 0
    let auth = ''
    const fetch = (url: string, init: { headers: Record<string, string> }) => {
      calls++; auth = init.headers.authorization!
      expect(url).toContain('/api/session?')
      return res(RECORDED)
    }
    const io = { stateDir: state(), fetch }
    expect((await readOpencodeV2Sessions(io))!).toHaveLength(5)
    await readOpencodeV2Sessions(io)
    expect(calls).toBe(1)
    expect(auth).toBe(`Basic ${Buffer.from('opencode:pw').toString('base64')}`)
    expect(opencodeV2Status()?.reachable).toBe(true)
    const linked = await readOpencodeV2ProcessSessions([{ pid: 9, cwd: WS_A, startedMs: T0 - 1000 }], io)
    expect(linked.get(9)).toBe(SES_A)
  })
  test('activity: running → working, absent → waiting, unreachable → null', async () => {
    const io = (body: unknown) => ({ stateDir: state(), fetch: () => res(body) })
    expect(await opencodeV2Activity(SES_A, io({ data: { [SES_A]: { type: 'running' } } }))).toBe('working')
    resetOpencodeV2()
    expect(await opencodeV2Activity(SES_A, io({ data: {} }))).toBe('waiting')
    resetOpencodeV2()
    expect(await opencodeV2Activity(SES_A, { stateDir: state(), fetch: () => Promise.reject(new Error('ECONNREFUSED')) })).toBeNull()
  })
  test('never throws: no service.json, HTTP error, bad JSON all answer null and record the failure', async () => {
    expect(await readOpencodeV2Sessions({ stateDir: state(null) })).toBeNull()
    expect(opencodeV2Status()).toMatchObject({ reachable: false })
    resetOpencodeV2()
    expect(await readOpencodeV2Sessions({ stateDir: state(), fetch: () => res({}, false) })).toBeNull()
    resetOpencodeV2()
    expect(await readOpencodeV2Sessions({ stateDir: state(), fetch: () => Promise.resolve({ ok: true, json: async () => { throw new Error('bad') } }) })).toBeNull()
  })
  test('a failed service is not asked again within the TTL', async () => {
    let calls = 0
    const io = { stateDir: state(), now: () => 1000, fetch: () => { calls++; return Promise.reject(new Error('down')) } }
    await readOpencodeV2Sessions(io); await readOpencodeV2Sessions(io)
    expect(calls).toBe(1)
  })
  test('pages until a short page', async () => {
    const mk = (n: number) => ({ id: `ses_${n}`, location: { directory: '/d' }, time: { created: n, updated: n } })
    const pages = [{ data: Array.from({ length: 200 }, (_, i) => mk(i)), cursor: { next: 'c1' } }, { data: [mk(500)], cursor: { next: 'c2' } }]
    let i = 0
    const out = await readOpencodeV2Sessions({ stateDir: state(), fetch: () => res(pages[i++]) })
    expect(out).toHaveLength(201)
    expect(i).toBe(2)
  })
})

describe('isOpencodeV2', () => {
  test('a store with session_v2, or a live service record; a 1.x store is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc2-db-'))
    const v1 = join(dir, 'v1.db'), v2 = join(dir, 'v2.db')
    let d = new Database(v1); d.run('CREATE TABLE session (id TEXT)'); d.close()
    d = new Database(v2); d.run('CREATE TABLE session_v2 (id TEXT)'); d.close()
    const noState = join(dir, 'none'); mkdirSync(noState)
    expect(isOpencodeV2(v1, noState)).toBe(false)
    expect(isOpencodeV2(v2, noState)).toBe(true)
    expect(isOpencodeV2(join(dir, 'absent.db'), noState)).toBe(false)
    expect(isOpencodeV2(v1, state())).toBe(true)
  })
})

describe('health: never silent', () => {
  test('an unreachable service raises a warning; a reachable or stale one does not', () => {
    const bad = { reachable: false, at: 1000, reason: 'service.json absent' }
    const out: HealthIssue[] = []
    analyzeOpencodeV2Status(bad, 2000, out)
    expect(out).toHaveLength(1)
    expect(out[0]!.title).toBe('OpenCode sessions cannot be read')
    expect(out[0]!.guide).toContain('opencode service start')
    const none: HealthIssue[] = []
    analyzeOpencodeV2Status({ reachable: true, at: 1000 }, 2000, none)
    analyzeOpencodeV2Status(bad, 1000 + 10 * 60_000, none)
    analyzeOpencodeV2Status(null, 2000, none)
    expect(none).toEqual([])
  })
})

// OPENCODE.ATIVAS-TUI — a 2.x TUI holds SEVERAL sessions (its tabs) and writes them to `<state>/<channel>/tui/tabs.json`
// (recorded on 2.2.5, 2026-11-06: one TUI in /work/ws with two open tabs, one in /work/ws2, one in the home dir).
describe('the TUI tabs record — one process, several sessions', () => {
  const TABS = readFileSync(new URL('./__fixtures__/opencode-v2.2.5/tabs.json', import.meta.url), 'utf8')
  const ref = (pid: number, cwd: string, tty?: boolean) => ({ pid, cwd, startedMs: 1, ...(tty !== undefined ? { tty } : {}) })

  test('the recorded file is read per directory, in tab order', () => {
    const t = parseOpencodeTabs(TABS)
    expect(t.cwd.get('/work/ws')).toEqual(['ses_e518c628affezx8DVpFfW7DYbK', 'ses_e518c336fffef88wYtVixaUt8C'])
    expect(t.cwd.get('/work/ws2')).toEqual(['ses_e5189f9d0ffebyLrwS5rCUdmAW'])
    expect(t.global).toEqual([])
  })

  test('junk is an empty record, never a throw', () => {
    for (const raw of ['', 'nope', '[]', '{"cwd":3}', '{"cwd":{"/a":{"tabs":[{"title":"no id"},7]}}}']) {
      const t = parseOpencodeTabs(raw)
      expect([...t.cwd.values()].flat()).toEqual([])
    }
  })

  test('each TUI gets every tab of ITS directory — three tabs are three sessions, not an ambiguity', () => {
    const t = parseOpencodeTabs(TABS)
    const m = opencodeTabSessions([ref(10, '/work/ws'), ref(11, '/work/ws2'), ref(12, '/elsewhere')], t)
    expect(m.get(10)).toEqual(['ses_e518c628affezx8DVpFfW7DYbK', 'ses_e518c336fffef88wYtVixaUt8C'])
    expect(m.get(11)).toEqual(['ses_e5189f9d0ffebyLrwS5rCUdmAW'])
    expect(m.has(12)).toBe(false)
  })

  test('a session a managed row drives is not offered to a TUI; a non-tty process gets nothing', () => {
    const t = parseOpencodeTabs(TABS)
    const m = opencodeTabSessions([ref(10, '/work/ws'), ref(11, '/work/ws2', false)], t, new Set(['ses_e518c628affezx8DVpFfW7DYbK']))
    expect(m.get(10)).toEqual(['ses_e518c336fffef88wYtVixaUt8C'])
    expect(m.has(11)).toBe(false)
  })

  test('global tabs belong to the TUI only when exactly one is running', () => {
    const t = parseOpencodeTabs('{"global":{"tabs":[{"sessionID":"ses_g"}]},"cwd":{}}')
    expect(opencodeTabSessions([ref(10, '/a')], t).get(10)).toEqual(['ses_g'])
    expect(opencodeTabSessions([ref(10, '/a'), ref(11, '/b')], t).size).toBe(0)
  })

  test('every channel directory is read and merged (IO)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc2-tabs-'))
    mkdirSync(join(dir, 'latest', 'tui'), { recursive: true })
    mkdirSync(join(dir, 'beta', 'tui'), { recursive: true })
    writeFileSync(join(dir, 'latest', 'tui', 'tabs.json'), TABS)
    writeFileSync(join(dir, 'beta', 'tui', 'tabs.json'), '{"cwd":{"/work/ws":{"tabs":[{"sessionID":"ses_beta"},{"sessionID":"ses_e518c336fffef88wYtVixaUt8C"}]}}}')
    const t = readOpencodeTabs(dir)
    expect(new Set(t.cwd.get('/work/ws'))).toEqual(new Set(['ses_e518c628affezx8DVpFfW7DYbK', 'ses_e518c336fffef88wYtVixaUt8C', 'ses_beta']))
    expect(readOpencodeTabs(join(dir, 'missing')).cwd.size).toBe(0)
  })
})
