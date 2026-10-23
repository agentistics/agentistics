import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SESSION_ROLES_FILE, applyRoleTitle, deliverStoredRole, ensureSpawnRole, loadRoles, markRoleDelivered, migrateLegacyRoles, parseRoles, rekeyStoredRole, roleOfRow, originOfRow, listRoleOrigins, spawnRoleOrigin, roleSenderFromBody, markParentVerified, markCallerVerified, roleOp, roleStatus, writeRolesDoc, type RoleDeps,
} from './session-roles'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'roles-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Row { id: string; conversationId?: string; title: string }
function fake(rows: Row[], extra: Partial<RoleDeps> = {}) {
  const renames: Array<[string, string]> = []
  const prompts: Array<[string, string]> = []
  const deps: RoleDeps = {
    dataDir: dir,
    rows: async () => rows,
    legacyPref: async () => undefined,
    uiLang: async () => 'en',
    rename: async (id, title) => { renames.push([id, title]); const r = rows.find(x => x.id === id); if (r) r.title = title; return { ok: true } },
    prompt: async (id, text) => { prompts.push([id, text]); return { ok: true } },
    parentOf: async () => undefined,
    ...extra,
  }
  return { deps, renames, prompts }
}

describe('store + migration', () => {
  test('parseRoles keeps only valid roles', () => {
    expect(parseRoles({ a: 'leader', b: 'worker', c: 'boss', d: 1 })).toEqual({ a: 'leader', b: 'worker' })
    expect(parseRoles(null)).toEqual({})
    expect(parseRoles([])).toEqual({})
  })
  test('migrates the legacy preference once; the store wins on conflict', async () => {
    const m = migrateLegacyRoles({ version: 1, migrated: false, roles: { a: 'worker' } }, { a: 'leader', b: 'leader' })
    expect(m).toEqual({ version: 1, migrated: true, roles: { a: 'worker', b: 'leader' } })
    expect(migrateLegacyRoles(m, { z: 'leader' })).toBe(m)
  })
  test('migration and read preserve lastDeliveredRole', async () => {
    const doc = migrateLegacyRoles({ version: 1, migrated: false, roles: { a: 'worker' }, lastDeliveredRole: { a: 'worker' } }, { b: 'leader' })
    expect(doc.lastDeliveredRole).toEqual({ a: 'worker' })
    await writeRolesDoc(dir, doc)
    expect((await loadRoles({ dataDir: dir, legacyPref: async () => undefined })).lastDeliveredRole).toEqual({ a: 'worker' })
  })
  test('loadRoles persists the migration and never re-reads the legacy pref', async () => {
    let reads = 0
    const legacyPref = async () => { reads++; return { c1: 'leader' } }
    expect((await loadRoles({ dataDir: dir, legacyPref })).roles).toEqual({ c1: 'leader' })
    expect((await loadRoles({ dataDir: dir, legacyPref })).roles).toEqual({ c1: 'leader' })
    expect(reads).toBe(1)
    expect(JSON.parse(await readFile(join(dir, SESSION_ROLES_FILE), 'utf-8')).migrated).toBe(true)
  })
  test('a corrupt file reads as empty', async () => {
    await writeFile(join(dir, SESSION_ROLES_FILE), '{nope')
    expect((await loadRoles({ dataDir: dir, legacyPref: async () => undefined })).roles).toEqual({})
  })
  test('roleOfRow finds a role by conversation key or managed id', () => {
    expect(roleOfRow({ conv: 'leader' }, { id: 'm1', conversationId: 'conv' })).toBe('leader')
    expect(roleOfRow({ m1: 'worker' }, { id: 'm1', conversationId: 'conv' })).toBe('worker')
    expect(roleOfRow({}, { id: 'm1' })).toBeUndefined()
  })
})

describe('spawn role assignment and delivery', () => {
  test('a leader spawn applies the localized title prefix through rename', async () => {
    const rows = [{ id: 'm1', title: 'Child' }]
    const { deps, renames } = fake(rows)
    expect(await applyRoleTitle('m1', 'Child', 'leader', 'pt', deps)).toBe(true)
    expect(renames).toEqual([['m1', '[ LÍDER ] - Child']])
    expect(await applyRoleTitle('m1', '[ LÍDER ] - Child', 'leader', 'pt', deps)).toBe(false)
  })

  test('a stored worker role strips the leader prefix, even from a placeholder title', async () => {
    const rows = [{ id: 'm2', title: '[ LÍDER ] - sessão sem registro 8c8c707d07' }]
    const { deps, renames } = fake(rows)
    expect(await applyRoleTitle('m2', '[ LÍDER ] - sessão sem registro 8c8c707d07', 'worker', 'pt', deps)).toBe(true)
    expect(renames).toEqual([['m2', 'sessão sem registro 8c8c707d07']])
    expect(await applyRoleTitle('m2', 'Plain', 'worker', 'pt', deps)).toBe(false)
  })

  test('a child defaults to worker, a handoff can request leader, and an explicit role wins', async () => {
    const { deps } = fake([])
    expect(await ensureSpawnRole(['child'], 'worker', deps)).toBe('worker')
    expect(await ensureSpawnRole(['handoff'], 'leader', deps)).toBe('leader')
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { child: 'worker', handoff: 'leader', explicit: 'leader' }, lastDeliveredRole: {} })
    expect(await ensureSpawnRole(['explicit', 'new-id'], 'worker', deps)).toBe('leader')
    expect(await ensureSpawnRole([], 'worker', deps)).toBe('worker')
    expect((await loadRoles(deps)).roles).toEqual({ child: 'worker', handoff: 'leader', explicit: 'leader' })
  })

  test('stores the managed id when the offered conversation id is not accepted', async () => {
    const { deps } = fake([])
    await ensureSpawnRole(['offered-conversation', 'managed-id'], 'worker', deps)
    expect((await loadRoles(deps)).roles).toEqual({ 'offered-conversation': 'worker', 'managed-id': 'worker' })
  })

  test('rekeys role and delivery state from an old managed id to a reopened id', async () => {
    const { deps, prompts } = fake([{ id: 'new-id', title: 'T' }])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { 'old-id': 'leader' }, lastDeliveredRole: { 'old-id': 'leader' } })
    await rekeyStoredRole(['old-id'], ['new-id'], deps)
    expect((await loadRoles(deps)).roles).toEqual({ 'new-id': 'leader' })
    expect((await loadRoles(deps)).lastDeliveredRole).toEqual({ 'new-id': 'leader' })
    expect(await deliverStoredRole('new-id', undefined, deps)).toBe(false)
    expect(prompts).toHaveLength(0)
  })

  test('rekeys to a newly discovered conversation while retaining the delivery watermark', async () => {
    const { deps } = fake([{ id: 'managed', title: 'T' }])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { managed: 'worker' }, lastDeliveredRole: { managed: 'worker' } })
    await rekeyStoredRole(['managed'], ['managed', 'conversation'], deps)
    expect((await loadRoles(deps)).roles).toEqual({ managed: 'worker', conversation: 'worker' })
    expect((await loadRoles(deps)).lastDeliveredRole).toEqual({ managed: 'worker', conversation: 'worker' })
  })

  test('a rekey never leaves two contradictory entries for one session', async () => {
    const { deps } = fake([])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { offered: 'worker', conversation: 'leader' }, at: { offered: 10, conversation: 20 } })
    await rekeyStoredRole(['offered'], ['conversation', 'managed'], deps)
    expect((await loadRoles(deps)).roles).toEqual({ conversation: 'leader', managed: 'leader' })
  })

  test('rekey chooses a newer target assignment over the source', async () => {
    const { deps } = fake([])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { old: 'worker', conversation: 'leader' }, at: { old: 10, conversation: 20 } })
    await rekeyStoredRole(['old'], ['conversation', 'managed'], deps)
    expect((await loadRoles(deps)).roles).toEqual({ conversation: 'leader', managed: 'leader' })
  })

  test('rekey chooses a newer source assignment over the target', async () => {
    const { deps } = fake([])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { old: 'leader', conversation: 'worker' }, at: { old: 20, conversation: 10 } })
    await rekeyStoredRole(['old'], ['conversation', 'managed'], deps)
    expect((await loadRoles(deps)).roles).toEqual({ conversation: 'leader', managed: 'leader' })
  })

  test('serializes rekey and delivery writes without losing either field', async () => {
    const { deps } = fake([])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { old: 'leader' }, lastDeliveredRole: {} })
    await Promise.all([
      rekeyStoredRole(['old'], ['new'], deps),
      markRoleDelivered(['new'], 'leader', deps),
    ])
    expect(await loadRoles(deps)).toMatchObject({
      roles: { new: 'leader' },
      lastDeliveredRole: { new: 'leader' },
    })
  })

  test('does not deadlock when input readiness rekeys the session', async () => {
    const { deps } = fake([{ id: 'new-id', title: 'T' }])
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { 'new-id': 'leader' }, lastDeliveredRole: {} })
    const gated = {
      ...deps,
      waitForInput: async () => {
        await rekeyStoredRole(['new-id'], ['new-id', 'conversation-id'], deps)
        return true
      },
    }
    const result = await Promise.race([
      deliverStoredRole('new-id', undefined, gated),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('role delivery deadlocked')), 250)),
    ])
    expect(result).toBe(true)
  })

  test('waits for input before recording an acknowledged delivery', async () => {
    const rows = [{ id: 'm1', conversationId: 'c1', title: 'T' }]
    const { deps } = fake(rows)
    const events: string[] = []
    const gated = { ...deps, waitForInput: async () => { events.push('ready'); return true }, prompt: async () => { events.push('prompt'); return { ok: true } } }
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { c1: 'worker' }, lastDeliveredRole: {} })
    expect(await deliverStoredRole('m1', 'c1', gated)).toBe(true)
    expect(events).toEqual(['ready', 'prompt'])
    expect((await loadRoles(deps)).lastDeliveredRole).toEqual({ c1: 'worker' })
  })

  test('delivers once per role value, redelivers after a change, and does not mark failed sends', async () => {
    const rows = [{ id: 'm1', conversationId: 'c1', title: 'T' }]
    const { deps, prompts } = fake(rows)
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { c1: 'worker' }, lastDeliveredRole: {} })
    expect(await deliverStoredRole('m1', 'c1', deps)).toBe(true)
    expect(await deliverStoredRole('m1', 'c1', deps)).toBe(false)
    expect(prompts).toHaveLength(1)

    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { c1: 'leader' }, lastDeliveredRole: { c1: 'worker' } })
    expect(await deliverStoredRole('m1', 'c1', deps)).toBe(true)
    expect(prompts).toHaveLength(2)

    let fail = true
    const failing = { ...deps, prompt: async () => { if (fail) { fail = false; return { ok: false } }; return { ok: true } } }
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { c1: 'worker' }, lastDeliveredRole: { c1: 'leader' } })
    expect(await deliverStoredRole('m1', 'c1', failing)).toBe(false)
    expect((await loadRoles(deps)).lastDeliveredRole).toEqual({ c1: 'leader' })
    expect(await deliverStoredRole('m1', 'c1', failing)).toBe(true)
  })
})

describe('roleOp (the agentistics_session_role handler)', () => {
  test('a session still titled with the unregistered placeholder is not renamed into a leader title', async () => {
    const rows = [{ id: 'm9', conversationId: 'c9', title: 'unregistered session 8c8c707d07' }]
    const { deps, renames } = fake(rows)
    const out = await roleOp('m9', { role: 'leader', lang: 'pt' }, deps)
    expect(out).toMatchObject({ ok: true, role: 'leader', renamed: false })
    expect(renames).toEqual([])
    expect(await applyRoleTitle('m9', 'sessão sem registro 8c8c707d07', 'leader', 'pt', deps)).toBe(false)
    expect(renames).toEqual([])
  })

  test('a browser sets leader: stored under the conversation key, renamed, and the session is told', async () => {
    const rows = [{ id: 'm1', conversationId: 'c1', title: 'Fix login' }]
    const { deps, renames, prompts } = fake(rows)
    const out = await roleOp(null, { ref: 'm1', role: 'leader', lang: 'pt' }, deps)
    expect(out).toMatchObject({ ok: true, role: 'leader', changed: true, renamed: true, notified: true })
    expect(renames).toEqual([['m1', '[ LÍDER ] - Fix login']])
    expect(prompts[0]![1]).toStartWith('[from agentistics · role]\n')
    expect(prompts[0]![1]).toContain('your role is now LEADER')
    expect((await loadRoles(deps)).roles).toEqual({ c1: 'leader' })
  })
  test('setting the same role twice is idempotent: no second rename, no second note', async () => {
    const rows = [{ id: 'm1', title: 'T' }]
    const { deps, renames, prompts } = fake(rows)
    await roleOp(null, { ref: 'm1', role: 'leader' }, deps)
    const again = await roleOp(null, { ref: 'm1', role: 'leader' }, deps)
    expect(again).toMatchObject({ ok: true, changed: false, renamed: false, notified: false })
    expect(renames).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(rows[0]!.title).toBe('[ LEADER ] - T')
  })
  test('worker / auto strip the prefix and clear the entry', async () => {
    const rows = [{ id: 'm1', title: 'T' }]
    const { deps, renames } = fake(rows)
    await roleOp(null, { ref: 'm1', role: 'leader' }, deps)
    const out = await roleOp(null, { ref: 'm1', role: 'auto' }, deps)
    expect(out).toMatchObject({ ok: true, role: 'auto', changed: true, renamed: true })
    expect(renames.at(-1)).toEqual(['m1', 'T'])
    expect((await loadRoles(deps)).roles).toEqual({})
    await roleOp(null, { ref: 'm1', role: 'worker' }, deps)
    expect((await loadRoles(deps)).roles).toEqual({ m1: 'worker' })
  })
  test('worker and auto strip a leader prefix from a placeholder title', async () => {
    for (const role of ['worker', 'auto'] as const) {
      const rows = [{ id: 'm1', title: '[ LÍDER ] - sessão sem registro 8c8c707d07' }]
      const { deps, renames } = fake(rows)
      const out = await roleOp(null, { ref: 'm1', role }, deps)
      expect(out).toMatchObject({ ok: true, renamed: true })
      expect(renames).toEqual([['m1', 'sessão sem registro 8c8c707d07']])
    }
  })
  test('a session sets its OWN role without ref and is not typed into', async () => {
    const rows = [{ id: 'm1', title: 'Me' }]
    const { deps, prompts, renames } = fake(rows)
    const out = await roleOp('m1', { role: 'leader' }, deps)
    expect(out).toMatchObject({ ok: true, role: 'leader', notified: false, renamed: true })
    expect(prompts).toHaveLength(0)
    expect(renames).toEqual([['m1', '[ LEADER ] - Me']])
    expect(out.ok && out.line).toContain('LEADER')
  })
  test('reading reports the role and changes nothing', async () => {
    const { deps, renames } = fake([{ id: 'm1', title: 'T' }])
    await roleOp(null, { ref: 'm1', role: 'worker' }, deps)
    const out = await roleOp('m1', {}, deps)
    expect(out).toMatchObject({ ok: true, role: 'worker', changed: false })
    expect(renames).toHaveLength(0)
  })
  test('another session only for its own children', async () => {
    const rows = [{ id: 'p', title: 'P' }, { id: 'kid', title: 'Kid' }, { id: 'other', title: 'Other' }]
    const { deps } = fake(rows, { parentOf: async id => (id === 'kid' ? 'p' : undefined) })
    expect(await roleOp('p', { ref: 'kid', role: 'worker' }, deps)).toMatchObject({ ok: true })
    const denied = await roleOp('p', { ref: 'other', role: 'leader' }, deps)
    expect(denied).toMatchObject({ ok: false, code: 'not_your_child' })
    expect(roleStatus(denied)).toBe(403)
  })
  test('refusals: no ref and no sender, bad role, unknown session', async () => {
    const { deps } = fake([{ id: 'm1', title: 'T' }])
    expect(await roleOp(null, { role: 'leader' }, deps)).toMatchObject({ ok: false, code: 'missing_argument' })
    expect(await roleOp(null, { ref: 'm1', role: 'boss' }, deps)).toMatchObject({ ok: false, code: 'bad_role' })
    expect(await roleOp(null, { ref: 'zzz', role: 'leader' }, deps)).toMatchObject({ ok: false, code: 'no_such_session' })
  })
  test('the UI language defaults from preferences when the request names none', async () => {
    const { deps, renames } = fake([{ id: 'm1', title: 'T' }], { uiLang: async () => 'pt' })
    await roleOp(null, { ref: 'm1', role: 'leader' }, deps)
    expect(renames[0]![1]).toBe('[ LÍDER ] - T')
  })
})

describe('role origin (who set it)', () => {
  test('the browser / CLI (no verified sender) is manual', async () => {
    const { deps } = fake([{ id: 'm1', conversationId: 'c1', title: 'T' }])
    const out = await roleOp(null, { ref: 'm1', role: 'worker' }, deps)
    expect(out).toMatchObject({ ok: true, origin: 'manual' })
    expect(await listRoleOrigins(deps)).toEqual({ c1: 'manual' })
  })
  test('a session setting its own role is auto', async () => {
    const { deps } = fake([{ id: 'm1', title: 'T' }])
    expect(await roleOp('m1', { role: 'leader' }, deps)).toMatchObject({ ok: true, origin: 'auto' })
    expect(await listRoleOrigins(deps)).toEqual({ m1: 'auto' })
  })
  test('a leader setting a child records itself as the origin', async () => {
    const { deps } = fake([{ id: 'p', title: 'P' }, { id: 'kid', title: 'Kid' }], { parentOf: async id => (id === 'kid' ? 'p' : undefined) })
    expect(await roleOp('p', { ref: 'kid', role: 'worker' }, deps)).toMatchObject({ ok: true, origin: { leader: 'p' } })
    expect(await listRoleOrigins(deps)).toEqual({ kid: { leader: 'p' } })
  })
  test('the owner choosing the same role afterwards takes the origin back (manual)', async () => {
    const { deps } = fake([{ id: 'm1', title: 'T' }])
    await roleOp('m1', { role: 'worker' }, deps)
    const out = await roleOp(null, { ref: 'm1', role: 'worker' }, deps)
    expect(out).toMatchObject({ ok: true, changed: false, origin: 'manual' })
    expect(await listRoleOrigins(deps)).toEqual({ m1: 'manual' })
  })
  test('clearing the role clears the origin', async () => {
    const { deps } = fake([{ id: 'm1', title: 'T' }])
    await roleOp('m1', { role: 'worker' }, deps)
    await roleOp(null, { ref: 'm1', role: 'auto' }, deps)
    expect(await listRoleOrigins(deps)).toEqual({})
  })
  test('an entry stored without an origin reads as manual', async () => {
    await writeFile(join(dir, SESSION_ROLES_FILE), JSON.stringify({ version: 1, migrated: true, roles: { c1: 'leader' } }))
    expect(originOfRow((await loadRoles({ dataDir: dir, legacyPref: async () => undefined })), { id: 'm1', conversationId: 'c1' })).toBe('manual')
  })
  test('rekey moves the origin with the role', async () => {
    const { deps } = fake([{ id: 'm1', title: 'T' }])
    await roleOp('m1', { role: 'leader' }, deps)
    await rekeyStoredRole(['m1'], ['c9'], deps)
    expect(await listRoleOrigins(deps)).toEqual({ c9: 'auto' })
  })
})

describe('ensureSpawnRole origin', () => {
  test('records the spawning leader as the origin', async () => {
    const { deps } = fake([])
    await ensureSpawnRole(['c1', 'm1'], 'worker', deps, { leader: 'p' })
    expect(await listRoleOrigins(deps)).toEqual({ c1: { leader: 'p' }, m1: { leader: 'p' } })
  })
})

describe('spawnRoleOrigin (only a proven live parent is a leader origin)', () => {
  test('verified parent present in the registry -> leader', () => {
    expect(spawnRoleOrigin('p', true, ['p', 'q'])).toEqual({ leader: 'p' })
  })
  test('unverified, unknown or absent parent -> manual', () => {
    expect(spawnRoleOrigin('p', false, ['p'])).toBe('manual')
    expect(spawnRoleOrigin('ghost', true, ['p'])).toBe('manual')
    expect(spawnRoleOrigin(undefined, true, ['p'])).toBe('manual')
  })
})

describe('roleSenderFromBody (who is asking)', () => {
  const verify = async (id: unknown, token: unknown) => (id === 'm1' && token === 'ok' ? 'm1' : null)
  test('no session field at all = the browser/CLI (manual power)', async () => {
    expect(await roleSenderFromBody({} , verify)).toEqual({ ok: true, sender: null })
  })
  test('a valid proof is the sender', async () => {
    expect(await roleSenderFromBody({ session: { id: 'm1', token: 'ok' } }, verify)).toEqual({ ok: true, sender: 'm1' })
  })
  test('a session field that is null, missing or invalid is unverified_sender', async () => {
    expect(await roleSenderFromBody({ session: null }, verify)).toMatchObject({ ok: false, code: 'unverified_sender' })
    expect(await roleSenderFromBody({ session: { id: 'm1', token: 'bad' } }, verify)).toMatchObject({ ok: false, code: 'unverified_sender' })
    expect(roleStatus({ ok: false, code: 'unverified_sender', message: '' })).toBe(403)
  })
})

describe('unverified_sender language', () => {
  const verify = async () => null
  test('PT when asked in PT, EN otherwise', async () => {
    const pt = await roleSenderFromBody({ session: null }, verify, 'pt')
    const en = await roleSenderFromBody({ session: null }, verify, 'en')
    expect(pt).toMatchObject({ ok: false, code: 'unverified_sender' })
    expect((pt as { message: string }).message).toContain('Só uma sessão')
    expect((en as { message: string }).message).toContain('Only a session')
    expect((en as { message: string }).message).not.toContain('without naming')
  })
})

describe('markParentVerified (the wire never states it)', () => {
  const verify = async (id: unknown, token: unknown) => (id === 'p1' && token === 'ok' ? 'p1' : null)
  test('overwrites a forged parentVerified: true when there is no proof', async () => {
    const body = { parent: 'p1', parentVerified: true } as { parent?: unknown; parentVerified?: unknown; session?: unknown }
    expect(await markParentVerified(body, verify)).toBe(false)
    expect(body.parentVerified).toBe(false)
  })
  test('overwrites it when the proof names a different parent', async () => {
    const body = { parent: 'p2', parentVerified: true, session: { id: 'p1', token: 'ok' } }
    await markParentVerified(body, verify)
    expect(body.parentVerified).toBe(false)
  })
  test('true only for a valid proof naming the parent it claims', async () => {
    const body = { parent: ' p1 ', parentVerified: false, session: { id: 'p1', token: 'ok' } }
    await markParentVerified(body, verify)
    expect(body.parentVerified).toBe(true)
  })
})

describe('markCallerVerified (PLAN.ACCOUNTS D3 — the wire never states it either)', () => {
  const verify = async (id: unknown, token: unknown) => (id === 'p1' && token === 'ok' ? 'p1' : null)
  test('a forged callerVerified without a proof is overwritten', async () => {
    const body: { session?: unknown; callerVerified?: unknown } = { callerVerified: true }
    expect(await markCallerVerified(body, verify)).toBe(false)
    expect(body.callerVerified).toBe(false)
  })
  test('a bad token is not an agent identity', async () => {
    const body: { session?: unknown; callerVerified?: unknown } = { session: { id: 'p1', token: 'bad' }, callerVerified: true }
    await markCallerVerified(body, verify)
    expect(body.callerVerified).toBe(false)
  })
  test('any valid proof marks the caller as an agent, whatever parent it names', async () => {
    const body: { session?: unknown; callerVerified?: unknown; parent?: unknown } = { parent: 'other', session: { id: 'p1', token: 'ok' } }
    await markCallerVerified(body, verify)
    expect(body.callerVerified).toBe(true)
  })
})

describe('ORQ.FORA live leader uniqueness warning', () => {
  test('warns with the other leader name and id, without blocking the role change', async () => {
    const rows = [
      { id: 'leader', title: 'Motor', state: 'working' },
      { id: 'child', title: 'Successor', state: 'waiting' },
    ]
    const { deps } = fake(rows, { taskOf: async () => 't-one' })
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { leader: 'leader' } })
    expect(await roleOp(null, { ref: 'child', role: 'leader' }, deps)).toMatchObject({ ok: true, role: 'leader', warning: 'Another live leader on task t-one: Motor (leader).' })
  })
  test('leaders of other tasks and closed leaders do not warn', async () => {
    const rows = [
      { id: 'other', title: 'Other front', state: 'working' },
      { id: 'old', title: 'Old', state: 'closed' },
      { id: 'child', title: 'New', state: 'waiting' },
    ]
    const { deps } = fake(rows, { taskOf: async id => id === 'other' ? 't-other' : 't-one' })
    await writeRolesDoc(dir, { version: 1, migrated: true, roles: { other: 'leader', old: 'leader' } })
    const result = await roleOp(null, { ref: 'child', role: 'leader' }, deps)
    expect(result.ok && result.warning).toBeUndefined()
  })
})
