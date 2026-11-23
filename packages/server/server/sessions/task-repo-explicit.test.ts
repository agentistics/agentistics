import { describe, expect, test } from 'bun:test'
import { addSession } from './registry'
import { defaultRoleDeps, leadOp, writeRolesDoc, type RoleDeps, type TaskRepoInfo } from './session-roles'
import { createTask, editTask } from './task-web'
import { loadTaskWorld } from './task-source'
import { unattributedContext } from '../delivery/guard'

// r5: INHERITED NEVER COUNTS FOR LEADING. Both the leader's own filing task and the target must carry an EXPLICIT repository.

describe('leadOp: both repositories must be explicit (fake deps)', () => {
  const info = (m: Record<string, TaskRepoInfo>) => async (id: string): Promise<TaskRepoInfo> => m[id] ?? { exists: false }
  const mk = (m: Record<string, TaskRepoInfo>, dir: string): RoleDeps => ({
    dataDir: dir, rows: async () => [{ id: 'L', title: 'lead', state: 'working' }] as never, legacyPref: async () => undefined, uiLang: async () => 'en',
    rename: async () => ({ ok: true }), prompt: async () => ({ ok: true }), parentOf: async () => undefined, taskOf: async () => 'OWN', taskInfoOf: info(m),
  })
  const run = async (m: Record<string, TaskRepoInfo>) => {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'r5-'))
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { L: 'leader' } })
    return leadOp('L', { add: ['T'] }, mk(m, dir))
  }
  const ex = (repo: string, title = 't'): TaskRepoInfo => ({ exists: true, title, repo, repoExplicit: true })
  const inh = (repo: string, title = 't'): TaskRepoInfo => ({ exists: true, title, repo })

  test('both explicit, same name, owner differs -> ok with the note (M6: an owner-strict compare must fail here)', async () => {
    expect(await run({ OWN: ex('blpsoares/agentistics'), T: ex('agentistics/agentistics') })).toMatchObject({ ok: true, leads: ['T'], note: 'owner_differs' })
  })
  test('both explicit and identical -> ok, no note (the r4 self-equal special case is gone, not needed)', async () => {
    const out = await run({ OWN: ex('o/r'), T: ex('o/r') })
    expect(out).toMatchObject({ ok: true, leads: ['T'] })
    expect(out.ok && out.note).toBeUndefined()
  })
  test('an inherited TARGET is refused with the task named and the fix', async () => {
    const out = await run({ OWN: ex('o/r'), T: inh('o/r', 'Prontuário') })
    expect(out).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(!out.ok && out.message).toContain('Prontuário')
    expect(!out.ok && out.message).toContain('task screen')
  })
  test("an inherited (or legacy, no provenance) OWN filing task is refused, naming that task", async () => {
    const out = await run({ OWN: inh('o/r', 'Motor'), T: ex('o/r') })
    expect(out).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(!out.ok && out.message).toContain('Motor')
    expect(!out.ok && out.message).toContain('task screen')
  })
  test('both inherited -> refused (the matching repositories prove nothing)', async () => {
    expect(await run({ OWN: inh('o/r'), T: inh('o/r') })).toMatchObject({ ok: false, code: 'repo_not_explicit' })
  })
  test('another name stays other_project even when both are explicit', async () => {
    expect(await run({ OWN: ex('o/r'), T: ex('o/other') })).toMatchObject({ ok: false, code: 'other_project' })
  })
})

describe('REAL wiring (defaultRoleDeps over the real board and registry) — M1b, M4 and the write gate', () => {
  const tag = Math.random().toString(36).slice(2, 8)
  async function setup() {
    const a = (await createTask({ title: `r5 motor ${tag}` }))!
    const b = (await createTask({ title: `r5 nav ${tag}` }))!
    const c = (await createTask({ title: `r5 jarvis ${tag}` }))!
    const lid = `lead-${tag}`, wid = `work-${tag}`
    const now = new Date().toISOString()
    await addSession({ id: lid, harness: 'claude', cwd: process.cwd(), createdAt: now, taskId: a.id })
    await addSession({ id: wid, harness: 'claude', cwd: process.cwd(), createdAt: now, taskId: a.id })
    const base = await defaultRoleDeps()
    const deps: RoleDeps = {
      ...base,
      rows: async () => [{ id: lid, title: 'L', state: 'working' }, { id: wid, title: 'W', state: 'working' }] as never,
    }
    await writeRolesDoc(deps.dataDir, { version: 1, migrated: true, roles: { [lid]: 'leader', [wid]: 'worker' } })
    const w = await loadTaskWorld()
    return { a, b, c, lid, wid, deps, store: w.store }
  }

  test('M1b: inherited repos refuse through the real deps; once the person writes both, it leads (200, owner_differs)', async () => {
    const { a, b, lid, deps, store } = await setup()
    await store.patchTask(a.id, { repo: 'blpsoares/agentistics', repoSource: 'inherited', repoFromSession: 'x' }, { guard: unattributedContext() })
    await store.patchTask(b.id, { repo: 'agentistics/agentistics', repoSource: 'inherited', repoFromSession: 'y' }, { guard: unattributedContext() })
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(await editTask(a.id, { repo: 'blpsoares/agentistics' })).toBe(true)
    // only the own side is explicit now: the target still refuses
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(await editTask(b.id, { repo: 'agentistics/agentistics' })).toBe(true)
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: true, leads: [b.id], note: 'owner_differs' })
  })

  test('every explicit write stamps repoSource explicit and clears repoFromSession', async () => {
    const { a, store } = await setup()
    await store.patchTask(a.id, { repo: 'o/seed', repoSource: 'inherited', repoFromSession: 'sess' }, { guard: unattributedContext() })
    expect(await editTask(a.id, { repo: 'o/said' })).toBe(true)
    const t = (await loadTaskWorld()).book.tasks.find(x => x.id === a.id)!
    expect(t.repoSource).toBe('explicit')
    expect(t.repoFromSession).toBeUndefined()
  })

  test('M4: an INHERITED write never overwrites an explicit repository', async () => {
    const { a, store } = await setup()
    expect(await editTask(a.id, { repo: 'o/said' })).toBe(true)
    await store.patchTask(a.id, { repo: 'o/copied', repoSource: 'inherited', repoFromSession: 'z' }, { guard: unattributedContext() })
    const t = (await loadTaskWorld()).book.tasks.find(x => x.id === a.id)!
    expect(t).toMatchObject({ repo: 'o/said', repoSource: 'explicit' })
  })

})
