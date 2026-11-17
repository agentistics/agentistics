/** S7a r2 mutation controls: each mutant reverts ONE fix in a disposable source copy (never this checkout) and a named test must die. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../../..')
const delivery = 'packages/server/server/delivery/'
let root: string
const originals = new Map<string, string>()
const files = ['custody.ts', 'custody-tick.ts', 'custody-project.ts', 'store.ts', 'service.ts'].map(f => delivery + f)
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'custody-r2-mutants-'))
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
async function run(target: string, pattern: string) {
  const child = Bun.spawn([process.execPath, 'test', target, '-t', pattern], { cwd: root, env: { ...process.env, HOME: join(root, 'home'), AGENTISTICS_DIR: join(root, 'data') }, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 110_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output: stdout + stderr }
  } finally { clearTimeout(timer) }
}

const pure = delivery + 'custody-r2.test.ts'
const e2e = delivery + 'custody-r2.e2e.test.ts'
const r3 = delivery + 'custody-r3.e2e.test.ts'
// [name, file, from, to, the test file, a pattern of the tests that must fail]
const mutants: Array<[string, string, string, string, string, string, [string, string]?]> = [
  ['M13 tie reversed (kills the r1 survivor)', delivery + 'custody.ts', 'a[0] < b[0] ? -1 : 1', 'a[0] < b[0] ? 1 : -1', pure, 'M13'],
  ['R1 the planner judges the first (stale) read AND the write does not recompute', delivery + 'custody-tick.ts', 'records: fresh, projects, board, fleet })\n      if', 'records, projects, board, fleet })\n      if', e2e, 'F1', ['final = planOf({ now: d.now(), orphanMs, records: Object.values(doc.deliveries), projects, board, fleet })', 'final = first']],
  ['R2 no recompute inside the write', delivery + 'custody-tick.ts', 'final = planOf({ now: d.now(), orphanMs, records: Object.values(doc.deliveries), projects, board, fleet })', 'final = first', e2e, 'INSIDE the write'],
  ['R3 rule C takes no envelope of its own (the old base lock)', delivery + 'service.ts', 'envelope: fn => withGuardEnvelope(c.paths ?? lockPaths(), fn),', 'envelope: fn => fn(),', e2e, 'F2'],
  ['R4 every update is a change (no semantic test)', delivery + 'store.ts', '(st.when?.() ?? true) && semanticallyChanged(phasesBefore[st.key], after)', '(st.when?.() ?? true)', e2e, 'F3'],
  ['R5 a refused action still stamps (`when` ignored)', delivery + 'store.ts', '(st.when?.() ?? true) &&', 'true &&', pure, 'when'],
  ['R6 the board source is ignored', delivery + 'custody-tick.ts', 'const b = o.board ? boardActivityOf({ key: r.subtaskId, taskId: r.taskId }, o.board, eligible) : null', 'const b = null as ReturnType<typeof boardActivityOf>', e2e, 'DECISION|BLOCK'],
  ['R7 an unverified poster counts', delivery + 'custody.ts', "c.role !== 'session' ||", 'false ||', pure, 'unverified|owner post'],
  ['R8 any thread comment counts (kind not checked)', delivery + 'custody.ts', "(c.kind !== 'decision' && c.kind !== 'block') ||", 'false ||', pure, 'note|handback'],
  ['R9 the folder fallback is gone', delivery + 'custody-project.ts', 'folderProjectOf(i.groups, sessionIdentityKey(s))', "''", e2e, 'F5'],
  ['R10 two folders are a vote (first wins) instead of a conflict', delivery + 'custody-project.ts', 'return set.size === 1 ? [...set][0]! : \'\'', 'return [...set][0] ?? \'\'', e2e, 'F5'],
  // r3: one mutant per fix (N1–N3, Q4, Q6) plus the planner-side eligibility
  ['R12 any actor anchors activity (eligibility ignored in planOf)', delivery + 'custody-tick.ts', 'const eligible = (by: string): boolean => by === r.leaderSessionId', 'const eligible = (by: string): boolean => true || by === r.leaderSessionId', r3, 'N2'],
  ['R13 boardActivityOf ignores the eligible filter', delivery + 'custody.ts', 'if (eligible && !eligible(c.sessionId)) continue', '', pure, 'r3 N2'],
  ['R14 a stamped door falls back to the fail-open base path (N1)', delivery + 'store.ts', 'if (stamped || await peekRuleA(paths)', 'if (await peekRuleA(paths)', r3, 'N1'],
  ['R15 the delivery mark ignores which custodian was told (Q4)', delivery + 'custody-tick.ts', 'cur?.custody?.sessionId === p.to', 'cur?.custody', r3, 'Q4'],
  ['R16 the release declaration batch stamps are dropped (Q6)', delivery + 'service.ts', '...(stamps.length ? { stamp: stamps } : {}) })\n    if (batch.kind', '})\n    if (batch.kind', r3, 'Q6'],
  ['R17 a board status event is a keep-alive source again (N3)', delivery + 'custody.ts', 'for (const c of facts.comments) {', "for (const e of facts.events ?? []) { if (e.kind === 'status' && e.actor) { const t = ms(e.at); if (t !== null && (!best || t > best.t)) best = { at: e.at, by: e.actor, t } } }\n  for (const c of facts.comments) {", pure, 'board status event'],
]

for (const [name, file, from, to, target, pattern, extra] of mutants) {
  test(`mutant killed: ${name}`, async () => {
    reset()
    change(file, from, to)
    if (extra) change(file, extra[0], extra[1])
    const out = await run(target, pattern)
    expect(out.code, out.output.slice(-1500)).not.toBe(0)
    expect(out.output).toMatch(/\(fail\)/)
  }, 150_000)
}
test('the unmutated copy passes the same selections (the harness itself is sound)', async () => {
  reset()
  const a = await run(pure, 'M13|when|board status event|unverified')
  expect(a.code, a.output.slice(-1500)).toBe(0)
}, 150_000)
