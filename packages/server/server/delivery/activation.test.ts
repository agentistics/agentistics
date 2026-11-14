import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RULE_IDS, createGuaranteesStore, guaranteeWarnings, parseGuarantees, restoreStatusStages, ruleState,
  type ActivationFacts, type OwnerCheck,
} from './activation'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'guarantees-')); file = join(dir, 'guarantees.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = '2026-11-13T00:00:00.000Z'
const owner: OwnerCheck = async () => ({ ok: true, via: 'vault-credential' })
const browserOwner: OwnerCheck = async () => ({ ok: true, via: 'legacy-browser' })
const notOwner: OwnerCheck = async () => ({ ok: false, code: 'owner_required' })
const unproven: OwnerCheck = async () => ({ ok: false, code: 'owner_proof_required' })

const facts = (over: Partial<ActivationFacts> = {}): ActivationFacts => ({
  now: T0, build: 'v2.211.0', capabilities: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'],
  migrated: ['a', 'b', 'c', 'd'], unexplainedWouldRefuse: 0, ...over,
})

describe('absent = off (spec §2.7, review r2 N2)', () => {
  test('no file: every rule is off, no warning, and READING creates nothing', async () => {
    const store = createGuaranteesStore(file)
    const { doc, warn } = await store.read()
    expect(warn).toBeUndefined()
    for (const r of RULE_IDS) expect(ruleState(doc, r)).toBe('off')
    expect(existsSync(file)).toBe(false)
  })
  test('an absent rule entry is off; a rule entry with a junk state is off', () => {
    const { doc } = parseGuarantees(JSON.stringify({ rules: { a: { state: 'on', build: 'x' }, b: { state: 'maybe', build: 'x' }, c: 7 } }))
    expect(ruleState(doc, 'a')).toBe('on')
    expect(ruleState(doc, 'b')).toBe('off')
    expect(ruleState(doc, 'c')).toBe('off')
    expect(ruleState(doc, 'd')).toBe('off')
  })
  test('an unparseable file is off for every rule WITH a warning naming the file', async () => {
    writeFileSync(file, '{ not json')
    const { doc, warn } = await createGuaranteesStore(file).read()
    for (const r of RULE_IDS) expect(ruleState(doc, r)).toBe('off')
    expect(warn).toContain('guarantees.json')
  })
  test('S0d.2: an unparseable file is TAMPERED — a non-owner changes nothing; the owner\'s proven move re-seals it and keeps a copy of the bytes', async () => {
    writeFileSync(file, '{ not json')
    expect(await createGuaranteesStore(file).setState('a', 'shadow', { check: notOwner, facts: facts() })).toEqual({ ok: false, code: 'owner_required' })
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    const r = await createGuaranteesStore(file).setState('a', 'shadow', { check: owner, facts: facts() })
    expect(r).toEqual({ ok: true })
    expect(readFileSync(`${file}.unreadable.bak`, 'utf8')).toBe('{ not json')
    const after = await createGuaranteesStore(file).read()
    expect(after.tampered).toBeUndefined(); expect(ruleState(after.doc, 'a')).toBe('shadow')
  })
})

describe('off / shadow / activate are OWNER-ONLY moves (principal stubbed behind an interface)', () => {
  test('a non-owner is refused and nothing is written, for every move', async () => {
    const store = createGuaranteesStore(file)
    for (const to of ['shadow', 'off', 'on'] as const) {
      const r = await store.setState('a', to, { check: notOwner, facts: facts() })
      expect(r).toEqual({ ok: false, code: 'owner_required' })
    }
    expect(existsSync(file)).toBe(false)
  })
  test('an owner whose proof is unavailable is refused with the proof code', async () => {
    const r = await createGuaranteesStore(file).setState('a', 'shadow', { check: unproven, facts: facts() })
    expect(r).toEqual({ ok: false, code: 'owner_proof_required' })
    expect(existsSync(file)).toBe(false)
  })
  test('the owner check receives the move, so a grant can be scoped to it', async () => {
    const seen: unknown[] = []
    await createGuaranteesStore(file).setState('b', 'shadow', { check: async m => { seen.push(m); return { ok: true, via: 'vault-credential' } }, facts: facts() })
    expect(seen).toEqual([{ rule: 'b', from: 'off', to: 'shadow' }])
  })
  test('shadow by an owner is recorded with who/how/when/build, mode 0600', async () => {
    const store = createGuaranteesStore(file)
    const r = await store.setState('a', 'shadow', { check: owner, facts: facts() })
    expect(r.ok).toBe(true)
    const { doc } = await store.read()
    expect(doc.rules.a).toEqual({ state: 'shadow', since: T0, build: 'v2.211.0' })
    expect(doc.log?.at(-1)).toMatchObject({ rule: 'a', from: 'off', to: 'shadow', via: 'vault-credential', at: T0 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  test('a legacy-browser owner may move a rule too, and the via is what gets logged', async () => {
    const store = createGuaranteesStore(file)
    await store.setState('a', 'shadow', { check: browserOwner, facts: facts() })
    expect((await store.read()).doc.log?.at(-1)?.via).toBe('legacy-browser')
  })
})

describe('activate refuses unless the three prerequisites hold (§2.7)', () => {
  const shadowedLongAgo = async (rule: 'a' | 'b' | 'c' | 'd' = 'a') => {
    const store = createGuaranteesStore(file)
    await store.setState(rule, 'shadow', { check: owner, facts: facts({ now: '2026-11-10T00:00:00.000Z' }) })
    return store
  }
  test('not in shadow first → refused (a rule never jumps off → on)', async () => {
    const r = await createGuaranteesStore(file).setState('a', 'on', { check: owner, facts: facts() })
    expect(r).toEqual({ ok: false, code: 'shadow_required' })
  })
  test('shadow shorter than 24 h → refused', async () => {
    const store = createGuaranteesStore(file)
    await store.setState('a', 'shadow', { check: owner, facts: facts({ now: '2026-11-12T12:00:00.000Z' }) })
    const r = await store.setState('a', 'on', { check: owner, facts: facts({ now: '2026-11-13T11:59:59.000Z' }) })
    expect(r).toEqual({ ok: false, code: 'shadow_too_short' })
    expect((await store.setState('a', 'on', { check: owner, facts: facts({ now: '2026-11-13T12:00:00.000Z' }) })).ok).toBe(true)
  })
  test('unexplained would_refuse in the shadow week → refused', async () => {
    const store = await shadowedLongAgo()
    expect(await store.setState('a', 'on', { check: owner, facts: facts({ unexplainedWouldRefuse: 2 }) }))
      .toEqual({ ok: false, code: 'unexplained_would_refuse' })
  })
  test('a capability the build does not declare → refused, naming it', async () => {
    const store = await shadowedLongAgo()
    const r = await store.setState('a', 'on', { check: owner, facts: facts({ capabilities: ['S0', 'S1', 'S2'] }) })
    expect(r).toEqual({ ok: false, code: 'prerequisite_capability', missing: ['S3'] })
  })
  test('the rule\'s migration has not run → refused', async () => {
    const store = await shadowedLongAgo()
    expect(await store.setState('a', 'on', { check: owner, facts: facts({ migrated: [] }) })).toEqual({ ok: false, code: 'migration_missing' })
  })
  test('rule b needs rule a already on', async () => {
    const store = await shadowedLongAgo('b')
    expect(await store.setState('b', 'on', { check: owner, facts: facts() })).toEqual({ ok: false, code: 'prerequisite_rule', missing: ['a'] })
  })
  test('rule d has no write guard: capability S8 is its only prerequisite (no shadow week, no migration)', async () => {
    const store = createGuaranteesStore(file)
    expect((await store.setState('d', 'on', { check: owner, facts: facts({ migrated: [], capabilities: [] }) })).ok).toBe(false)
    expect((await store.setState('d', 'on', { check: owner, facts: facts({ migrated: [], capabilities: ['S8'] }) })).ok).toBe(true)
  })
  test('all prerequisites met → on, with the build that turned it on', async () => {
    const store = await shadowedLongAgo()
    const r = await store.setState('a', 'on', { check: owner, facts: facts() })
    expect(r.ok).toBe(true)
    expect(ruleState((await store.read()).doc, 'a')).toBe('on')
  })
  test('the owner check comes first, so a stranger learns nothing about prerequisites', async () => {
    const r = await createGuaranteesStore(file).setState('a', 'on', { check: notOwner, facts: facts({ capabilities: [] }) })
    expect(r).toEqual({ ok: false, code: 'owner_required' })
  })
})

describe('the escape: off at any time, and it is loud until the rule is back on', () => {
  test('off from on works, logs, and raises guarantee-off naming the command to undo it', async () => {
    const store = createGuaranteesStore(file)
    await store.setState('a', 'shadow', { check: owner, facts: facts({ now: '2026-11-10T00:00:00.000Z' }) })
    await store.setState('a', 'on', { check: owner, facts: facts() })
    expect(guaranteeWarnings((await store.read()).doc)).toEqual([])
    await store.setState('a', 'off', { check: browserOwner, facts: facts() })
    const { doc } = await store.read()
    expect(ruleState(doc, 'a')).toBe('off')
    expect(guaranteeWarnings(doc)).toEqual(['guarantee-off: a, by legacy-browser'])
  })
  test('a never-touched rule raises nothing; going back to shadow clears it', async () => {
    const store = createGuaranteesStore(file)
    expect(guaranteeWarnings((await store.read()).doc)).toEqual([])
    await store.setState('b', 'off', { check: owner, facts: facts() })
    expect(guaranteeWarnings((await store.read()).doc)).toEqual(['guarantee-off: b, by vault-credential'])
    await store.setState('b', 'shadow', { check: owner, facts: facts() })
    expect(guaranteeWarnings((await store.read()).doc)).toEqual([])
  })
  test('the log is capped, not unbounded', async () => {
    const store = createGuaranteesStore(file)
    for (let i = 0; i < 230; i++) await store.setState('a', i % 2 ? 'shadow' : 'off', { check: owner, facts: facts() })
    expect((await store.read()).doc.log!.length).toBeLessThanOrEqual(200)
  })
})

describe('statusStages mirror (the copy an older writer cannot erase)', () => {
  test('mirror writes status→stage and keeps rule state', async () => {
    const store = createGuaranteesStore(file)
    await store.setState('a', 'shadow', { check: owner, facts: facts() })
    await store.writeStatusStages([{ id: 'todo', stage: 'queue' }, { id: 'in_progress', stage: 'running' }, { id: 'legacy' }])
    const { doc } = await store.read()
    expect(doc.statusStages).toEqual({ todo: 'queue', in_progress: 'running' })
    expect(ruleState(doc, 'a')).toBe('shadow')
  })
  test('restoreStatusStages re-applies the mirror only where the stage is missing, and reports what it restored', () => {
    const r = restoreStatusStages(
      [{ id: 'todo' }, { id: 'in_progress', stage: 'adjust' }, { id: 'published' }, { id: 'new' }],
      { todo: 'queue', in_progress: 'running', published: 'published' },
    )
    expect(r.statuses).toEqual([{ id: 'todo', stage: 'queue' }, { id: 'in_progress', stage: 'adjust' }, { id: 'published', stage: 'published' }, { id: 'new' }])
    expect(r.restored).toEqual(['todo', 'published'])
  })
  test('a mirror naming an unknown stage is ignored, never applied', () => {
    const r = restoreStatusStages([{ id: 'todo' }], { todo: 'warp-speed' })
    expect(r.statuses).toEqual([{ id: 'todo' }])
    expect(r.restored).toEqual([])
  })
})
