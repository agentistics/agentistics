import { test, expect } from 'bun:test'
import { toControlSession } from './control-session'
import { cliStrings } from '../cli-i18n'
import { liveAge } from '../../../web/src/lib/asideTabs'
import { joinLive } from '../../../web/src/components/tasks/liveDeliveryModel'
import { cardStateWord, leaderCounts, workerWordText } from '../../../web/src/components/tasks/liveCardModel'
import { workerInfo } from '../../../web/src/components/tasks/LiveLeaders'
import { describeLive, liveRowOf } from './task-live-view'

for (const signal of ['tool', 'heavy-lock', 'output']) test(`QA Live consumes the same ${signal} evidence as the sidebar`, () => {
  const v: any = { id:'w', cwd:'/tmp/qa', harness:'claude', status:'running', activity:'waiting', attached:false, approvalDetection:false, searchFields:{name:'',folder:'',harness:'',note:'',task:'',prompt:''},
    ...(signal === 'tool' ? {chatTurns:[{role:'assistant',text:'Running Bash',pending:true}]} : signal === 'heavy-lock' ? {heavyLock:'waiting'} : {outputMoved:true}) }
  const c = toControlSession(v, cliStrings('pt'))
  expect(c.activeSignal).toBe(signal as any)
  const d: any = {key:'t/s',taskId:'t',taskTitle:'T',subtaskId:'s',title:'S',status:'in_progress',stage:'running',stageSinceMs:0,startedAtMs:0,sessionIds:['w'],blockedReason:null}
  const card = joinLive([d], [c] as any)[0]!
  console.log(`QA ${signal}: sidebar=${liveAge(c,Date.now(),true)}; fleet.state=${c.state}; Live=${cardStateWord(card,true)}; liveState=${card.liveState}`)
  expect(cardStateWord(card,true)).toBe(signal === 'heavy-lock' ? 'na fila' : 'trabalhando')
})

const view = (extra: Record<string, unknown>): any => ({ id: 'w', cwd: '/tmp/qa', harness: 'claude', status: 'running', activity: 'waiting', attached: false, approvalDetection: false, searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' }, ...extra })
const piece: any = { key: 't/s', taskId: 't', taskTitle: 'T', subtaskId: 's', title: 'S', status: 'in_progress', stage: 'running', stageSinceMs: 0, startedAtMs: 0, sessionIds: ['w'], blockedReason: null }

// QA r3 adversarial: the screen already reads `working` (the Bash is running) and that Bash is the `flock`.
test('a session ALREADY working that waits on the heavy lock is "na fila" in the sidebar AND the Live card', () => {
  const c = toControlSession(view({ activity: 'working', heavyLock: 'waiting' }), cliStrings('pt'))
  expect(c.state).toBe('working')
  expect(c.activeSignal).toBe('heavy-lock')
  expect(liveAge(c, Date.now(), true)).toBe('na fila')
  const card = joinLive([piece], [c] as any)[0]!
  expect(card.agents[0]!.queued).toBe(true)
  expect(cardStateWord(card, true)).toBe('na fila')
  expect(cardStateWord(card, false)).toBe('queued')
})

test('a working session HOLDING the heavy lock stays "trabalhando" (it is running its job, not queued)', () => {
  const c = toControlSession(view({ activity: 'working', heavyLock: 'holding' }), cliStrings('pt'))
  expect(cardStateWord(joinLive([piece], [c] as any)[0]!, true)).toBe('trabalhando')
})

test('a dialog on a person is never re-worded by the heavy lock', () => {
  const c = toControlSession(view({ activity: 'waiting-approval', heavyLock: 'waiting' }), cliStrings('pt'))
  expect(joinLive([piece], [c] as any)[0]!.agents[0]!.queued).toBeUndefined()
})

// QA r3 adversarial: the leaders' lane is the third surface, and it read "trabalhando" for a queued worker.
test('the leaders lane keeps the queue: worker word "queued" (na fila), leader queued too', () => {
  const rows: any = [
    { id: 'L', title: 'leader', harness: 'claude', state: 'working', activeSignal: 'heavy-lock' },
    { id: 'w', title: 'worker', harness: 'claude', state: 'waiting', activeSignal: 'heavy-lock', parentSessionId: 'L' },
    { id: 'w2', title: 'worker 2', harness: 'claude', state: 'working', activeSignal: 'heavy-lock', parentSessionId: 'L' },
    { id: 'w3', title: 'worker 3', harness: 'claude', state: 'waiting', activeSignal: 'tool', parentSessionId: 'L' },
    { id: 'w4', title: 'worker 4', harness: 'claude', state: 'waiting', activeSignal: null, parentSessionId: 'L' },
  ]
  const v = describeLive({ reply: { generatedAt: 'x', deliveries: [], samples: 0, hidden: [], sessionTasks: {} } as any, rows, leaderIds: new Set(['L']), nowMs: Date.now() })
  const l = v.leaders[0]!
  expect(l.queued).toBe(true)
  const word = Object.fromEntries(l.workers.map(w => [w.id, w.word]))
  expect(word).toEqual({ w: 'queued', w2: 'queued', w3: 'working', w4: 'idle' })
  expect(workerWordText('queued', true)).toBe('na fila')
  expect(workerInfo(l.workers.find(w => w.id === 'w')! as any, Date.now(), true)).toBe('na fila')
  // Queued is active, not idle: the pill counts it with the working ones.
  expect(leaderCounts([l as any])).toEqual({ working: 3, waiting: 1, blocked: 0, workers: 4 })
})

// Found on the r4 throwaway: GET /api/tasks/live copied each fleet row field by field and dropped `activeSignal`,
// so the SERVER's Live view drew the queued worker "ocioso" while the sidebar said "na fila". The route now maps
// every row through `liveRowOf`; this is that chain from the very SessionView the poller produces.
test('the /api/tasks/live row mapping keeps activeSignal: SessionView → ControlSession → liveRowOf → describeLive', () => {
  const s = cliStrings('pt')
  const views = [
    view({ id: 'L', activity: 'waiting' }),
    view({ id: 'q', activity: 'waiting', heavyLock: 'waiting', parentSessionId: 'L' }),
    view({ id: 'r', activity: 'working', outputMoved: true, parentSessionId: 'L' }),
    view({ id: 'i', activity: 'waiting', parentSessionId: 'L' }),
  ]
  const rows = views.map(v => liveRowOf(toControlSession(v, s)))
  expect(rows.find(r => r.id === 'q')!.activeSignal).toBe('heavy-lock')
  const out = describeLive({ reply: { generatedAt: 'x', deliveries: [], samples: 0, hidden: [], sessionTasks: {} } as any, rows, leaderIds: new Set(['L']), nowMs: Date.now() })
  const word = Object.fromEntries(out.leaders[0]!.workers.map(w => [w.id, w.word]))
  expect(word).toEqual({ q: 'queued', r: 'working', i: 'idle' })
  // The sidebar reads the same ControlSession: the three surfaces agree on each row.
  const side = Object.fromEntries(views.map(v => { const c = toControlSession(v, s); return [v.id, liveAge(c, Date.now(), true)] }))
  expect(side.q).toBe('na fila')
})
