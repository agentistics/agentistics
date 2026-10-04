/**
 * resources/hog-fix.ts — the governor's fix for ONE process, for the admission refusal that names it.
 *
 * Only an agentop process has a fix the product can state with confidence; anything else (a browser,
 * an assistant CLI, a build) is named without one, because "stop the user's browser" is not advice
 * this product is in a position to give.
 */

import { readProcEntries, pidAlive } from './proc-read'
import { buildInventory } from './inventory'
import type { Fix } from './governor'

export async function governorFixFor(pid: number): Promise<Fix | undefined> {
  const entries = await readProcEntries(new Set([pid]))
  if (!entries) return undefined
  const p = buildInventory(entries.filter(e => e.pid === pid), {
    selfPid: process.pid, home: process.env.HOME, alive: pidAlive, helpers: new Map(),
  })[0]
  if (!p || p.self) return undefined
  if (p.kind === 'server') return { action: 'restart-server', pid }
  if (p.kind === 'cockpit') return { action: 'reopen-cockpit', pid }
  if (p.kind === 'mcp' && !p.orphan && p.owner?.alive) return { action: 'reconnect-session', pid }
  return { action: 'kill', pid }
}
