/** S2a r7 notes + S2b mutation controls: each mutant is applied to a disposable source copy, never to this checkout. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../../..')
const delivery = 'packages/server/server/delivery/'
let root: string
const originals = new Map<string, string>()
const files = ['service.ts', 'web.ts', 'machine.ts', 'guard-ast.testing.ts', 'sweep.ts', 'sweep-plan.ts', 'guards-store.ts', 'store.ts'].map(f => delivery + f).filter(f => existsSync(join(repo, f)))
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
  ['R7-1 sentencePt', delivery + 'web.ts', 'sentence: e.message, sentencePt: e.messagePt, missing: e.missing } }\n      const safe = safeError(e, { verbose: false })\n      console.error(safe.logLine)\n      return { status: 500, body: { ...safe.body, sentence: \'the reconcile', 'sentence: e.message, missing: e.missing } }\n      const safe = safeError(e, { verbose: false })\n      console.error(safe.logLine)\n      return { status: 500, body: { ...safe.body, sentence: \'the reconcile', 'R7-1 the reconcile route', [service]],
  ['R7-2 dedupe', delivery + 'service.ts', 'if (refusalSeen.get(e.piece) === e.code) return', '', 'R7-2 a persistently', [notes]],
  ['R7-2 clear', delivery + 'service.ts', 'if (!refusedNow.has(piece)) refusalSeen.delete(piece)', 'void piece', 'R7-2 the note is written again', [notes]],
  ['R7-2 pt', delivery + 'service.ts', ' | recusa do guarda em ${e.piece}: ${e.code}: ${e.messagePt}', '', 'R7-2 a persistently', [notes]],
  ['R7-3 rule', delivery + 'guard-ast.testing.ts', "if (!compared && !named) out.push('constructor-access')", "if (false) out.push('constructor-access')", 'R7-3', [notes]],
  ['R7-3 compared', delivery + 'guard-ast.testing.ts', 'const compared = !!p && ts.isBinaryExpression(p) &&', 'const compared = !!p &&', 'R7-3', [notes]],
  ['R7-3 destructure', delivery + 'guard-ast.testing.ts', "out.push('constructor-destructure')", 'void n', 'R7-3', [notes]],
  ['R7-4 M7', delivery + 'service.ts', 'budget: AUTO_RUN_GH_BUDGET, tickActions: actions', 'budget: AUTO_RUN_GH_BUDGET', 'R7-4/M7', [service]],
  ['R7-4 M8', delivery + 'machine.ts', "if (r.phase !== 'fila' && r.phase !== 'bloqueado') return false", '', 'R7-4/M8', [notes]],
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
  const r = await run([notes])
  expect(r.code, r.output).toBe(0)
}, 150_000)
void sweepTest
