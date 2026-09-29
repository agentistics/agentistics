/**
 * structured/request.ts — what a caller asks for (`StructuredRequest`) and the retry policy as a pure
 * function of the attempt number (TOOL.1, spec §6.1).
 *
 * `maxRetries` counts the attempts AFTER the first, so a run makes at most `maxRetries + 1` attempts.
 * Default 2; anything above 5 (or not a non-negative integer) is refused at request time, before any
 * provider call — the same moment an unsupported or unsatisfiable schema is refused. `maxRetries` is
 * not what bounds the money a run spends: each retry is a separate billed response, and the run's own
 * limits (turns, tool calls, wall time — and ORC.1's ceiling once it exists) are the bound.
 */

import { compileSchema, type Schema } from './schema.ts'

export const DEFAULT_MAX_RETRIES = 2
export const MAX_RETRIES_CEILING = 5

export interface StructuredRequest {
  /** A schema in the supported subset (`./schema.ts`). */
  schema: unknown
  /** Attempts after the first. Default 2, at most 5. */
  maxRetries?: number
}

export interface PreparedStructured {
  schema: Schema
  maxRetries: number
  /** `maxRetries + 1`. */
  maxAttempts: number
}

export type PrepareResult =
  | { ok: true; prepared: PreparedStructured }
  /**
   * `code`: `max-retries` (the number is out of range), `unsupported` (a keyword or shape outside the
   * subset), `unsatisfiable` (in the subset, but no value can match it). `sentence` joins every
   * problem; `problems` keeps them apart for a screen that lists them.
   */
  | { ok: false; code: 'max-retries' | 'unsupported' | 'unsatisfiable'; sentence: string; problems: string[] }

export function prepareStructured(req: StructuredRequest): PrepareResult {
  const n = req.maxRetries ?? DEFAULT_MAX_RETRIES
  if (!Number.isInteger(n) || n < 0 || n > MAX_RETRIES_CEILING) {
    const problem = `maxRetries must be a whole number from 0 to ${MAX_RETRIES_CEILING}; ${String(n)} was asked for, so no model call was made.`
    return { ok: false, code: 'max-retries', sentence: problem, problems: [problem] }
  }
  const c = compileSchema(req.schema)
  if (!c.ok) {
    const head = c.unsatisfiable
      ? 'The structured-result schema can never be satisfied, so no model call was made:'
      : 'The structured-result schema is outside the supported subset, so no model call was made:'
    return {
      ok: false,
      code: c.unsatisfiable ? 'unsatisfiable' : 'unsupported',
      sentence: `${head} ${c.problems.join(' ')}`,
      problems: c.problems,
    }
  }
  return { ok: true, prepared: { schema: c.schema, maxRetries: n, maxAttempts: n + 1 } }
}

export type AttemptDecision = 'accept' | 'retry' | 'exhausted'

/**
 * After attempt `attempt` (1-based) came back `ok` or not: keep the value, try again, or stop. A
 * valid value is accepted whatever the count; an invalid one is retried while attempts remain.
 */
export function decideAttempt(attempt: number, ok: boolean, maxRetries: number): AttemptDecision {
  if (ok) return 'accept'
  return attempt < maxRetries + 1 ? 'retry' : 'exhausted'
}
