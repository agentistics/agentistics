import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanStaleRoleTmps, ensureSpawnRole, readRolesDoc, type RoleDeps } from './session-roles'
import { backfillParentConversation } from './registry'
import { planReopenReparent } from './team-links'
import { parseSessionArgs } from './cli-parse'
import type { ManagedSession } from './types'

const roots: string[] = []
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'roles-lock-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

const ROLES = join(import.meta.dir, 'session-roles.ts')

/** A child PROCESS that writes `n` distinct spawn roles into `dataDir`, as `agentop session …` does. */
function writer(dataDir: string, tag: string, n: number) {
  const script = `
    const { ensureSpawnRole } = await import(${JSON.stringify(ROLES)})
    const deps = { dataDir: ${JSON.stringify(dataDir)}, legacyPref: async () => undefined }
    for (let i = 0; i < ${n}; i++) await ensureSpawnRole(['${tag}-' + i, '${tag}-conv-' + i], 'worker', deps, { leader: 'lead' })
  `
  return Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env, HOME: dataDir } })
}

test('DSL.TIPO-SESSAO: concurrent processes writing roles lose none (the 30/10 lost update)', async () => {
  const dataDir = temp()
  const N = 25
  const children = ['a', 'b', 'c'].map(t => writer(dataDir, t, N))
  // The parent process writes too, like the server's role operations do at the same time.
  const deps = { dataDir, legacyPref: async () => undefined } as unknown as RoleDeps
  const own = (async () => { for (let i = 0; i < N; i++) await ensureSpawnRole([`srv-${i}`], 'leader', deps, 'manual') })()
  const codes = await Promise.all(children.map(c => c.exited))
  await own
  for (const c of children) expect(await new Response(c.stderr).text()).toBe('')
  expect(codes).toEqual([0, 0, 0])
  const doc = await readRolesDoc(dataDir)
  const missing: string[] = []
  for (const t of ['a', 'b', 'c']) for (let i = 0; i < N; i++) {
    if (doc.roles[`${t}-${i}`] !== 'worker') missing.push(`${t}-${i}`)
    if (doc.roles[`${t}-conv-${i}`] !== 'worker') missing.push(`${t}-conv-${i}`)
  }
  for (let i = 0; i < N; i++) if (doc.roles[`srv-${i}`] !== 'leader') missing.push(`srv-${i}`)
  expect(missing).toEqual([])
  expect(Object.keys(doc.roles)).toHaveLength(N * 3 * 2 + N)
  // No temp file is left behind by the writes themselves.
  expect(readdirSync(dataDir).filter(f => f.endsWith('.tmp'))).toEqual([])
}, 60_000)

test('server start removes only role temp files older than an hour', async () => {
  const dataDir = temp()
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  for (const name of ['session-roles.json.123.tmp', 'session-roles.json.456.ab12cd34.tmp']) {
    writeFileSync(join(dataDir, name), ''); utimesSync(join(dataDir, name), old, old)
  }
  writeFileSync(join(dataDir, 'session-roles.json.789.tmp'), '') // fresh: a write in flight
  writeFileSync(join(dataDir, 'other.json.1.tmp'), ''); utimesSync(join(dataDir, 'other.json.1.tmp'), old, old)
  writeFileSync(join(dataDir, 'session-roles.json'), '{}')
  expect(await cleanStaleRoleTmps(dataDir)).toBe(2)
  expect(readdirSync(dataDir).sort()).toEqual(['other.json.1.tmp', 'session-roles.json', 'session-roles.json.789.tmp'])
})

const row = (id: string, extra: Partial<ManagedSession> = {}) => ({ id, harness: 'codex', cwd: '/w', createdAt: 'x', ...extra }) as ManagedSession

test('a child born before its leader had a conversation gets the conversation link when the leader links', () => {
  const list = [row('lead'), row('w1', { parentSessionId: 'lead' }), row('w2', { parentSessionId: 'lead', parentConversationId: 'keep' }), row('x', { parentSessionId: 'other' })]
  expect(backfillParentConversation(list, 'lead', 'conv-lead')).toBe(1)
  expect(list.map(r => [r.id, r.parentConversationId])).toEqual([['lead', undefined], ['w1', 'conv-lead'], ['w2', 'keep'], ['x', undefined]])
})

test('a leader reopened with a new managed id keeps its team; other teams are untouched', () => {
  const rows = [
    { id: 'old', conversationId: undefined },
    { id: 'new', conversationId: 'c-new', parentSessionId: 'boss' },
    { id: 'w1', parentSessionId: 'old' },
    { id: 'w2', parentSessionId: 'old', parentConversationId: 'c-old' },
    { id: 'w3', parentSessionId: 'someone-else' },
  ]
  const plan = planReopenReparent(rows, rows[0]!, rows[1]!)
  expect(plan.children).toEqual(['w1', 'w2'])
  expect(plan.childPatch).toEqual({ parentSessionId: 'new', parentConversationId: 'c-new' })
})

test('session batch --role is a positional default for the sessions that follow', () => {
  const cmd = parseSessionArgs(['batch', '--task', 't', '--session', 'claude: a', '--role', 'worker', '--session', 'codex: b', '--role', 'leader', '--session', 'claude: c'])
  expect(cmd.kind).toBe('batch')
  if (cmd.kind !== 'batch') return
  expect(cmd.specs.map(s => s.role)).toEqual([undefined, 'worker', 'leader'])
  expect(parseSessionArgs(['batch', '--task', 't', '--role', 'boss', '--session', 'claude: a'])).toMatchObject({ kind: 'error' })
})
