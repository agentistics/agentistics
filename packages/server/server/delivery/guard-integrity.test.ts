/**
 * ENTREGA.GARANTIDA S0d.2 (QA F2, HIGH) — guards.json and guarantees.json are sealed. The QA attacks of
 * `s0b-tamper.ts` (T1 delete, T2 edit to off with no log, T3 edit to on with a forged owner log, T4 a forged rank-5
 * checkpoint) must each be DETECTED, fail closed and raise a WARN; never silently turn a rule off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUARD_KEY_FILE, canonicalJson, checkIntegrity, parseKeyFile, sealDoc, formatKeyFile } from './guard-integrity'
import { createGuaranteesStore, guaranteeWarnings, ruleState, rulesWhenTampered, type ActivationFacts, type OwnerCheck } from './activation'
import { GuardsUnreadable, applyGuardedWrite, createGuardsStore, type PieceCheckpoint } from './guards-store'
import { analyzeGuardIntegrity } from './owner-health'
import type { HealthIssue } from '@agentistics/core'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guard-integrity-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const gp = () => join(dir, 'guarantees.json')
const kp = () => join(dir, GUARD_KEY_FILE)
const owner: OwnerCheck = async () => ({ ok: true, via: 'vault-credential' })
const facts: ActivationFacts = { now: '2026-11-13T10:00:00.000Z', build: 'test', capabilities: ['S0', 'S1', 'S2', 'S3'], migrated: ['a'], unexplainedWouldRefuse: 0 }
const forged: PieceCheckpoint = {
  key: 's-forged', rank: 5, boardStatus: 'done', boardStage: 'published', phase: 'publicado', revision: 1, headSha: null,
  auth: [{ kind: 'owner', via: 'vault-credential', grantIdHash: 'f'.repeat(64) }], by: { kind: 'owner', via: 'vault-credential', grantId: 'forged' },
  at: facts.now, transitionId: 'tr-forged',
}
async function ownerShadowsA() {
  const store = createGuaranteesStore(gp())
  expect(await store.setState('a', 'shadow', { check: owner, facts })).toEqual({ ok: true })
  return store
}

describe('the seal (pure)', () => {
  const key = { key: Buffer.alloc(32, 3), sealed: new Set(['guards', 'guarantees'] as const) }
  test('canonical JSON ignores key order', () => expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 })))
  test('a sealed doc verifies; one changed byte, a doc without its seal, or the other file\'s seal do not', () => {
    const doc = sealDoc(key.key, 'guarantees', { rules: { a: { state: 'shadow', build: 'x' } } })
    expect(checkIntegrity(key, 'guarantees', JSON.stringify(doc))).toEqual({ state: 'ok' })
    expect(checkIntegrity(key, 'guarantees', JSON.stringify({ ...doc, rules: { a: { state: 'on', build: 'x' } } }))).toEqual({ state: 'tampered', reason: 'forged' })
    expect(checkIntegrity(key, 'guarantees', JSON.stringify({ rules: {} }))).toEqual({ state: 'tampered', reason: 'unsealed' })
    expect(checkIntegrity(key, 'guarantees', 'not json')).toEqual({ state: 'tampered', reason: 'unsealed' })
    expect(checkIntegrity(key, 'guards', JSON.stringify(doc))).toEqual({ state: 'tampered', reason: 'forged' }) // swapped files
  })
  test('absent: fresh unless the key says it was sealed; present with no key: key-missing', () => {
    expect(checkIntegrity(null, 'guards', null)).toEqual({ state: 'fresh' })
    expect(checkIntegrity({ key: key.key, sealed: new Set() }, 'guards', null)).toEqual({ state: 'fresh' })
    expect(checkIntegrity(key, 'guards', null)).toEqual({ state: 'tampered', reason: 'missing' })
    expect(checkIntegrity(null, 'guards', '{}')).toEqual({ state: 'tampered', reason: 'key-missing' })
  })
  test('the key file round-trips and refuses junk', () => {
    expect(parseKeyFile(formatKeyFile(key))).toEqual(key)
    expect(parseKeyFile('nope')).toBeNull()
    expect(parseKeyFile(formatKeyFile(key).replace('guards,', 'gards,'))).toBeNull()
  })
  test('rulesWhenTampered: mirror wins; no mirror = never moved = off; guards tampered too = on (fail closed)', () => {
    expect(rulesWhenTampered({ rules: { a: 'shadow' } })).toEqual({ a: { state: 'shadow', build: '' } })
    expect(rulesWhenTampered({})).toEqual({})
    expect(Object.values(rulesWhenTampered('tampered')).map(e => e!.state)).toEqual(['on', 'on', 'on', 'on'])
  })
})

describe('QA s0b-tamper.ts against the real stores', () => {
  test('writes are sealed, 0600, and the key is 0600', async () => {
    await ownerShadowsA()
    expect(JSON.parse(readFileSync(gp(), 'utf8')).integrity).toMatchObject({ v: 1, mac: expect.any(String) })
    expect(JSON.parse(readFileSync(join(dir, 'guards.json'), 'utf8'))).toMatchObject({ rules: { a: 'shadow' }, integrity: { v: 1 } })
    expect(statSync(kp()).mode & 0o777).toBe(0o600)
    expect(statSync(gp()).mode & 0o777).toBe(0o600)
  })
  test('T1 DELETE guarantees.json → rule a stays shadow (sealed mirror) with a WARN — never silently off', async () => {
    const store = await ownerShadowsA()
    unlinkSync(gp())
    const r = await store.read()
    expect(ruleState(r.doc, 'a')).toBe('shadow')
    expect(r.tampered).toBe('missing')
    expect(r.warn).toMatch(/guarantees-tampered: missing/)
  })
  test('T2 EDIT a→off with no log → not believed: shadow + WARN', async () => {
    const store = await ownerShadowsA()
    writeFileSync(gp(), JSON.stringify({ rules: { a: { state: 'off', build: 'qa' } } }))
    const r = await store.read()
    expect(ruleState(r.doc, 'a')).toBe('shadow'); expect(r.tampered).toBe('unsealed')
  })
  test('T3 EDIT a→on with a forged owner log (even carrying the old seal) → not believed', async () => {
    const store = await ownerShadowsA()
    const j = JSON.parse(readFileSync(gp(), 'utf8'))
    writeFileSync(gp(), JSON.stringify({ ...j, rules: { a: { state: 'on', since: '2020-01-01T00:00:00Z', build: 'qa' } }, log: [{ rule: 'a', from: 'shadow', to: 'on', via: 'vault-credential', at: '2020-01-01T00:00:00Z' }] }))
    const r = await store.read()
    expect(ruleState(r.doc, 'a')).toBe('shadow'); expect(r.tampered).toBe('forged'); expect(r.doc.log).toBeUndefined()
    // a non-owner cannot use the tamper to move anything; a mere stage mirror write refuses
    expect(await store.setState('a', 'off', { check: async () => ({ ok: false, code: 'owner_proof_required' }), facts })).toEqual({ ok: false, code: 'owner_proof_required' })
    await expect(store.writeStatusStages([{ id: 'todo', stage: 'queued' }])).rejects.toThrow(/tampered/)
  })
  test('T4 a forged rank-5 checkpoint planted in guards.json is refused (GuardsUnreadable, tampered)', async () => {
    await ownerShadowsA()
    const g = JSON.parse(readFileSync(join(dir, 'guards.json'), 'utf8'))
    writeFileSync(join(dir, 'guards.json'), JSON.stringify({ ...g, checkpoints: { 's-forged': forged } }))
    const store = createGuardsStore(join(dir, 'guards.json'))
    const err = await store.read().catch(e => e)
    expect(err).toBeInstanceOf(GuardsUnreadable); expect((err as GuardsUnreadable).tampered).toBe('forged')
    // and a guarded write refuses rather than building on it
    await expect(applyGuardedWrite({ locks: ['guards'], paths: { tasks: join(dir, 't.json'), deliveries: join(dir, 'd.json'), guards: join(dir, 'guards.json') }, piece: 'p', target: { ...forged, key: 'p' }, now: facts.now, writeDocuments: async () => undefined })).rejects.toBeInstanceOf(GuardsUnreadable)
    // with guards.json untrustworthy too, a tampered guarantees.json reads every rule ON
    unlinkSync(gp())
    const r = await createGuaranteesStore(gp()).read()
    expect(RULE_STATES(r.doc)).toEqual(['on', 'on', 'on', 'on'])
  })
  test('a guards.json written by hand from scratch (no seal) and a deleted guards.json are tampered, not "empty"', async () => {
    await ownerShadowsA()
    writeFileSync(join(dir, 'guards.json'), JSON.stringify({ version: 1, checkpoints: {}, intents: {} }))
    expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('unsealed')
    unlinkSync(join(dir, 'guards.json'))
    expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('missing')
  })
  test('deleting the KEY while a document remains is key-missing; deleting key + both documents is a fresh machine (stated limit)', async () => {
    await ownerShadowsA()
    unlinkSync(kp())
    expect((await createGuaranteesStore(gp()).read()).tampered).toBe('key-missing')
    unlinkSync(gp()); unlinkSync(join(dir, 'guards.json'))
    const r = await createGuaranteesStore(gp()).read()
    expect(r.tampered).toBeUndefined(); expect(ruleState(r.doc, 'a')).toBe('off')
  })
  test('the OWNER repairs a tampered guarantees.json by moving a rule: re-sealed from the effective state', async () => {
    const store = await ownerShadowsA()
    unlinkSync(gp())
    expect(await store.setState('b', 'shadow', { check: owner, facts })).toEqual({ ok: true })
    const r = await store.read()
    expect(r.tampered).toBeUndefined(); expect(ruleState(r.doc, 'a')).toBe('shadow'); expect(ruleState(r.doc, 'b')).toBe('shadow')
  })
  test('a fresh machine: no file, no key, nothing written by a read', async () => {
    const r = await createGuaranteesStore(gp()).read()
    expect(r).toEqual({ doc: { rules: {} } })
    expect(existsSync(kp())).toBe(false)
  })
  test('GET /api/deliveries/integrity (and the MCP vault status) reports the tamper', async () => {
    const before = process.env.AGENTISTICS_TASKS_FILE
    process.env.AGENTISTICS_TASKS_FILE = join(dir, 'tasks.json')
    try {
      await ownerShadowsA()
      writeFileSync(gp(), JSON.stringify({ rules: { a: { state: 'off', build: 'qa' } } }))
      const { deliveryIntegrity } = await import('./integrity-status')
      const r = await deliveryIntegrity()
      expect(r.guarantees).toEqual({ rules: { a: 'shadow', b: 'off', c: 'off', d: 'off' }, tampered: 'unsealed' })
      expect(r.guards).toEqual({})
      expect(['legacy', 'required']).toContain(r.ownerProof.mode)
    } finally { if (before === undefined) delete process.env.AGENTISTICS_TASKS_FILE; else process.env.AGENTISTICS_TASKS_FILE = before }
  })
  test('health WARNs each tamper and every owner-off rule', async () => {
    const issues: HealthIssue[] = []
    analyzeGuardIntegrity({ guaranteesWarn: 'guarantees-tampered: missing', guardsTamper: 'forged', offWarnings: ['guarantee-off: a, by vault-credential'] }, issues)
    expect(issues.map(i => i.id)).toEqual(['guards-tampered', 'guarantees-tampered', 'guarantee-off:a'])
    const none: HealthIssue[] = []
    analyzeGuardIntegrity({ offWarnings: guaranteeWarnings({ rules: {} }) }, none)
    expect(none).toEqual([])
  })
})

const RULE_STATES = (doc: Parameters<typeof ruleState>[0]) => (['a', 'b', 'c', 'd'] as const).map(r => ruleState(doc, r))
