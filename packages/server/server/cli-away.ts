/**
 * `agentop away [status|on|off] [--until back|<N>h|<HH:MM>] [--allow releases,workers,merges]
 *  [--workers N] [--cap <harness>=N[,…]] [--note "…"]` — AWAY MODE from the terminal, and
 * `agentop away session <id|title> on|off` — one session's own flag (`/api/away/session`).
 *
 * It talks to the local server (`/api/away`) so the browser hears the change over SSE; when no
 * server answers it writes `preferences.json` through the same `setAway` and SAYS so. The
 * argument reading is pure (`parseAwayArgs`) and tested.
 */
import { AWAY_AUTH_IDS, HARNESS_ORDER, topCapsText, type AwayState } from '@agentistics/core'

export type AwayCommand =
  | { kind: 'status' }
  | { kind: 'set'; body: Record<string, unknown> }
  | { kind: 'session'; body: { target: string; on: boolean } }
  | { kind: 'error'; message: string }

/** `--until`: `back`, `<N>h`/`<N>m`, or `HH:MM` (the next such time on the LOCAL clock). */
export function untilFromArg(v: string, now: number): string | null | undefined {
  if (v === 'back') return null
  const rel = /^(\d+)(h|m)$/.exec(v)
  if (rel) return new Date(now + Number(rel[1]) * (rel[2] === 'h' ? 3_600_000 : 60_000)).toISOString()
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v)
  if (hm && Number(hm[1]) < 24 && Number(hm[2]) < 60) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.toISOString()
  }
  return undefined
}

export function parseAwayArgs(args: readonly string[], now: number): AwayCommand {
  const [verb = 'status', ...rest] = args
  if (verb === 'status') return { kind: 'status' }
  if (verb === 'off') return { kind: 'set', body: { on: false } }
  if (verb === 'session') {
    const [target, sw] = rest
    if (!target || (sw !== 'on' && sw !== 'off')) return { kind: 'error', message: 'usage: agentop away session <id|title> on|off' }
    return { kind: 'session', body: { target, on: sw === 'on' } }
  }
  if (verb !== 'on') return { kind: 'error', message: `unknown verb "${verb}" — use status, on or off` }
  const body: Record<string, unknown> = { on: true, authorised: ['releases', 'workers'] }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const val = rest[i + 1]
    if (val === undefined) return { kind: 'error', message: `${flag} needs a value` }
    i++
    if (flag === '--until') {
      const u = untilFromArg(val, now)
      if (u === undefined) return { kind: 'error', message: `--until "${val}": use back, 8h, 90m or HH:MM` }
      body.until = u
    } else if (flag === '--allow') {
      body.authorised = val === 'none' ? [] : val.split(',').map(s => s.trim()).filter(Boolean)
    } else if (flag === '--workers') body.maxWorkers = Number(val)
    else if (flag === '--cap' || flag === '--opus') {
      // `--opus N` is the old Claude-only spelling of `--cap claude=N`.
      const pairs = flag === '--opus' ? [`claude=${val}`] : val.split(',').map(p => p.trim()).filter(Boolean)
      const caps = { ...(body.topCaps as Record<string, number> | undefined) }
      for (const p of pairs) {
        const m = /^([a-z]+)=(\d+)$/.exec(p)
        if (!m || !(HARNESS_ORDER as readonly string[]).includes(m[1]!)) return { kind: 'error', message: `--cap "${p}": use <harness>=N with harness one of ${HARNESS_ORDER.join(', ')}` }
        caps[m[1]!] = Number(m[2])
      }
      body.topCaps = caps
    }
    else if (flag === '--note') body.note = val
    else return { kind: 'error', message: `unknown flag ${flag}` }
  }
  return { kind: 'set', body }
}

export function describeAway(s: AwayState, active: boolean): string {
  if (!active) return 'away mode: off'
  const until = s.until === null ? "until you're back" : `until ${new Date(s.until).toLocaleString()}`
  const auth = s.authorised.length ? s.authorised.join(', ') : 'nothing'
  return `away mode: ON ${until}\n  authorised: ${auth}\n  ceilings: ${s.maxWorkers} workers; ${topCapsText(s)}${s.note ? `\n  note: ${s.note}` : ''}`
}

const USAGE = `usage: agentop away [status|on|off] [--until back|8h|90m|HH:MM] [--allow ${AWAY_AUTH_IDS.join(',')}|none] [--workers N] [--cap <harness>=N[,…]] [--note "…"]\n       agentop away session <id|title> on|off`

export async function runAway(args: readonly string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') { console.log(USAGE); return 0 }
  const cmd = parseAwayArgs(args, Date.now())
  if (cmd.kind === 'error') { console.error(`${cmd.message}\n${USAGE}`); return 2 }
  const { PORT } = await import('./config')
  if (cmd.kind === 'session') return runSessionAway(cmd.body, PORT)
  const url = `http://127.0.0.1:${PORT}/api/away`
  try {
    const res = await fetch(url, cmd.kind === 'status'
      ? { signal: AbortSignal.timeout(2_000) }
      : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cmd.body), signal: AbortSignal.timeout(2_000) })
    const body = await res.json() as { ok?: boolean; state?: AwayState; active?: boolean; error?: string }
    if (cmd.kind === 'set' && body.ok !== true) { console.error(`refused: ${body.error ?? res.status}`); return 1 }
    console.log(describeAway(body.state as AwayState, body.active === true))
    return 0
  } catch {
    // No server answering: the same rules, written straight to preferences.json.
    const { defaultAwayDeps, readAwayView, setAway } = await import('./away')
    const deps = await defaultAwayDeps()
    if (cmd.kind === 'status') {
      const v = await readAwayView(deps)
      console.log(describeAway(v.state, v.active))
      return 0
    }
    const out = await setAway(cmd.body, deps)
    if (!out.ok) { console.error(`refused: ${out.error}`); return 1 }
    console.log(`${describeAway(out.state, out.active)}\n(agentistics server not reachable: written to preferences; open dashboards update on reload)`)
    return 0
  }
}

async function runSessionAway(body: { target: string; on: boolean }, port: number): Promise<number> {
  const say = (r: { ok: boolean; id?: string; away?: boolean; effective?: boolean; queued?: boolean; error?: string; message?: string }): number => {
    if (!r.ok) { console.error(`refused: ${r.error ?? 'unknown'}`); return 1 }
    const eff = r.effective ? 'away (effective)' : 'not away'
    console.log(`session ${r.id}: own away flag ${r.away ? 'ON' : 'OFF'} — now ${eff}${r.queued ? '; the session will be told after the quiet window' : r.message ? `; not told: ${r.message}` : ''}`)
    return 0
  }
  // A title or an id prefix is resolved HERE, against the same registry the server reads.
  const { readRegistry } = await import('./sessions/registry')
  const { resolveSessionRef } = await import('./sessions/session-ref')
  const reg = await readRegistry()
  const byConversation = reg.find(r => r.conversationId === body.target)
  const hit = byConversation ? { ok: true as const, session: byConversation } : resolveSessionRef(reg, body.target)
  if (!hit.ok) { console.error(`refused: ${hit.reason === 'ambiguous' ? `ambiguous (${hit.matches.join(', ')})` : 'no such session'}`); return 1 }
  const target = hit.session.id
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/away/session`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, target }), signal: AbortSignal.timeout(10_000) })
    return say(await res.json())
  } catch {
    const { setSessionAway, defaultSessionAwayDeps } = await import('./away')
    const deps = await defaultSessionAwayDeps()
    // No server: the flag is written; nothing can be typed into the session from here.
    return say(await setSessionAway({ ...body, target }, { ...deps, prompt: async () => ({ ok: false, message: 'agentistics server not reachable' }) }))
  }
}
