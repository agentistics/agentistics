/** S2b.1: one mutant per r6 re-QA reservation (B1..B6, GAP-M1/M2), applied to a disposable source copy, never to this checkout. */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dir, '../../../..')
const delivery = 'packages/server/server/delivery/'
let root: string
const originals = new Map<string, string>()
const taskStore = 'packages/server/server/sessions/task-store.ts'
const taskWeb = 'packages/server/server/sessions/task-web.ts'
const files = [...['service.ts', 'guard-host.ts', 'guard-ast.testing.ts', 'sweep.ts', 'sweep-plan.ts', 'guards-store.ts', 'store.ts', 'owner-health.ts', 'gates.ts', 'web.ts'].map(f => delivery + f), taskStore, taskWeb, 'packages/server/server/errors.ts', 'packages/server/server/index.ts', 'packages/server/server/host-allow.ts', 'packages/server/server/sessions/cli-task.ts', 'packages/mcp/agentistics-mcp.ts', 'packages/server/server/backup/restore.ts', 'docs/delivery-store-guard.md'].filter(f => existsSync(join(repo, f)))
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'guard-s2b1-mutants-'))
  cpSync(join(repo, 'packages'), join(root, 'packages'), { recursive: true, filter: p => !p.split('/').some(s => ['node_modules', 'dist', 'target', '.git'].includes(s)) })
  cpSync(join(repo, 'scripts'), join(root, 'scripts'), { recursive: true })
  for (const f of ['tsconfig.json', 'bunfig.toml', 'package.json']) cpSync(join(repo, f), join(root, f))
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir')
  for (const pkg of readdirSync(join(repo, 'packages'))) {
    const deps = join(repo, 'packages', pkg, 'node_modules')
    if (existsSync(deps)) symlinkSync(deps, join(root, 'packages', pkg, 'node_modules'), 'dir')
  }
  mkdirSync(join(root, 'docs'))
  cpSync(join(repo, 'docs/delivery-store-guard.md'), join(root, 'docs/delivery-store-guard.md'))
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

const suite = delivery + 'guard-sweep-s2b1.test.ts'
const mutants: Array<[string, string, string, string, string]> = [
 ['B1 release sentence', delivery + 'sweep-plan.ts', '${LOOP_RELEASE} | ${LOOP_RELEASE_PT}', '${SWEEP_ESCAPE}', 'B1 the sweep-loop'],
 ['B2 unaccepted warn', delivery + 'sweep-plan.ts', 'unacceptedSince[p.key] = o.memory.unacceptedSince?.[p.key] ?? at', 'void 0', 'B2 QA6-RIDE2'],
 ['B3 group task restored', taskStore, "...(r.parentGroupId && r.groupTaskId ? { taskId: r.groupTaskId } : {})", '', 'B3 QA6-COLLIDE'],
 ['B4 placeholder mark', taskStore, "restoredBy: 'guard', parentGroupId: r.parentGroupId", 'parentGroupId: r.parentGroupId', 'B4 the placeholder is marked'],
 ['B4 dismissal raises nothing', taskStore, 'const raised = dismissing ? [] : boardRaises(prior, after)', 'const raised = boardRaises(prior, after)', 'B4 the task leader'],
 ['B4 stage refuses', delivery + 'service.ts', "if (sub.restoredBy === 'guard') return fail(", 'if (false) return fail(', 'B4 task_next'],
 ['B5 QA6-M1 owner-authorized group', delivery + 'sweep-plan.ts', "if (!c.members || ownerAuthorized(c.auth) || (c.by as { kind?: string } | undefined)?.kind === 'owner') continue", 'if (!c.members) continue', 'GAP-M1'],
 ['B5 QA6-M2 moved-out status', delivery + 'sweep-plan.ts', 'const to = mv && Math.max(mv.boardRank, mv.ciRank) <= accRank ? mv.boardStatus! : acc.status', 'const to = acc.status', 'GAP-M2'],
 ['B6 id from text', delivery + 'owner-health.ts', 'issues.push({ id: i.id, severity', "issues.push({ id: `guarantee-off:${i.text.split(', ')[0]}`, severity", 'B6 the member WARN id'],
 ['r3 door refuses nobody', taskWeb, "if (guard?.principal.kind !== 'owner') return { ok: false, reason: 'member_accepted'", "if (false) return { ok: false, reason: 'member_accepted'", 'r3 Q4/ATK-7'],
 ['r3 acceptedMemberOf blind', taskStore, "return status === 'done' ? { groupId: group, status } : null", 'return null', 'r3 Q4/ATK-7'],
 ['r3 owner removal not recorded', taskStore, 'if (opts?.ownerRemoval && removedGroup && !currentBase) {', 'if (false) {', 'r3 the owner removes|r3 an owner removal'],
 ['r3 sweep restores an owner-removed member', delivery + 'sweep-plan.ts', 'if (o.memory.ownerRemoved?.[id]) continue\n      if (mv?.checkpointKey === key', 'if (mv?.checkpointKey === key', 'r3 the owner removes|r3 an owner removal'],
 ['r3 missing report ignores owner record', delivery + 'sweep-plan.ts', "if (acc.status !== 'done' || o.memory.ownerRemoved?.[id]) continue", "if (acc.status !== 'done') continue", 'r3 the owner removes|r3 an owner removal'],
 ['r3 missing never reported', delivery + 'sweep-plan.ts', "if (acc.status !== 'done' || o.memory.ownerRemoved?.[id]) continue", 'continue', 'r3 a raw delete'],
 ['r3 ledger parser drops owner records', delivery + 'guards-store.ts', "for (const field of ['ownerRemoved', 'acceptedMissing'] as const) {", "for (const field of [] as unknown as readonly ['ownerRemoved']) {", 'r3 the owner removes|r3 an owner removal'],
 ['r3 forged-mark guide points at guard off', delivery + 'sweep-plan.ts', 'guide: GUIDE_FORGED_MARK,', "guide: 'agentop flow guarantee off a',", 'r3 every sweep WARN'],
 ['r3 loop guide points at guard off', delivery + 'sweep-plan.ts', 'guide: GUIDE_LOOP,', "guide: 'agentop flow guarantee off a',", 'r3 every sweep WARN'],
 ['r4 A1 service door accepts the legacy-browser owner', taskWeb, "if (guard.principal.via !== 'vault-credential') return", 'if (false) return', 'r4 A1'],
 ['r4 A1 REST door accepts the header owner', delivery + 'web.ts', "((who.principal.kind === 'owner' && who.principal.via === 'legacy-browser') || (who.mode === 'required' && who.principal.kind === 'unattributed'))", "(false || (who.mode === 'required' && who.principal.kind === 'unattributed'))", 'r4 A1'],
 ['r4 A1 REST door lets required mode without proof through', delivery + 'web.ts', "|| (who.mode === 'required' && who.principal.kind === 'unattributed')) {", '|| false) {', 'r4 A1'],
 ['r4 A2 plain removal drops the guard context', taskWeb, 'await w.store.removeSubtask(subtaskId, guard ? { guard } : undefined)', 'await w.store.removeSubtask(subtaskId)', 'r4 A2'],
 ['r4 A2 guard refusal is not translated', delivery + 'web.ts', 'if (e instanceof GuardRefused) return { status: e.status, body: { ok: false, reason: e.code', 'if (false) return { status: e.status, body: { ok: false, reason: e.code', 'r4 A2'],
 ['r4 A4 shared escape sentence cites guard off again', delivery + 'sweep-plan.ts', "export const SWEEP_ESCAPE = 'the sweep only reverts raw file writes: make the change through the board, MCP or CLI'", "export const SWEEP_ESCAPE = 'to stop the sweep from reverting: agentop flow guarantee off a'", 'r4 A4'],
 ['r4 A4 breaker text cites guard off again', delivery + 'sweep.ts', 'Descubra quem escreve cru no tasks.json; ${SWEEP_ESCAPE_PT}`', 'agentop flow guarantee off a`', 'r4 A4'],
 ['r5 D1/D2 placeholder door skips the accepted-member rule', taskWeb, "if (await w.store.acceptedMemberOf(subtaskId)) {\n    const refused = await removeAcceptedMember(w.store, subtaskId, guard)\n    return refused ?? { ok: true }", "if (false) {\n    const refused = await removeAcceptedMember(w.store, subtaskId, guard)\n    return refused ?? { ok: true }", 'r5 D1|r5 D2|r5 the CLI door'],
 ['r5 legacy-browser owner accepted for ownerRemoval (shared helper)', taskWeb, "if (guard.principal.via !== 'vault-credential') return", 'if (false) return', 'r5 D2|r5 the CLI door|r5 D1/D2 over REST'],
 ['r5 placeholder door owner removal not recorded', taskWeb, 'await store.removeSubtask(subtaskId, { ownerRemoval: guard })', 'await store.removeSubtask(subtaskId)', 'r5 the vault-proven owner|r5 D1/D2 over REST'],
 ['r5 index keeps the legacy-browser fallback for the placeholder door', 'packages/server/server/index.ts', 'const missing = reply.status === 422 &&', "const legacyFallback = { via: 'legacy-browser' }; const missing = reply.status === 422 &&", 'r5 the index no longer'],
 ['r7 F1 removeTask guard removed', taskStore, "if (accepted.length && !isVaultOwner(opts?.guard)) throw", "if (false) throw", 'r7 F1'],
 ['r7 F1 removeTask accepts any owner', taskStore, "if (accepted.length && !isVaultOwner(opts?.guard)) throw", "if (accepted.length && opts?.guard?.principal.kind !== 'owner') throw", 'r7 F1'],
 ['r7 F1 group removal guard removed', taskStore, "if (acceptedInGroup.length && !isVaultOwner(opts?.ownerRemoval ?? opts?.guard)) throw", "if (false) throw", 'r7 F1 store: deleting a GROUP'],
 ['r7 F1 owner delete not recorded', taskStore, "await recordOwnerRemoval(accepted)", "void 0", 'r7 F1 store: only the vault'],
 ['r7 F1 REST door lets the header owner delete', delivery + 'web.ts', "if ((who.principal.kind === 'owner' && who.principal.via === 'legacy-browser') || (who.mode === 'required' && who.principal.kind === 'unattributed')) {\n    return { status: 403, body: { ok: false, reason: 'owner_proof_required', message: 'This task holds", "if (false) {\n    return { status: 403, body: { ok: false, reason: 'owner_proof_required', message: 'This task holds", 'r7 F1 REST'],
 ['r7 F1 route drops the guard context', taskWeb, '}, held), guard ? { guard } : undefined)', '}, held))', 'r7 F1 doors'],
 ['r7 F2 reopen guard removed', taskStore, "(prior.status === 'done' && next.status !== 'done') ||", "false ||", 'r7 F2 store: reopening'],
 ['r7 F3 leaving the group allowed', taskStore, "next.parentGroupId !== prior.parentGroupId)) {", "false)) {", 'r7 F3'],
 ['r7 F4 route ignores the path ref', 'packages/server/server/index.ts', "mod.subtaskPathCheck(ref, body.id)", "'ok'", 'r7 F4'],
 ['r8 B individual accepted member removable by anyone', taskStore, "if (acceptedSelf.length && !isVaultOwner(opts?.ownerRemoval ?? opts?.guard)) throw", "if (false) throw", 'r8 B'],
 ['r8 C exemption extended to every upsert (any principal, any piece)', taskStore, "classifyExempt = exempt ? new Set([exempt]) : undefined", "classifyExempt = new Set([t.id])", 'r8 C'],
 ['r8 C exemption not limited to the vault owner (guard A)', delivery + 'guard-host.ts', "o.ctx.principal.kind === 'owner' && o.ctx.principal.via === 'vault-credential' && !!o.exemptClassification?.has(r.key)", "!!o.exemptClassification?.has(r.key)", 'r8 C'],
 ['r8 D route decodes unsafely again', 'packages/server/server/index.ts', "const ref = safeDecodePath(url.pathname.slice('/api/tasks/'.length))\n      if (ref === null) return json({ error: 'bad_path', message: 'The address contains an invalid %-escape; send the id URL-encoded.' }, 400)\n      const { deleteTask }", "const ref = decodeURIComponent(url.pathname.slice('/api/tasks/'.length))\n      const { deleteTask }", 'r8 D'],
 ['r8 D tick ignores the session proof again', 'packages/server/server/index.ts', "Object.keys(body).filter(k => k !== 'session').length === 2", "Object.keys(body).length === 2", 'r8 D'],
 ['r9 D global bad-path gate removed', 'packages/server/server/host-allow.ts', "if (parsed.pathname.startsWith('/api/')) {", 'if (false) {', 'r9 D'],
 ['r9 D evidence route decodes unsafely again', 'packages/server/server/index.ts', 'safeDecodePath(evidenceRoute[1]!)', 'decodeURIComponent(evidenceRoute[1]!)', 'r9 D'],
 ['r5 restore text tells the user to turn the guarantee off', 'packages/server/server/backup/restore.ts', 'Restore the other files from the backup and re-create', 'Turn the guarantee off first, then restore the other files from the backup and re-create', 'r5 docs and restore'],
 ['r5 docs cite the old guide again', 'docs/delivery-store-guard.md', 'a guide that tells the person to find who writes', 'guide `agentop flow guarantee off a`; a guide that tells the person to find who writes', 'r5 docs and restore'],
]
for (const [id, file, from, to, pattern] of mutants) test(`s2b1 mutant ${id} is killed`, async () => {
 reset(); change(file, from, to)
 try {
   const result = await run([suite], pattern)
   console.log(`${id}: exit ${result.code}\n${result.output}`)
   expect(result.code, result.output).toBe(1)
   expect(result.output).toContain('(fail)')
   expect(result.output).toContain('expect(received)')
 } finally { reset() }
}, 150_000)
test('s2b1 mutation positive control', async () => {
 reset()
 const result = await run([suite])
 expect(result.code, result.output).toBe(0)
}, 150_000)
