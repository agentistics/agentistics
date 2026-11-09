/** Read-only replay of QA r7. All status changes below are on parsed, in-memory copies. No server, git, gh or real store. */
import { join } from 'node:path'
import { buildLive } from '../server/sessions/task-live'
import { describeLive } from '../server/sessions/task-live-view'
import { buildTaskDetail, rowsOfTask, subtaskHasSession } from '../server/sessions/task-report'
import { boardReviewTargets } from '../server/delivery/review-board'
import { createDeliveryService } from '../server/delivery/service'
import { hintsFromHandbacks } from '../server/delivery/batch-proof'
import type { TaskBook } from '../server/sessions/task-model'
import type { DeliveryDoc } from '../server/delivery/store'
import type { GateFacts } from '../server/delivery/gates'

const source = process.argv[2]
if (!source) throw new Error('usage: bun packages/server/scripts/reconcile-r8-evidence.ts <qa-reconcile-2-r7 evidence directory>')
const json = (file: string) => Bun.file(join(source, file)).json()
const book: TaskBook = await json('fixture/tasks.json')
const bookPieces = book.tasks.length + book.subtasks.length
const registry = await json('fixture/managed-sessions.json')
const doc: DeliveryDoc = await json('deliveries-before-run1.json')
const capturedBefore = await json('live-before.json')
const capturedAfter = await json('live-after-run1.json')
const capturedDry = await json('dry-run-1.json')
const moved = await json('run1-moved-keys.json')
const nowMs = Date.parse(capturedBefore.generatedAt)
const liveIds = new Set<string>(capturedBefore.deliveries.flatMap((d: { sessionIds: string[] }) => d.sessionIds))
// Registry copies do not carry process liveness. Use the captured Live's live session ids at this fixed clock.
const rows = registry.filter((r: { taskId?: string }) => r.taskId).map((r: { id: string; endedAt?: string }) => ({ ...r, endedAt: liveIds.has(r.id) ? undefined : r.endedAt ?? capturedBefore.generatedAt }))
const alive = rows.filter((r: { endedAt?: string }) => !r.endedAt).map((r: object) => ({ ...r, alive: true }))
const service = createDeliveryService({
  store: { path: '<in-memory evidence copy>', read: async () => doc, get: async id => doc.deliveries[id] ?? null, update: async fn => fn(doc) },
  now: () => nowMs, autonomous: async () => true,
  facts: {
    sessions: async () => alive,
    subtask: async () => null,
    repoCwd: async () => '<evidence>',
    // The captured r7 run has ZERO PR matches and release transitions. Reproduce its empty merged-PR lists.
    gh: async () => '[]', git: async () => { throw new Error('no git evidence in this replay') },
  } as unknown as GateFacts,
  board: { setPhaseStatus: async () => ({ ok: true }), setCi: async () => {}, logStep: async () => {}, comment: async () => {}, subtaskFinished: async () => false, stage: async () => ({ ok: true }) },
  notify: { session: async () => false, owner: async () => {} }, emit: async () => {},
  reviewPieces: async () => boardReviewTargets(book).map(p => {
    const handbacks = book.comments.filter(c => (c.subtaskId ?? c.taskId) === p.id && c.kind === 'handback').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const repos = [...new Set<string>(registry.filter((r: { subtaskId?: string; taskId?: string; role?: string }) => (r.subtaskId ?? r.taskId) === p.id && r.role !== 'leader').flatMap((r: { repo?: { repo?: string } }) => r.repo?.repo ? [r.repo.repo] : []))]
    // Preserve the exact lookup domain recorded by r7, including directories resolved by its host.
    const captured = capturedDry.entries.find((e: { subtaskId: string }) => e.subtaskId === p.id)
    if (captured?.unchecked === 'no-repos') repos.length = 0
    else if (captured && !repos.length) repos.push('example/fixture-repo')
    return { ...p, repos, handbackAt: handbacks.at(-1)?.createdAt, hints: hintsFromHandbacks(handbacks.map(c => ({ body: c.body, atMs: Date.parse(c.createdAt) }))) }
  }),
  hasSession: async id => { const p = book.subtasks.find(s => s.id === id) ?? book.tasks.find(t => t.id === id); return !!p && ('taskId' in p ? subtaskHasSession({ id: p.taskId }, id, rows) : rowsOfTask(p, rows).length > 0) },
  closeLegacy: async (id, to) => {
    const p = book.subtasks.find(s => s.id === id) ?? book.tasks.find(t => t.id === id)
    if (!p) return { ok: false, message: 'missing evidence piece' }
    // Honor the board's existing completion gate; archive remains available for unfiled non-code work.
    const hasSession = 'taskId' in p ? subtaskHasSession({ id: p.taskId }, id, rows) : rowsOfTask(p, rows).length > 0
    if (to === 'done' && !hasSession) return { ok: false, message: 'done_needs_session' }
    p.status = to; p.updatedAt = new Date(nowMs).toISOString()
    if ('done' in p) p.done = to === 'done'
    return { ok: true }
  },
})
const dry = await service.reconcile({}, 'owner')
if (!dry.ok) throw new Error(dry.sentence)
const { outcomes } = await service.proofOutcomes()
const view = () => describeLive({
  reply: buildLive({
    details: book.tasks.map(task => buildTaskDetail({ task, attempts: book.attempts, rows, metas: new Map(), costOf: () => 0, comments: book.comments.filter(c => c.taskId === task.id), subtasks: book.subtasks.filter(s => s.taskId === task.id), files: [] })),
    events: book.events, nowMs, deliveries: new Map(Object.entries(doc.deliveries)), statusLabel: id => book.statuses.find(s => s.id === id)?.label,
    proven: new Set([...outcomes].filter(([, o]) => o.proven).map(([id]) => id)),
    suggestions: new Map([...outcomes].flatMap(([id, o]) => o.suggestion ? [[id, o.suggestion] as const] : [])),
    unchecked: new Set([...outcomes].filter(([, o]) => o.unchecked).map(([id]) => id)),
    uncheckedWhy: new Map([...outcomes].flatMap(([id, o]) => o.unchecked ? [[id, o.unchecked] as const] : [])),
  }), rows: [], leaderIds: new Set(), nowMs, filters: { period: 'all' },
})
const before = view()
const screenIds = before.deliveries.filter(d => d.old).map(d => d.subtaskId ?? d.taskId).sort()
const dryIds = dry.entries.filter(e => e.bucket === 'antiga').map(e => e.subtaskId).sort()
if (JSON.stringify(screenIds) !== JSON.stringify(dryIds)) throw new Error(`screen/dry set mismatch: screen only ${screenIds.filter(id => !dryIds.includes(id))}; dry only ${dryIds.filter(id => !screenIds.includes(id))}`)
const out = await service.antigas({ action: 'conclude', all: true, expect: screenIds.length }, 'owner')
if (!out.ok) throw new Error('evidence action refused')
if (JSON.stringify(out.done.map(d => d.subtaskId).sort()) !== JSON.stringify(screenIds)) throw new Error('screen/action set mismatch')
const afterComplete = view()
const afterCompleteDry = await service.reconcile({}, 'owner')
if (!afterCompleteDry.ok) throw new Error(afterCompleteDry.sentence)
if (afterCompleteDry.summary.antigas !== afterComplete.deliveries.filter(d => d.old).length) throw new Error('remaining count differs after completion')
for (const d of out.done) if (d.ok && d.how !== 'archived' && !afterComplete.deliveries.some(c => (c.subtaskId ?? c.taskId) === d.subtaskId && c.stage === 'completed')) throw new Error(`completed card vanished: ${d.subtaskId}`)
const archived = { done: out.done.filter(d => d.ok && d.how === 'archived') } // one click: no second step
const after = view()
if (book.tasks.length + book.subtasks.length !== bookPieces) throw new Error('a board piece was deleted')
const afterDry = await service.reconcile({}, 'owner')
if (!afterDry.ok) throw new Error(afterDry.sentence)
if (after.deliveries.some(d => d.old) || afterDry.summary.antigas !== 0) throw new Error('old pieces remain after the complete in-memory run')
for (const d of out.done) if (d.ok && d.how !== 'archived' && !after.deliveries.some(c => (c.subtaskId ?? c.taskId) === d.subtaskId && c.stage === 'completed')) throw new Error(`completed card vanished: ${d.subtaskId}`)
const stages = ['queue', 'running', 'qa', 'adjust', 'leader', 'merge', 'ci', 'completed', 'published']
const report = (name: string, v: typeof before, count: number | null) => ({ name, antiga: v.deliveries.filter(d => d.old).length, dry: count, ...Object.fromEntries(stages.map(s => [s, v.deliveries.filter(d => d.stage === s).length])), all: v.deliveries.length })
console.log('ASSUMPTIONS: QA r7 copied fixture; clock fixed at live-before.generatedAt; liveness from captured sessionIds; no tag proofs; empty PR lists reproduce the captured zero-match run. Actions mutate memory only. ONE click (conclude): pieces with a session complete, the others are archived, none deleted.')
console.table([
  report('r7 captured before', capturedBefore, capturedDry.summary.antigas),
  report('r7 captured after', capturedAfter, null),
  report('r8 replay before', before, dry.summary.antigas),
  report('r8 after complete', afterComplete, afterCompleteDry.summary.antigas),
  report('r8 replay after', after, afterDry.summary.antigas),
])
console.log('Completion attempts:', out.done.length, 'completed:', out.done.filter(d => d.ok).length, 'refused:', out.done.filter(d => !d.ok).length, 'archived in the same click:', archived.done.length, 'Same screen/dry/action ids: true')
const r6 = await Bun.file(join(source, '..', 'qa-reconcile-2-r6', 'live-fixture-1.json')).json()
const r6Old = new Set<string>(r6.deliveries.filter((d: { old?: boolean }) => d.old).map((d: { key: string }) => d.key))
const r7Old = new Set<string>(capturedBefore.deliveries.filter((d: { old?: boolean }) => d.old).map((d: { key: string }) => d.key))
const gained = capturedBefore.deliveries.filter((d: { old?: boolean; key: string }) => d.old && !r6Old.has(d.key))
const noRepoGains = gained.filter((d: { subtaskId: string }) => capturedDry.entries.some((e: { subtaskId: string; unchecked?: string }) => e.subtaskId === d.subtaskId && e.unchecked === 'no-repos'))
const otherGains = gained.filter((d: object) => !noRepoGains.includes(d))
const removed = [...r6Old].filter(key => !r7Old.has(key))
if (r6Old.size !== 134 || r7Old.size !== 171 || noRepoGains.length !== 42 || otherGains.length !== 1 || removed.length !== 6) throw new Error('historical arithmetic differs from r6/r7 evidence')
console.log('Historical counts:', `${r6Old.size} + ${noRepoGains.length} no-repos cache differences + ${otherGains.length} handback aged past 7d - ${removed.length} task exclusions = ${r7Old.size}`)
for (const d of otherGains) {
  const last = book.comments.filter(c => c.kind === 'handback' && c.subtaskId === d.subtaskId).map(c => c.createdAt).sort().at(-1)
  console.log('7-day crossing:', d.subtaskId, last, 'r6 clock', r6.generatedAt, 'r7 clock', capturedBefore.generatedAt)
}
console.table(moved.notPub.map((s: string) => {
  const id = s.split(' ')[0]
  const p = book.subtasks.find(s => s.id === id)
  return { id, group: !!p?.isGroup, before: before.deliveries.find(d => d.subtaskId === id)?.stage ?? 'not a review card', after: after.deliveries.find(d => d.subtaskId === id)?.stage ?? (p?.status === 'abandoned' ? 'explicitly archived' : 'not a review card'), moved: screenIds.includes(id!) }
}))
const realLive = await json('real-live.json')
console.table(realLive.deliveries.filter((d: { subtaskId: string | null; stage: string }) => !d.subtaskId && d.stage === 'leader').map((d: { taskId: string; title: string }) => ({ id: d.taskId, title: d.title, before: before.deliveries.find(c => c.taskId === d.taskId && c.subtaskId === null)?.stage ?? 'container; children are the cards', antiga: screenIds.includes(d.taskId), after: after.deliveries.find(c => c.taskId === d.taskId && c.subtaskId === null)?.stage ?? (book.tasks.find(t => t.id === d.taskId)?.status === 'abandoned' ? 'explicitly archived (no filed session)' : 'container; children are the cards') })))
