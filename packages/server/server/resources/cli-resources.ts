/**
 * resources/cli-resources.ts — `agentop resources`: the governor's view in a terminal.
 *
 * Asks the running server (`/api/resources`, which carries what its governor last saw and did); with
 * no server it reads `/proc` itself and PLANS without acting — a one-shot command never kills
 * anything. `--json` prints the raw snapshot.
 */

import { PORT } from '../config'
import { readProcEntries, pidAlive } from './proc-read'
import { buildInventory, type AgentopProcess } from './inventory'
import { planGovernor, type Alert } from './governor'
import { readHelpers } from './helpers'
import { readHeavyState } from './heavy-io'

const mb = (b: number | null): string => (b === null ? '?' : `${Math.round(b / 1048576)} MB`)
const age = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}m`)

export async function printResources(args: string[]): Promise<number> {
  let snap: { inventory: AgentopProcess[]; alerts: Alert[]; source: string } | null = null
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/resources`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const body = await res.json() as { inventory?: AgentopProcess[]; alerts?: Alert[] }
      if (Array.isArray(body.inventory)) snap = { inventory: body.inventory, alerts: body.alerts ?? [], source: 'server' }
    }
  } catch { /* no server — read it here */ }
  if (!snap) {
    const helpers = await readHelpers()
    const heavy = await readHeavyState()
    const always = new Set([...helpers.map(h => h.pid), ...heavy.running.map(r => r.pid)])
    await readProcEntries(always)
    await Bun.sleep(1000) // CPU is a rate: a second sample one second later.
    const entries = await readProcEntries(always)
    if (!entries) { process.stderr.write('agentop resources: /proc is not readable here (Linux only).\n'); return 1 }
    const inventory = buildInventory(entries, {
      selfPid: process.pid, home: process.env.HOME, alive: pidAlive,
      helpers: new Map(helpers.map(h => [h.pid, { id: h.id, ...(h.ownerPid ? { ownerPid: h.ownerPid } : {}) }])),
    }).filter(p => !p.self)
    snap = { inventory, alerts: planGovernor({ inventory, helpers, nowMs: Date.now() }).alerts, source: 'local (no server — nothing is acted on)' }
  }
  if (args.includes('--json')) { process.stdout.write(`${JSON.stringify(snap, null, 2)}\n`); return 0 }
  process.stdout.write(`agentop processes (${snap.source})\n`)
  for (const p of snap.inventory) {
    const flags = [p.stale ? 'OLD BINARY' : '', p.orphan ? 'orphan' : '', p.owner && !p.owner.alive ? 'owner gone' : ''].filter(Boolean).join(', ')
    process.stdout.write(`  ${String(p.pid).padStart(8)}  ${p.kind.padEnd(7)}  ${mb(p.usedBytes).padStart(8)}  cpu ${String(p.cpuPercent ?? '?').padStart(3)}%  ${age(p.ageSec).padStart(6)}  ${p.label}${flags ? `  [${flags}]` : ''}\n`)
  }
  if (snap.alerts.length) {
    process.stdout.write('alerts\n')
    for (const a of snap.alerts) process.stdout.write(`  pid ${a.pid} ${a.label}: ${a.reason}${a.budgetBytes ? ` (${mb(a.usedBytes)} > ${mb(a.budgetBytes)})` : ''}${a.fix ? ` — fix: ${a.fix.action}` : ''}\n`)
  }
  return 0
}
