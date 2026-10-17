/**
 * newProjectApi.ts — the one call that creates a project folder.
 *
 * `POST /api/fs/folders {parent, name}` — the same route that LISTS folders for the browser, so the
 * allowlist that decides what may be browsed is the one that decides where a folder may be created.
 * Every refusal comes back as a code; the sentence is `projectNameMessage`'s.
 */
import { isCreateFolderRefusal, type CreateFolderRefusal } from '@agentistics/core'

export type { CreateFolderRefusal }
export type CreateFolderResult = { ok: true; path: string } | { ok: false; reason: CreateFolderRefusal; path?: string }

export async function createProjectFolder(parent: string, name: string, createParent = false): Promise<CreateFolderResult> {
  try {
    const res = await fetch('/api/fs/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name, createParent }),
    })
    const body = await res.json().catch(() => ({})) as { path?: unknown; error?: unknown }
    const path = typeof body.path === 'string' && body.path !== '' ? body.path : undefined
    if (res.ok && path) return { ok: true, path }
    return toRefusal(body.error, path)
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/** A refusal the route can answer with keeps its code; anything else — `csrf_blocked`,
 *  `capability_disabled`, a 500's correlation body, no body at all — is `failed`, which has a sentence.
 *  Only a real `exists` carries the path the form offers to reuse. */
export function toRefusal(error: unknown, path?: string): CreateFolderResult {
  const reason: CreateFolderRefusal = isCreateFolderRefusal(error) ? error : 'failed'
  return { ok: false, reason, ...(reason === 'exists' && path ? { path } : {}) }
}
