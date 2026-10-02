/**
 * evidence.ts — the task Evidence feed on the web: the wire shape, its grouping for the gallery, and
 * the hook. PURE except `useEvidence`.
 *
 * ONE STORE: an item is a file in the chat's own attachment store, so it is served by the same
 * `/api/fleet/attachment` route the chat thumbnails use (`attachmentUrl`) — which also serves video and
 * PDF, unlike the by-name route. `GET /api/tasks/evidence` (server `task-evidence-gallery.ts`) is the
 * only thing that decides which files are evidence; this file only arranges them.
 */
import { useCallback, useEffect, useState } from 'react'
import { attachmentUrl } from './attachmentUrl'
import { fileFormat, type GalleryGroup } from './gallery'
import { attachmentKind } from './messageAttachments'

export type EvidenceOrigin = 'sessions' | 'mine'
export type EvidenceScope = 'all' | EvidenceOrigin

export interface EvidenceItem {
  name: string
  path: string
  origin: EvidenceOrigin
  taskId: string | null
  subtaskId: string | null
  /** The session that produced it (a managed id for `sessions`, a conversation id for `mine`). */
  sessionId: string | null
  author: string
  createdAt: string
  taskTitle: string | null
}

/** How many of each origin — drives the segmented control, which is drawn only when BOTH have files. */
export function evidenceSides(items: readonly EvidenceItem[]): { mine: number; sessions: number } {
  let mine = 0; let sessions = 0
  for (const e of items) { if (e.origin === 'mine') mine++; else sessions++ }
  return { mine, sessions }
}

/** A stored scope whose side is empty falls back to everything — the gallery's own `effectiveScope` rule. */
export function effectiveEvidenceScope(scope: EvidenceScope, sides: { mine: number; sessions: number }): EvidenceScope {
  if (scope === 'mine' && sides.mine === 0) return 'all'
  if (scope === 'sessions' && sides.sessions === 0) return 'all'
  return scope
}

export function filterEvidence(items: readonly EvidenceItem[], scope: EvidenceScope, taskId: string | null): EvidenceItem[] {
  return items.filter(e => (scope === 'all' || e.origin === scope) && (taskId === null || e.taskId === taskId))
}

/** The short handle a row shows for the producing session — what `agentop session attach <id>` resolves. */
export const sessionHandle = (id: string | null): string => (id ? id.replace(/^agentop-/, '').slice(0, 8) : '')

/**
 * One GalleryGroup per (task, session, note-moment): a worker's three screenshots from one comment are
 * ONE group, headed by the TASK, with the producing session on the text line — "who took this".
 */
export function evidenceGroups(items: readonly EvidenceItem[], pt: boolean): GalleryGroup[] {
  const groups: GalleryGroup[] = []
  const at = new Map<string, GalleryGroup>()
  for (const e of items) {
    const key = `${e.taskId ?? '-'}|${e.origin}|${e.sessionId ?? '-'}|${e.createdAt}`
    let g = at.get(key)
    if (!g) {
      const who = e.origin === 'mine'
        ? (pt ? 'enviado por você' : 'sent by you')
        : `${pt ? 'sessão' : 'session'} ${sessionHandle(e.sessionId)}${e.subtaskId ? (pt ? ' · subtarefa' : ' · subtask') : ''}`
      g = {
        index: groups.length, at: e.createdAt, text: who, files: [],
        taskTitle: e.taskTitle ?? (pt ? 'Sem tarefa' : 'No task'),
      }
      at.set(key, g); groups.push(g)
    }
    g.files.push({
      path: e.path, name: e.name, kind: attachmentKind(e.name), format: fileFormat(e.name), url: attachmentUrl(e.path),
    })
  }
  // Grouped BY TASK: the newest group of each task leads, the rest of that task's follow it.
  const order = new Map<string, number>()
  groups.forEach(g => { const t = g.taskTitle ?? ''; if (!order.has(t)) order.set(t, order.size) })
  groups.sort((a, b) => (order.get(a.taskTitle ?? '') ?? 0) - (order.get(b.taskTitle ?? '') ?? 0))
  return groups.map((g, i) => ({ ...g, index: i }))
}

export function useEvidence(task?: string) {
  const [items, setItems] = useState<EvidenceItem[] | null>(null)
  const [error, setError] = useState(false)
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/evidence${task ? `?task=${encodeURIComponent(task)}` : ''}`)
      if (!res.ok) { setError(true); setItems([]); return }
      const body = await res.json() as { items?: EvidenceItem[] }
      setError(false); setItems(body.items ?? [])
    } catch { setError(true); setItems([]) }
  }, [task])
  useEffect(() => { void load() }, [load])
  return { items, error, reload: load }
}
