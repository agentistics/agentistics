import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leadOp, leadsOfRows, loadRoles, roleOp, writeRolesDoc, type RoleDeps } from './session-roles'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'leads-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Row { id: string; title: string; state: string; conversationId?: string }
const tasks: Record<string, { repo?: string; remotes?: string[] }> = {
  A: { repo: 'github.com/o/r' }, B: { repo: 'github.com/o/r' }, X: { repo: 'github.com/o/other' },
  // The owner's own example (21/11): Motor and Navegador. Task.repo is free text and differs; the sessions' git remotes agree.
  MOTOR: { repo: 'blpsoares/agentistics', remotes: ['git@github.com:agentistics/agentistics.git'] },
  NAV: { repo: 'agentistics/agentistics', remotes: ['https://github.com/Agentistics/agentistics'] },
  JARVIS: { repo: 'agentistics-workspace', remotes: ['github.com/blpsoares/workspace'] },
  EMPTY: {}, EMPTY2: { remotes: [] },
}
const filed: Record<string, string> = { L: 'A', L2: 'A', W: 'A', LM: 'MOTOR', LE: 'EMPTY' }
function deps(rows: Row[], extra: Partial<RoleDeps> = {}): RoleDeps {
  return {
    dataDir: dir, rows: async () => rows as never, legacyPref: async () => undefined, uiLang: async () => 'en',
    rename: async () => ({ ok: true }), prompt: async () => ({ ok: true }), parentOf: async () => undefined,
    taskOf: async id => filed[id],
    taskInfoOf: async id => (tasks[id] ? { exists: true, ...tasks[id]! } : { exists: false }),
    ...extra,
  }
}
const rows = (): Row[] => [
  { id: 'LM', title: 'motor lead', state: 'working' }, { id: 'LE', title: 'lead without repo', state: 'working' },
  { id: 'L', title: 'lead', state: 'working' }, { id: 'L2', title: 'lead2', state: 'working' }, { id: 'W', title: 'worker', state: 'working' },
]
const withRoles = async (roles: Record<string, 'leader' | 'worker'>) => writeRolesDoc(dir, { version: 1, migrated: true, roles })

describe('declaring leadership', () => {
  test('a leader declares and drops tasks; N tasks are allowed', async () => {
    await withRoles({ L: 'leader' })
    const r = await leadOp('L', { add: ['B'] }, deps(rows()))
    expect(r).toMatchObject({ ok: true, leads: ['B'], changed: true })
    expect((await leadOp('L', {}, deps(rows())))).toMatchObject({ ok: true, leads: ['B'] })
    expect(await leadOp('L', { remove: ['B'] }, deps(rows()))).toMatchObject({ ok: true, leads: [] })
  })
  test('BYPASS: a worker cannot declare itself leader of another task', async () => {
    await withRoles({ W: 'worker' })
    expect(await leadOp('W', { add: ['B'] }, deps(rows()))).toMatchObject({ ok: false, code: 'not_leader' })
    expect((await loadRoles(deps(rows()))).leads ?? {}).toEqual({})
  })
  test('BYPASS: a session with no role at all cannot either', async () => {
    await withRoles({})
    expect(await leadOp('W', { add: ['B'] }, deps(rows()))).toMatchObject({ ok: false, code: 'not_leader' })
  })
  test('BYPASS: a session of another project cannot lead the task', async () => {
    await withRoles({ L: 'leader' })
    expect(await leadOp('L', { add: ['X'] }, deps(rows()))).toMatchObject({ ok: false, code: 'other_project' })
  })
  test('BYPASS: a leader cannot declare for ANOTHER session, even a leader', async () => {
    await withRoles({ L: 'leader', L2: 'leader' })
    expect(await leadOp('L', { ref: 'L2', add: ['B'] }, deps(rows()))).toMatchObject({ ok: false, code: 'not_own' })
  })
  test('BYPASS: a leader with no filing of its own, or an unknown task, is refused', async () => {
    await withRoles({ L: 'leader' })
    expect(await leadOp('L', { add: ['B'] }, deps(rows(), { taskOf: async () => undefined }))).toMatchObject({ ok: false, code: 'no_task' })
    expect(await leadOp('L', { add: ['nope'] }, deps(rows()))).toMatchObject({ ok: false, code: 'no_such_task' })
  })
  test('the person (no sender) may declare for a leader', async () => {
    await withRoles({ L: 'leader' })
    expect(await leadOp(null, { ref: 'L', add: ['B'] }, deps(rows()))).toMatchObject({ ok: true, leads: ['B'] })
  })
})

describe('a task repository is a SET, not a string (r2 blocker)', () => {
  test("the owner's example: Motor (blpsoares/agentistics) leads Navegador (agentistics/agentistics)", async () => {
    await withRoles({ LM: 'leader' })
    expect(await leadOp('LM', { add: ['NAV'] }, deps(rows()))).toMatchObject({ ok: true, leads: ['NAV'] })
  })
  test('ssh, https, case and .git are the same repository', async () => {
    await withRoles({ LM: 'leader' })
    const d = deps(rows(), { taskInfoOf: async id => (id === 'MOTOR' ? { exists: true, remotes: ['git@github.com:Org/Repo.git'] } : { exists: true, remotes: ['https://github.com/org/repo'] }) })
    expect(await leadOp('LM', { add: ['NAV'] }, d)).toMatchObject({ ok: true })
  })
  test('another project (no shared repository in either set) is still refused', async () => {
    await withRoles({ LM: 'leader' })
    expect(await leadOp('LM', { add: ['JARVIS'] }, deps(rows()))).toMatchObject({ ok: false, code: 'other_project' })
  })
  test('FAIL CLOSED: a target task with no repository at all is refused, with the way forward', async () => {
    await withRoles({ LM: 'leader' })
    for (const id of ['EMPTY', 'EMPTY2']) {
      const out = await leadOp('LM', { add: [id] }, deps(rows()))
      expect(out).toMatchObject({ ok: false, code: 'other_project' })
      expect(!out.ok && out.message).toContain('has no repository; set the task')
    }
  })
  test('FAIL CLOSED: a leader whose own filed task has no repository cannot lead anything', async () => {
    await withRoles({ LE: 'leader' })
    expect(await leadOp('LE', { add: ['NAV'] }, deps(rows()))).toMatchObject({ ok: false, code: 'other_project' })
  })
})

describe('stored entries of sessions that are gone are pruned on write', () => {
  test('a dead session lead entry disappears at the next write; the live ones stay', async () => {
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { L: 'leader', GONE: 'leader' }, leads: { GONE: ['B'], L2: ['B'] } })
    await leadOp('L', { add: ['B'] }, deps(rows()))
    const doc = await loadRoles(deps(rows()))
    expect(Object.keys(doc.leads ?? {}).sort()).toEqual(['L', 'L2'])
  })
  test('an unreadable fleet (no rows) prunes nothing', async () => {
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { L: 'leader' }, leads: { GONE: ['B'] } })
    await leadOp(null, { ref: 'L', add: ['B'] }, deps([])).catch(() => {})
    expect((await loadRoles(deps(rows()))).leads?.GONE).toEqual(['B'])
  })
})

describe('what the Live gets', () => {
  test('a closed leader still stored is read by the Live only while a leader; revoking the role revokes the lead', async () => {
    await withRoles({ L: 'leader' })
    await leadOp('L', { add: ['B'] }, deps(rows()))
    const doc = await loadRoles(deps(rows()))
    expect(leadsOfRows(doc, rows()).get('L')).toEqual(['B'])
    expect(leadsOfRows({ ...doc, roles: { L: 'worker' } }, rows()).size).toBe(0)
  })
  test('a successor declared leader with retirePredecessor inherits the leads', async () => {
    await withRoles({ L: 'leader', L2: 'leader' })
    await leadOp('L', { add: ['B'] }, deps(rows()))
    const d = deps(rows(), { requestRetire: async () => true, parentOf: async () => undefined })
    const out = await roleOp('L2', { role: 'leader', retirePredecessor: 'L' }, d)
    expect(out.ok && out.retire?.ok).toBe(true)
    expect(leadsOfRows(await loadRoles(d), rows()).get('L2')).toEqual(['B'])
  })
  test('a retire that is refused (different task) inherits nothing', async () => {
    await withRoles({ L: 'leader', L2: 'leader' })
    await leadOp('L', { add: ['B'] }, deps(rows()))
    const d = deps(rows(), { requestRetire: async () => true, taskOf: async id => (id === 'L2' ? 'B' : filed[id]) })
    const out = await roleOp('L2', { role: 'leader', retirePredecessor: 'L' }, d)
    expect(out.ok && out.retire?.ok).toBe(false)
    expect(leadsOfRows(await loadRoles(d), rows()).get('L2')).toBeUndefined()
  })
})
