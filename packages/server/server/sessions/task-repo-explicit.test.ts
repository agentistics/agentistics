import { describe, expect, test } from 'bun:test'
import { addSession } from './registry'
import { defaultRoleDeps, leadOp, repoWriteRefusal, writeRolesDoc, type RoleDeps, type TaskRepoInfo } from './session-roles'
import { cliRepoSender, repoEditGate, repoEditGateFor } from './task-repo-gate'
import type { CallerVerdict } from '../browser/browser-caller'
import { createTask, editTask } from './task-web'
import { loadTaskWorld } from './task-source'

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
    expect(!out.ok && out.message).toContain('agentop task edit T --repo <owner/name>')
  })
  test("an inherited (or legacy, no provenance) OWN filing task is refused, naming that task", async () => {
    const out = await run({ OWN: inh('o/r', 'Motor'), T: ex('o/r') })
    expect(out).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(!out.ok && out.message).toContain('Motor')
    expect(!out.ok && out.message).toContain('agentop task edit OWN --repo')
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
    await store.patchTask(a.id, { repo: 'blpsoares/agentistics', repoSource: 'inherited', repoFromSession: 'x' })
    await store.patchTask(b.id, { repo: 'agentistics/agentistics', repoSource: 'inherited', repoFromSession: 'y' })
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(await editTask(a.id, { repo: 'blpsoares/agentistics' })).toBe(true)
    // only the own side is explicit now: the target still refuses
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: false, code: 'repo_not_explicit' })
    expect(await editTask(b.id, { repo: 'agentistics/agentistics' })).toBe(true)
    expect(await leadOp(lid, { add: [b.id] }, deps)).toMatchObject({ ok: true, leads: [b.id], note: 'owner_differs' })
  })

  test('every explicit write stamps repoSource explicit and clears repoFromSession', async () => {
    const { a, store } = await setup()
    await store.patchTask(a.id, { repo: 'o/seed', repoSource: 'inherited', repoFromSession: 'sess' })
    expect(await editTask(a.id, { repo: 'o/said' })).toBe(true)
    const t = (await loadTaskWorld()).book.tasks.find(x => x.id === a.id)!
    expect(t.repoSource).toBe('explicit')
    expect(t.repoFromSession).toBeUndefined()
  })

  test('M4: an INHERITED write never overwrites an explicit repository', async () => {
    const { a, store } = await setup()
    expect(await editTask(a.id, { repo: 'o/said' })).toBe(true)
    await store.patchTask(a.id, { repo: 'o/copied', repoSource: 'inherited', repoFromSession: 'z' })
    const t = (await loadTaskWorld()).book.tasks.find(x => x.id === a.id)!
    expect(t).toMatchObject({ repo: 'o/said', repoSource: 'explicit' })
  })

  const person: CallerVerdict = { kind: 'person', via: 'process', pid: 1 }
  const verify = (ok: string[]) => async (id: unknown) => (typeof id === 'string' && ok.includes(id) ? id : null)

  test('write gate: the person writes any task; a leader only its own filing and only its OWN cwd repo; a worker or another task is 403', async () => {
    const { a, b, lid, wid, deps } = await setup()
    const own: RoleDeps = { ...deps, cwdRepoOf: async () => 'o/own' }
    const asLeader = { session: { id: lid, token: 't' } }
    expect(await repoEditGate({}, b.id, verify([]), 'x/anything', () => person, own)).toBeNull()
    // D1: own filing + value equal to the cwd repo -> 200
    expect(await repoEditGate(asLeader, a.id, verify([lid]), 'o/own', undefined, own)).toBeNull()
    // D1 (r5 blocker 1): own filing, value NOT the cwd repo -> 403 repo_not_own_cwd, with the plain sentence
    const foreign = await repoEditGate(asLeader, a.id, verify([lid]), 'blpsoares/prontuario', undefined, own)
    expect(foreign).toMatchObject({ status: 403, body: { error: 'repo_not_own_cwd' } })
    expect(foreign!.body.message).toContain('Only the person can set a repository')
    expect(foreign!.body.message).toContain('agentop task edit')
    // clearing is not a verifiable fact either
    expect(await repoEditGate(asLeader, a.id, verify([lid]), '', undefined, own)).toMatchObject({ body: { error: 'repo_not_own_cwd' } })
    // a session with no resolvable cwd repo is refused (fail-closed)
    expect(await repoEditGate(asLeader, a.id, verify([lid]), 'o/own', undefined, { ...deps, cwdRepoOf: async () => undefined })).toMatchObject({ body: { error: 'repo_not_own_cwd' } })
    expect(await repoEditGate(asLeader, b.id, verify([lid]), 'o/own', undefined, own)).toMatchObject({ status: 403, body: { error: 'not_own_task' } })
    expect(await repoEditGate({ session: { id: wid, token: 't' } }, a.id, verify([wid]), 'o/own', undefined, own)).toMatchObject({ status: 403, body: { error: 'not_own_task' } })
    expect(await repoEditGate({ session: { id: lid, token: 'forged' } }, a.id, verify([]), 'o/own', undefined, own)).toMatchObject({ status: 403, body: { error: 'unverified_sender' } })
  })

  test('D3: REST without a session body — the SOCKET decides (a curl from inside a session is a session)', async () => {
    const { a, lid, deps } = await setup()
    const own: RoleDeps = { ...deps, cwdRepoOf: async () => 'o/own' }
    const asSession = (managedId: string | null): CallerVerdict => ({ kind: 'session', pid: 9, managedId })
    // a peer in the leader's tree, body silent, foreign value -> 403
    expect(await repoEditGate({}, a.id, verify([]), 'blpsoares/prontuario', () => asSession(lid), own)).toMatchObject({ status: 403, body: { error: 'repo_not_own_cwd' } })
    // the same peer writing its own cwd repo on its own filing -> allowed
    expect(await repoEditGate({}, a.id, verify([]), 'o/own', () => asSession(lid), own)).toBeNull()
    // a session peer with no id (a structured session's harness) is refused outright
    expect(await repoEditGate({}, a.id, verify([]), 'o/own', () => asSession(null), own)).toMatchObject({ status: 403 })
    // an unidentifiable local peer on Linux is refused (fail-closed)…
    expect(await repoEditGate({}, a.id, verify([]), 'o/own', () => ({ kind: 'unknown', reason: 'socket-not-found' }), own)).toMatchObject({ status: 403 })
    // …but where there is no /proc the body is all there is (stated limit), and the person's terminal/browser is the person
    expect(await repoEditGate({}, a.id, verify([]), 'x/y', () => ({ kind: 'unknown', reason: 'no-proc' }), own)).toBeNull()
    expect(await repoEditGate({}, a.id, verify([]), 'x/y', () => person, own)).toBeNull()
  })

  test('D2: the CLI is decided by its process tree, never by the environment variable', async () => {
    const { a, lid, deps } = await setup()
    const own: RoleDeps = { ...deps, cwdRepoOf: async () => 'o/own' }
    // env -u AGENTOP_MANAGED_ID: no variable, but a managed ancestor -> still that session
    const stripped = cliRepoSender({ ancestry: [{ managedId: null }, { managedId: lid }], proven: null, claimed: null })
    expect(stripped).toBe(lid)
    expect(await repoEditGateFor(stripped, a.id, 'blpsoares/prontuario', own)).toMatchObject({ status: 403, body: { error: 'repo_not_own_cwd' } })
    expect(await repoEditGateFor(stripped, a.id, 'o/own', own)).toBeNull()
    // a claimed id with no proof anywhere is refused, fail-closed
    const forged = cliRepoSender({ ancestry: [{ managedId: null }], proven: null, claimed: lid })
    expect(await repoEditGateFor(forged, a.id, 'o/own', own)).toMatchObject({ status: 403, body: { error: 'not_own_task' } })
    // the tree beats a claim that names someone else
    expect(cliRepoSender({ ancestry: [{ managedId: lid }], proven: null, claimed: 'other' })).toBe(lid)
    // no managed ancestor and no claim: the person
    expect(cliRepoSender({ ancestry: [{ managedId: null }], proven: null, claimed: null })).toBeNull()
    expect(await repoEditGateFor(null, a.id, 'x/y', own)).toBeNull()
  })

  test('write gate: a leader cannot set another task\'s repo to its own and then lead it', async () => {
    const { a, c, lid, deps } = await setup()
    expect(await editTask(a.id, { repo: 'o/own' })).toBe(true)
    const own: RoleDeps = { ...deps, cwdRepoOf: async () => 'o/own' }
    const refused = await repoEditGate({ session: { id: lid, token: 't' } }, c.id, async id => (id === lid ? lid : null), 'o/own', undefined, own)
    expect(refused).toMatchObject({ status: 403 })
    // the refused write never happened, so the target stays repo-less and cannot be led
    expect(await leadOp(lid, { add: [c.id] }, deps)).toMatchObject({ ok: false })
  })

  test('repoWriteRefusal: no sender allows, an unfiled session is refused', async () => {
    const { a, deps } = await setup()
    expect(await repoWriteRefusal(null, a.id, deps, 'o/r')).toBeNull()
    expect(await repoWriteRefusal('ghost', a.id, deps, 'o/r')).toMatchObject({ code: 'not_own_task' })
  })
})
