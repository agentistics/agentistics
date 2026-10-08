/**
 * vault/personal-http.ts — `/api/vault/personal*` (VAULT.PERSONAL P1). Called by http.ts, and answers
 * ONLY through the `reply` it is handed — the module's one JSON exit, which runs the page filter — so a
 * route here cannot bypass it. Every route goes through the gate first (gate.ts §3 rows); the store
 * (personal.ts) holds no rule. Exactly ONE route returns a value: `reveal`. The lint in
 * `personal.test.ts` seals a marker and drives every route to prove it.
 */
import { readJsonLimited } from '../limits'
import { GROUP_ID, ITEM_ID, KIND_FIELDS, PERSONAL_KINDS, TYPE_ID, isUseOnly, originMatchesRp, needsConfirm, validGroupName, validateInput, type PersonalKind } from '@agentistics/vault'
import * as gate from './gate'
import * as store from './personal'
import * as mobile from './mobile'
import * as phone from './phone'
import * as grants from './grants'
import { vaultAudit, vaultLang } from './service'
import { informationalSecure } from './request-origin'

type Reply = (r: { ok: boolean } & Record<string, unknown>, extra?: Record<string, unknown>) => Response
export interface PersonalHttpCtx { req: Request; path: string; url: URL; session: string; grant: string | null; loopback: boolean; reply: Reply; /** Review H2: the single-use proof from this page's own unlock reply. */ fresh?: string | null }

/** Large enough for a 64 KiB value or a `.env` file; still bounded and read as a stream. */
const BODY_LIMIT = 256 * 1024
/** Most secrets one batch delete may name. */
const BATCH_LIMIT = 200

/**
 * The binding a phone's gesture token carries for a batch: a short digest of the sorted ids (a token's target is
 * capped at 200 characters). FNV-1a/64 — not a secret, only a name; the token is single-use and session-bound.
 * The web page computes the same string (`batchBinding` in lib/vaultPersonal.ts; both tests pin one vector).
 */
export function batchBinding(ids: readonly string[]): string {
  let h = 0xcbf29ce484222325n
  for (const ch of [...ids].sort().join(',')) { h ^= BigInt(ch.charCodeAt(0)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn }
  return `batch:${ids.length}:${h.toString(16).padStart(16, '0')}`
}

const pt = () => vaultLang() === 'pt'
const fail = (code: string, en: string, ptText: string) => ({ ok: false as const, code, sentence: pt() ? ptText : en })
const bad = () => fail('bad-request', 'Bad request.', 'Requisição inválida.')
function storeFail(r: store.StoreFail) {
  switch (r.code) {
    case 'version-conflict': return { ...fail('version-conflict', 'This secret was changed somewhere else since you opened it. Reload and try again.', 'Este segredo foi alterado em outro lugar desde que você o abriu. Recarregue e tente de novo.'), version: r.version }
    case 'not-found': return fail('not-found', 'That secret no longer exists.', 'Esse segredo não existe mais.')
    case 'no-import': return fail('no-import', 'That import expired (10 minutes) or belongs to another window. Choose the file again.', 'Essa importação expirou (10 minutos) ou é de outra janela. Escolha o arquivo de novo.')
    case 'import-format':
      return r.reason === 'json-nested'
        ? fail('import-format', 'This JSON has objects or lists inside it. The import takes one flat object — {"NAME": "value", …} — so flatten it (one level, text values) and try again.', 'Este JSON tem objetos ou listas dentro. A importação aceita um objeto simples — {"NOME": "valor", …} — então deixe-o em um nível só, com valores de texto, e tente de novo.')
        : r.reason === 'json-not-object'
          ? fail('import-format', 'This JSON is not an object. Use {"NAME": "value", …}.', 'Este JSON não é um objeto. Use {"NOME": "valor", …}.')
          : fail('import-format', 'That file looks like JSON but cannot be read. Check for a missing quote or comma.', 'Esse arquivo parece JSON, mas não dá para ler. Confira se falta uma aspa ou vírgula.')
    default: return fail('record-unreadable', 'That secret could not be opened on this machine.', 'Esse segredo não pôde ser aberto nesta máquina.')
  }
}
const invalid = (field: string) => fail('invalid', `Check the field "${field}".`, `Confira o campo "${field}".`)

export async function handlePersonalHttp(c: PersonalHttpCtx): Promise<Response | null> {
  const { req, path, session, grant, loopback, reply } = c
  const fresh = c.fresh ?? null
  if (!path.startsWith('/api/vault/personal')) return null
  const body = async (): Promise<Record<string, unknown>> => {
    const r = await readJsonLimited<Record<string, unknown>>(req, BODY_LIMIT)
    return r.ok && r.value && typeof r.value === 'object' ? r.value : {}
  }
  const codeOf = (b: Record<string, unknown>) => (typeof b.code === 'string' && b.code.length <= 16 ? b.code : undefined)
  const ver = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : null)
  const tokenOf = (b: Record<string, unknown>) => (typeof b.gestureToken === 'string' && b.gestureToken.length <= 64 ? b.gestureToken : undefined)
  /** `binding` names the target a phone's gesture token was minted for (§7): a token for A never acts on B. */
  const step = (action: gate.VaultAction, b: Record<string, unknown>, binding = '') =>
    gate.requireVaultStepUp(action, { grant, session, loopback, fresh, code: codeOf(b), gestureToken: tokenOf(b), binding })
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
  if (path === '/api/vault/personal/mobile' && req.method === 'GET') {
    const g = await step('personal-list', {})
    if (!g.ok) return reply(g)
    return reply({ ok: true, ...(await mobile.mobileView()), loopback, secure: informationalSecure(req, c.url), ...withGrant(g) })
  }
  if (path === '/api/vault/personal/grants' && req.method === 'GET') {
    const g = await step('personal-list', {})
    if (!g.ok) return reply(g)
    return reply({ ok: true, grants: grants.listGrants().map(x => ({ sessionId: x.sessionId, createdAt: x.createdAt, refs: x.refs.map(r => ({ ref: r.ref, env: r.env, name: r.name, field: r.field })) })), ...withGrant(g) })
  }
  if (req.method !== 'POST') return null
  const b = await body()

  if (path === '/api/vault/personal') {
    const v = validateInput(b.item, { requireFields: true })
    if (!v.ok) return reply(invalid(v.field))
    const g = await step('personal-create', b)
    if (!g.ok) return reply(g)
    // Review M2: a secret born with "Sempre confirmar" OFF is the same act as turning it off later — it
    // costs the gesture once (personalText's "Turning it off needs Hello once"), never nothing.
    if (v.value.confirmEach === false) {
      const e = await step('personal-edit', b, 'new')
      if (!e.ok) return reply(e)
    }
    const r = await store.createItem(v.value)
    vaultAudit({ type: 'vault.personal-create', name: r.meta.id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/edit') {
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion)
    const v = validateInput(b.item, { requireFields: false })
    if (!ITEM_ID.test(id) || !ev) return reply(bad())
    if (!v.ok) return reply(invalid(v.field))
    const g = await step('personal-edit', b, id)
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
    const meta = await store.latestMeta(id)
    // "Só uso" (VAULT.UX-R2 item 11): sealed write-only — refused BEFORE any gesture is asked, for every
    // version (the newest record decides; sealing is irreversible), and audited as the refused attempt.
    if (meta && isUseOnly(meta)) {
      vaultAudit({ type: 'vault.personal-reveal-refused', name: id })
      return reply(fail('use-only',
        'This secret is "use only": sessions and providers can use it, but nobody can see or copy the value — not even you. To change it, use "Replace value".',
        'Este segredo é "só uso": sessões e provedores podem usá-lo, mas ninguém pode ver ou copiar o valor — nem você. Para trocá-lo, use "Substituir valor".'))
    }
    const g = await gate.requirePersonalReveal({ grant, session, loopback, fresh, code: codeOf(b), gestureToken: tokenOf(b), binding: `${id}:${field}` }, { confirm: meta ? needsConfirm(meta) : true })
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
    const g = await step(action, b, id)
    if (!g.ok) return reply(g)
    const r = await run(id, ev)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: audit, name: id })
    return reply({ ok: true, meta: r.meta, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/trash-batch') {
    // Deleting N secrets is ONE act: the proof 'personal-trash' asks is asked ONCE for the whole batch (a phone's
    // token is bound to the batch's digest), then each item is trashed on its own and reported on its own — one
    // stale version never aborts the rest.
    const raw = Array.isArray(b.items) ? b.items : []
    const items: { id: string; ev: number }[] = []
    for (const x of raw) {
      const o = x && typeof x === 'object' ? x as Record<string, unknown> : {}
      const id = typeof o.id === 'string' ? o.id : '', ev = ver(o.expectedVersion)
      if (!ITEM_ID.test(id) || !ev) return reply(bad())
      items.push({ id, ev })
    }
    if (items.length === 0 || items.length > BATCH_LIMIT || new Set(items.map(i => i.id)).size !== items.length) return reply(bad())
    const g = await step('personal-trash', b, batchBinding(items.map(i => i.id)))
    if (!g.ok) return reply(g)
    const results: Record<string, unknown>[] = []
    for (const it of items) {
      const r = await store.trashItem(it.id, it.ev)
      if (!r.ok) { const f = storeFail(r); results.push({ id: it.id, ok: false, code: f.code, sentence: f.sentence }); continue }
      vaultAudit({ type: 'vault.personal-trash', name: it.id })
      results.push({ id: it.id, ok: true, meta: r.meta })
    }
    return reply({ ok: true, results, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/restore-version') {
    const id = typeof b.id === 'string' ? b.id : '', ev = ver(b.expectedVersion), v = ver(b.version)
    if (!ITEM_ID.test(id) || !ev || !v) return reply(bad())
    const g = await step('personal-restore-version', b, id)
    if (!g.ok) return reply(g)
    const r = await store.restoreVersion(id, v, ev)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-restore-version', name: id })
    return reply({ ok: true, meta: r.meta })
  }
  if (path === '/api/vault/personal/purge') {
    const id = typeof b.id === 'string' ? b.id : ''
    if (!ITEM_ID.test(id)) return reply(bad())
    const g = await step('personal-purge', b, id)
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
    const g = await step('personal-group-delete', b, id)
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
    if (!r.ok) return reply(storeFail(r))
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
      const kind = typeof o.kind === 'string' && (PERSONAL_KINDS as readonly string[]).includes(o.kind) ? o.kind as PersonalKind : undefined
      const typeId = typeof o.typeId === 'string' && TYPE_ID.test(o.typeId) ? o.typeId : undefined
      return [{ key: o.key, action: o.action as 'import' | 'skip' | 'replace' | 'rename', ...(name ? { name } : {}), ...(kind ? { kind } : {}), ...(typeId && kind ? { typeId } : {}) }]
    }) : []
    if (!token) return reply(bad())
    const g = await step('personal-import-env', b)
    if (!g.ok) return reply(g)
    // Review M1: "replace" overwrites a stored secret's value — an edit, so it costs the edit's gesture
    // (once for the whole import). Importing new names and skipping still ask nothing more.
    if (choices.some(x => x.action === 'replace')) {
      const e = await step('personal-edit', b, 'import')
      if (!e.ok) return reply(e)
    }
    const r = await store.importCommit(token, session, choices, groupId, tags)
    if (!r.ok) return reply(storeFail(r))
    vaultAudit({ type: 'vault.personal-import' })
    return reply({ ok: true, created: r.created, replaced: r.replaced, skipped: r.skipped, ...withGrant(g) })
  }

  // ── §8 grants: which secrets a session's agent may USE (never see) ──
  if (path === '/api/vault/personal/grants') {
    const sid = typeof b.sessionId === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(b.sessionId) ? b.sessionId : ''
    const ids = Array.isArray(b.itemIds) ? b.itemIds.filter((x): x is string => typeof x === 'string' && ITEM_ID.test(x)).slice(0, 100) : []
    const gids = Array.isArray(b.groupIds) ? b.groupIds.filter((x): x is string => typeof x === 'string' && GROUP_ID.test(x)).slice(0, 50) : []
    if (!sid || (ids.length === 0 && gids.length === 0)) return reply(bad())
    // Per secret: any chosen secret with "Sempre confirmar" ON (the default) asks Hello/biometrics.
    const chosen = (await store.listItems()).filter(m => !m.deletedAt && (ids.includes(m.id) || (m.groupId !== null && gids.includes(m.groupId))))
    const g = await step(chosen.some(needsConfirm) ? 'personal-grant' : 'personal-grant-open', b, sid)
    if (!g.ok) return reply(g)
    const r = await grants.grantSession(sid, ids, gids)
    if (!r.ok) return reply(fail(r.code === 'grant-empty' ? 'grant-empty' : 'not-found', 'Nothing to grant: the chosen secrets no longer exist.', 'Nada a liberar: os segredos escolhidos não existem mais.'))
    for (const id of new Set(r.grant.refs.map(x => x.itemId))) vaultAudit({ type: 'vault.personal-grant', name: id })
    return reply({ ok: true, refs: r.grant.refs.map(x => ({ ref: x.ref, env: x.env, name: x.name, field: x.field })), briefing: grants.grantBriefing(r.grant, pt() ? 'pt' : 'en'), ...withGrant(g) })
  }
  if (path === '/api/vault/personal/grants/revoke') {
    const sid = typeof b.sessionId === 'string' ? b.sessionId : ''
    // Revoking only REDUCES exposure: the read grant (code once) is enough.
    const g = await step('personal-list', b)
    if (!g.ok) return reply(g)
    return reply({ ok: true, revoked: grants.revokeGrant(sid), ...withGrant(g) })
  }

  // ── backup: erase the vault's older bundles from the GitHub backup (code + gesture, fresh) ──
  if (path === '/api/vault/personal/backup/wipe-history') {
    const g = await step('personal-backup-wipe', b)
    if (!g.ok) return reply(g)
    const { wipeBundleHistoryNow } = await import('../backup/vault-bundle-github')
    const r = await wipeBundleHistoryNow(() => {})
    if (!r.ok) {
      return reply(r.reason === 'not-configured'
        ? fail('not-configured', 'This machine has no GitHub backup set up, so there is no history to erase.', 'Esta máquina não tem backup no GitHub configurado, então não há histórico para apagar.')
        : fail('wipe-failed', 'GitHub could not be reached to erase the history; nothing was deleted. Try again later.', 'Não deu para falar com o GitHub para apagar o histórico; nada foi apagado. Tente de novo mais tarde.'))
    }
    vaultAudit({ type: 'vault.bundle-wiped' })
    return reply({ ok: true, deleted: r.deleted, failed: r.failed })
  }

  // ── §7 the phone: passkeys and the opt-in code window ──
  const origin = req.headers.get('origin') ?? ''
  const rpId = c.url.hostname
  const secure = originMatchesRp(origin, rpId)
  const notSecure = () => fail('insecure-context',
    'Biometrics on this device need a secure address (https). Open Agentistics by its https address — for example with the HTTPS certificate of your Tailscale network — and try again.',
    'A digital neste aparelho precisa de um endereço seguro (https). Abra o Agentistics pelo endereço https — por exemplo com o certificado HTTPS da sua rede Tailscale — e tente de novo.')
  const desktopOnly = () => fail('desktop-only', 'Do this on the computer itself.', 'Faça isto no próprio computador.')
  if (path === '/api/vault/personal/mobile/register/begin') {
    if (!secure) return reply(notSecure())
    // VAULT.PERSONAL §10: an escalation in TWO halves on TWO devices — the phone asked with the code
    // (/api/vault/phone/enrol/request) and the computer approved it with Windows Hello. Without that
    // approval, bound to this session, there is nothing to register.
    const requestId = typeof b.requestId === 'string' ? b.requestId : ''
    const label = phone.approvalLabel(session, requestId, 'passkey')
    if (!label) return reply(fail('not-approved', 'The computer has not approved this phone yet (or the approval expired). Ask again and approve it on the computer.', 'O computador ainda não aprovou este celular (ou a aprovação expirou). Peça de novo e aprove no computador.'))
    return reply({ ok: true, options: { ...mobile.beginRegistration(session, rpId, origin, label), extensions: { prf: {} } } })
  }
  if (path === '/api/vault/personal/mobile/register/finish') {
    const requestId = typeof b.requestId === 'string' ? b.requestId : ''
    if (!phone.approvalLabel(session, requestId, 'passkey')) return reply(fail('not-approved', 'The approval for this phone expired. Ask again.', 'A aprovação deste celular expirou. Peça de novo.'))
    const r = await mobile.finishRegistration(session, b)
    if (!r.ok) return reply(passkeyFail(r.code))
    vaultAudit({ type: 'vault.personal-passkey-add' })
    // The next step asks the passkey for its PRF output, which becomes this phone's way to OPEN the vault.
    return reply({ ok: true, id: r.id, prf: phone.passkeyRegistered(session, requestId, r.id, rpId, origin) })
  }
  if (path === '/api/vault/personal/mobile/assert/begin') {
    if (!secure) return reply(notSecure())
    const action = typeof b.action === 'string' ? b.action : ''
    const target = typeof b.target === 'string' ? b.target.slice(0, 200) : ''
    if (!/^personal-(reveal|edit|trash|restore|restore-version|purge|group-delete|grant)$/.test(action)) return reply(bad())
    const g = await step('personal-list', b)
    if (!g.ok) return reply(g)
    const r = await mobile.beginAssertion(session, `${action}:${target}`, rpId, origin)
    if (!r.ok) return reply(fail('no-passkey', 'This device has no passkey registered for the vault yet.', 'Este aparelho ainda não tem uma passkey registrada para o cofre.'))
    return reply({ ok: true, challengeId: r.challengeId, challenge: r.challenge, allowCredentials: r.allowCredentials, rpId: r.rpId, ...withGrant(g) })
  }
  if (path === '/api/vault/personal/mobile/assert/finish') {
    const r = await mobile.finishAssertion(session, b)
    if (!r.ok) return reply(passkeyFail(r.code))
    return reply({ ok: true, gestureToken: r.gestureToken })
  }
  if (path === '/api/vault/personal/mobile/passkeys/remove') {
    if (!loopback) return reply(desktopOnly())
    const id = typeof b.id === 'string' ? b.id : ''
    const g = await step('mobile-passkey-remove', b)
    if (!g.ok) return reply(g)
    if (!(await mobile.removePasskey(id))) return reply(fail('not-found', 'That passkey is not registered.', 'Essa passkey não está registrada.'))
    vaultAudit({ type: 'vault.personal-passkey-remove' })
    return reply({ ok: true })
  }
  if (path === '/api/vault/personal/mobile/code-reveal') {
    if (!loopback) return reply(desktopOnly())
    if (typeof b.enabled !== 'boolean') return reply(bad())
    const g = await step('mobile-code-reveal', b)
    if (!g.ok) return reply(g)
    await mobile.setCodeReveal(b.enabled)
    vaultAudit({ type: 'vault.personal-code-reveal' })
    return reply({ ok: true, codeReveal: b.enabled })
  }
  return null
}

/** A passkey check that failed, in words — the code names WHICH check, for the log and the tests. */
function passkeyFail(code: string) {
  if (code === 'no-challenge') return fail('passkey-expired', 'That confirmation expired (60 seconds) or was already used. Try again.', 'Essa confirmação expirou (60 segundos) ou já foi usada. Tente de novo.')
  if (code === 'counter') return fail('passkey-clone', 'This passkey answered with an old counter, which is what a copied passkey does. It was refused.', 'Esta passkey respondeu com um contador antigo, que é o que uma passkey copiada faz. Ela foi recusada.')
  if (code === 'no-verification') return fail('passkey-no-uv', 'The phone did not confirm it was you (fingerprint, face or PIN). Try again.', 'O celular não confirmou que é você (digital, rosto ou PIN). Tente de novo.')
  return { ...fail('passkey-refused', 'The phone\'s confirmation could not be verified. Nothing was opened.', 'A confirmação do celular não pôde ser verificada. Nada foi aberto.'), check: code }
}

/** For the page: the kinds and their fields (no values, no secrets). */
export const PERSONAL_KIND_LIST: readonly PersonalKind[] = Object.keys(KIND_FIELDS) as PersonalKind[]
