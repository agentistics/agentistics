import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { rm, readFile } from 'node:fs/promises'
import { createSessionsPoller } from './sessions-host'
import { sessionsPollerOptions } from '../cli-start'
import { stalledHostOps } from '../flows/stalled-host'
import { toControlSession } from './control-session'
import { cliStrings } from '../cli-i18n'
import { liveAge } from '../../../web/src/lib/asideTabs'
import { joinLive } from '../../../web/src/components/tasks/liveDeliveryModel'
import { cardStateWord } from '../../../web/src/components/tasks/liveCardModel'

function setup(ids: string[], heavyLocks?: any) {
  let now = Date.now()
  let frames = ['❯ ']
  const backend: any = { id: 'tmux', unavailable: async () => undefined, list: async () => ids.map(id => ({ id, alive: true, attached: false, createdMs: now - 3 * 3600000, lastActivityMs: now - 60000 })), capture: async () => frames }
  const rows = ids.map(id => ({ id, harness: 'claude', cwd: '/tmp/qa-atividade-r2', createdAt: new Date(now - 3 * 3600000).toISOString(), parentSessionId: 'qa-leader' }))
  const poller = createSessionsPoller({ backend, readRegistry: async () => rows as any, scanProcesses: async () => ({ procs: [] }), now: () => now, heavyLocks })
  const deps: any = { registry: async () => [...rows, {id: 'qa-leader'}], role: async (r: any) => r.id === 'qa-leader' ? 'leader' : 'worker', dirty: async () => false, now: () => now, snapshot: async () => (poller as any).snapshot(), heavyLock: async () => false, message: async () => ({ok:true}) }
  return { poller, deps, backend, advance: () => { now += 5000 }, frame: (v: string[]) => { frames = v }, now: () => now }
}

// Real flock processes + the shared ps scanner (process-wide, cached HEAVY_SCAN_TTL_MS). In the whole-suite process
// other tests leave fleet pollers ticking, which can refill that cache right before these processes exist; the old
// retry loop gave up after ~3 s, inside one 5 s cache life, and failed only there. It now waits until it SEES both
// processes, for more than two cache lives, so a refill at any moment cannot make it fail.
test('QA real ps/proc → production options → poller → SessionView → sidebar/Live and alert', async () => {
  const lock = `/tmp/agentistics-heavy.${process.pid}.lock`
  const ids = [`qa-r2-holder-${process.pid}`, `qa-r2-queued-${process.pid}`]
  const env = { ...process.env }; delete env.AGENTISTICS_FLOWS
  const holder = spawn('flock', [lock, 'sleep', '20'], { env: {...env, AGENTOP_MANAGED_ID: ids[0]!} })
  const holderDone = new Promise(r => holder.once('exit', r))
  await Bun.sleep(200)
  const waiter = spawn('flock', [lock, 'true'], { env: {...env, AGENTOP_MANAGED_ID: ids[1]!} })
  const waiterDone = new Promise(r => waiter.once('exit', r))
  try {
    await Bun.sleep(200)
    expect((await readFile(`/proc/${waiter.pid}/environ`)).includes(Buffer.from('AGENTISTICS_FLOWS='))).toBe(false)
    const f = setup(ids)
    const production = sessionsPollerOptions(f.backend)
    const real = setup(ids, production.heavyLocks)
    const seen = (s: Awaited<ReturnType<typeof real.poller.poll>>) => s.sessions.find(v => v.id === ids[0])?.heavyLock === 'holding' && s.sessions.find(v => v.id === ids[1])?.heavyLock === 'waiting'
    let snap = await real.poller.poll()
    for (const until = Date.now() + 15_000; !seen(snap) && Date.now() < until;) { await Bun.sleep(500); snap = await real.poller.poll() }
    for (let i = 0; i < ids.length; i++) {
      const v = snap.sessions.find(v => v.id === ids[i])!
      expect(v.heavyLock).toBe(i === 0 ? 'holding' : 'waiting')
      const c = toControlSession(v, cliStrings('pt'))
      expect(c.activeSignal).toBe(i === 0 ? 'heavy-hold' : 'heavy-lock')
      expect(liveAge(c, real.now(), true)).toBe(i === 0 ? 'rodando' : 'na fila')
      real.deps.snapshot = async () => snap
      expect(await stalledHostOps(real.deps)['observar-sessao-parada']({ sessionId: ids[i] })).toMatchObject({ok:true, state:'working', activeSignal: c.activeSignal})
      console.log(`real flock ${ids[i]}: ${v.heavyLock} → ${c.activeSignal} → ${liveAge(c, real.now(), true)}`)
      const card = joinLive([{key:'t/s',taskId:'t',taskTitle:'T',subtaskId:'s',title:'S',status:'in_progress',stage:'running',stageSinceMs:0,startedAtMs:0,sessionIds:[ids[i]],blockedReason:null}] as any, [c] as any)[0]!
      expect(cardStateWord(card, true)).toBe(i === 0 ? 'trabalhando' : 'na fila')
    }
  } finally {
    // The holder's job ends by itself (20 s > the 15 s wait); the waiter then gets the lock and exits. Nothing is killed.
    await Promise.all([holderDone, waiterDone]); await rm(lock, {force:true})
  }
}, 40000)

test('QA real poller carries output movement into the same surfaces', async () => {
  const f = setup(['qa-output'], async () => new Map())
  await f.poller.poll()
  f.advance(); f.frame(['new build output', '❯ '])
  const snap = await f.poller.poll()
  expect(snap.sessions[0]!.outputMoved).toBe(true)
  const c = toControlSession(snap.sessions[0]!, cliStrings('pt'))
  expect(c.activeSignal).toBe('output')
  f.deps.snapshot = async () => snap
  expect(await stalledHostOps(f.deps)['observar-sessao-parada']({sessionId:'qa-output'})).toMatchObject({ok:true, activeSignal:'output', state:'working'})
})

// QA r3 adversarial: a timestamp a command PRINTS is output — it must never be blanked into "nothing moved".
test('a log line whose only change is its timestamp counts as output in the poller and the alert', async () => {
  const f = setup(['qa-clock'], async () => new Map())
  f.frame(['Heartbeat received at 12:34:01', '❯ '])
  const first = await f.poller.poll()
  f.deps.snapshot = async () => first
  expect(await stalledHostOps(f.deps)['observar-sessao-parada']({ sessionId: 'qa-clock' })).toMatchObject({ ok: true, activeSignal: null })
  f.advance(); f.frame(['Heartbeat received at 12:34:06', '❯ '])
  const snap = await f.poller.poll()
  expect(snap.sessions[0]!.outputMoved).toBe(true)
  f.deps.snapshot = async () => snap
  expect(await stalledHostOps(f.deps)['observar-sessao-parada']({ sessionId: 'qa-clock' })).toMatchObject({ ok: true, state: 'working', activeSignal: 'output' })
})

test('a duration a command prints (test elapsed 45s → 46s) is output in the poller', async () => {
  const f = setup(['qa-elapsed'], async () => new Map())
  f.frame(['test elapsed 45s', '❯ '])
  await f.poller.poll()
  f.advance(); f.frame(['test elapsed 46s', '❯ '])
  expect((await f.poller.poll()).sessions[0]!.outputMoved).toBe(true)
})

test('a frame identical between polls is not output', async () => {
  const f = setup(['qa-still'], async () => new Map())
  f.frame(['Heartbeat received at 12:34:01', '❯ '])
  await f.poller.poll()
  f.advance()
  expect((await f.poller.poll()).sessions[0]!.outputMoved).toBeFalsy()
})
