/** The 15-step r4 Opus REST transcript, byte-compared to its live base capture (2af66b7be). */
import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockFile } from '../sessions/file-lock'
import { gitTestEnv } from '../../../core/src/gitTestEnv'

const norm = (s: string) => s
  .replace(/\b[ts]-[0-9a-f]{10}\b/g, '<id>').replace(/\bc-[0-9a-f]{10}\b/g, '<cid>').replace(/\bf-[0-9a-z-]+\b/g, '<fid>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<iso>').replace(/"ref":"[^"]+"/g, '"ref":"<ref>"').replace(/\b[0-9a-f]{40,64}\b/g, '<hex>')

test('OFF: QA 15-step REST transcript stays byte-identical, including the 7s tasks lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-off-parity-'))
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = reservation.port!
  reservation.stop(true)
  const env = { ...gitTestEnv(), HOME: root, AGENTISTICS_DIR: root, PORT: String(port), SERVE_STATIC: '0', AGENTISTICS_TELEMETRY: '0', NODE_ENV: 'test' } as Record<string, string>
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, '../index.ts')], { env, stdout: 'ignore', stderr: 'pipe' })
  const errors = new Response(proc.stderr).text()
  const base = `http://127.0.0.1:${port}`
  const log: Array<{ step: string; status: number; body: unknown }> = []
  const timings: Array<{ step: string; ms: number }> = []
  const call = async (step: string, method: string, path: string, body?: unknown) => {
    const t0 = performance.now()
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const text = await r.text()
    const ms = Math.round(performance.now() - t0)
    log.push({ step, status: r.status, body: JSON.parse(norm(text)) })
    timings.push({ step, ms })
    return { status: r.status, json: JSON.parse(text), ms }
  }
  const holding = async (file: string, run: () => Promise<unknown>) => {
    const lock = await lockFile(join(root, file))
    const released = new Promise<void>(resolve => setTimeout(async () => { await lock.release(); resolve() }, 7000))
    try { return await run() } finally { await released }
  }
  try {
    let ready = false
    for (let i = 0; i < 400 && !ready; i++) {
      try { ready = (await fetch(`${base}/api/tasks/statuses`)).ok } catch {}
      if (proc.exitCode !== null) throw new Error(await errors)
      if (!ready) await Bun.sleep(50)
    }
    expect(ready).toBe(true)
    const t = (await call('create task', 'POST', '/api/tasks', { title: 'QA off' })).json.task.id
    const p1 = (await call('add subtask p1', 'POST', `/api/tasks/${t}/subtasks`, { title: 'p1' })).json.id
    const g = (await call('add group g', 'POST', `/api/tasks/${t}/subtasks`, { title: 'g', isGroup: true })).json.id
    const m = (await call('add member m', 'POST', `/api/tasks/${t}/subtasks`, { title: 'm' })).json.id
    await call('join m to g', 'POST', `/api/tasks/${t}/subtasks`, { id: m, parentGroupId: g })
    await call('p1 -> in_review', 'POST', `/api/tasks/${t}/subtasks`, { id: p1, status: 'in_review' })
    await call('m -> done (member)', 'POST', `/api/tasks/${t}/subtasks`, { id: m, status: 'done' })
    await call('p1 -> done (no session)', 'POST', `/api/tasks/${t}/subtasks`, { id: p1, status: 'done' })
    await call('task status in_review', 'POST', `/api/tasks/${t}`, { status: 'in_review' })
    await call('comment', 'POST', `/api/tasks/${t}/comments`, { body: 'hello', author: 'qa' })
    await call('evidence probe p1', 'POST', `/api/tasks/${t}/evidence`, { subtaskId: p1, kind: 'probe', probe: { kind: 'bundle', literal: 'qa-literal-of-12+' } })
    await call('evidence list', 'GET', `/api/tasks/${t}/evidence?subtaskId=${p1}`)
    await holding('tasks.json', () => call('rename p1 while tasks.json held 7s', 'POST', `/api/tasks/${t}/subtasks`, { id: p1, title: 'renamed' }))
    await holding('deliveries.json', () => call('evidence while deliveries.json held 7s', 'POST', `/api/tasks/${t}/evidence`, { subtaskId: p1, kind: 'probe', probe: { kind: 'bundle', literal: 'qa-literal-two-12+' } }))
    await call('task detail', 'GET', `/api/tasks/${t}`)
    console.log('OFF REST timings', JSON.stringify(timings))
    expect(JSON.stringify(log, null, 1) + '\n').toBe(readFileSync(join(import.meta.dir, 'guard-off-base.fixture.json'), 'utf8'))
    expect(existsSync(join(root, 'guards.json'))).toBe(false)
    const rename = timings.find(t => t.step.startsWith('rename'))!
    // Leave scheduling margin in the full precommit run; the holder still runs its original 7000ms timer.
    expect(rename.ms).toBeGreaterThan(5000)
    expect(rename.ms).toBeLessThan(12000)
  } finally {
    proc.kill(); await proc.exited; await errors.catch(() => '')
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
