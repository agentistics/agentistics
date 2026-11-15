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
const files = [delivery + 'guard-host.ts', delivery + 'guard.ts', delivery + 'store.ts', delivery + 'guard-sites.testing.ts', delivery + 'guard-inventory.fixture.json', tasks, restore]
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
  change(delivery + 'guard.ts', '(to >= 1 && was && binding(was) !== binding(r))', 'false')
  await killed('F4')
}, 120_000)
test('mutant F5: evidence:true disables detection', async () => {
  reset()
  change(delivery + 'store.ts', 'const phasesBefore = structuredClone(doc.deliveries)', 'const phasesBefore = options?.evidence ? null : structuredClone(doc.deliveries)')
  change(delivery + 'store.ts', 'const raised = deliveryRaises(phasesBefore, doc.deliveries)', 'const raised = phasesBefore ? deliveryRaises(phasesBefore, doc.deliveries) : []')
  await killed('F5')
}, 120_000)
test('mutant F6: policy captured before acquiring guards is trusted after activation', async () => {
  reset()
  change(tasks, 'guardedWrite, guardPathsOf, type GuardWiring', 'guardedWrite, guardPathsOf, ruleAState, type GuardWiring')
  change(tasks, 'let currentGuard: GuardContext | undefined', "let staleRule: 'off' | 'shadow' | 'on' | undefined\n  let currentGuard: GuardContext | undefined")
  change(tasks, 'raised, ctx: currentGuard,', 'rule: staleRule, raised, ctx: currentGuard,')
  change(tasks, 'const run = () => withGuardTransaction(anchor.paths, serialized)', 'const run = async () => { staleRule = await ruleAState(anchor.dir); return withGuardTransaction(anchor.paths, serialized) }')
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
