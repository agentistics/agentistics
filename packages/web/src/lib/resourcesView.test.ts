import { describe, expect, test } from 'bun:test'
import { groupAlerts, staleMcpSentence, alertSentence, fixFor, fmtAge, fmtMb, heavyLine, killSentence, ownerText, type ResAlert, type ResProcess } from './resourcesView'

const MB = 1024 * 1024
const proc = (o: Partial<ResProcess> = {}): ResProcess => ({
  pid: 9, kind: 'mcp', label: 'agentop mcp', usedBytes: 50 * MB, cpuPercent: 0, ageSec: 60,
  stale: false, orphan: false, owner: null, self: false, isolatedHome: false, ...o,
})

describe('resourcesView', () => {
  test('an alert names the culprit and the numbers, in both languages', () => {
    const a: ResAlert = { pid: 40, label: 'agentop', reason: 'over-budget', usedBytes: 8200 * MB, budgetBytes: 768 * MB, fix: { action: 'reopen-cockpit', pid: 40 } }
    expect(alertSentence(a, 'en')).toBe('agentop (pid 40) uses 8.0 GB of RAM+swap, over its 768 MB budget.')
    expect(alertSentence(a, 'pt')).toContain('acima do limite de 768 MB')
  })
  test('only a kill is a button; the rest are the exact sentence to act on', () => {
    const base = { pid: 1, label: 'x', reason: 'stale-binary' as const, usedBytes: null }
    expect(fixFor({ ...base, fix: { action: 'kill', pid: 1 } }, 'en')).toEqual({ button: 'Stop it' })
    expect(fixFor({ ...base, fix: { action: 'restart-server', pid: 1 } }, 'en')?.text).toContain('agentop restart server')
    expect(fixFor({ ...base, fix: { action: 'reconnect-session', pid: 1 } }, 'pt')?.button).toBeUndefined()
    expect(fixFor({ ...base, fix: null }, 'en')).toBeNull()
  })
  test('the owner is never blank', () => {
    expect(ownerText(proc(), 'en')).toBe('unknown')
    expect(ownerText(proc({ orphan: true }), 'en')).toBe('none (orphan)')
    expect(ownerText(proc({ owner: { kind: 'session', pid: 5, sessionId: 'abcdef123456', alive: false } }), 'en')).toBe('abcdef12 — ended')
    expect(ownerText(proc({ self: true }), 'pt')).toBe('este servidor')
  })
  test('formatting', () => {
    expect(fmtMb(null)).toBe('N/A')
    expect(fmtMb(512 * MB)).toBe('512 MB')
    expect(fmtAge(35_000)).toBe('9h43')
    expect(killSentence({ pid: 3, label: 'agentop mcp', reason: 'orphan-mcp', usedBytes: 30 * MB, atMs: 0 }, 'en'))
      .toBe('agentop mcp (pid 3, 30 MB) stopped — its assistant was gone.')
    expect(heavyLine({ slots: 2, availableBytes: 4 * 1024 * MB, running: [], waiting: [] }, 'en')).toBe('0 running, 0 queued — 2 slot(s) with 4.0 GB available.')
  })
})

test('stale MCPs after an upgrade become one line; other alerts stay their own', () => {
  const inv = [proc({ pid: 1 }), proc({ pid: 2 }), proc({ pid: 3, kind: 'cockpit', label: 'agentop' })]
  const a = (pid: number, reason: ResAlert['reason']): ResAlert => ({ pid, label: 'x', reason, usedBytes: null, fix: null })
  const g = groupAlerts([a(1, 'stale-binary'), a(2, 'stale-binary'), a(3, 'stale-binary'), a(1, 'over-budget')], inv)
  expect(g.staleMcpPids).toEqual([1, 2])
  expect(g.single.map(x => [x.pid, x.reason])).toEqual([[3, 'stale-binary'], [1, 'over-budget']])
  expect(staleMcpSentence([1, 2], 'en')).toBe('2 MCP server(s) of open sessions still run the agentop from before the upgrade (pid 1, 2).')
})

import { endNote, harnessBreakdown, orphansOf, recommendedActions, recommendedSentence, staleBySession, } from './resourcesView'

const rp = (o: Partial<ResProcess>): ResProcess => ({
  pid: 1, kind: 'mcp', label: 'agentop mcp', usedBytes: 100 * 1024 ** 2, cpuPercent: 0, ageSec: 1,
  stale: true, orphan: false, owner: null, self: false, isolatedHome: false, ...o,
})
const stale = (pid: number): ResAlert => ({ pid, label: 'x', reason: 'stale-binary', usedBytes: 0, fix: null })

describe('RES.ACTIONS view', () => {
  const fleet = new Map([['a', { id: 'a', title: 'T', harness: 'claude' }], ['b', { id: 'b', title: 'U', harness: 'gemini' }]])
  test('stale MCPs group by owning session; a vanished session is an orphan group', () => {
    const inv = [rp({ pid: 1, managedId: 'a' }), rp({ pid: 2, managedId: 'a' }), rp({ pid: 3, managedId: 'b' }), rp({ pid: 4, managedId: 'gone' })]
    const g = staleBySession(inv, [1, 2, 3, 4].map(stale), fleet)
    expect(g.length).toBe(3)
    expect(g.find(x => x.managedId === 'a')!.pids).toEqual([1, 2])
    expect(g.find(x => x.managedId === 'gone')!.session).toBeNull()
    expect(harnessBreakdown(g, h => h)).toBe('claude 1, gemini 1')
  })
  test('recommended actions count orphans and reopenable sessions', () => {
    const inv = [rp({ pid: 9, kind: 'cli', orphanWhy: 'parent-gone', stale: false }), rp({ pid: 1, managedId: 'a' })]
    const r = recommendedActions(inv, staleBySession(inv, [stale(1)], fleet))
    expect(r).toMatchObject({ orphanCount: 1, reopenCount: 1 })
    expect(recommendedSentence(r, 'pt')).toContain('encerrar 1 órfão(s) · reabrir 1 sessão(ões)')
    expect(recommendedSentence({ orphanCount: 0, orphanBytes: 0, reopenCount: 0 }, 'pt')).toBeNull()
  })
  test('this server is never an orphan to end; only a confirmed exit says ended', () => {
    expect(orphansOf([rp({ orphanWhy: 'parent-gone', self: true })])).toEqual([])
    expect(endNote(5, { ended: false }, 'pt')).toContain('não encerrou')
    expect(endNote(5, { ended: true }, 'pt')).toBe('pid 5 encerrado.')
  })
})
