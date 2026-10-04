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
