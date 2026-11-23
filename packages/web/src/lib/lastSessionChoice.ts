/**
 * lastSessionChoice.ts — what the person picked on step 1 of the LAST session they created.
 *
 * Owner 2026-11-23: opening "new session" should come with the previous creation's assistant, model,
 * effort and mode already chosen — step 1 ONLY. The later steps and the title always start empty.
 *
 * A CHOICE, so it lives in the person's own preferences (`/api/user-prefs`, key `newSessionLast`).
 * It is written from ONE place — the wizard's own successful create — so a session started by an
 * assistant (MCP / CLI) can never overwrite what the person chose.
 *
 * Reading is TOTAL and silent: a stored value that is junk, or names an assistant this machine can no
 * longer start, yields nothing for that field and the wizard falls back to today's defaults.
 */
import { createPersonalDoc } from './sharedPref'
import { CANONICAL_MODES, type CanonicalMode } from '@agentistics/core'

export interface LastSessionChoice {
  harnessId: string
  nativeProvider: string
  model: string
  effort: string
  mode: CanonicalMode
}

const doc = createPersonalDoc('agentistics-new-session-last-v1', 'newSessionLast')

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** PURE: a stored document as a choice, or null when there is nothing usable. */
export function parseLastChoice(stored: unknown): LastSessionChoice | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  const o = stored as Record<string, unknown>
  const harnessId = str(o.harnessId)
  if (!harnessId) return null
  const mode = (CANONICAL_MODES as readonly string[]).includes(str(o.mode)) ? (o.mode as CanonicalMode) : 'default'
  return { harnessId, nativeProvider: str(o.nativeProvider), model: str(o.model), effort: str(o.effort), mode }
}

/**
 * PURE: the remembered choice, kept only if its assistant is still offered. Model, effort and mode
 * are validated against the chosen assistant by the wizard's own "what survives a change of
 * assistant" rule, so they are not second-guessed here.
 */
export function usableLastChoice(
  stored: unknown, offered: readonly { id: string }[] | null,
): LastSessionChoice | null {
  const c = parseLastChoice(stored)
  if (!c || !offered || !offered.some(h => h.id === c.harnessId)) return null
  return c
}

export const readLastChoice = (): LastSessionChoice | null => parseLastChoice(doc.get())

/** Called by the wizard after the PERSON's create succeeded — never by anything else. */
export function rememberLastChoice(c: LastSessionChoice): void {
  doc.set({ ...c })
}
