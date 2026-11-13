/**
 * ENTREGA.GARANTIDA S0d.2 (QA F2, HIGH) — guards.json and guarantees.json are sealed. The QA attacks of
 * `s0b-tamper.ts` (T1 delete, T2 edit to off with no log, T3 edit to on with a forged owner log, T4 a forged rank-5
 * checkpoint) must each be DETECTED, fail closed and raise a WARN; never silently turn a rule off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GUARD_KEY_FILE, WITNESS_DIR, WITNESS_FILE, __resetGuardLatchForTests, canonicalJson, checkIntegrity, parseKeyFile, sealDoc, formatKeyFile, formatWitness } from './guard-integrity'
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
    expect(checkIntegrity(key, 'guarantees', JSON.stringify(doc))).toEqual({ state: 'ok', gen: 1 })
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
    expect(parseKeyFile(formatKeyFile(key))).toEqual({ ...key, macVerified: true })
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
  test('deleting the KEY while a document remains is key-missing', async () => {
    await ownerShadowsA()
    unlinkSync(kp())
    expect((await createGuaranteesStore(gp()).read()).tampered).toBe('key-missing')
  })
  // QA S0d security re-QA N1 (HIGH): deleting files WITHOUT reading the key must never turn the rules off in silence.
  describe('N1 deletions fail CLOSED with a WARN', () => {
    const wp = () => join(dir, WITNESS_DIR, WITNESS_FILE)
    test('K6: rm guarantees.json guards.json guard-integrity.key → tampered + WARN, every rule ON', async () => {
      await ownerShadowsA()
      unlinkSync(gp()); unlinkSync(join(dir, 'guards.json')); unlinkSync(kp())
      __resetGuardLatchForTests() // as after a restart: the witness alone says the set was sealed
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('key-missing'); expect(r.warn).toMatch(/guarantees-tampered/)
      expect(ruleState(r.doc, 'a')).toBe('on'); expect(ruleState(r.doc, 'b')).toBe('on')
    })
    test('K7: rm guarantees.json + key (guards.json stays) → guarantees tampered too, not "fresh"', async () => {
      await ownerShadowsA()
      unlinkSync(gp()); unlinkSync(kp())
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('key-missing'); expect(r.warn).toBeTruthy(); expect(ruleState(r.doc, 'a')).toBe('on')
    })
    test('K7 without the witness either: a sealed sibling with no key still proves a key existed', async () => {
      await ownerShadowsA()
      unlinkSync(gp()); unlinkSync(kp()); unlinkSync(wp())
      __resetGuardLatchForTests()
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('key-missing'); expect(ruleState(r.doc, 'a')).toBe('on')
    })
    test('K3b: the key\'s "sealed" line stripped + both documents deleted → the witness still says they were sealed', async () => {
      await ownerShadowsA()
      const k = parseKeyFile(readFileSync(kp(), 'utf8'))!
      writeFileSync(kp(), formatKeyFile({ key: k.key, sealed: new Set() }))
      unlinkSync(gp()); unlinkSync(join(dir, 'guards.json'))
      __resetGuardLatchForTests()
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('missing'); expect(ruleState(r.doc, 'a')).toBe('on')
    })
    test('deleting only the witness is tampered (witness-missing) for both documents', async () => {
      await ownerShadowsA()
      unlinkSync(wp())
      expect((await createGuaranteesStore(gp()).read()).tampered).toBe('witness-missing')
      expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('witness-missing')
    })
    test('all four deleted: the running process still remembers (latch) → missing; only a restart reads a fresh machine (stated limit)', async () => {
      await ownerShadowsA()
      await createGuaranteesStore(gp()).read()
      for (const f of [gp(), join(dir, 'guards.json'), kp(), wp()]) unlinkSync(f)
      const live = await createGuaranteesStore(gp()).read()
      expect(live.tampered).toBe('key-missing'); expect(ruleState(live.doc, 'a')).toBe('on')
      __resetGuardLatchForTests()
      const restarted = await createGuaranteesStore(gp()).read()
      expect(restarted.tampered).toBeUndefined(); expect(ruleState(restarted.doc, 'a')).toBe('off')
    })
    test('health WARNs the deletion', async () => {
      await ownerShadowsA()
      unlinkSync(gp()); unlinkSync(join(dir, 'guards.json')); unlinkSync(kp())
      __resetGuardLatchForTests()
      const issues: HealthIssue[] = []
      analyzeGuardIntegrity({ guaranteesWarn: (await createGuaranteesStore(gp()).read()).warn, offWarnings: [] }, issues)
      expect(issues.map(i => i.id)).toContain('guarantees-tampered')
    })
  })
  // QA S0d security re-QA N2 (MEDIUM): restoring an OLDER sealed copy (a valid MAC) is a rollback, detected and WARNed.
  describe('N2 rollback to an older sealed copy is detected', () => {
    async function toOn() {
      const store = await ownerShadowsA()
      const old = { g: readFileSync(gp(), 'utf8'), d: readFileSync(join(dir, 'guards.json'), 'utf8'), w: readFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), 'utf8') }
      expect(await store.setState('b', 'shadow', { check: owner, facts })).toEqual({ ok: true })
      return { store, old }
    }
    test('R1: BOTH documents back to the older sealed copy → rolled-back (after a restart too), rules not weakened', async () => {
      const { old } = await toOn()
      writeFileSync(gp(), old.g); writeFileSync(join(dir, 'guards.json'), old.d)
      __resetGuardLatchForTests()
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('rolled-back'); expect(r.warn).toMatch(/guarantees-tampered: rolled-back/)
      expect(ruleState(r.doc, 'b')).toBe('on') // guards is rolled back too → no trusted mirror → fail closed
      expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('rolled-back')
    })
    test('R2: only guarantees.json rolled back → rolled-back; the rules come from the newer sealed mirror', async () => {
      const { old } = await toOn()
      writeFileSync(gp(), old.g)
      __resetGuardLatchForTests()
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('rolled-back'); expect(ruleState(r.doc, 'b')).toBe('shadow')
    })
    test('R3/R4: only guards.json rolled back → guards refused (rolled-back)', async () => {
      const { old } = await toOn()
      writeFileSync(join(dir, 'guards.json'), old.d)
      __resetGuardLatchForTests()
      expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('rolled-back')
    })
    test('rolling back the witness too is still caught by the running process (latch); after a restart it is the stated limit', async () => {
      const { old } = await toOn()
      await createGuaranteesStore(gp()).read()
      writeFileSync(gp(), old.g); writeFileSync(join(dir, 'guards.json'), old.d); writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), old.w)
      expect((await createGuaranteesStore(gp()).read()).tampered).toBe('rolled-back')
    })
    // QA eg-integ W1: the three `.json` files restored together from a backup, then a restart. The key file is not a `.json`
    // and is excluded from backups, so its own generation record is the anchor the copy-back cannot reach.
    test('W1: guarantees.json + guards.json + witness.json restored from an older sealed copy, then a restart → rolled-back', async () => {
      const { old } = await toOn()
      writeFileSync(gp(), old.g); writeFileSync(join(dir, 'guards.json'), old.d); writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), old.w)
      __resetGuardLatchForTests()
      const r = await createGuaranteesStore(gp()).read()
      expect(r.tampered).toBe('rolled-back'); expect(r.warn).toMatch(/guarantees-tampered: rolled-back/)
      expect(ruleState(r.doc, 'b')).toBe('on') // no trusted mirror → fail closed
      expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('rolled-back')
    })
    test('W1b: the same copy-back with only guards.json + witness.json (guarantees untouched) is rolled-back for guards', async () => {
      const { old } = await toOn()
      writeFileSync(join(dir, 'guards.json'), old.d); writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), old.w)
      __resetGuardLatchForTests()
      expect(((await createGuardsStore(join(dir, 'guards.json')).read().catch(e => e)) as GuardsUnreadable).tampered).toBe('rolled-back')
    })
    test('W1c: the key file records the generations and health WARNs the copy-back', async () => {
      const { old, store } = await toOn()
      expect(parseKeyFile(readFileSync(kp(), 'utf8'))!.gens?.guarantees).toBeGreaterThanOrEqual(2)
      writeFileSync(gp(), old.g); writeFileSync(join(dir, 'guards.json'), old.d); writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), old.w)
      __resetGuardLatchForTests()
      const r = await store.read()
      expect(r.tampered).toBe('rolled-back')
      const issues: HealthIssue[] = []
      analyzeGuardIntegrity({ guaranteesWarn: r.warn, offWarnings: [] }, issues)
      expect(issues.map(i => i.id)).toContain('guarantees-tampered')
    })
    test('W1d: an OLD key file (no generation line, no mac) with an old witness still verifies; the next write upgrades it', async () => {
      await ownerShadowsA()
      const k = parseKeyFile(readFileSync(kp(), 'utf8'))!
      writeFileSync(kp(), `agentistics-guard-integrity v1\n${k.key.toString('base64')}\n${[...k.sealed].join(',')}\n`)
      const w = JSON.parse(readFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), 'utf8')) as { sealed: string[]; gens: Record<string, number> }
      writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), formatWitness(k.key, w.sealed as never, w.gens as never)) // no marker: written before r3
      __resetGuardLatchForTests()
      expect((await createGuaranteesStore(gp()).read()).tampered).toBeUndefined()
      await createGuaranteesStore(gp()).setState('b', 'shadow', { check: owner, facts })
      expect(readFileSync(kp(), 'utf8')).toMatch(/\nmac=/)
    })
    // r3 W1′: the 4th line (the generation marks) was outside any MAC, so restoring the 3 documents from a backup and then
    // deleting or lowering that line with a text editor passed silently. The key file now carries a MAC over its sealed list +
    // gens line, and the witness records that the key is MAC'd (so deleting the mac line is a downgrade, not an "old file").
    describe('W1′ the generation line is bound', () => {
      async function backupRestored() {
        const { old } = await toOn()
        writeFileSync(gp(), old.g); writeFileSync(join(dir, 'guards.json'), old.d); writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), old.w)
        return old
      }
      const verdict = async () => { __resetGuardLatchForTests(); return (await createGuaranteesStore(gp()).read()).tampered }
      test('baseline: the key file carries a mac line over the gens', async () => {
        await toOn()
        expect(readFileSync(kp(), 'utf8')).toMatch(/guarantees=\d+.*\nmac=\S+\n$/s)
      })
      test('K1: the gens line deleted (mac line kept) → the key is refused', async () => {
        await backupRestored()
        writeFileSync(kp(), readFileSync(kp(), 'utf8').split('\n').filter((l, i) => i !== 3).join('\n'))
        expect(await verdict()).toBe('key-unreadable')
      })
      test('K2: the gens LOWERED to the backup\'s values (mac kept) → refused', async () => {
        const old = await backupRestored()
        const lines = readFileSync(kp(), 'utf8').split('\n')
        const oldG = JSON.parse(old.g).integrity.gen as number, oldD = JSON.parse(old.d).integrity.gen as number
        lines[3] = `guards=${oldD},guarantees=${oldG}`
        writeFileSync(kp(), lines.join('\n'))
        expect(await verdict()).toBe('key-unreadable')
      })
      test('K3: gens line AND mac line deleted (the "old format" downgrade) → rolled-back, via the witness marker', async () => {
        await backupRestored()
        const lines = readFileSync(kp(), 'utf8').split('\n')
        writeFileSync(kp(), `${lines[0]}\n${lines[1]}\n${lines[2]}\n`)
        // the restored witness is the BACKUP's (taken after the first r3 write, so it carries the marker)
        expect(await verdict()).toBe('rolled-back')
      })
      test('K4: lowering the gens and recomputing nothing else keeps the mac wrong even when only the sealed list is touched', async () => {
        await toOn()
        const lines = readFileSync(kp(), 'utf8').split('\n')
        lines[2] = 'guarantees'
        writeFileSync(kp(), lines.join('\n'))
        expect(await verdict()).toBe('key-unreadable')
      })
      test('an honest restart and ordinary writes still read clean', async () => {
        await toOn()
        expect(await verdict()).toBeUndefined()
      })
    })
    test('a forged witness (edited generation) is tampered', async () => {
      await toOn()
      const w = JSON.parse(readFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), 'utf8')); w.gens.guarantees = 0
      writeFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), JSON.stringify(w))
      __resetGuardLatchForTests()
      expect((await createGuaranteesStore(gp()).read()).tampered).toBe('witness-forged')
    })
    test('stripping the generation from a sealed doc breaks its MAC (forged, not an old v1 doc)', async () => {
      await toOn()
      const g = JSON.parse(readFileSync(gp(), 'utf8')); delete g.integrity.gen
      writeFileSync(gp(), JSON.stringify(g))
      expect((await createGuaranteesStore(gp()).read()).tampered).toBe('forged')
    })
    test('ordinary writes keep reading clean (no false rollback) and the generation only grows', async () => {
      const { store } = await toOn()
      expect(await store.setState('a', 'off', { check: owner, facts })).toEqual({ ok: true })
      __resetGuardLatchForTests()
      const r = await store.read(); expect(r.tampered).toBeUndefined(); expect(ruleState(r.doc, 'a')).toBe('off')
      const gen = (f: string) => JSON.parse(readFileSync(f, 'utf8')).integrity.gen
      expect(gen(gp())).toBe(3); expect(JSON.parse(readFileSync(join(dir, WITNESS_DIR, WITNESS_FILE), 'utf8')).gens.guarantees).toBe(3)
      expect(statSync(join(dir, WITNESS_DIR, WITNESS_FILE)).mode & 0o777).toBe(0o600)
    })
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
