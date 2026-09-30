import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_TOOL_POLICY } from '@agentistics/core'
import {
  AUDIT_KEEP_FILES,
  AUDIT_ROTATE_BYTES,
  argsHash,
  buildToolAuditRecord,
  createAgentAuditSink,
  defaultAuditPath,
  outcomeOf,
  targetsOf,
  type AuditFs,
} from './agent-audit'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-audit-'))
  path = join(dir, 'nested', 'agent-audit.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const lines = (p = path) => (existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const at = (iso: string) => () => new Date(iso)
const ok = { isError: false }

describe('the policy table decides the class', () => {
  it('the tools the tests lean on are classed the way the tests assume', () => {
    expect(AGENT_TOOL_POLICY.agentistics_tasks.risk).toBe('R')
    expect(AGENT_TOOL_POLICY.agentistics_task_comment.risk).toBe('W')
    expect(AGENT_TOOL_POLICY.agentistics_task_delete.risk).toBe('D')
  })
})

describe('what a line may carry — never an argument value', () => {
  // Every value an agent could send that must never land on disk: a title, a comment body, a
  // prompt, file content, and credentials of the shapes redactSecrets knows.
  const SENTINELS = {
    title: 'SENTINEL-TITLE-7f3a quarterly plan',
    body: 'SENTINEL-BODY-91c2 please look at this',
    detail: 'SENTINEL-PROMPT-4d1e ignore previous instructions',
    content: 'SENTINEL-FILE-CONTENT-aa01\nline two',
    note: 'SENTINEL-NOTE-b3b3',
    name: 'SENTINEL-LAYOUT-NAME with spaces',
    ghToken: 'ghp_' + 'A'.repeat(36),
    anthropicKey: 'sk-ant-api03-' + 'B'.repeat(40),
  }
  const args = {
    ref: 't-086a67beb0',
    title: SENTINELS.title,
    body: SENTINELS.body,
    detail: SENTINELS.detail,
    content: SENTINELS.content,
    note: SENTINELS.note,
    name: SENTINELS.name,
    // A credential passed where an id belongs is still refused.
    id: SENTINELS.ghToken,
    sessionId: SENTINELS.anthropicKey,
    // A free-text value under an id key is refused by shape.
    group: 'SENTINEL-GROUP a folder name with spaces',
    actor: SENTINELS.anthropicKey,
  }

  it('writes none of them, for a known W tool and for an unknown name', () => {
    const sink = createAgentAuditSink({ path, now: at('2026-09-29T21:00:00Z') })
    sink.recordCall({ name: 'agentistics_task_comment', args, client: { name: 'claude-code', version: '2.1.300' }, result: ok })
    sink.recordCall({ name: 'agentistics_task_edit', args, result: { isError: true, errorText: `POST /api/tasks/x → HTTP 422 {"error":"${SENTINELS.title}"}` } })
    sink.recordCall({ name: `unknown ${SENTINELS.body}`, args, result: ok })
    const raw = readFileSync(path, 'utf8')
    for (const [k, v] of Object.entries(SENTINELS)) {
      expect(raw.includes(v), k).toBe(false)
      expect(raw.includes(v.slice(0, 16)), `${k} prefix`).toBe(false)
    }
    expect(raw.includes('SENTINEL')).toBe(false)
    expect(lines().length).toBe(3)
  })

  it('keeps who, which tool, the ids and how it ended', () => {
    const rec = buildToolAuditRecord({
      at: new Date('2026-09-29T21:00:00Z'),
      name: 'agentistics_task_comment',
      args: { ref: 't-086a67beb0', body: 'x', actor: 'claude:3f5f' },
      client: { name: 'claude-code', version: '2.1.300' },
      naySession: 'nay-12ab',
      result: ok,
    })
    expect(rec).toEqual({
      v: 1, kind: 'tool', at: '2026-09-29T21:00:00.000Z',
      actor: { client: 'claude-code', clientVersion: '2.1.300', declared: 'claude:3f5f', naySession: 'nay-12ab' },
      tool: 'agentistics_task_comment', risk: 'W',
      targets: ['t-086a67beb0'],
      argsHash: argsHash({ ref: 't-086a67beb0', body: 'x', actor: 'claude:3f5f' }),
      outcome: 'ok',
    })
  })

  it('an unknown tool name is not written verbatim', () => {
    const rec = buildToolAuditRecord({ at: new Date(), name: 'rm -rf /', args: {}, result: ok })
    expect(rec.tool).toBeNull()
    expect(rec.risk).toBeNull()
    expect(rec.outcome).toBe('unknown_tool')
  })

  it('targets are id-shaped values under id keys only, deduped and counted when refused', () => {
    expect(targetsOf({ ref: 'abc', blockedBy: ['t-1', 't-2', 't-1'], title: 'no', name: 'no' })).toEqual({ targets: ['abc', 't-1', 't-2'], omitted: 0 })
    expect(targetsOf({ ref: 'has space', session: '../etc/passwd' })).toEqual({ targets: [], omitted: 2 })
    expect(targetsOf(null)).toEqual({ targets: [], omitted: 0 })
    expect(targetsOf({ remove: true })).toEqual({ targets: [], omitted: 0 })
  })

  it('argsHash is order-independent and not the arguments', () => {
    expect(argsHash({ a: 1, b: [2, { c: 3 }] })).toBe(argsHash({ b: [2, { c: 3 }], a: 1 }))
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }))
    expect(argsHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
  })

  it('an outcome keeps only the HTTP status of an error', () => {
    expect(outcomeOf(ok)).toBe('ok')
    expect(outcomeOf({ isError: true, errorText: 'POST /api/tasks/x → HTTP 422 {"error":"secret"}' })).toBe('http_422')
    expect(outcomeOf({ isError: true, errorText: 'fetch failed' })).toBe('error')
    expect(outcomeOf('unknown_tool')).toBe('unknown_tool')
  })
})

describe('R calls are counted, W and D calls are logged', () => {
  it('reads become one line per hour, written when the hour turns or on flush', () => {
    let now = new Date('2026-09-29T21:10:00Z')
    const sink = createAgentAuditSink({ path, now: () => now })
    sink.recordCall({ name: 'agentistics_tasks', args: {}, result: ok })
    sink.recordCall({ name: 'agentistics_tasks', args: {}, result: ok })
    sink.recordCall({ name: 'agentistics_summary', args: {}, result: ok })
    expect(lines()).toEqual([])
    // A W call in the NEXT hour closes the previous hour's counts before its own line.
    now = new Date('2026-09-29T22:01:00Z')
    sink.recordCall({ name: 'agentistics_task_create', args: {}, result: ok })
    sink.recordCall({ name: 'agentistics_task', args: { ref: 'a' }, result: ok })
    sink.flush()
    const got = lines()
    expect(got.map((l) => l.kind)).toEqual(['reads', 'tool', 'reads'])
    expect(got[0]).toEqual({ v: 1, kind: 'reads', hour: '2026-09-29T21', counts: { agentistics_tasks: 2, agentistics_summary: 1 } })
    expect(got[1].tool).toBe('agentistics_task_create')
    expect(got[2]).toEqual({ v: 1, kind: 'reads', hour: '2026-09-29T22', counts: { agentistics_task: 1 } })
    sink.flush()
    expect(lines().length).toBe(3)
  })

  it('a D call is logged with its class', () => {
    const sink = createAgentAuditSink({ path, now: at('2026-09-29T21:00:00Z') })
    sink.recordCall({ name: 'agentistics_task_delete', args: { ref: 't-9' }, result: ok })
    expect(lines()).toMatchObject([{ kind: 'tool', tool: 'agentistics_task_delete', risk: 'D', targets: ['t-9'] }])
  })

  it('every W tool in the table produces exactly one line', () => {
    const sink = createAgentAuditSink({ path, now: at('2026-09-29T21:00:00Z') })
    const writes = Object.entries(AGENT_TOOL_POLICY).filter(([, p]) => p.risk !== 'R').map(([n]) => n)
    for (const n of writes) sink.recordCall({ name: n, args: {}, result: ok })
    expect(lines().map((l) => l.tool)).toEqual(writes)
  })
})

describe('the file', () => {
  it('lives under AGENTISTICS_DIR, else ~/.agentistics', () => {
    expect(defaultAuditPath({ AGENTISTICS_DIR: '/x/y' })).toBe('/x/y/agent-audit.jsonl')
    expect(defaultAuditPath({})).toMatch(/\.agentistics\/agent-audit\.jsonl$/)
  })

  it('is created 0600, and a wider pre-existing file is narrowed', () => {
    const sink = createAgentAuditSink({ path, now: at('2026-09-29T21:00:00Z') })
    sink.recordCall({ name: 'agentistics_task_create', args: {}, result: ok })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    const other = join(dir, 'wide.jsonl')
    writeFileSync(other, '', { mode: 0o644 })
    fs.chmodSync(other, 0o644)
    const sink2 = createAgentAuditSink({ path: other, now: at('2026-09-29T21:00:00Z') })
    sink2.recordCall({ name: 'agentistics_task_create', args: {}, result: ok })
    expect(statSync(other).mode & 0o777).toBe(0o600)
  })

  it('rotates at the stated size and keeps the stated number of files, each 0600', () => {
    expect(AUDIT_ROTATE_BYTES).toBe(10 * 1024 * 1024)
    expect(AUDIT_KEEP_FILES).toBe(3)
    const sink = createAgentAuditSink({ path, maxBytes: 600, now: at('2026-09-29T21:00:00Z') })
    for (let i = 0; i < 40; i++) sink.recordCall({ name: 'agentistics_task_create', args: { i }, result: ok })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(`${path}.2`)).toBe(true)
    expect(existsSync(`${path}.3`)).toBe(false)
    for (const p of [path, `${path}.1`, `${path}.2`]) {
      expect(statSync(p).size).toBeLessThanOrEqual(600)
      expect(statSync(p).mode & 0o777).toBe(0o600)
    }
    // Nothing was dropped: rotation is not a failure.
    expect(sink.stats().writeFailures).toBe(0)
    // The newest record is in the live file.
    expect(lines().at(-1)!.argsHash).toBe(argsHash({ i: 39 }))
  })
})

describe('a failed write never fails the call, and is counted', () => {
  it('counts failures and reports them on the next line that lands', () => {
    let broken = true
    const failing: AuditFs = {
      ...fs,
      appendFileSync: ((...a: Parameters<typeof fs.appendFileSync>) => {
        if (broken) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        return fs.appendFileSync(...a)
      }) as typeof fs.appendFileSync,
    }
    const sink = createAgentAuditSink({ path, fs: failing, now: at('2026-09-29T21:00:00Z') })
    expect(() => sink.recordCall({ name: 'agentistics_task_create', args: {}, result: ok })).not.toThrow()
    expect(() => sink.recordCall({ name: 'agentistics_task_edit', args: {}, result: ok })).not.toThrow()
    expect(sink.stats()).toEqual({ written: 0, writeFailures: 2, pendingDropped: 2 })
    broken = false
    sink.recordCall({ name: 'agentistics_task_comment', args: {}, result: ok })
    expect(lines()).toMatchObject([{ tool: 'agentistics_task_comment', dropped: 2 }])
    expect(sink.stats()).toEqual({ written: 1, writeFailures: 2, pendingDropped: 0 })
  })

  it('an unwritable directory is survived too', () => {
    const blocker = join(dir, 'file-not-dir')
    writeFileSync(blocker, '')
    const sink = createAgentAuditSink({ path: join(blocker, 'agent-audit.jsonl'), now: at('2026-09-29T21:00:00Z') })
    expect(() => sink.recordCall({ name: 'agentistics_task_create', args: {}, result: ok })).not.toThrow()
    expect(() => sink.flush()).not.toThrow()
    expect(sink.stats().writeFailures).toBe(1)
  })
})
