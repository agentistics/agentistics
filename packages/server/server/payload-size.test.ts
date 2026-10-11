import { describe, expect, test } from 'bun:test'
import { slimApiResponse } from './data-slim'
import { buildFleetFrame, snapshotBody, type FleetFramePayload } from './sessions/fleet-events'

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

function dataFixture(count: number) {
  const session = (i: number) => ({
    session_id: `s-${i}`, project_path: `/workspace/repo-${i % 12}`,
    start_time: new Date(Date.UTC(2026, 0, 1, i % 24, i % 60)).toISOString(),
    input_tokens: 1000, output_tokens: 500,
    first_prompt: `Implement the long feature ${'x'.repeat(180)}`,
    message_hours: Array.from({ length: 800 }, (_, n) => n % 24),
    user_message_timestamps: Array.from({ length: 200 }, () => '2026-01-01T00:00:00Z'),
    agentMetrics: { invocations: Array.from({ length: 12 }, () => ({ model: 'opus', input: 100, output: 200 })) },
    tool_output_tokens: { Bash: 2000, Read: 1000 }, user_response_times: Array(80).fill(2),
    tool_error_categories: { timeout: 8, permission: 3 },
    daily: Array.from({ length: 30 }, () => ({ input: 100, output: 200, tools: 4 })),
    hours: Object.fromEntries(Array.from({ length: 24 }, (_, n) => [String(n), n])),
    model_usage: { opus: { input: 100, output: 200, cost: 1 } }, messages: Array(20).fill('message'),
  })
  return {
    statsCache: { dailyActivity: Array.from({ length: 365 }, () => ({ date: '2026-01-01', messageCount: 12 })) },
    projects: Array.from({ length: 12 }, (_, i) => ({ path: `/workspace/repo-${i}`, name: `repo-${i}`, sessions: [] })),
    allSessions: [], sessions: Array.from({ length: count }, (_, i) => session(i)),
    healthIssues: [], homeDir: '/home/user', harnesses: ['claude', 'codex', 'gemini', 'copilot', 'kimi'],
    workflows: Array.from({ length: count }, (_, i) => ({ id: `w-${i}`, steps: [{ output: 'y'.repeat(120) }] })),
  } as never
}

function fleetFixture(liveCount = 12, closedCount = 400) {
  const row = (id: string, closed: boolean) => ({
    id: closed ? `closed:${id}` : id, title: `A long session title ${'x'.repeat(120)}`,
    harness: 'claude', cwd: '/workspace/repo', project: 'repo', state: closed ? 'closed' : 'working',
    stateLabel: closed ? 'Closed' : 'Working', actionable: !closed, attachCommand: `agentop session attach ${id}`,
    verbs: Array.from({ length: 8 }, (_, n) => ({ action: `action-${n}`, label: `Action ${n} ${'v'.repeat(35)}`, enabled: n % 2 === 0, reason: 'r'.repeat(20) })),
    searchFields: { name: 'long title', folder: '/workspace/repo', harness: 'claude', note: 'n'.repeat(40), task: 't'.repeat(40), prompt: 'p'.repeat(120) },
    tokenParts: { input: 100, output: 200 }, context: { fraction: 0.5, used: 50_000, window: 100_000 },
    ...(closed ? { endedAt: 1 } : { cpuPercent: 1, rssBytes: 1024 }),
  })
  const sessions = Array.from({ length: liveCount }, (_, i) => row(`live-${i}`, false))
  const closed = Array.from({ length: closedCount }, (_, i) => row(`old-${i}`, true))
  const rows = [...sessions, ...closed]
  const shaped = rows.map(({ searchFields: _searchFields, tokenParts: _tokenParts, context: _context, ...r }) => r)
  return { sessions: shaped, rows, attention: 1, tasks: ['task'], finishedTasks: [] }
}

describe('payload budgets on realistic fleet/data fixtures', () => {
  test('/api/data first-screen slim payload drops lifetime per-session arrays', () => {
    const source = dataFixture(1200)
    const full = bytes(source)
    const slim = bytes(slimApiResponse(source))
    expect(slim).toBeLessThan(full * 0.1)
    expect(slim).toBeLessThan(250_000)
  })

  test('/api/fleet first snapshot sends live rows and only the closed window', () => {
    const source = fleetFixture() as unknown as FleetFramePayload
    const frame = buildFleetFrame(source, 20)
    const body = snapshotBody(1, frame)
    expect(frame.closedTotal).toBe(400)
    expect((body.rows as unknown[]).length).toBe(32)
    expect(bytes(body)).toBeLessThanOrEqual(50 * 1024)
  })

  test('the real-shaped 808-row stream has one canonical list and no derived search index', () => {
    const source = fleetFixture(508, 300) as unknown as FleetFramePayload
    const states = [...Array(5).fill('waiting'), ...Array(4).fill('working'), ...Array(710).fill('exited'), ...Array(85).fill('lost'), ...Array(4).fill('closed')]
    source.rows.forEach((row, i) => { row.state = states[i] as never; row.stateLabel = states[i] as never })
    source.sessions.forEach((row, i) => { row.state = states[i] as never; row.stateLabel = states[i] as never })
    const body = snapshotBody(1, buildFleetFrame(source, 0))
    const json = JSON.stringify(body)
    expect((body.sessions as unknown[]).length).toBe(9)
    expect((body as { closed: { total: number; sent: number } }).closed).toEqual({ total: 799, sent: 0 })
    expect(json).not.toContain('"rows"')
    expect(json).not.toContain('"searchFields"')
    expect(json).not.toContain('"attachCommand"')
    expect(json).toContain('"verbCatalog"')
    expect(json).toContain('"verbKey"')
    expect(bytes(body)).toBeLessThanOrEqual(50 * 1024)
    expect(json.length).toBeLessThan(bytes({ ...source, rows: source.rows }))
  })
})
