import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeTaskRepo } from './task-repo'

const SESSIONS_DIR = import.meta.dir

test.each([
  ['agentistics/agentistics', 'agentistics/agentistics'],
  ['  agentistics/agentistics/ ', 'agentistics/agentistics'],
  ['agentistics/agentistics.git', 'agentistics/agentistics'],
  ['GitHub.com/agentistics/agentistics', 'agentistics/agentistics'],
  ['https://github.com/agentistics/agentistics.git', 'agentistics/agentistics'],
  ['https://GitHub.com/agentistics/agentistics/', 'agentistics/agentistics'],
  ['git@github.com:agentistics/agentistics.git', 'agentistics/agentistics'],
  ['ssh://git@github.com/agentistics/agentistics.git', 'agentistics/agentistics'],
  ['Agentistics/Agentistics', 'Agentistics/Agentistics'],
  ['git.example.org/Org/Repo', 'Org/Repo'],
  ['', ''],
  ['   ', ''],
])('accepts %p -> %p', (input, repo) => {
  expect(normalizeTaskRepo(input)).toEqual({ ok: true, repo })
})

test('refusals say WHY: spaces and local paths get their own sentence', () => {
  const sp = normalizeTaskRepo('org/repo with space')
  const lp = normalizeTaskRepo('/home/me/agentistics')
  expect(!sp.ok && sp.reason).toMatch(/spaces/)
  expect(!lp.ok && lp.reason).toMatch(/local path/)
})

test.each([
  ['agentistics', 'garbage: one segment'],
  ['https://github.com/', 'url with no repo'],
  ['https://github.com/onlyowner', 'url with no name'],
  ['a//b', 'empty segment'],
  ['org/repo with space', 'spaces'],
  ['/home/me/agentistics', 'local path'],
  ['./agentistics', 'relative path'],
  ['~/agentistics', 'home path'],
  ['C:\\code\\repo', 'windows path'],
  ['O/R/extra', 'three segments without a host (QA r1: was stored as R/extra)'],
  ['github.com/o/r/extra', 'host plus an extra segment'],
  ['https://github.com/o/r/tree/main/x', 'url with a path after the name (QA r1: was stored as o/r/tree/main/x)'],
  ['https://gitlab.com/grp/sub/proj', 'nested group url: not guessed'],
  ['github.com/o', 'host and owner, no name (QA r2: was stored)'],
  ['o/' + 'r'.repeat(400), 'absurdly long'],
  ['file:///srv/repo.git', 'file url'],
  ['org/re$po', 'bad chars'],
  ['org/..', 'dotdot'],
])('refuses %p (%s) with a sentence', input => {
  const r = normalizeTaskRepo(input)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.reason.length).toBeGreaterThan(10)
})

async function run(body: string): Promise<any> {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-task-repo-'))
  const script = `
    const cfg = await import(${JSON.stringify(join(SESSIONS_DIR, '..', 'config.ts'))})
    const { createTaskStore } = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-store.ts'))})
    const web = await import(${JSON.stringify(join(SESSIONS_DIR, 'task-web.ts'))})
    const store = createTaskStore(cfg.TASKS_FILE)
    await store.upsertTask({ id: 't1', title: 'T', status: 'todo', repo: 'blpsoares/agentistics',
      createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:00:00.000Z' })
    ${body}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    env: { ...process.env, AGENTISTICS_DIR: dir }, stdout: 'pipe', stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`script failed: ${err.trim().split('\n').slice(-8).join(' | ')}`)
  return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1) ?? '{}')
}

test('editTask stores the normalized repo and logs "from -> to" with the actor', async () => {
  const out = await run(`
    const ok = await web.editTask('t1', { repo: 'https://github.com/agentistics/agentistics.git', actor: 'claude:abcd' })
    const w = await store.read()
    console.log(JSON.stringify({ ok, repo: w.tasks[0].repo, ev: w.events.filter(e => e.kind === 'repo').map(e => [e.actor, e.from, e.to]) }))
  `)
  expect(out).toEqual({ ok: true, repo: 'agentistics/agentistics', ev: [['claude:abcd', 'blpsoares/agentistics', 'agentistics/agentistics']] })
})

test('an empty repo clears it (and is logged); an absent one leaves it alone', async () => {
  const out = await run(`
    await web.editTask('t1', { title: 'T2' })
    const kept = (await store.read()).tasks[0].repo
    await web.editTask('t1', { repo: '' })
    const w = await store.read()
    console.log(JSON.stringify({ kept, repo: w.tasks[0].repo ?? '', ev: w.events.filter(e => e.kind === 'repo').map(e => [e.from, e.to]) }))
  `)
  expect(out).toEqual({ kept: 'blpsoares/agentistics', repo: '', ev: [['blpsoares/agentistics', '']] })
})

test('a refused repo writes nothing and logs nothing; an unchanged repo logs nothing', async () => {
  const out = await run(`
    const bad = await web.editTask('t1', { repo: '/home/x/repo', title: 'ignored' })
    const same = await web.editTask('t1', { repo: 'blpsoares/agentistics' })
    const w = await store.read()
    console.log(JSON.stringify({ bad, same, repo: w.tasks[0].repo, title: w.tasks[0].title, ev: w.events.filter(e => e.kind === 'repo').length }))
  `)
  expect(out).toEqual({ bad: false, same: true, repo: 'blpsoares/agentistics', title: 'T', ev: 0 })
})
