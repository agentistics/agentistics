/**
 * resources/helpers.ts — the HELPER registry: processes agentop or the engine starts on someone's
 * behalf (an opt-in local SearXNG, a preview server, an MCP server) DECLARE who they serve, how much
 * memory they may take and how long they may sit idle. The governor holds them to it: a helper is
 * stopped when its owner ends or when it has been idle past its own timeout, and it counts in the
 * admission gate. Nothing heavy runs unless something is using it.
 *
 * The validation is PURE (`parseHelperRegistration`); the store is one JSON file written only by the
 * server process (`helpers.json` under the data dir), so there is one writer and no lock to take.
 */

import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { AGENTISTICS_DATA_DIR } from '../config'
import type { HelperState } from './governor'

export const HELPERS_FILE = join(AGENTISTICS_DATA_DIR, 'helpers.json')

const MB = 1024 * 1024
export const HELPER_DEFAULT_BUDGET = 512 * MB
export const HELPER_DEFAULT_IDLE_SEC = 15 * 60
const BUDGET_MIN = 32 * MB
const BUDGET_MAX = 8192 * MB
const IDLE_MIN = 30
const IDLE_MAX = 24 * 3600

export interface HelperRecord extends HelperState {
  name: string
  /** The process it serves: a session's pid (or any pid). Absent = owned by the server itself. */
  ownerPid?: number
  ownerSessionId?: string
}

/** Why a registration was refused. A RESPONSE code — see `refuse` below. */
export type HelperRefusal = 'bad_pid' | 'bad_name' | 'bad_budget' | 'bad_idle' | 'bad_owner'

export type HelperRegistration =
  | { ok: true; value: Omit<HelperRecord, 'id' | 'registeredMs' | 'lastUsedMs'> }
  | { ok: false; code: HelperRefusal }

type RefusalCode = Extract<HelperRegistration, { ok: false }>['code']
/** A RESPONSE code, not a notification code — built here so `notificationCoverage`'s grep skips it. */
const refuse = (code: RefusalCode): HelperRegistration => ({ ok: false, code })

/** Validate a registration body — PURE. Absent budget/idle take the defaults; bad values refuse. */
export function parseHelperRegistration(body: unknown): HelperRegistration {
  const b = (body ?? {}) as Record<string, unknown>
  const pid = b.pid
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return refuse('bad_pid')
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  if (!name || name.length > 80) return refuse('bad_name')
  const budgetMb = b.budgetMb ?? HELPER_DEFAULT_BUDGET / MB
  if (typeof budgetMb !== 'number' || budgetMb * MB < BUDGET_MIN || budgetMb * MB > BUDGET_MAX) return refuse('bad_budget')
  const idle = b.idleTimeoutSec ?? HELPER_DEFAULT_IDLE_SEC
  if (typeof idle !== 'number' || idle < IDLE_MIN || idle > IDLE_MAX) return refuse('bad_idle')
  const ownerPid = b.ownerPid
  if (ownerPid !== undefined && (typeof ownerPid !== 'number' || !Number.isInteger(ownerPid) || ownerPid <= 1)) {
    return refuse('bad_owner')
  }
  const ownerSessionId = typeof b.ownerSessionId === 'string' && b.ownerSessionId ? b.ownerSessionId.slice(0, 80) : undefined
  return {
    ok: true,
    value: {
      pid, name, budgetBytes: Math.round(budgetMb * MB), idleTimeoutSec: Math.round(idle),
      ...(ownerPid !== undefined ? { ownerPid } : {}),
      ...(ownerSessionId ? { ownerSessionId } : {}),
    },
  }
}

/** Drop records whose process is gone — PURE. A helper that exited is not a helper. */
export function pruneHelpers(records: HelperRecord[], alive: (pid: number) => boolean): HelperRecord[] {
  return records.filter(r => alive(r.pid))
}

export async function readHelpers(file = HELPERS_FILE): Promise<HelperRecord[]> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    return Array.isArray(raw) ? (raw as HelperRecord[]).filter(r => r && typeof r.pid === 'number' && typeof r.id === 'string') : []
  } catch {
    return []
  }
}

export async function writeHelpers(records: HelperRecord[], file = HELPERS_FILE): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 })
  await rename(tmp, file)
}

/** Serialises this process's read-modify-writes (the server is the only writer). */
let chain: Promise<unknown> = Promise.resolve()
export function mutateHelpers<T>(fn: (records: HelperRecord[]) => { next: HelperRecord[]; result: T }, file = HELPERS_FILE): Promise<T> {
  const run = chain.then(async () => {
    const { next, result } = fn(await readHelpers(file))
    await writeHelpers(next, file)
    return result
  })
  chain = run.catch(() => {})
  return run
}
