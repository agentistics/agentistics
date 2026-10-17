/**
 * newProjectApi.ts — the one call that creates a project folder.
 *
 * `POST /api/fs/folders {parent, name}` — the same route that LISTS folders for the browser, so the
 * allowlist that decides what may be browsed is the one that decides where a folder may be created.
 * Every refusal comes back as a code; the sentence is `projectNameMessage`'s.
 */
import type { ProjectNameRefusal } from '@agentistics/core'

export type CreateFolderRefusal = ProjectNameRefusal | 'exists' | 'forbidden' | 'parent-missing' | 'failed'
export type CreateFolderResult = { ok: true; path: string } | { ok: false; reason: CreateFolderRefusal; path?: string }

export async function createProjectFolder(parent: string, name: string, createParent = false): Promise<CreateFolderResult> {
  try {
    const res = await fetch('/api/fs/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name, createParent }),
    })
    const body = await res.json().catch(() => ({})) as { path?: string; error?: CreateFolderRefusal }
    if (res.ok && body.path) return { ok: true, path: body.path }
    return { ok: false, reason: body.error ?? 'failed', ...(body.path ? { path: body.path } : {}) }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
