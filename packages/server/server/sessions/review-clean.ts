/** Audit-first cleanup of owner conversations that landed in the review board. */
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TASKS_FILE } from '../config'
import { loadTaskWorld } from './task-source'
import { newCommentId, type TaskComment } from './task-model'
import { ownerIntent } from '../flows/owner-intent'

export interface ReviewCleanEntry {
  taskId: string; taskTitle: string; subtaskId: string | null; subtaskTitle: string | null; status: string
  conversationIds: string[]; text: string; sessionIds: string[]; comments: Array<{ id: string; author: string; body: string; createdAt: string }>
  record: unknown | null; action: 'report-only' | 'abandoned'; reason: string
}
export interface ReviewCleanPlan { version: 1; generatedAt: string; source: string; entries: ReviewCleanEntry[]; summary: { total: number; reportOnly: number; abandoned: number } }
const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/** Only these shapes count as proof; prose containing "pr" is never evidence. */
export function hasStructuralProof(record: any, comments: readonly { kind?: string; role?: string; body: string }[]): boolean {
  if (record && (record.pr !== undefined || record.mergeSha || record.headSha || record.qaSha || record.tag || record.releaseRepo || record.declaredRelease || record.mergeDetected || record.ci)) return true
  return comments.some(c => c.kind === 'handback' && c.role === 'session') || comments.some(c => /(?:#\d+\b|\b[0-9a-f]{7,40}\b|https?:\/\/[^\s/]+\/[^\s/]+\/pull\/\d+\b)/i.test(c.body))
}

/** The owner-request classifier is the source of truth, with the three known conversational forms
 * called out because they are replies/questions despite polite words such as "precisa". */
export function ownerConversationIsWork(text: string): boolean {
  const t = norm(text)
  if (/^precisa de algo meu\??$/.test(t) || /^(mandei|eu vou dormir)\b/.test(t)) return false
  if (/^explora\s+todas\s+as\s+pocs\b/.test(t)) return true
  return ownerIntent(text) === 'work'
}

export async function buildReviewCleanPlan(): Promise<ReviewCleanPlan> {
  const world = await loadTaskWorld()
  const records = await (async () => { try { return (await (await import('../delivery/store')).createDeliveryStore().read()).deliveries } catch { return {} } })()
  const entries: ReviewCleanEntry[] = []
  for (const task of world.book.tasks) {
    const subs = world.book.subtasks.filter(s => s.taskId === task.id)
    const pieces = subs.length ? subs.map(sub => ({ sub, status: sub.status, title: sub.title })) : [{ sub: null, status: task.status, title: task.title }]
    for (const piece of pieces) {
      if (!['in_review', 'revisao_lider'].includes(piece.status)) continue
      const subtaskId = piece.sub?.id ?? null
      const sessions = world.rollupRows.filter(r => r.taskId === task.id && (subtaskId === null || r.subtaskId === subtaskId))
      const comments = world.book.comments.filter(c => c.taskId === task.id && (c.subtaskId ?? null) === subtaskId)
      entries.push({ taskId: task.id, taskTitle: task.title, subtaskId, subtaskTitle: piece.sub?.title ?? null, status: piece.status, conversationIds: [],
        text: [task.detail, piece.sub?.notes, ...comments.map(c => c.body)].filter(Boolean).join('\n\n'), sessionIds: sessions.map(s => s.id),
        comments: comments.map(c => ({ id: c.id, author: c.author, body: c.body, createdAt: c.createdAt })), record: subtaskId ? records[subtaskId] ?? null : records[task.id] ?? null,
        action: 'report-only', reason: 'pending classification' })
      const entry = entries.at(-1)!
      const record = entry.record as any
      const hasWork = sessions.length > 0
      const hasProof = hasStructuralProof(record, comments)
      const ownerRequestText = [piece.sub?.notes, task.detail, ...comments.filter(c => c.role === 'owner').map(c => c.body)].filter(Boolean).join('\n')
      if (!hasWork && !hasProof && (record?.pedidoIds?.length || ownerRequestText) && !ownerConversationIsWork(ownerRequestText)) {
        entry.action = 'abandoned'; entry.reason = 'owner conversation, not work'
      } else if (!hasWork && !hasProof) {
        entry.reason = `not safe to consolidate: request identity is not provable (title=${norm(piece.title)})`
      } else entry.reason = 'work or delivery proof exists'
    }
  }
  const abandoned = entries.filter(e => e.action === 'abandoned').length
  return { version: 1, generatedAt: new Date().toISOString(), source: TASKS_FILE, entries, summary: { total: entries.length, reportOnly: entries.length - abandoned, abandoned } }
}
function lines(p: ReviewCleanPlan): string[] { return [`Review cleanup plan ${p.generatedAt}`, `source: ${p.source}`, `pieces: ${p.summary.total} · report-only: ${p.summary.reportOnly} · abandoned: ${p.summary.abandoned}`, ...p.entries.map(e => `${e.action}\t${e.taskId}${e.subtaskId ? `/${e.subtaskId}` : ''}\t${e.taskTitle}${e.subtaskTitle ? ` · ${e.subtaskTitle}` : ''}\t${e.reason}`)] }

export async function runReviewClean(argv: readonly string[]): Promise<number> {
  const applyAt = argv.indexOf('--apply'), outAt = argv.indexOf('--out'), json = argv.includes('--json')
  if (applyAt >= 0) {
    const file = argv[applyAt + 1]
    if (!file) { console.error('--apply requires the JSON plan produced by a dry-run'); return 2 }
    const raw = await Bun.file(file).text().catch(() => '')
    if (!raw) { console.error(`plan not found: ${file}`); return 2 }
    const plan = JSON.parse(raw) as ReviewCleanPlan
    const world = await loadTaskWorld()
    const deliveryStore = (await import('../delivery/store')).createDeliveryStore()
    const pending = plan.entries.filter(e => e.action === 'abandoned').filter(e => e.subtaskId
      ? world.book.subtasks.some(s => s.id === e.subtaskId && s.status !== 'abandoned')
      : world.book.tasks.some(t => t.id === e.taskId && t.status !== 'abandoned'))
    if (pending.length === 0) { console.log(JSON.stringify({ ok: true, changed: 0, plan: file, idempotent: true }, null, 2)); return 0 }
    const backup = `${TASKS_FILE}.review-clean-${Date.now()}.bak`; await copyFile(TASKS_FILE, backup)
    let changed = 0
    const skipped: string[] = []
    for (const e of pending) {
      const currentSub = e.subtaskId ? world.book.subtasks.find(s => s.id === e.subtaskId) : null
      const currentTask = world.book.tasks.find(t => t.id === e.taskId)
      const currentStatus = currentSub?.status ?? currentTask?.status
      const currentSessions = world.rollupRows.filter(r => r.taskId === e.taskId && (!e.subtaskId || r.subtaskId === e.subtaskId))
      const currentRecord = e.subtaskId ? (await deliveryStore.get(e.subtaskId)) : null
      const currentComments = world.book.comments.filter(c => c.taskId === e.taskId && (c.subtaskId ?? null) === (e.subtaskId ?? null))
      if (currentStatus !== e.status || currentSessions.length > 0 || hasStructuralProof(currentRecord, currentComments)) { skipped.push(`${e.taskId}${e.subtaskId ? `/${e.subtaskId}` : ''}`); continue }
      if (e.subtaskId) { if (!currentSub || currentSub.status === 'abandoned') continue; await world.store.upsertSubtask({ ...currentSub, status: 'abandoned', updatedAt: new Date().toISOString() }) }
      else { if (!currentTask || currentTask.status === 'abandoned') continue; await world.store.patchTask(currentTask.id, { status: 'abandoned', updatedAt: new Date().toISOString() }) }
      if (e.subtaskId && currentRecord && !currentRecord.dequeued) {
        await deliveryStore.update(doc => { const rec = doc.deliveries[e.subtaskId!]; if (rec && !rec.dequeued) rec.dequeued = { at: new Date().toISOString(), actor: 'agentop tasks limpar-revisao', reason: 'owner conversation, not work' } })
      }
      const c: TaskComment = { id: newCommentId(), taskId: e.taskId, ...(e.subtaskId ? { subtaskId: e.subtaskId } : {}), author: 'agentop tasks limpar-revisao', body: `abandoned: ${e.reason}. Canonical piece: ${e.taskId}${e.subtaskId ? `/${e.subtaskId}` : ''}`, createdAt: new Date().toISOString() }
      await world.store.addComment(c); changed++
    }
    console.log(JSON.stringify({ ok: true, changed, skipped, backup, plan: file }, null, 2)); return 0
  }
  const plan = await buildReviewCleanPlan(); const target = outAt >= 0 && argv[outAt + 1] ? argv[outAt + 1]! : join(process.cwd(), `.agentistics-review-clean-${Date.now()}.json`)
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(plan, null, 2) + '\n', 'utf8')
  if (json) console.log(JSON.stringify({ ...plan, planFile: target }, null, 2)); else console.log([...lines(plan), `plan: ${target}`, 'dry-run: no board changes were made'].join('\n'))
  return 0
}
