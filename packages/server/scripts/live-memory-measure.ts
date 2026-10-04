#!/usr/bin/env bun
/**
 * live-memory-measure.ts — LIVE.4's 24 h memory measurement on THIS machine (spec
 * `2026-10-02-live-sessions-from-journal` §6 C5, Q6).
 *
 *   sample  --pid <n|auto> --out <file.csv> [--every 60] [--hours 24] [--probe http://127.0.0.1:47291/api/version]
 *   report  <run.csv> [--baseline <baseline.csv>]
 *
 * READ-ONLY: it reads `/proc/<pid>/status` and `/proc/<pid>/stat` and makes one GET to the loopback probe
 * URL. It never signals, restarts or writes to the process it watches, and touches no data directory.
 * `--pid auto` finds the process running `agentop server`. It appends a row per sample, so it survives being
 * restarted (it resumes appending to the same file) and a crash loses at most one row.
 *
 * Protocol (spec §6): (1) a BASELINE csv from a server with the live/projection flags off; (2) a RUN csv from
 * the same server config with AGENTISTICS_JOURNAL=1, AGENTISTICS_JOURNAL_LIVE=1, AGENTISTICS_PROJECTIONS=1
 * and AGENTISTICS_PROJECTIONS_SURFACES=sessions, after `agentop journal import`; (3) `report` judges the
 * gate. One csv alone is "incomplete": the gate is a DELTA.
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs'
import { GATE, parseCsv, parseProcStat, parseProcStatus, report, sampleToCsv, type Sample } from './live-memory-lib'

const arg = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

/** The pid of the process running `agentop server` (the compiled binary or `bun … server`). */
export function findServerPid(procRoot = '/proc'): number | null {
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const cmd = readFileSync(`${procRoot}/${name}/cmdline`, 'utf8').split('\0').filter(Boolean)
      if (cmd.length >= 2 && /agentop$/.test(cmd[0]!) && cmd[1] === 'server') return Number(name)
    } catch { /* gone, or not ours */ }
  }
  return null
}

async function probe(url: string): Promise<number | null> {
  const t0 = performance.now()
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5_000) }); await r.arrayBuffer(); return r.ok ? Math.round(performance.now() - t0) : null } catch { return null }
}

async function sample(args: string[]): Promise<number> {
  const out = arg(args, '--out')
  if (!out) { console.error('--out <file.csv> is required'); return 2 }
  const pidArg = arg(args, '--pid') ?? 'auto'
  const every = Number(arg(args, '--every') ?? 60) * 1000
  const until = Date.now() + Number(arg(args, '--hours') ?? 24) * 3_600_000
  const url = arg(args, '--probe') ?? 'http://127.0.0.1:47291/api/version'
  const pid = pidArg === 'auto' ? findServerPid() : Number(pidArg)
  if (!pid) { console.error('no `agentop server` process found; pass --pid'); return 1 }
  if (!existsSync(out)) writeFileSync(out, sampleToCsv([]))
  console.error(`sampling pid ${pid} every ${every / 1000}s until ${new Date(until).toISOString()} → ${out}`)
  while (Date.now() < until) {
    try {
      const st = parseProcStatus(readFileSync(`/proc/${pid}/status`, 'utf8'))
      const ticks = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (!st || ticks === null) throw new Error('unreadable')
      const s: Sample = { at: new Date().toISOString(), ...st, cpuTicks: ticks, latencyMs: await probe(url) }
      appendFileSync(out, sampleToCsv([s]).split('\n').slice(1).join('\n'))
    } catch {
      console.error(`pid ${pid} is gone — the measurement ends here (the server restarted or exited)`)
      return 3
    }
    await Bun.sleep(every)
  }
  return 0
}

function reportCmd(args: string[]): number {
  const run = args.find(a => !a.startsWith('--') && a !== arg(args, '--baseline'))
  if (!run || !existsSync(run)) { console.error('report <run.csv> [--baseline <baseline.csv>]'); return 2 }
  const b = arg(args, '--baseline')
  const r = report(parseCsv(readFileSync(run, 'utf8')), b && existsSync(b) ? { baseline: parseCsv(readFileSync(b, 'utf8')) } : {})
  const f = (n: number | null, u = '') => (n === null ? '—' : `${n.toFixed(1)}${u}`)
  console.log(`samples ${r.samples} · ${r.hours.toFixed(1)} h · steady ${f(r.steadyMB, ' MB')} · baseline ${f(r.baselineMB, ' MB')} · delta ${f(r.deltaMB, ' MB')}`)
  console.log(`slope ${f(r.slopeMBPerHour, ' MB/h')} · peak ${f(r.peakMB, ' MB')} · probe p95 ${f(r.latencyP95Ms, ' ms')} (baseline ${f(r.baselineLatencyP95Ms, ' ms')}) · cpu ${f(r.cpuTicksPerMin, ' ticks/min')}`)
  for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`)
  console.log(`verdict: ${r.verdict}${r.verdict === 'pass' ? ' — the gate allows proposing default-on; the OWNER signs' : r.verdict === 'incomplete' ? ' — needs a baseline and 24 h' : ' — stays opt-in'}  (gate: +${GATE.deltaMB} MB, ±${GATE.slopeMBPerHour} MB/h, <${GATE.peakMB} MB peak)`)
  return r.verdict === 'fail' ? 1 : 0
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2)
  const code = cmd === 'sample' ? await sample(rest) : cmd === 'report' ? reportCmd(rest) : (console.error('live-memory-measure.ts sample|report …'), 2)
  process.exit(code)
}
