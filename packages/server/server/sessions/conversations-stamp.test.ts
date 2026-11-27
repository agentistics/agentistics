/**
 * PERF.SERVIDOR-OCIOSO fase 3 (QA C2) — `loadConversations` re-reads the consolidate store when the store CHANGED
 * (the build stamps it), not every 30 s: an idle server re-read ~5 000 records twice a minute for nothing. Out of
 * process: the store directory is a module-level constant.
 */
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = import.meta.dir

test('the conversation list follows the store: no re-read while it is unchanged, one as soon as a build writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conv-stamp-'))
  try {
    const script = `
      const c = await import(${JSON.stringify(join(DIR, '..', 'consolidate.ts'))})
      const conv = await import(${JSON.stringify(join(DIR, 'conversations.ts'))})
      const meta = (id, t) => ({ session_id: id, harness: 'claude', start_time: t, project_path: '/tmp/p', first_prompt: 'hi ' + id, user_message_count: 1 })
      await c.writeConsolidated([meta('s1', '2026-11-01T10:00:00.000Z')])
      const r0 = conv.conversationStoreReads()
      const a = await conv.loadConversations()
      const b = await conv.loadConversations()
      const quietReads = conv.conversationStoreReads() - r0
      // the same record written again changes nothing on disk: still no re-read
      await c.writeConsolidated([meta('s1', '2026-11-01T10:00:00.000Z')])
      await conv.loadConversations()
      const sameReads = conv.conversationStoreReads() - r0
      // a build writes a new session: the next read sees it at once (no 30 s wait)
      await c.writeConsolidated([meta('s2', '2026-11-02T10:00:00.000Z')])
      const d = await conv.loadConversations()
      const changedReads = conv.conversationStoreReads() - r0
      console.log(JSON.stringify({ a: a.length, b: b.length, quietReads, sameReads, changedReads, d: d.map(x => x.sessionId) }))
      process.exit(0)
    `
    const proc = Bun.spawn([process.execPath, '-e', script], { env: { ...process.env, AGENTISTICS_DIR: dir, AGENTISTICS_TELEMETRY: '0', AGENTISTICS_JOURNAL: '0' }, stdout: 'pipe', stderr: 'pipe', cwd: DIR })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    expect(await proc.exited, err.slice(-2000)).toBe(0)
    const r = JSON.parse(out.trim().split('\n').pop()!)
    expect(r.a).toBe(1)
    expect(r.b).toBe(1)
    expect(r.quietReads).toBe(1)
    expect(r.sameReads).toBe(1)
    expect(r.changedReads).toBe(2)
    expect(r.d).toEqual(['s2', 's1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
