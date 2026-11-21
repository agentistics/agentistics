/** S2a r7 notes + S2b mutation controls: each mutant is applied to a disposable source copy, never to this checkout. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../../..')
const delivery = 'packages/server/server/delivery/'
let root: string
const originals = new Map<string, string>()
const taskStore = 'packages/server/server/sessions/task-store.ts'
const files = [...['service.ts', 'guard-host.ts', 'guard-ast.testing.ts', 'sweep.ts', 'sweep-plan.ts', 'guards-store.ts', 'store.ts', 'owner-health.ts'].map(f => delivery + f), taskStore, 'packages/server/server/errors.ts', 'packages/server/server/index.ts', 'packages/server/server/sessions/cli-task.ts', 'packages/mcp/agentistics-mcp.ts'].filter(f => existsSync(join(repo, f)))
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-r8-mutants-'))
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

const reset = () => { for (const [f, src] of originals) writeFileSync(join(root, f), src) }
function change(file: string, from: string, to: string) {
  const src = readFileSync(join(root, file), 'utf8')
  expect(src.includes(from), `${file}: mutation anchor`).toBe(true)
  writeFileSync(join(root, file), src.replace(from, to))
}
async function run(targets: string[], pattern?: string) {
  const child = Bun.spawn([process.execPath, 'test', ...targets, ...(pattern ? ['--test-name-pattern', pattern] : [])], {
    cwd: root, env: { ...process.env, HOME: join(root, 'home'), AGENTISTICS_DIR: join(root, 'data') }, stdout: 'pipe', stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill(), 100_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output: stdout + stderr }
  } finally { clearTimeout(timer) }
}


const regression = delivery + 'guard-sweep-r2.test.ts'
const r3 = delivery + 'guard-sweep-r3.test.ts'
const r4 = delivery + 'guard-sweep-r4.test.ts'
const host = delivery + 'guard-sweep-host-r2.test.ts'
const errors = 'packages/server/server/errors.test.ts'
const storeTest = delivery + 'guard-store.test.ts'
const rest = delivery + 'guard-sweep-r2.e2e.test.ts'
const mcp = 'packages/mcp/task-write-proof.test.ts'
const mutants: Array<[string, string, string, string, string, string[]]> = [
 ['R2-1 member derived rank', delivery + 'sweep-plan.ts', 'if (p.checkpointKey && (p.groupRank ?? 0) <= rank) reason = null', '', 'R2-M1|R2-M2', [r3]],
 ['R2-2 retain phase', delivery + 'guard-host.ts', 'rec?.phase ?? null : prior.phase', 'rec?.phase ?? null : null', 'R2-K2', [r3]],
 ['R2-2 retain phase rank', delivery + 'guard-host.ts', 'rank: Math.max(r.rank, phaseRank(phase))', 'rank: r.rank', 'R2-K2', [r3]],
 ['R2-2 owner retreat', delivery + 'guard-host.ts', "if (o.ctx.principal.kind === 'owner') auth.push({ kind: 'owner', via: o.ctx.principal.via })", '', 'R2-K2', [r3]],
 ['R2-3 health warning', delivery + 'sweep.ts', 'if (current.sweep?.warning !== warning) await d.guards.write', 'if (false) await d.guards.write', 'R2-3 breaker', [r3]],
 ['R2-3 leader notice', delivery + 'sweep.ts', 'await d.notifyLeaders?.(', 'void (', 'R2-3 breaker', [r3]],
 ['R2-3 notice dedupe', delivery + 'sweep.ts', "notify = !current.sweep?.warning?.startsWith('sweep-breaker:')", 'notify = true', 'R2-3 breaker', [r3]],
 ['R3-2 breaker counts every kind', delivery + 'sweep.ts', "const checkpointed = plan.reverts.filter(r => r.reason !== 'no_checkpoint')", 'const checkpointed: typeof plan.reverts = []', 'R2-4/R3-2|R3-2', [r3, r4]],
 ['R3-2 ceiling', delivery + 'sweep.ts', "checkpointed.length > SWEEP_CHECKPOINT_CEILING ? 'checkpoint_ceiling'", "false ? 'checkpoint_ceiling'", 'R3-2 checkpointed reverts have their own', [r4]],
 ['R3-2 breaker keeps checkpointed repairs', delivery + 'sweep.ts', "const toApply = skipped === 'no_checkpoint_breaker' ? checkpointed : plan.reverts", "const toApply = skipped === 'no_checkpoint_breaker' ? [] : plan.reverts", 'R3-2 a checkpointed forgery', [r4]],
 ['R3-1 accepted status', delivery + 'sweep-plan.ts', 'if (accepted && accepted.status === p.boardStatus) reason = null', '', 'R3-1 a group of 17', [r4]],
 ['R3-1 restore status', delivery + 'sweep-plan.ts', 'to: restore ?? boardTarget(cp, target, o.statuses)', 'to: boardTarget(cp, target, o.statuses)', 'R3-1 a group of 17', [r4]],
 ['R3-1 sweep baseline', delivery + 'sweep.ts', 'if (plan.baselines.length) {', 'if (false) {', 'R3-1 a quiet tick', [r4]],
 ['R3-1 guard retreat records members', delivery + 'guard-host.ts', 'const members = r.members ? { ...(prior.members ?? {}), ...acceptedAt(r.members, at) } : prior.members', 'const members = prior.members', 'R3-1 the guard records', [r4]],
 ['R3-3 recorded board rank', delivery + 'sweep-plan.ts', ' && boardNow < statusRankIn(o.statuses, cp.boardStatus)', '', 'R3-3', [r4]],
 ['R3-3 abandoned', delivery + 'sweep-plan.ts', " && p.boardStatus !== 'abandoned'", '', 'R3-3 abandoned', [r4]],
 ['R3-4 group rank without ci', delivery + 'sweep.ts', 'groupRank: board.get(parentOf.get(key)!)?.statusRank ?? 0,', 'groupRank: Math.max(board.get(parentOf.get(key)!)?.statusRank ?? 0, board.get(parentOf.get(key)!)?.ciRank ?? 0),', 'R3-4', [r4]],
 ['R3-5 spread', delivery + 'guard-ast.testing.ts', 'if (ts.isSpreadElement(target)) assignmentConstructors(target.expression)', '', 'R3-5', [r4]],
 ['R3-5 spread assignment', delivery + 'guard-ast.testing.ts', 'if (ts.isSpreadAssignment(p)) assignmentConstructors(p.expression)', '', 'R3-5', [r4]],
 ['R3-5 indirect Reflect', delivery + 'guard-ast.testing.ts', "out.push('reflect-indirect')", 'void n', 'R3-5', [r4]],
 ['R3-6 sweep_changed', delivery + 'service.ts', "if (!await unchanged()) return { ok: false, code: 'sweep_changed' }", '', 'R3-6', [r4]],
 ['R2-5 bounded chunks', delivery + 'sweep.ts', 'export const SWEEP_CHUNK_SIZE = 4', 'export const SWEEP_CHUNK_SIZE = 1000', 'R2-5 planning', [r3]],
 ['R2-5 revalidate', delivery + 'sweep.ts', 'const reverts = proposed.filter(r => (r.checkKeys ?? [r.key]).every(k => signature(fresh.byKey.get(k), fresh.doc.checkpoints, fresh.doc.sweep) === expected.get(k)))', 'const reverts = proposed', 'R2-5 planning', [r3]],
 ['R2-5 plan outside', delivery + 'sweep.ts', 'const initial = await snapshot()', 'const initial = await d.envelope(snapshot)', 'R2-5 planning', [r3]],
 ['R2-5 tick envelope', delivery + 'service.ts', 'try { return await tickOnce() }', 'try { return await transaction(tickOnce)() }', 'R2-5 the real service', [r3]],
 ['R2-6 normal clear', taskStore, "if (next.status !== 'blocked') delete next.blockedReason", '', 'R2-6', [r3]],
 ['R2-6 sweep clear', taskStore, 'else delete next.blockedReason', '', 'R2-6', [r3]],
 ['R2-7 nested array', delivery + 'guard-ast.testing.ts', 'if (ts.isArrayLiteralExpression(target)) for (const el of target.elements) assignmentConstructors(el)', '', 'R2-7 refuses \\[', [r3]],
 ['R2-7 for-of', delivery + 'guard-ast.testing.ts', 'if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) assignmentConstructors(n.initializer)', '', 'R2-7 refuses for', [r3]],
 ['R2-8 N10 revision', delivery + 'guard-host.ts', '&& (rec?.revision ?? 0) === checkpoint.revision', '', 'R2-8 N10', [r3]],
 ['G1 raw members', delivery + 'sweep.ts', 'slice.subtasks.filter(s => !groups.has(s.id))', 'slice.subtasks.filter(s => !groups.has(s.id) && !s.parentGroupId)', 'G1', [regression]],
 ['G1 derived rank', delivery + 'sweep-plan.ts', 'if (p.checkpointKey && (p.groupRank ?? 0) <= rank) reason = null', '', 'identical ineffective', [regression]],
 ['K1 current checkpoint', delivery + 'sweep-plan.ts', 'return Math.min(cp.rank, Math.max(board, phaseRank(cp.phase)))', 'return cp.rank', 'K1', [regression]],
 ['K1 retreat hook', delivery + 'guard-host.ts', 'if (o.ctx) for (const r of o.retreats ?? [])', 'if (false) for (const r of o.retreats ?? [])', 'authorized.*retreat lowers', [regression]],
 ['CU1 checkpoint cover', delivery + 'guard-host.ts', "const covered = o.ctx.principal.kind === 'flow'", 'const covered = false', 'CU1', [host]],
 ['CU failure dedupe', delivery + 'sweep.ts', 'if (doc.sweep?.catchUpFailures?.[c.key] !== code)', 'if (true)', 'catch-up refusals', [regression]],
 ['migration stamp', delivery + 'sweep.ts', "!doc.migrations?.a ? 'migration_missing'", "false ? 'migration_missing'", 'migration missing', [regression]],
 ['breaker percent', delivery + 'sweep.ts', 'revertCount > views.length * 0.05', 'false', 'breaker rejects', [regression]],
 ['breaker count', delivery + 'sweep.ts', 'revertCount > 20', 'false', 'breaker absolute', [regression]],
 ['delivered timestamp', taskStore, "if (r.clearCi) delete next.ci", "if (r.clearCi) delete next.ci; delete next.deliveredAt", 'delivered piece', [regression]],
 ['B1 reason', taskStore, "if (r.to === 'blocked') next.blockedReason = 'externo: an unknown writer keeps moving this piece'", '', 'B1', [regression]],
 ['health aggregation', delivery + 'owner-health.ts', "if (w.startsWith('sweep-loop:') || w.startsWith('sweep-skipped:'))", 'if (false)', 'health has one', [regression]],
 ['O1 owner principal', delivery + 'sweep-plan.ts', " || (cp.by as { kind?: string } | undefined)?.kind === 'owner'", '', 'O1', [regression]],
 ['owner persisted', delivery + 'guard-host.ts', "if (o.ctx!.principal.kind === 'owner') auth.push({ kind: 'owner', via: o.ctx!.principal.via })", '', 'S2B-6 owner principal', [storeTest]],
 ['Reflect.get', delivery + 'guard-ast.testing.ts', "out.push('constructor-reflect-get')", 'void n', 'S2B-7', [regression]],
 ['assignment destructure', delivery + 'guard-ast.testing.ts', "out.push('constructor-assignment-destructure')", 'void n', 'S2B-7', [regression]],
 ['busy safeError', 'packages/server/server/errors.ts', "if (err instanceof Error && 'code' in err && err.code === 'guard_busy' && 'status' in err && err.status === 409)", 'if (false)', 'S2B-8', [errors]],
 ['busy HTTP boundary', 'packages/server/server/index.ts', "\n    return new Response(JSON.stringify(safe.body), { status: safe.status ?? 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })", "\n    return new Response(JSON.stringify(safe.body), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } })", 'S2B-8', [rest]],
 ['busy MCP GET sentence', 'packages/mcp/agentistics-mcp.ts', 'async function apiGet(path: string) {\n  const res = await fetch(`${API}${path}`);\n  if (!res.ok) throw new Error(`agentistics API ${path} → HTTP ${res.status}${await apiErrorDetail(res)}`);', 'async function apiGet(path: string) {\n  const res = await fetch(`${API}${path}`);\n  if (!res.ok) throw new Error(`agentistics API ${path} → HTTP ${res.status}`);', 'S2B-8', [mcp]],
 ['busy CLI read sentence', 'packages/server/server/sessions/cli-task.ts', "if (!info) throw e\n    console.error(argv.includes('--json')", "throw e\n    console.error(argv.includes('--json')", 'S2B-8', [rest]],
 ['Q1 block record', delivery + 'sweep.ts', 'if (rv.loop) {', 'if (false) {', 'Q1', [regression]],
 ['Q2 override', delivery + 'sweep-plan.ts', "a.kind === 'owner' || a.kind === 'override'", "a.kind === 'owner'", 'Q2', [regression]],
 ['Q3 short sha', delivery + 'sweep-plan.ts', 'a.startsWith(b) || b.startsWith(a)', 'a === b', 'Q3', [regression]],
 ['Q4 record-only', delivery + 'sweep.ts', '[...keys, ...board.keys(), ...Object.keys(records)]', '[...board.keys()]', 'Q4', [regression]],
 ['Q5 board checkpoint status', delivery + 'sweep-plan.ts', 'if (cp?.boardStatus && known(cp.boardStatus) && rankOf(cp.boardStatus) <= rank) return cp.boardStatus', "if (false) return ''", 'Q5', [regression]],
 ['Q7 pruning', delivery + 'sweep-plan.ts', '.filter(([, v]) => (v as string[]).length > 0)', '.filter(() => true)', 'Q7', [regression]],
]
for (const [id, file, from, to, pattern, suites] of mutants) test(`r2 mutant ${id} is killed`, async () => {
 reset(); change(file, from, to)
 // r5 adds an independent literal-key check; disable its constructor arm too to model the original escape.
 if (id === 'Reflect.get') change(file, " && literalText(call.arguments[1]) !== 'constructor'", '')
 if (id === 'R3-1 guard retreat records members') change(file, 'for (const m of o.memberChanges ?? [])', 'for (const m of [] as NonNullable<typeof o.memberChanges>)')
 const r = await run(suites, pattern)
 console.log(`${id}: exit ${r.code}\n${r.output.split('\n').filter(l => l.startsWith('(fail)') || /Expected:|Received:| pass| fail/.test(l)).join('\n')}`)
 expect(r.code, r.output).toBe(1)
 expect(r.output).toContain('(fail)')
}, 150_000)
test('r2 mutation positive control', async () => {
 reset()
 const r = await run([regression, r3, r4, host, errors, storeTest])
 expect(r.code, r.output).toBe(0)
}, 150_000)
