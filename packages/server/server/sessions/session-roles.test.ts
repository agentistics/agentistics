import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SESSION_ROLES_FILE, loadRoles, migrateLegacyRoles, parseRoles, roleOfRow, roleOp, roleStatus, type RoleDeps,
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

describe('roleOp (the agentistics_session_role handler)', () => {
  test('a browser sets leader: stored under the conversation key, renamed, and the session is told', async () => {
    const rows = [{ id: 'm1', conversationId: 'c1', title: 'Fix login' }]
    const { deps, renames, prompts } = fake(rows)
    const out = await roleOp(null, { ref: 'm1', role: 'leader', lang: 'pt' }, deps)
    expect(out).toMatchObject({ ok: true, role: 'leader', changed: true, renamed: true, notified: true })
    expect(renames).toEqual([['m1', '[ LÍDER ] - Fix login']])
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
