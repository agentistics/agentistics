/** S2b r6: one mutant per re-QA r5 finding (R5-1..R5-6), applied to a disposable source copy, never to this checkout. */
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

const suite = delivery + 'guard-sweep-r6.test.ts'
const mutants: Array<[string, string, string, string, string]> = [
 ['R5-1 removed members', delivery + 'sweep-plan.ts', 'if (groupNow <= checkpointRank(c, o.statuses)) continue', 'continue', 'QA5 REMOVE|QA5 MOVE-OUT|real group'],
 ['R5-1 placeholder', packagesTaskStore(), 'if (!r.subtaskId || !r.placeholder || !r.parentGroupId || present.has(r.subtaskId)) continue', 'continue', 'QA5 REMOVE'],
 ['R5-2 baselined group', delivery + 'sweep-plan.ts', 'if (p.checkpointKey && cp && !accepted && cp.members === undefined) {', 'if (p.checkpointKey && cp && !accepted) {', 'QA5 REPLACE'],
 ['R5-3 sweep never adds', delivery + 'sweep-plan.ts', 'if (!c || c.members !== undefined || ownerAuthorized', 'if (!c || ownerAuthorized', 'QA5 NEW MEMBER'],
 ['R5-4 moved status', delivery + 'guard-host.ts', 'if (!m.moved) return true', 'return true', 'QA5 LAUNDER'],
 ['R5-4 removed member', packagesTaskStore(), '...before.subtasks.flatMap(s => s.parentGroupId && afterSubs.get(s.id)?.parentGroupId !== s.parentGroupId', '...before.subtasks.flatMap(s => false && s.parentGroupId && afterSubs.get(s.id)?.parentGroupId !== s.parentGroupId', 'guarded store'],
 ['R5-5 persistent report', delivery + 'sweep-plan.ts', 'noBaselineSince[p.key] = o.memory.noBaselineSince?.[p.key] ?? at', 'void 0', 'QA5 OLD-FOREVER'],
 ['R5-6 QA5-M2 equivalent', delivery + 'sweep-plan.ts', 'if (!c || c.members !== undefined || ownerAuthorized', 'if (!c || ownerAuthorized', 'R5-6'],
]
function packagesTaskStore() { return taskStore }
for (const [id, file, from, to, pattern] of mutants) test(`r6 mutant ${id} is killed`, async () => {
 reset(); change(file, from, to)
 try {
   const result = await run([suite], pattern)
   console.log(`${id}: exit ${result.code}\n${result.output}`)
   expect(result.code, result.output).toBe(1)
   expect(result.output).toContain('(fail)')
   expect(result.output).toContain('expect(received)')
 } finally { reset() }
}, 150_000)
test('r6 mutation positive control', async () => {
 reset()
 const result = await run([suite])
 expect(result.code, result.output).toBe(0)
}, 150_000)
