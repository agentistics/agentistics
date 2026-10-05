/**
 * scripts/perf/startup.ts — how long until the app is USABLE, on a fresh install and on a restart.
 * Measured against a THROWAWAY server (`server-harness.ts`: isolated HOME, free ports, never the
 * machine's running server).
 *
 *   bun scripts/perf/synth-home.ts /tmp/perf-home --scale 0.3 --git
 *   bun scripts/perf/startup.ts /tmp/perf-home [--json out.json] [--budget]
 *   bun scripts/perf/startup.ts --empty            # a fresh, EMPTY home (a brand-new machine)
 *   bun scripts/perf/startup.ts <home> --slow-git 20000   # every `git log --numstat` takes 20 s
 *                                                         # (a huge repository; needs a --git home)
 *
 * For each of three boots — COLD (the agentistics data dir wiped: a fresh install), WARM (a restart
 * over what the cold boot left) and WARM again — it reports, in ms since the process was spawned:
 *   - health:      `/api/health` answered (the server is up);
 *   - firstScreen: the first `/api/data` 200 AND `/api/team/session` answered — the two requests the
 *                  web app waits on before it paints anything. A partial payload counts: it is what
 *                  the shell renders with;
 *   - fullData:    `/api/data` answered WITHOUT `partial: true` (everything, git facts included).
 *
 * `--budget` fails (exit 1) when a cold or warm firstScreen exceeds `startupFirstScreenMs` in
 * `budgets.json`, or fullData never arrives within the harness's patience.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPerfServer } from './server-harness.ts'

const args = process.argv.slice(2)
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const EMPTY = args.includes('--empty')
let home = args[0] && !args[0].startsWith('--') ? args[0] : undefined
let scratch: string | undefined
if (EMPTY) {
  scratch = mkdtempSync(join(tmpdir(), 'agentistics-startup-empty-'))
  home = join(scratch, 'home')
  mkdirSync(join(home, '.claude'), { recursive: true })
}
if (!home) { console.error('usage: startup.ts <home> [--json out] [--budget] [--slow-git ms] | --empty'); process.exit(2) }
// `--slow-git ms`: a `git` shim ahead of the real one that sleeps before every `log --numstat` — the
// shape of a huge repository, which is what held the whole first build on real machines.
const SLOW_GIT = Number(opt('slow-git') ?? 0)
let shimDir: string | undefined
if (SLOW_GIT > 0) {
  shimDir = mkdtempSync(join(tmpdir(), 'agentistics-slow-git-'))
  const real = Bun.which('git')
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" --numstat "*) sleep ${SLOW_GIT / 1000} ;; esac\nexec ${real} "$@"\n`)
  chmodSync(join(shimDir, 'git'), 0o755)
}
// `?partial=1` is what the web app sends; `--legacy` measures what a client that does not send it gets.
const DATA_PATH = args.includes('--legacy') ? '/api/data' : '/api/data?partial=1'
const budgets = await Bun.file(join(import.meta.dir, 'budgets.json')).json() as Record<string, number>
const FULL_PATIENCE_MS = 180_000

interface Boot { kind: string; health: number; firstScreen: number; firstPartial: string | false; firstSessions: number; fullData: number | null; sessions: number; deferredRepos: number }

async function boot(kind: string): Promise<Boot> {
  if (kind === 'cold') { rmSync(join(home!, '.agentistics'), { recursive: true, force: true }); mkdirSync(join(home!, '.agentistics'), { recursive: true }) }
  let t0 = performance.now()
  // A random free port can still be taken between the harness's probe and the bind (other servers
  // run on this machine); that is exit 75, and it is retried rather than reported as a startup time.
  const start = () => startPerfServer(home!, { env: { PATH: `${shimDir ? `${shimDir}:` : ''}${join(import.meta.dir, 'fake-bin')}:${process.env.PATH}` } })
  let started: Awaited<ReturnType<typeof startPerfServer>> | undefined
  for (let attempt = 0; !started; attempt++) {
    t0 = performance.now()
    try { started = await start() } catch (e) { if (attempt >= 3 || !String(e).includes('exited 75')) throw e }
  }
  const s = started
  const health = performance.now() - t0
  try {
    const data = async () => {
      const r = await fetch(`${s.base}${DATA_PATH}`)
      const j = await r.json() as { partial?: boolean; partialReason?: string; sessions?: unknown[]; deferredRepos?: string[] }
      return { ok: r.ok, partial: j.partial === true, reason: j.partialReason, sessions: j.sessions?.length ?? 0, deferred: j.deferredRepos?.length ?? 0 }
    }
    const [first] = await Promise.all([data(), fetch(`${s.base}/api/team/session`).then(r => r.text())])
    const firstScreen = performance.now() - t0
    let full: number | null = first.partial ? null : firstScreen
    let sessions = first.sessions
    let deferred = first.deferred
    while (full === null && performance.now() - t0 < FULL_PATIENCE_MS) {
      await Bun.sleep(250)
      const d = await data()
      if (!d.partial) { full = performance.now() - t0; sessions = d.sessions; deferred = d.deferred }
    }
    return { kind, health: Math.round(health), firstScreen: Math.round(firstScreen), firstPartial: first.partial ? (first.reason ?? 'yes') : false, firstSessions: first.sessions, fullData: full === null ? null : Math.round(full), sessions, deferredRepos: deferred }
  } finally {
    // Leave the full build's writes (the snapshot, the caches) on disk for the next WARM boot.
    await Bun.sleep(1500)
    await s.stop()
  }
}

const boots: Boot[] = []
try {
  for (const kind of ['cold', 'warm', 'warm']) {
    const b = await boot(kind)
    boots.push(b)
    console.error('[startup]', JSON.stringify(b))
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  if (shimDir) rmSync(shimDir, { recursive: true, force: true })
}

const out = { home: EMPTY ? '(empty)' : home, at: new Date().toISOString(), boots }
console.log(JSON.stringify(out, null, 2))
const jsonOut = opt('json')
if (jsonOut) await Bun.write(jsonOut, JSON.stringify(out, null, 2))

if (args.includes('--budget')) {
  const ceiling = budgets.startupFirstScreenMs ?? 2000
  const fullCeiling = budgets.startupFullDataMs ?? 60_000
  // The first screen is measured from SPAWN, so it includes the process start; health alone is
  // bounded by `bootListeningMs`. What this budget is about is what the app waits for after that.
  const ok = (b: Boot) => b.firstScreen - b.health <= ceiling && b.fullData !== null && b.fullData <= fullCeiling
  const over = boots.filter(b => !ok(b))
  for (const b of boots) console.log(`${ok(b) ? 'ok     ' : 'OVER   '} ${b.kind.padEnd(5)} firstScreen-after-health ${b.firstScreen - b.health} ms ≤ ${ceiling}; full ${b.fullData ?? 'never'} ms ≤ ${fullCeiling}`)
  if (over.length) { console.error(`\n${over.length} startup boot(s) over budget.`); process.exit(1) }
  console.log('\nStartup budget holds.')
}
