/** Mutation controls run real store/restore/lint probes in a disposable source copy, never edit this checkout. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { missingContextSites } from './guard-sites.testing'

const repo = resolve(import.meta.dir, '../../../..')
const delivery = 'packages/server/server/delivery/'
const tasks = 'packages/server/server/sessions/task-store.ts'
const restore = 'packages/server/server/backup/restore.ts'
let root: string
const originals = new Map<string, string>()
const files = [delivery + 'guard-host.ts', delivery + 'guard.ts', delivery + 'store.ts', delivery + 'guard-sites.testing.ts', delivery + 'guard-inventory.fixture.json', tasks, restore,
  delivery + 'guard-transaction.ts', delivery + 'activation.ts', delivery + 'guard-ast.testing.ts', delivery + 'guard-inventory-r3.fixture.json', delivery + 'service.ts', delivery + 'guard-modules.fixture.json', delivery + 'lint-scan.testing.ts', delivery + 'guard-helpers.fixture.json', delivery + 'guard-inventory.testing.ts', delivery + 'web.ts', delivery + 'machine.ts']
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-mutants-'))
  cpSync(join(repo, 'packages'), join(root, 'packages'), { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', 'dist', 'target', '.git'].includes(s)) })
  cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true })
  for (const f of ['tsconfig.json', 'bunfig.toml', 'package.json']) cpSync(join(repo, f), join(root, f))
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const pkg of readdirSync(join(repo, 'packages'))) {
    const deps = join(repo, 'packages', pkg, 'node_modules')
    if (existsSync(deps)) symlinkSync(deps, join(root, 'packages', pkg, 'node_modules'), 'dir')
  }
  mkdirSync(join(root, 'home'))
  for (const f of files) originals.set(f, readFileSync(join(root, f), 'utf8'))
})
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function reset() { for (const [f, src] of originals) writeFileSync(join(root, f), src) }
function change(file: string, from: string, to: string) {
  const src = readFileSync(join(root, file), 'utf8')
  expect(src.includes(from), `${file}: mutation anchor`).toBe(true)
  writeFileSync(join(root, file), src.replace(from, to))
}
async function run(targets: string[], pattern?: string) {
  const child = Bun.spawn([process.execPath, 'test', ...targets, ...(pattern ? ['--test-name-pattern', pattern] : [])], {
    cwd: root, env: { ...process.env, HOME: join(root, 'home'), AGENTISTICS_DIR: join(root, 'data') }, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 90_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output: stdout + stderr }
  } finally { clearTimeout(timer) }
}
const storeTest = delivery + 'guard-store.test.ts'
const r5Test = delivery + 'guard-r5.test.ts'
const r6Test = delivery + 'guard-r6.test.ts'

const r6Mutants: Array<[string, string, string, string, string]> = [
  ['R5-1 activation', delivery + 'activation.ts', 'g = await rollForwardDelivery(paths.deliveries, guards, g)', 'void g', 'J1/J2'],
  ['R5-1 N1', delivery + 'store.ts', 'if (guardDoc.pendingDelivery !== undefined) {', 'if (false && guardDoc.pendingDelivery !== undefined) {', 'N1 OFF writer'],
  ['R5-1 N2', delivery + 'store.ts', 'await floorStore.write(committed)', 'void committed', 'N1 OFF writer'],
  ['R5-2 reconciliation', delivery + 'activation.ts', "if (rule === 'a' && from === 'off' && to === 'shadow') {", 'if (false) {', 'R1 OFF restore'],
  ['R5-2 unchanged', delivery + 'store.ts', 'if (JSON.stringify(before) === JSON.stringify(after)) return false', '', 'floors judge only'],
  ['R5-2 downgrade', delivery + 'store.ts', 'if (before && after && after.phase !== before.phase && phaseRank(after.phase) <= phaseRank(before.phase)) return false', '', 'floors judge only'],
  ['R5-3 fallback', delivery + 'store.ts', "catch (e) { console.warn('[guard] delivery read falls back to ledger:'", "catch (e) { throw e; console.warn('[guard] delivery read falls back to ledger:'", 'J3 unreadable'],
  ['R5-4 eval', delivery + 'guard-ast.testing.ts', "if (ts.isIdentifier(n) && n.text === 'eval') out.push('eval')", '', 'eval references'],
  ['R5-4 vm', delivery + 'guard-ast.testing.ts', "out.push('module:vm')", 'void n', 'eval references'],
  ['R5-4 loaders', delivery + 'guard-ast.testing.ts', 'const receiver = unwrap(e.expression).getText()', "return false; const receiver = unwrap(e.expression).getText()", 'module loaders'],
  ['R5-4 receivers', delivery + 'guard-ast.testing.ts', '/^(global|globalThis|self|Bun)$/', '/^(globalThis|Bun)$/', 'eval references'],
  ['R5-5 N3', delivery + 'guard-inventory.testing.ts', 'while (changed) {\n    changed = false', 'for (let once = 0; once < 1; once++) {\n    changed = false', 'N3 two-step'],
  ['R5-5 N4', tasks, 'if ([...before.statuses, ...book.statuses].some(s => !isStatusStage(s.stage))) {', 'if (before.statuses.some(s => !isStatusStage(s.stage))) {', 'N4 stripping'],
  ['R5-5 N5', delivery + 'guard-ast.testing.ts', '|| ts.isNonNullExpression(e) ', '', 'eval references'],
  ['OFF cost', delivery + 'activation.ts', 'if (cached?.stamp === stamp) return cached.state', '', 'OFF reads use'],
]
for (const [id, file, from, to, pattern] of r6Mutants) test(`r6 mutant ${id} is killed`, async () => {
  reset(); change(file, from, to)
  const r = await run([r6Test], pattern)
  console.log(`${id}: exit ${r.code}\n${r.output.split('\n').filter(l => /\(fail\)|Expected:|Received:| pass| fail/.test(l)).join('\n')}`)
  expect(r.code, r.output).toBe(1)
  expect(r.output).toContain('(fail)')
}, 120_000)

test('r6 mutant: a production file under e2e cannot hide a forbidden capability', async () => {
  reset()
  const dir = join(root, 'packages/server/server/e2e')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'new-module.ts')
  writeFileSync(file, 'const run = eval; export const invoke = run')
  try {
    const r = await run([delivery + 'doors.lint.test.ts'], 'runtime escape hatches')
    expect(r.code, r.output).toBe(1)
    expect(r.output).toContain('server/server/e2e/new-module.ts:eval')
  } finally { rmSync(file) }
}, 120_000)

const r5Mutants: Array<[string, string, string, string]> = [
  ['O1', tasks, 'subtasks: effectiveSubtasks(b.subtasks)', 'subtasks: b.subtasks'],
  ['O2', tasks, 'after = { ...after, statuses: book.statuses.map(s => ({ ...s, stage: s.stage ?? doc.statusStages?.[s.id] })) }', 'after = sliceOf(book)'],
  ['O3', delivery + 'store.ts', 'deliveryFloors: next, pendingDelivery: serialized', 'deliveryFloors: next'],
  ['O4', tasks, 'const before = currentBase ? await read() : await readUncached()', 'const before = await read()'],
  ['MU2', delivery + 'store.ts', 'Object.entries({ ...phasesBefore, ...final.deliveries })', 'Object.entries(final.deliveries)'],
  ['MU3', delivery + 'guard.ts', 'if (!hasContext && ((was.evidence?.length ?? 0) > 0 || (was.history?.length ?? 0) > 0))', 'if (!hasContext && (was.evidence?.length ?? 0) > 0)'],
  ['MU5', delivery + 'guard.ts', "case 'done': return 4", "case 'done': return 0"],
  ['O5 dangerous', delivery + 'guard-ast.testing.ts', 'export function forbiddenCapabilities(src: string): string[] {', 'export function forbiddenCapabilities(src: string): string[] { return [];'],
  ['O5 existing', delivery + 'guard-inventory.testing.ts', 'const capable = new Set(Object.entries(sources)', 'return {}; const capable = new Set(Object.entries(sources)'],
  ['O5 shipped', delivery + 'lint-scan.testing.ts', "if (!['node_modules', '.git'].includes(name))", "if (!['node_modules', '.git', 'target', 'build', 'dist'].includes(name))"],
]
for (const [id, file, from, to] of r5Mutants) test(`r5 mutant ${id} is killed`, async () => {
  reset(); change(file, from, to)
  if (id === 'O4') change(tasks, 'if (!currentBase) bookMemo.delete(file)', '')
  const r = await run(id === 'O1' ? [r5Test, delivery + 'guard-doors.e2e.test.ts'] : [r5Test], id)
  console.log(`${id}: exit ${r.code}\n${r.output}`)
  expect(r.code, r.output).toBe(1)
  expect(r.output).toContain('(fail) ' + id)
}, 120_000)
async function killed(id: string, targets = [storeTest]) {
  const r = await run(targets, id)
  console.log(`${id}: exit ${r.code}\n${r.output.split('\n').filter(l => /\(fail\)|Expected:|Received:| pass| fail/.test(l)).join('\n')}`)
  expect(r.code, r.output).toBe(1)
  expect(r.output).toContain('(fail)')
  expect(r.output).toContain(id)
}

test('mutation harness positive control: unmodified probes pass', async () => {
  reset()
  const r = await run([storeTest, restore.replace('.ts', '.test.ts'), delivery + 'guard-context.lint.test.ts', delivery + 'doors.lint.test.ts'])
  expect(r.code, r.output).toBe(0)
}, 120_000)

test('mutant F1: restore bypassing rule A is killed by real archive probe', async () => {
  reset(); change(restore, "if (await ruleAState(anchor.dir) === 'on')", 'if (false)')
  await killed('F1', [restore.replace('.ts', '.test.ts')])
}, 120_000)
test('mutant F1: a new computed-target raw writer is killed by the inventory', async () => {
  reset()
  const file = join(root, delivery, 'mutant-writer.ts')
  writeFileSync(file, "import { writeFile as save } from 'node:fs/promises'; import { join } from 'node:path'; const target = join(dir, 'tasks.json'); await save(target, advancedBook)")
  try {
    const r = await run([delivery + 'doors.lint.test.ts'])
    expect(r.code, r.output).toBe(1); expect(r.output).toContain('mutant-writer.ts')
    console.log('F1 computed-target module: killed')
  } finally { rmSync(file) }
}, 120_000)
test('mutant F2: absent documents/key incorrectly mean OFF', async () => {
  reset()
  change(delivery + 'guard-host.ts', "import { dirname, join }", "import { existsSync } from 'node:fs'\nimport { dirname, join }")
  change(delivery + 'guard-host.ts', "export async function ruleAState(dir: string): Promise<RuleState> {", "export async function ruleAState(dir: string): Promise<RuleState> {\n  if (!['guarantees.json', 'guards.json', 'guard-integrity.key'].some(f => existsSync(join(dir, f)))) return 'off'")
  await killed('F2')
}, 120_000)
test('mutant F3: grandfather authorizes new progress to rank 3', async () => {
  reset()
  change(delivery + 'guard-host.ts', 'const { raised, checkpoint } = o', "const { raised, checkpoint } = o\n  if (checkpoint?.auth.some(a => a.kind === 'grandfathered') && raised.rank <= 3) return { ok: true, ids: [], sha256: [], headSha: checkpoint.headSha, category: 'grandfathered', grandfathered: true }")
  await killed('F3')
}, 120_000)
test('mutant F4: bindings, advanced adoption and exposed pieces disappear from detection', async () => {
  reset()
  change(delivery + 'guard.ts', 'const from = was && !was.parentGroupId ? subRank(before, was) : 0', 'const from = was ? subRank(before, was) : 0')
  change(delivery + 'guard.ts', '(to >= 1 && was && (was.taskId !== s.taskId || was.parentGroupId !== s.parentGroupId || JSON.stringify(was.ci) !== JSON.stringify(s.ci)))', 'false')
  change(delivery + 'guard.ts', 'const from = was && !taskWithSubsBefore.has(t.id) ? statusRank(before.statuses, was.status) : 0', 'const from = was ? statusRank(before.statuses, was.status) : 0')
  change(delivery + 'guard.ts', 'const to = phaseRank(r.phase)', 'if (!was) continue\n    const to = phaseRank(r.phase)')
  change(delivery + 'guard.ts', '(to >= 1 && was && !retreat && binding(was) !== binding(r))', 'false')
  await killed('F4')
}, 120_000)
test('mutant F5: evidence:true disables detection', async () => {
  reset()
  change(delivery + 'store.ts', 'const phasesBefore = structuredClone(doc.deliveries)', 'const phasesBefore = options?.evidence ? null : structuredClone(doc.deliveries)')
  change(delivery + 'store.ts', 'const raised = deliveryRaises(phasesBefore, final.deliveries)', 'const raised = phasesBefore ? deliveryRaises(phasesBefore, final.deliveries) : []')
  await killed('F5')
}, 120_000)
test('mutant F6: policy captured before acquiring guards is trusted after activation', async () => {
  reset()
  change(tasks, 'let currentGuard: GuardContext | undefined', "let staleRule: 'off' | 'shadow' | 'on' | undefined\n  let currentGuard: GuardContext | undefined")
  change(tasks, 'raised, retreats, ctx: currentGuard,', 'rule: staleRule, raised, retreats, ctx: currentGuard,')
  change(tasks, "if (await peekRuleA(anchor.paths) !== 'off') return enveloped()", "staleRule = await ruleAState(anchor.dir); if (staleRule !== 'off') return enveloped()")
  change(delivery + 'guard-host.ts', 'const rule = await ruleAState(dirname(o.paths.guards))', 'const rule = o.rule ?? await ruleAState(dirname(o.paths.guards))')
  await killed('F6')
}, 120_000)
test('mutant F7: old round evidence accepted at the same HEAD', async () => {
  reset()
  change(delivery + 'guard-host.ts', "const items = (o.record?.evidence ?? []).filter(i => i.revision >= round && i.revision <= (o.record?.revision ?? Infinity))", 'const items = o.record?.evidence ?? []')
  await killed('F7')
}, 120_000)
test('mutant F8: text guard/ctx anywhere in arguments is mistaken for context', async () => {
  reset()
  change(delivery + 'guard-sites.testing.ts', 'export const missingContext = (src: string): number => missingContextSites(src).length', "export const missingContext = (src: string): number => /\\bguard\\b|\\bctx\\b/.test(src) ? 0 : missingContextSites(src).length")
  await killed('F8', [delivery + 'guard-context.lint.test.ts'])
}, 120_000)
test('mutant F8: new call and enlarged live allowance cannot enlarge the pinned historical ceiling', async () => {
  reset()
  const file = join(root, delivery, 'mutant-context.ts')
  const src = 'store.upsertTask(newPiece)'
  writeFileSync(file, src)
  const path = join(root, delivery, 'guard-inventory.fixture.json')
  const fixture = JSON.parse(readFileSync(path, 'utf8'))
  fixture.contexts['server/server/delivery/mutant-context.ts'] = missingContextSites(src)
  writeFileSync(path, JSON.stringify(fixture, null, 2) + '\n')
  try {
    const r = await run([delivery + 'guard-context.lint.test.ts'])
    expect(r.code, r.output).toBe(1)
    expect(r.output).toContain('Historical guard inventory changed')
    console.log('F8 call + enlarged allowance: killed by independent pin')
  } finally { rmSync(file); reset() }
}, 120_000)

// ── S2a r3: one mutant per finding of the live Opus re-QA (N1–N5) and per surviving QA mutant (M1, M3–M7) ─────────────
const guardTest = delivery + 'guard.test.ts'
const locksTest = delivery + 'guard-locks.test.ts'
const restoreTest = restore.replace('.ts', '.test.ts')
const lintTest = delivery + 'doors.lint.test.ts'
test('mutant N2: rule OFF takes the full envelope again (the r2 behaviour)', async () => {
  reset(); change(tasks, "if (await peekRuleA(anchor.paths) !== 'off') return enveloped()", 'return enveloped()')
  await killed('OFF-1')
}, 120_000)
test('mutant N2: a delivery write under rule OFF takes deliveries + guards again', async () => {
  reset(); change(delivery + 'store.ts', "if (await peekRuleA(paths) !== 'off') return guarded()", 'return guarded()')
  await killed('OFF-3')
}, 120_000)
test('mutant N2: a board writer that read OFF never re-checks the rule under its lock', async () => {
  reset(); change(tasks, 'throw new RuleNoLongerOff()', 'return writeRaw(book)')
  await killed('retakes the envelope')
}, 120_000)
test('mutant N2/N5: the activation does not take the envelope', async () => {
  reset(); change(delivery + 'activation.ts', 'return withGuardEnvelope(paths, () => moveRule(rule, to, ctx, paths))', 'return moveRule(rule, to, ctx, paths)')
  await killed('activation takes the full envelope')
}, 120_000)
test('mutant N1: the append-only check on history/evidence is dropped', async () => {
  reset(); change(delivery + 'store.ts', 'if (rule === \'on\') throw new GuardRefused(tampered[0]!)', 'if (false) throw new GuardRefused(tampered[0]!)')
  await killed('GAP-1')
}, 120_000)
test('mutant N1: the pure history check keeps only the length (a rewritten entry passes)', async () => {
  reset(); change(delivery + 'guard.ts', '(was ?? []).every((e, i) => (now ?? []).length > i && sameJson(e, now![i]))', '(now ?? []).length >= (was ?? []).length')
  await killed('GAP-1', [guardTest])
}, 120_000)
test('mutant M1: headSha leaves the delivery binding', async () => {
  reset(); change(delivery + 'guard.ts', 'r.revision, r.headSha, r.qaSha', 'r.revision, r.qaSha')
  await killed('M1', [guardTest])
}, 120_000)
test('mutant M3: restore guards tasks.json only', async () => {
  reset(); change(restore, "return name === 'tasks.json' || name === 'deliveries.json'", "return name === 'tasks.json'")
  await killed('M3', [restoreTest])
}, 120_000)
test('mutant M4: the downgrade stage mirror is ignored', async () => {
  reset(); change(tasks, 'stage: s.stage ?? doc.statusStages?.[s.id]', 'stage: s.stage')
  await killed('M4')
}, 120_000)
test('mutant M5: an envelope is matched on the tasks file only', async () => {
  reset(); change(delivery + 'guard-transaction.ts', "(['tasks', 'deliveries', 'guards'] as const).every(", "(['tasks'] as const).every(")
  await killed('M5', [locksTest])
}, 120_000)
test('mutant M6: no upper revision bound on this round’s captures', async () => {
  reset(); change(delivery + 'guard-host.ts', 'i.revision >= round && i.revision <= (o.record?.revision ?? Infinity)', 'i.revision >= round')
  await killed('M6')
}, 120_000)
test('mutant M7: the subtask CI signal leaves the binding', async () => {
  reset(); change(delivery + 'guard.ts', ' || JSON.stringify(was.ci) !== JSON.stringify(s.ci)', '')
  await killed('M7', [guardTest])
}, 120_000)
test('mutant N6: the restore decides inside the loop again (after earlier files were written)', async () => {
  reset()
  change(restore, "if (await ruleAState(anchor.dir) === 'on') return { ok: false as const", "if (false) return { ok: false as const")
  change(restore, "      if (a.rel.endsWith('.json') && manifest.homeDir !== opts.homeDir) {", "      if (isGuardedBook(to) && await ruleAState(dirname(to)) === 'on') throw new Error('guard_restore_refused')\n      if (a.rel.endsWith('.json') && manifest.homeDir !== opts.homeDir) {")
  await killed('N6', [restoreTest])
}, 120_000)
test('mutant N3: the new writer forms are not detected (element access, Bun global, child process, links…)', async () => {
  reset()
  change(delivery + 'guard-ast.testing.ts', 'if (isBun(e.expression)) return BUN_WRITES.has(name)', "if (isBun(e.expression)) return name === 'write' && e.expression.getText(file) === 'Bun'")
  change(delivery + 'guard-ast.testing.ts', 'return WRITES.has(name) || PROPERTY_WRITES.has(name) || (MODULE_WRITES.has(name) && fromWritingModule(e.expression))', 'return WRITES.has(name)')
  await killed('nine forms', [lintTest])
}, 120_000)
test('mutant N3: book references are not pinned (a retargeted inherited call passes)', async () => {
  reset(); change(delivery + 'guard-ast.testing.ts', "if (ts.isIdentifier(n) && REACH_IDENTS.has(n.text)) out.push(`ident:${n.text}`)", '')
  await killed('retargeting', [lintTest])
}, 120_000)
test('mutant N3: a new module retargets a write at a book through a constant', async () => {
  reset()
  const file = join(root, delivery, 'mutant-reach.ts')
  writeFileSync(file, "import { TASKS_FILE } from '../config'\nimport { cacheWrite } from './cache-helper'\nawait cacheWrite(TASKS_FILE, '{}')\n")
  try {
    const r = await run([lintTest], 'no new raw writer')
    expect(r.code, r.output).toBe(1); expect(r.output).toContain('mutant-reach.ts')
    console.log('N3 new reach module: killed')
  } finally { rmSync(file) }
}, 120_000)
test('mutant N3: production imports a *.testing helper that writes', async () => {
  reset()
  const file = join(root, delivery, 'mutant-import.ts')
  writeFileSync(file, "import { put } from './evidence-world.testing'\nexport const x = put\n")
  try {
    const r = await run([lintTest], 'test-only module')
    expect(r.code, r.output).toBe(1); expect(r.output).toContain('mutant-import.ts')
    console.log('N3 testing import: killed')
  } finally { rmSync(file) }
}, 120_000)

const r4Test = delivery + 'guard-r4.test.ts'
test('mutant Q1: duplicate ids again collapse in the append-only Map', async () => {
  reset(); change(delivery + 'guard.ts', 'if (new Set(ids).size !== ids.length)', 'if (false)')
  await killed('Q1 duplicate evidence IDs', [r4Test])
}, 120_000)
test('mutant Q2: judge callbacks before the preserved merge', async () => {
  reset(); change(delivery + 'store.ts', 'const final = parseDeliveryDocStrict(serialized)', 'const final = doc')
  await killed('Q2', [r4Test])
}, 120_000)
test('mutant Q3: forget durable floors when a delivery was deleted', async () => {
  reset(); change(delivery + 'store.ts', "const floors = floorRule === 'off' ? {} : (await floorStore.read()).deliveryFloors ?? {}", 'const floors = {}')
  await killed('Q3', [r4Test])
}, 120_000)
test('mutant Q8: the flow door drops only the Portuguese refusal', async () => {
  reset(); change(delivery + 'service.ts', 'sentencePt: e.messagePt', 'sentencePt: undefined')
  await killed('Q8', [r4Test])
}, 120_000)
const r4Modules: Record<string, string> = {
  'Q4.generated': "import fs from 'node:fs'; fs.writeFileSync.call(fs, process.env['BOOK_PATH'], '{}')",
  Q4: "import { Worker } from 'node:worker_threads'; new Worker(new URL('./writer.testing.ts', import.meta.url))",
  Q5: "import fs from 'node:fs'; fs.writeFileSync.call(fs, process.env['BOOK_PATH'], '{}')",
  Q6: "const fs = await import(process.env['FS_MODULE']); const put = fs['writeFileSync']; put(process.env['BOOK_PATH'], '{}')",
  Q7: "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const fs = load('node:fs'); const put = fs['writeFileSync']; put(process.env['BOOK_PATH'], '{}')",
}
for (const [id, src] of Object.entries(r4Modules)) test(`mutant ${id}: a new capability-bearing production MODULE is refused`, async () => {
  reset()
  const file = join(root, delivery, `mutant-${id}.ts`)
  writeFileSync(file, src)
  try {
    const r = await run([lintTest], 'no new raw writer')
    console.log(`${id}: exit ${r.code}`)
    expect(r.code, r.output).toBe(1)
    expect(r.output).toContain(`mutant-${id}.ts`)
    expect(r.output).toContain('(fail)')
  } finally { rmSync(file) }
}, 120_000)
test('mutant Q4–Q7: enlarging the module list itself is refused', async () => {
  reset()
  change(delivery + 'guard-modules.fixture.json', '"modules": {', '"modules": { "mutant.ts": ["module:fs"],')
  await killed('no new raw writer', [lintTest])
}, 120_000)

const r7Test = delivery + 'guard-r7.test.ts'
const r7Mutants: Array<[string, string, string, string, string, string[]?]> = [
  ['X1', delivery + 'activation.ts', "rule === 'a' && from === 'off' && to === 'shadow'", "rule === 'a' && to !== 'off'", 'R6-2 X1'],
  ['X2', delivery + 'activation.ts', 'reconciledFloors: { dropped, reason', 'reconciledFloors: { dropped: [], reason', 'R1 OFF restore', [r6Test]],
  ['X3', delivery + 'store.ts', 'if (before && after && after.phase !== before.phase && phaseRank', 'if (before && after && phaseRank', 'floors judge only', [r6Test]],
  ['X4', delivery + 'store.ts', "if (await deliveryReadRule(anchor.paths.guards) !== 'off') {", "if (await deliveryReadRule(anchor.paths.guards) === 'on') {", 'OFF reads use', [r6Test]],
  ['X5', delivery + 'guard-ast.testing.ts', '/^(global|globalThis|self|Bun)$/.test(unwrap(n.expression)', '/^(global|globalThis|Bun)$/.test(unwrap(n.expression)', 'eval references', [r6Test]],
  ['R6-1 floor', delivery + 'store.ts', 'if (isPureAdoption(r) && !protectedFloor(old))', 'if (false)', 'A1'],
  ['R6-1 isolation', delivery + 'service.ts', 'if (!(e instanceof GuardRefused)) throw e', 'throw e', 'per-piece tick refusal'],
  ['R6-1 batch', delivery + 'service.ts', "if (await ruleAState(dirname(d.store.path)) === 'off') { await write(ids); return }", 'await write(ids); return', 'a refused wake stamp'],
  ['R6-1 queue', delivery + 'service.ts', 'if (!d.spawn) return { actions }', "if (!d.spawn) return { actions }; const tickRefusal = async (e: unknown) => { throw e }", 'queue reminder refusal'],
  ['R6-1 HTTP', delivery + 'web.ts', 'if (e instanceof GuardRefused) return { status: e.status', 'if (false) return { status: e.status', 'tick HTTP refusal'],
  ['R6-3 Function', delivery + 'guard-ast.testing.ts', "if (ts.isIdentifier(n) && n.text === 'Function') out.push('Function')", '', 'R6-3'],
  ['R6-3 literal global', delivery + 'guard-ast.testing.ts', "out.push('global-code:' + key)", 'void key', 'R6-3'],
  ['R6-3 constructor', delivery + 'guard-ast.testing.ts', "if (key === 'constructor')", 'if (false)', 'R6-3'],
  ['R6-4 climbed', delivery + 'activation.ts', 'climbed, createdRanked }', 'climbed: [], createdRanked }', 'B1 off'],
  ['R6-4 created', delivery + 'activation.ts', 'climbed, createdRanked }', 'climbed, createdRanked: [] }', 'B1 off'],
  ['R6-4 warning', delivery + 'activation.ts', "if (latest?.reconciledFloors) out.push", 'if (false) out.push', 'B1 off'],
  ['R6-5 cache', delivery + 'activation.ts', 'if (cached?.stamp === stamp) return cached.pending', '', 'R6-5'],
]
for (const [id, file, from, to, pattern, suites] of r7Mutants) test(`r7 mutant ${id} is killed`, async () => {
  reset(); change(file, from, to)
  if (id === 'R6-1 floor') change(delivery + 'store.ts', 'if (after && isPureAdoption(after) && !protectedFloor(floors[id])) return false', '')
  const r = await run(suites ?? [r7Test], pattern)
  console.log(`${id}: exit ${r.code}\n${r.output.split('\n').filter(l => /\(fail\)|Expected:|Received:| pass| fail/.test(l)).join('\n')}`)
  expect(r.code, r.output).toBe(1)
  expect(r.output).toContain('(fail)')
}, 120_000)
test('r7 mutation positive control', async () => {
  reset(); const r = await run([r7Test]); expect(r.code, r.output).toBe(0)
}, 120_000)
