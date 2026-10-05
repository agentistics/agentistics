/**
 * createPlan.ts — what the create form may submit, as pure rules (the dialog draws; this decides).
 *
 * Title is the one required field, trimmed like a rename (`planRename`'s rule: no blank task, bounded).
 * The description is MARKDOWN — the editor formats as you type but what is stored is the markdown text,
 * exactly what `DeliveryDetail`'s description editor and every reader already handle — and is omitted
 * when it is empty rather than stored as whitespace. Status defaults to `todo`; type is optional.
 */
/** The longest title a task may carry (the same bound a rename uses). */
export const TITLE_MAX = 200

export interface CreateDraft { title: string; type: string; status: string; detail: string }
export type CreatePlan =
  | { ok: true; title: string; detail?: string; type?: string; status: string }
  | { ok: false; reason: 'title' }

export const DEFAULT_CREATE_STATUS = 'todo'

export function planCreate(d: CreateDraft): CreatePlan {
  const title = d.title.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)
  if (!title) return { ok: false, reason: 'title' }
  const detail = d.detail.replace(/ /g, ' ').trim()
  return {
    ok: true, title,
    ...(detail ? { detail } : {}),
    ...(d.type ? { type: d.type } : {}),
    status: d.status || DEFAULT_CREATE_STATUS,
  }
}
