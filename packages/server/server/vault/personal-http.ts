/**
 * vault/personal-http.ts — `/api/vault/personal*` (VAULT.PERSONAL P1). Called by http.ts, and answers
 * ONLY through the `reply` it is handed — the module's one JSON exit, which runs the page filter — so a
 * route here cannot bypass it. Every route goes through the gate first (gate.ts §3 rows); the store
 * (personal.ts) holds no rule. Exactly ONE route returns a value: `reveal`. The lint in
 * `personal.test.ts` seals a marker and drives every route to prove it.
 */
import { readJsonLimited } from '../limits'
import { GROUP_ID, ITEM_ID, KIND_FIELDS, validGroupName, validateInput, type PersonalKind } from '@agentistics/vault'
import * as gate from './gate'
import * as store from './personal'
import { vaultAudit, vaultLang } from './service'

type Reply = (r: { ok: boolean } & Record<string, unknown>, extra?: Record<string, unknown>) => Response
export interface PersonalHttpCtx { req: Request; path: string; url: URL; session: string; grant: string | null; loopback: boolean; reply: Reply }

/** Large enough for a 64 KiB value or a `.env` file; still bounded and read as a stream. */
const BODY_LIMIT = 256 * 1024

const pt = () => vaultLang() === 'pt'
const fail = (code: string, en: string, ptText: string) => ({ ok: false as const, code, sentence: pt() ? ptText : en })
const bad = () => fail('bad-request', 'Bad request.', 'Requisição inválida.')
function storeFail(r: store.StoreFail) {
  switch (r.code) {
    case 'version-conflict': return { ...fail('version-conflict', 'This secret was changed somewhere else since you opened it. Reload and try again.', 'Este segredo foi alterado em outro lugar desde que você o abriu. Recarregue e tente de novo.'), version: r.version }
    case 'not-found': return fail('not-found', 'That secret no longer exists.', 'Esse segredo não existe mais.')
    case 'no-import': return fail('no-import', 'That import expired (10 minutes) or belongs to another window. Choose the file again.', 'Essa importação expirou (10 minutos) ou é de outra janela. Escolha o arquivo de novo.')
    default: return fail('record-unreadable', 'That secret could not be opened on this machine.', 'Esse segredo não pôde ser aberto nesta máquina.')
  }
}
const invalid = (field: string) => fail('invalid', `Check the field "${field}".`, `Confira o campo "${field}".`)

export async function handlePersonalHttp(c: PersonalHttpCtx): Promise<Response | null> {
  const { req, path, session, grant, loopback, reply } = c
  if (!path.startsWith('/api/vault/personal')) return null
  const body = async (): Promise<Record<string, unknown>> => {
    const r = await readJsonLimited<Record<string, unknown>>(req, BODY_LIMIT)
    return r.ok && r.value && typeof r.value === 'object' ? r.value : {}
  }
  const codeOf = (b: Record<string, unknown>) => (typeof b.code === 'string' && b.code.length <= 16 ? b.code : undefined)
  const ver = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : null)
  const step = (action: gate.VaultAction, b: Record<string, unknown>) => gate.requireVaultStepUp(action, { grant, session, loopback, code: codeOf(b) })
  const withGrant = (g: gate.GateResult) => (g.ok && g.grant ? { grant: g.grant } : {})

  // ── list: metadata only ──
  if (path === '/api/vault/personal' && req.method === 'GET') {
    const g = await step('personal-list', {})
    if (!g.ok) return reply(g)
    return reply({ ok: true, items: await store.listItems(), groups: await store.listGroups(), kinds: KIND_FIELDS, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/versions' && req.method === 'GET') {
    const id = c.url.searchParams.get('id') ?? ''
    const g = await step('personal-list', {})
    if (!g.ok) return reply(g)
    const r = await store.listVersions(id)
    return reply(Array.isArray(r) ? { ok: true, versions: r } : storeFail(r))
  }
  if (req.method !== 'POST') return null
  const b = await body()

  if (path === '/api/vault/personal') {
    const v = validateInput(b.item, { requireFields: true })
    if (!v.ok) return reply(invalid(v.field))
    const g = await step('personal-create', b)
    if (!g.ok) return reply(g)
    const r = await store.createItem(v.value)
    vaultAudit({ type: 'vault.personal-create', name: r.meta.id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/edit') {
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion)
    const v = validateInput(b.item, { requireFields: false })
    if (!ITEM_ID.test(id) || !ev) return reply(bad())
    if (!v.ok) return reply(invalid(v.field))
    const g = await step('personal-edit', b)
    if (!g.ok) return reply(g)
    const r = await store.editItem(id, ev, v.value)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-edit', name: id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/reveal') {
    // THE value route. The gesture every time (gate.requirePersonalReveal); the act is audited, never the value.
    const id = typeof b.id === 'string' ? b.id : '', field = typeof b.field === 'string' ? b.field : ''
    const version = b.version === undefined ? undefined : ver(b.version)
    if (!ITEM_ID.test(id) || !field || version === null) return reply(bad())
    const g = await gate.requirePersonalReveal({ session, loopback, code: codeOf(b) })
    if (!g.ok) return reply(g)
    const r = await store.revealField(id, field, version)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-reveal', name: id })
    return reply({ ok: true, value: r.value, field, version: r.meta.version })
  }
  for (const [route, action, run, audit] of [
    ['/api/vault/personal/trash', 'personal-trash', store.trashItem, 'vault.personal-trash'],
    ['/api/vault/personal/restore', 'personal-restore', store.restoreItem, 'vault.personal-restore'],
  ] as const) {
    if (path !== route) continue
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion)
    if (!ITEM_ID.test(id) || !ev) return reply(bad())
    const g = await step(action, b)
    if (!g.ok) return reply(g)
    const r = await run(id, ev)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: audit, name: id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/restore-version') {
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion), v = ver(b.version)
    if (!ITEM_ID.test(id) || !ev || !v) return reply(bad())
    const g = await step('personal-restore-version', b)
    if (!g.ok) return reply(g)
    const r = await store.restoreVersion(id, v, ev)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-restore-version', name: id })
    return reply({ ok: true, meta: r.meta })
  }
  if (path === '/api/vault/personal/purge') {
    const id = typeof b.id === 'string' ? b.id : ''
    if (!ITEM_ID.test(id)) return reply(bad())
    const g = await step('personal-purge', b)
    if (!g.ok) return reply(g)
    const r = await store.purgeItem(id)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-purge', name: id })
    return reply({ ok: true })
  }
  if (path === '/api/vault/personal/move') {
    // Moving into / out of a group changes metadata only; the value is untouched.
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion)
    const groupId = b.groupId === null ? null : typeof b.groupId === 'string' && GROUP_ID.test(b.groupId) ? b.groupId : undefined
    if (!ITEM_ID.test(id) || !ev || groupId === undefined) return reply(bad())
    const g = await step('personal-group-write', b)
    if (!g.ok) return reply(g)
    const r = await store.moveItem(id, ev, groupId)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-group', name: id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/groups') {
    const name = validGroupName(b.name)
    if (!name) return reply(invalid('name'))
    const g = await step('personal-group-write', b)
    if (!g.ok) return reply(g)
    const r = await store.createGroup(name)
    vaultAudit({ type: 'vault.personal-group', name: r.group.id })
    return reply({ ok: true, group: r.group, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/groups/rename') {
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion), name = validGroupName(b.name)
    if (!GROUP_ID.test(id) || !ev) return reply(bad())
    if (!name) return reply(invalid('name'))
    const g = await step('personal-group-write', b)
    if (!g.ok) return reply(g)
    const r = await store.renameGroup(id, ev, name)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-group', name: id })
    return reply({ ok: true, group: r.group, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/groups/delete') {
    const id = typeof b.id === 'string' ? b.id : ''
    if (!GROUP_ID.test(id)) return reply(bad())
    const g = await step('personal-group-delete', b)
    if (!g.ok) return reply(g)
    const r = await store.deleteGroup(id)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-group', name: id })
    return reply({ ok: true, moved: r.moved, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/import/preview') {
    const text = typeof b.text === 'string' && b.text.length <= BODY_LIMIT ? b.text : null
    if (text === null) return reply(bad())
    const g = await step('personal-import-env', b)
    if (!g.ok) return reply(g)
    const r = await store.importPreview(text, session)
    b.text = ''
    return reply({ ok: true, token: r.token, keys: r.keys, skipped: r.skipped, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/import/commit') {
    const token = typeof b.token === 'string' ? b.token : ''
    const groupId = typeof b.groupId === 'string' && GROUP_ID.test(b.groupId) ? b.groupId : null
    const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : []
    const choices = Array.isArray(b.choices) ? b.choices.flatMap(x => {
      const o = x as Record<string, unknown>
      if (typeof o.key !== 'string' || !['import', 'skip', 'replace', 'rename'].includes(String(o.action))) return []
      const name = typeof o.name === 'string' ? o.name.trim().slice(0, 120) : undefined
      return [{ key: o.key, action: o.action as 'import' | 'skip' | 'replace' | 'rename', ...(name ? { name } : {}) }]
    }) : []
    if (!token) return reply(bad())
    const g = await step('personal-import-env', b)
    if (!g.ok) return reply(g)
    const r = await store.importCommit(token, session, choices, groupId, tags)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-import' })
    return reply({ ok: true, created: r.created, replaced: r.replaced, skipped: r.skipped, ...withGrant(g) })
  }
  return null
}

/** For the page: the kinds and their fields (no values, no secrets). */
export const PERSONAL_KIND_LIST: readonly PersonalKind[] = Object.keys(KIND_FIELDS) as PersonalKind[]
