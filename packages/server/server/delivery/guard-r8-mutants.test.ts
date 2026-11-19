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
const files = [...['service.ts', 'web.ts', 'machine.ts', 'guard-ast.testing.ts', 'sweep.ts', 'sweep-plan.ts', 'guards-store.ts', 'store.ts'].map(f => delivery + f), taskStore].filter(f => existsSync(join(repo, f)))
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

const notes = delivery + 'guard-r8-notes.test.ts'
const service = delivery + 'service.test.ts'
const sweepTest = delivery + 'guard-sweep.test.ts'
// [id, file, from, to, test-name pattern, suites]
const mutants: Array<[string, string, string, string, string, string[]]> = [
  ['R7-1 isolation', delivery + 'service.ts', "if (!(error instanceof GuardRefused)) throw error\n        e.applied = false", "throw error\n        e.applied = false", 'R7-1 a MANUAL', [service]],
  ['R7-1 route', delivery + 'web.ts', "// R7-1: a refusal is an answer (code + sentence in both languages), never the runtime's error page.\n      if (e instanceof GuardRefused)", "// R7-1\n      if (false)", 'R7-1 the reconcile route', [service]],
  ['R7-1 sentencePt', delivery + 'web.ts', "// R7-1: a refusal is an answer (code + sentence in both languages), never the runtime's error page.\n      if (e instanceof GuardRefused) return { status: e.status, body: { ok: false, error: e.code, sentence: e.message, sentencePt: e.messagePt, missing: e.missing } }", "// R7-1: a refusal is an answer (code + sentence in both languages), never the runtime's error page.\n      if (e instanceof GuardRefused) return { status: e.status, body: { ok: false, error: e.code, sentence: e.message, missing: e.missing } }", 'R7-1 the reconcile route', [service]],
  ['R7-2 dedupe', delivery + 'service.ts', 'if (refusalSeen.get(e.piece) === e.code) return', '', 'R7-2 a persistently', [notes]],
  ['R7-2 clear', delivery + 'service.ts', 'if (!refusedNow.has(piece)) refusalSeen.delete(piece)', 'void piece', 'R7-2 the note is written again', [notes]],
  ['R7-2 pt', delivery + 'service.ts', ' | recusa do guarda em ${e.piece}: ${e.code}: ${e.messagePt}', '', 'R7-2 a persistently', [notes]],
  ['R7-3 rule', delivery + 'guard-ast.testing.ts', "if (!compared && !named) out.push('constructor-access')", "if (false) out.push('constructor-access')", 'R7-3', [notes]],
  ['R7-3 compared', delivery + 'guard-ast.testing.ts', 'const compared = !!p && ts.isBinaryExpression(p) &&', 'const compared = !!p &&', 'R7-3', [notes]],
  ['R7-3 destructure', delivery + 'guard-ast.testing.ts', "out.push('constructor-destructure')", 'void n', 'R7-3', [notes]],
  ['R7-4 M7', delivery + 'service.ts', 'budget: AUTO_RUN_GH_BUDGET, tickActions: actions', 'budget: AUTO_RUN_GH_BUDGET', 'R7-4/M7', [service]],
  ['R7-4 M8', delivery + 'machine.ts', "if (r.phase !== 'fila' && r.phase !== 'bloqueado') return false", '', 'R7-4/M8', [notes]],
  // ---- S2b: the guard sweep
  ['S2b off', delivery + 'sweep.ts', "if (rule === 'off') return", '', 'OFF: a forged state stays', [sweepTest]],
  ['S2b shadow', delivery + 'sweep.ts', "if (rule === 'shadow') {", 'if (false) {', 'SHADOW', [sweepTest]],
  ['S2b delivery side', delivery + 'sweep-plan.ts', 'if (boardNow > rank || phaseNow > rank)', 'if (boardNow > rank)', 'delivery phase only', [sweepTest]],
  ['S2b owner', delivery + 'sweep-plan.ts', "if (cp && (ownerAuthorized(cp.auth) || (cp.by as { kind?: string } | undefined)?.kind === 'owner')) continue", '', 'owner checkpoint', [sweepTest]],
  ['S2b stale evidence', delivery + 'sweep-plan.ts', '(staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0 || headMoved(cp, p.authorizationRecord ?? p.record))', 'headMoved(cp, p.authorizationRecord ?? p.record)', 'evidence_stale', [sweepTest]],
  ['S2b head moved', delivery + 'sweep-plan.ts', '(staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0 || headMoved(cp, p.authorizationRecord ?? p.record))', 'staleEvidence(cp, p.authorizationRecord ?? p.record).length > 0', 'HEAD moved', [sweepTest]],
  ['S2b catch-up', delivery + 'sweep-plan.ts', 'phaseRank(authorized.phase) === rank && boardNow < rank', 'false', 'caught up', [sweepTest]],
  ['S2b loop limit', delivery + 'sweep-plan.ts', 'export const SWEEP_LOOP_LIMIT = 2', 'export const SWEEP_LOOP_LIMIT = 3', 'reverted twice', [sweepTest]],
  ['S2b loop window', delivery + 'sweep-plan.ts', 'now - Date.parse(s) < SWEEP_LOOP_WINDOW_MS', 'now - Date.parse(s) < Infinity', 'loop window expires', [sweepTest]],
  ['S2b intent commit', delivery + 'sweep.ts', 'if (documentsShow(intent.target, shown))', 'if (false)', 'commits the intent', [sweepTest]],
  ['S2b intent drop', delivery + 'sweep.ts', 'if (documentsShow(intent.target, shown))', 'if (true)', 'drops it', [sweepTest]],
  ['S2b ci signal', delivery + 'sweep-plan.ts', 'clearCi: p.ciRank > target', 'clearCi: false', 'ci SIGNAL', [sweepTest]],
  ['S2b ranked revision', delivery + 'sweep.ts', 'phaseRank(to) === 0 ? r.revision + 1 : r.revision', 'r.revision + 1', 'not to rank 0', [sweepTest]],
  ['S2b memory persisted', delivery + 'guards-store.ts', '...(sweep ? { sweep } : {})', '...{}', 'BLOCKED', [sweepTest]],
  ['S2b missing chunk', delivery + 'sweep.ts', 'offset < toApply.length;', 'offset < toApply.length - SWEEP_CHUNK_SIZE;', '12 forged pieces', [sweepTest]],
  ['S2b clear ci in store', 'packages/server/server/sessions/task-store.ts', 'if (r.clearCi) delete next.ci', '', 'ci SIGNAL', [sweepTest]],
]
for (const [id, file, from, to, pattern, suites] of mutants) test(`r8 mutant ${id} is killed`, async () => {
  reset(); change(file, from, to)
  const r = await run(suites, pattern)
  console.log(`${id}: exit ${r.code}\n${r.output.split('\n').filter(l => /\(fail\)|Expected:|Received:| pass| fail/.test(l)).join('\n')}`)
  expect(r.code, r.output).toBe(1)
  expect(r.output).toContain('(fail)')
}, 150_000)
test('r8 mutation positive control', async () => {
  reset()
  const r = await run([notes, sweepTest])
  expect(r.code, r.output).toBe(0)
}, 150_000)
