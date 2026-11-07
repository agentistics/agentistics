import { describe, expect, test } from 'bun:test'
import {
  blockLines, cardStateWord, columnCollapsed, countOutOfView, etaBoxes, humanSlotReason, matchesColumnQuery, readViewPrefs, showColumnSearch, writeViewPrefs, revealScrollLeft, mergeGone, planDepartures, snapshotOf, stageBar,
  taskOfSession, taskOptions, timeRow, waitingReason, lingering, GONE_LINGER_MS, readCollapsedPrefs,
  cardPercent, ciChecklist, leaderCounts, locateWorker, stagePercent,
} from './liveCardModel'
import { rollPlan } from './LiveOdometer'
import { cardPills, filterCards, joinLive, LIVE_STAGES, type LiveAgent, type LiveDeliveryRecord, type RuntimeFacts } from './liveDeliveryModel'
import type { FleetRow } from '../../lib/fleet'

const NOW = 2_000_000_000_000
const MIN = 60_000, H = 3600_000
const rec = (over: Partial<LiveDeliveryRecord> = {}): LiveDeliveryRecord => ({
  key: 't/a', taskId: 't', taskTitle: 'Task', subtaskId: 'a', title: 'Piece', status: 'in_progress', stage: 'running',
  stageSinceMs: NOW - 52 * MIN, startedAtMs: NOW - 52 * MIN, sessionIds: [], harnesses: ['claude'], models: [], eta: { kind: 'none', reason: 'no-history' },
  lastAction: null, blockedReason: null, deliveredAtMs: null, ...over,
})
const row = (id: string, state: FleetRow['state'], x: Partial<FleetRow> = {}): FleetRow => ({
  id, title: id, harness: 'claude', cwd: '/x', project: 'p', state, stateLabel: state, actionable: false, attachCommand: '', verbs: [], ...x,
})
const card = (d: Partial<LiveDeliveryRecord>, fleet: FleetRow[] = []) => joinLive([rec(d)], fleet)[0]!

describe('state words — a worker that is merely idle is not "waiting for you"', () => {
  test('waiting means different things in different columns', () => {
    const f = [row('s', 'waiting')]
    expect(cardStateWord(card({ sessionIds: ['s'], stage: 'running' }, f), true)).toBe('ocioso')
    expect(cardStateWord(card({ sessionIds: ['s'], stage: 'leader' }, f), true)).toBe('aguardando revisão')
    expect(cardStateWord(card({ sessionIds: ['s'], stage: 'qa' }, f), true)).toBe('entregou')
    expect(cardStateWord(card({ sessionIds: ['s'], stage: 'running' }, [row('s', 'waiting-approval')]), true)).toBe('precisa de você')
    expect(cardStateWord(card({ sessionIds: ['s'] }, [row('s', 'working')]), false)).toBe('working')
  })
})

describe('what a waiting card waits for (item i)', () => {
  test('review, QA, merge, queue, a dialog with its question, and honesty when unknown', () => {
    const f = [row('s', 'waiting')]
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'leader' }, f), f, true)).toBe('esperando revisão do líder')
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'qa' }, f), f, true)).toBe('esperando a QA')
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'merge' }, f), f, true)).toBe('esperando o CI / merge')
    expect(waitingReason(card({ stage: 'queue' }), [], true)).toBe('esperando vaga na máquina')
    const dlg = [row('s', 'waiting-approval', { approvalLines: ['Posso apagar a pasta dist?', '1. Sim'] })]
    expect(waitingReason(card({ sessionIds: ['s'] }, dlg), dlg, true)).toBe('esperando resposta sua (pergunta: Posso apagar a pasta dist?)')
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'running' }, f), f, true)).toBe('esperando (sem motivo conhecido)')
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'running', lastAction: { text: 'x', atMs: 1, kind: 'handback' } }, f), f, true)).toBe('entregou, esperando o líder')
  })
  test('a blocked card says why in its block, not in a second waiting line', () => {
    const f = [row('s', 'waiting')]
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'blocked' }, f), f, true)).toBeNull()
  })
  test('a working card waits for nothing', () => {
    const f = [row('s', 'working')]
    expect(waitingReason(card({ sessionIds: ['s'] }, f), f, true)).toBeNull()
  })
})

describe('stage bar — active segment wears its column colour', () => {
  test('running = orange active, nothing done; QA = blue, two grey behind', () => {
    const r = stageBar('running', null)
    expect(r.map(s => s.state)).toEqual(['done', 'cur', 'todo', 'todo', 'todo', 'todo', 'todo'])
    expect(r[1]!.color).toBe('#f5a623')
    const q = stageBar('qa', null)
    expect(q.map(s => s.state)).toEqual(['done', 'done', 'cur', 'todo', 'todo', 'todo', 'todo'])
    expect(q[2]!.color).toBe('#4c9aff')
    expect(q[0]!.color).toBe('#4b5563')
  })
  test('adjust sits on QA in red; blocked marks where it came from', () => {
    expect(stageBar('adjust', null)[2]).toMatchObject({ state: 'cur', color: '#ff5f5f' })
    expect(stageBar('blocked', 'leader')[3]).toMatchObject({ state: 'cur', color: '#c2410c' })
  })
})

describe('time row — "total" is the card\'s work, never the task\'s age (item a, f)', () => {
  test('the same words in every column; a 52-day-old task shows the card\'s 52 minutes', () => {
    for (const stage of ['running', 'qa', 'leader'] as const) {
      const t = timeRow(card({ stage, workMs: 52 * MIN, trail: [{ stage: 'queue', enteredMs: 0, ms: 1 }, { stage, enteredMs: 1, ms: 2 }] }), NOW, true)
      expect(t.inStage).toBe('tempo nessa etapa 52 min')
      expect(t.total).toBe('total 52 min')
      expect(t.stageNo).toBe('2ª etapa')
    }
    expect(timeRow(card({ workMs: null }), NOW, true).total).toBe('total —')
    expect(timeRow(card({ stage: 'published', workMs: 2 * H, deliveredAtMs: NOW }), NOW, true).total).toBe('total 2h')
    expect(timeRow(card({ stage: 'published', deliveredAtMs: null }), NOW, true).inStage).toBe('publicado —')
  })
  test('the tooltip lists the stages it passed through', () => {
    const t = timeRow(card({ trail: [{ stage: 'running', enteredMs: 0, ms: 4 * H }, { stage: 'qa', enteredMs: 1, ms: 20 * MIN }] }), NOW, true)
    expect(t.title).toContain('em desenvolvimento 4h')
    expect(t.title).toContain('qa 20 min')
  })
})

describe('the two estimates (item g, b)', () => {
  test('both explicit; "sem estimativa" and the late sentence say what they compare', () => {
    const ok = etaBoxes(rec({
      stageEta: { kind: 'estimate', atMs: new Date(2026, 10, 6, 17, 46).getTime(), medianMs: H, n: 5, nextStage: 'qa' },
      publishEta: { kind: 'estimate', atMs: new Date(2026, 10, 6, 23, 30).getTime(), source: 'stages', n: 5, parts: [{ stage: 'qa', medianMs: H }] },
    }), true)!
    expect(ok[0]).toMatchObject({ label: 'próxima etapa (qa)', value: '~17:46', tone: 'ok' })
    expect(ok[1]).toMatchObject({ label: 'publicação', value: '~23:30' })
    expect(ok[1].title).toContain('Soma das durações típicas')
    const late = etaBoxes(rec({ stageEta: { kind: 'none', reason: 'beyond-range', typicalMs: 40 * MIN } }), true)!
    expect(late[0]).toMatchObject({ tone: 'late', value: 'mais demorado que o normal (típico ~40 min)' })
    expect(etaBoxes(rec(), true)![0].value).toBe('sem estimativa')
    expect(etaBoxes(rec(), true)![1].value).toBe('sem estimativa')
    expect(etaBoxes(rec({ stage: 'published' }), true)).toBeNull()
  })
})

describe('Bloqueado card lines (item q)', () => {
  test('reason, who lifts it, how long, where it returns', () => {
    const l = blockLines({ reason: 'limite', text: 'contas em 90%', unlocker: 'leader', originStage: 'qa' }, NOW - 42 * MIN, NOW, true)
    expect(l).toEqual({ reason: 'bloqueado por: limite de uso / login — contas em 90%', unlocker: 'quem destrava: líder', since: 'há 42 min', origin: 'volta para: qa' })
    expect(blockLines({ reason: 'decisao_do_dono', text: null, unlocker: 'owner', originStage: null }, null, NOW, true).unlocker).toBe('quem destrava: dono')
  })
})

describe('harness · model · effort on every card (item e)', () => {
  const accountOf = () => null
  const runtime: Record<string, RuntimeFacts> = {
    claude: { model: 'opus', effort: 'high', effortConcept: true },
    codex: { model: 'gpt-6.1-sol', effort: 'medium', effortConcept: true },
    gemini: { effortConcept: false },
    opencode: { effortConcept: false },
    copilot: { effortConcept: true },
    antigravity: { effortConcept: true, effort: 'medium' },
    kimi: { effortConcept: true },
  }
  const agent = (h: string, x: Partial<LiveAgent> = {}): LiveAgent => ({ id: 'a', harness: h, model: null, effort: null, accountId: null, state: 'working', stateLabel: '', ...x })
  const cardOf = (h: string, agents: LiveAgent[], d: Partial<LiveDeliveryRecord> = {}) => ({ ...card({ harnesses: [h], ...d }), agents })
  test.each(['claude', 'codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'opencode', 'hermes'])('%s: a bare card still shows harness · model · effort or says default', h => {
    const p = cardPills(cardOf(h, []), accountOf, 'conta', runtime, true).runtime!
    expect(p.startsWith(h)).toBe(true)
    expect(p.split(' · ').length).toBeGreaterThanOrEqual(h === 'gemini' || h === 'opencode' || h === 'hermes' ? 2 : 3)
  })
  test('the live agent wins, then the registry facts, then the default marked as such', () => {
    expect(cardPills(cardOf('claude', [agent('claude', { model: 'sonnet', effort: 'max' })]), accountOf, 'conta', runtime, true).runtime).toBe('claude · Sonnet 5 · max')
    expect(cardPills(cardOf('claude', [], { models: ['opus'], efforts: ['low'] }), accountOf, 'conta', runtime, true).runtime).toBe('claude · Opus 5 · low')
    expect(cardPills(cardOf('claude', []), accountOf, 'conta', runtime, true).runtime).toBe('claude · Opus 5 (padrão) · high (padrão)')
    expect(cardPills(cardOf('gemini', []), accountOf, 'conta', runtime, true).runtime).toBe('gemini · modelo padrão')
  })
})

describe('Publicado is not emptied by the filters (item c)', () => {
  test('a published piece has no live agent and must survive "only with active agents" and a task filter', () => {
    const cards = joinLive([
      rec({ key: 'p', stage: 'published', taskId: 'T1', deliveredAtMs: NOW }), rec({ key: 'r', stage: 'running', taskId: 'T1' }), rec({ key: 'q', stage: 'published', taskId: 'T2' }),
    ], [])
    const shown = filterCards(cards, { taskIds: ['T1'], onlyActive: true }).map(c => c.d.key)
    expect(shown).toEqual(['p', 'r']) // the running piece is a flow card too: "active" is about the column, not a live agent
    expect(filterCards(cards, { taskIds: ['T1', 'T2'], onlyActive: true }).map(c => c.d.key)).toEqual(['p', 'r', 'q'])
    expect(filterCards(cards, { taskIds: [], onlyActive: false }).length).toBe(0) // "apenas ativas" off hides the cards of the flow columns after the queue
  })
  test('a blocked card is never hidden by the agent switch either', () => {
    const cards = joinLive([rec({ key: 'b', stage: 'blocked' })], [])
    expect(filterCards(cards, { taskIds: [], onlyActive: true })).toHaveLength(1)
  })
})

describe('task filter: Recentes first, and which task a session belongs to', () => {
  test('tasks with live agents come first', () => {
    const f = [row('s', 'working')]
    const cards = joinLive([rec({ key: '1', taskId: 'A', taskTitle: 'Alpha', stageSinceMs: NOW - 90 * H, stage: 'leader' }), rec({ key: '2', taskId: 'Z', taskTitle: 'Zeta', sessionIds: ['s'] })], f)
    const o = taskOptions(cards, NOW)
    expect(o.map(x => [x.value, x.recent])).toEqual([['Z', true], ['A', false]])
  })
  test('session -> task: the filing wins, then its piece, then a leader\'s filing', () => {
    const cards = joinLive([rec({ taskId: 'P', sessionIds: ['w'] })], [row('w', 'working')])
    expect(taskOfSession('x', { sessionTasks: { x: 'F' }, cards })).toBe('F')
    expect(taskOfSession('w', { cards })).toBe('P')
    expect(taskOfSession('L', { cards, leaders: [{ id: 'L', taskId: 'T-led' }] })).toBe('T-led')
    expect(taskOfSession('nobody', { cards })).toBeNull()
    expect(taskOfSession(null, { cards })).toBeNull()
  })
})

describe('columns: today\'s layout plus Publicado collapsed; the user\'s choice wins (item d)', () => {
  test('defaults', () => {
    expect(columnCollapsed('running', 3, {})).toBe(false)
    expect(columnCollapsed('qa', 0, {})).toBe(true)
    expect(columnCollapsed('published', 9, {})).toBe(true)
    expect(columnCollapsed('running', 3, { running: true })).toBe(true)
    expect(columnCollapsed('published', 9, { published: false })).toBe(false)
    expect(columnCollapsed('qa', 0, { qa: false })).toBe(false)
  })
  test('persisted prefs ignore junk', () => {
    expect(readCollapsedPrefs({ getItem: () => JSON.stringify({ running: true, qa: 'x', nope: true }) })).toEqual({ running: true })
    expect(readCollapsedPrefs({ getItem: () => 'not json' })).toEqual({})
    expect(readCollapsedPrefs(null)).toEqual({})
  })
  test('every stage has a bar position or is a detour', () => {
    for (const s of LIVE_STAGES) expect(stageBar(s, null).filter(x => x.state === 'cur')).toHaveLength(1)
  })
})

describe('column body — one vertical stack with its own scroll, and a search past three hidden cards', () => {
  const view = { top: 100, bottom: 500 }
  const at = (top: number, h = 100) => ({ top, bottom: top + h })
  test('countOutOfView counts the cards wholly above or below the scroll area; a sliver counts as seen', () => {
    expect(countOutOfView([at(100), at(210), at(320), at(430)], view)).toBe(0)
    expect(countOutOfView([at(100), at(210), at(320), at(430), at(540), at(650)], view)).toBe(2)
    expect(countOutOfView([at(-50), at(60), at(480), at(600)], view)).toBe(2) // 480 shows 20px: visible
    expect(countOutOfView([], view)).toBe(0)
  })
  test('the search shows ONLY with MORE than three out of view', () => {
    expect(showColumnSearch({ outOfView: 3, query: '', wasShown: false })).toBe(false)
    expect(showColumnSearch({ outOfView: 4, query: '', wasShown: false })).toBe(true)
    expect(showColumnSearch({ outOfView: 0, query: '', wasShown: false })).toBe(false)
  })
  test('once shown it holds at three (it takes room itself), and a typed query never makes it vanish', () => {
    expect(showColumnSearch({ outOfView: 3, query: '', wasShown: true })).toBe(true)
    expect(showColumnSearch({ outOfView: 2, query: '', wasShown: true })).toBe(false)
    expect(showColumnSearch({ outOfView: 0, query: 'abc', wasShown: false })).toBe(true)
    expect(showColumnSearch({ outOfView: 0, query: '   ', wasShown: false })).toBe(false)
  })
  test('the search filters only by title or task, every word, case-folded', () => {
    const c = (title: string, taskTitle: string) => ({ d: rec({ title, taskTitle }) })
    expect(matchesColumnQuery(c('Fix login', 'Auth'), '')).toBe(true)
    expect(matchesColumnQuery(c('Fix login', 'Auth'), 'LOGIN')).toBe(true)
    expect(matchesColumnQuery(c('Fix login', 'Auth'), 'auth fix')).toBe(true)
    expect(matchesColumnQuery(c('Fix login', 'Auth'), 'billing')).toBe(false)
  })
  test('revealScrollLeft reaches a card past the right edge, horizontally only, and never past the content', () => {
    // QA MED 6: the card ended at x=1365 on a board ending at 1223 and scrollLeft moved only 30
    const left = revealScrollLeft({ scrollLeft: 30, viewLeft: 100, viewWidth: 1100, cardLeft: 1085, cardWidth: 280, scrollWidth: 1700 })
    expect(left).toBeGreaterThan(30)
    const rel = 1085 - 100 + 30 - left
    expect(rel).toBeGreaterThanOrEqual(0)
    expect(rel + 280).toBeLessThanOrEqual(1100)
    expect(revealScrollLeft({ scrollLeft: 0, viewLeft: 0, viewWidth: 1000, cardLeft: 10, cardWidth: 280, scrollWidth: 2000 })).toBe(0)
    expect(revealScrollLeft({ scrollLeft: 0, viewLeft: 0, viewWidth: 1000, cardLeft: 1900, cardWidth: 280, scrollWidth: 2000 })).toBe(1000)
  })
})

describe('no card leaves in silence (item r) — a sentence per path', () => {
  const sc = (keys: string[], sig = 'f') => snapshotOf(joinLive(keys.map(k => rec({ key: k, title: `T-${k}` })), []), [], sig)
  const ctx = (o: Partial<Parameters<typeof planDepartures>[2]> = {}) => ({ allKeys: new Set<string>(), hidden: [], leaderIdsNow: new Set<string>(), nowMs: NOW, pt: true, ...o })
  test('path 1: a filter of the bar hides the card', () => {
    const g = planDepartures(sc(['a']), sc([]), ctx({ allKeys: new Set(['a']) }))
    expect(g).toEqual([expect.objectContaining({ key: 'a', title: 'T-a', reason: 'ficou fora dos filtros da barra' })])
  })
  test.each([
    ['no-live-session', 'a sessão encerrou e a peça segue sem agente'],
    ['status-unplaced', 'status sem etapa reconhecida'],
    ['published-old', 'publicado há mais de 24 h'],
    ['queue-idle', 'saiu da fila (sessão em espera removida)'],
  ] as const)('path: server-hidden %s', (reason, text) => {
    const g = planDepartures(sc(['a']), sc([]), ctx({ hidden: [{ key: 'a', taskId: 't', title: 'x', stage: null, reason }] }))
    expect(g[0]!.reason).toBe(text)
  })
  test('path: gone from the book entirely', () => {
    expect(planDepartures(sc(['a']), sc([]), ctx())[0]!.reason).toContain('removido do quadro')
  })
  test('path: a leader whose session ended', () => {
    const p = snapshotOf([], [{ id: 'L', title: 'Motor' }], 'f'), n = snapshotOf([], [], 'f')
    expect(planDepartures(p, n, ctx())).toEqual([expect.objectContaining({ kind: 'leader', title: 'Motor', reason: 'sessão do líder encerrada' })])
  })
  test('a change of the user\'s own filters is not a departure; the first paint has no past', () => {
    expect(planDepartures(sc(['a'], 'f1'), sc([], 'f2'), ctx())).toEqual([])
    expect(planDepartures(null, sc([]), ctx())).toEqual([])
  })
  test('a card that only changed column has not left', () => {
    expect(planDepartures(sc(['a']), sc(['a']), ctx())).toEqual([])
  })
  test('the line lingers 30 s, the short list keeps 10 min', () => {
    const g = [{ key: 'a', title: 'A', reason: 'r', atMs: NOW, kind: 'card' as const }]
    expect(lingering(g, NOW + GONE_LINGER_MS - 1)).toHaveLength(1)
    expect(lingering(g, NOW + GONE_LINGER_MS)).toHaveLength(0)
    expect(mergeGone(g, [], NOW + 11 * MIN)).toHaveLength(0)
    expect(mergeGone(g, [], NOW + 5 * MIN)).toHaveLength(1)
  })
})

describe('per-stage percent from fixed steps (item t4)', () => {
  test('pct = (k-1)/n, rounded; the line shows the step in words', () => {
    expect(stagePercent('running', 1, true)).toEqual({ pct: 0, step: 1, of: 5, label: 'lendo o pedido' })
    expect(stagePercent('running', 3, true)).toEqual({ pct: 40, step: 3, of: 5, label: 'rodando os testes' })
    expect(stagePercent('qa', 4, true)!.pct).toBe(75)
    expect(stagePercent('leader', 2, false)).toMatchObject({ pct: 33, label: 'checking what was deleted' })
    expect(stagePercent('merge', 3, true, true)).toMatchObject({ pct: 100, label: 'pronto' })
  })
  test('each stage has its fixed step count', () => {
    const n = (s: Parameters<typeof stagePercent>[0]) => stagePercent(s, 1, true)!.of
    expect([n('running'), n('qa'), n('adjust'), n('leader'), n('merge'), n('ci')]).toEqual([5, 4, 4, 3, 3, 3])
  })
  test('unknown is hidden, never invented: no report, no steps for the stage, nonsense', () => {
    expect(stagePercent('running', null, true)).toBeNull()
    expect(stagePercent('running', undefined, true)).toBeNull()
    expect(stagePercent('queue', 2, true)).toBeNull()
    expect(stagePercent('published', 2, true)).toBeNull()
    expect(stagePercent('running', 0, true)).toBeNull()
    expect(stagePercent('running', Number.NaN, true)).toBeNull()
  })
  test('a step past the end clamps to the last one', () => expect(stagePercent('merge', 9, true)).toMatchObject({ step: 3, pct: 67 }))
  test('in CI the percent comes from the release signal, not from a reported step', () => {
    const ci = (x: object) => ({ mergedMain: true, releaseGreen: false, tagPublished: false, tag: null, pr: null, ...x })
    expect(cardPercent({ stage: 'ci', ci: ci({}), step: null }, true)).toMatchObject({ pct: 33, step: 2, label: 'publicação rodando' })
    expect(cardPercent({ stage: 'ci', ci: ci({ releaseGreen: true }), step: null }, true)).toMatchObject({ pct: 67, step: 3 })
    expect(cardPercent({ stage: 'ci', ci: ci({ releaseGreen: true, tagPublished: true }), step: null }, true)).toMatchObject({ pct: 100, label: 'pronto' })
    expect(cardPercent({ stage: 'ci', ci: null, step: 2 }, true)).toBeNull()
    expect(cardPercent({ stage: 'qa', ci: null, step: 2 }, true)).toMatchObject({ pct: 25 })
  })
  test('the odometer rolls only the digits that changed', () => {
    expect(rollPlan('33%', '67%')).toEqual([{ char: '6', from: '3' }, { char: '7', from: '3' }, { char: '%', from: null }])
    expect(rollPlan('9%', '10%')).toEqual([{ char: '1', from: ' ' }, { char: '0', from: '9' }, { char: '%', from: null }])
    expect(rollPlan('50%', '50%').every(d => d.from === null)).toBe(true)
  })
})

describe('CI · publicando checklist (item t2)', () => {
  test('three signal lines, each done or pending, with the tag named when the flow states it', () => {
    expect(ciChecklist({ mergedMain: true, releaseGreen: false, tagPublished: false, tag: 'v2.200.8' }, true)).toEqual([
      { key: 'merge', done: true, text: 'merge no main' }, { key: 'release', done: false, text: 'release.yml terminou verde' }, { key: 'tag', done: false, text: 'tag v2.200.8 publicada' },
    ])
    expect(ciChecklist({ mergedMain: false, releaseGreen: false, tagPublished: false, tag: null }, false)[2]!.text).toBe('tag published')
  })
  test('CI sits between merge and published on the bar and in the waiting words', () => {
    const bar = stageBar('ci', null)
    expect(bar.map(s => s.stage)).toEqual(['queue', 'running', 'qa', 'leader', 'merge', 'ci', 'published'])
    expect(bar[5]).toMatchObject({ state: 'cur', color: 'rgb(45,180,200)' })
    const f = [row('s', 'waiting')]
    expect(waitingReason(card({ sessionIds: ['s'], stage: 'ci' }, f), f, true)).toBe('esperando o sinal do release')
  })
})

describe('Líderes pill counters (item t1) — real worker states, each worker once', () => {
  const w = (id: string, state: string, stage: Parameters<typeof stageBar>[0] | null = null) => ({ id, state, stage })
  test('3 leaders listing the same worker do not triple-count it', () => {
    const c = leaderCounts([
      { workers: [w('a', 'working', 'running'), w('b', 'waiting', 'leader'), w('c', 'waiting', 'blocked')] },
      { workers: [w('a', 'working', 'running'), w('d', 'waiting', 'running')] },
    ])
    expect(c).toEqual({ working: 1, waiting: 2, blocked: 1, workers: 4 })
  })
  test('the three counters always add up to the workers', () => {
    const c = leaderCounts([{ workers: [w('a', 'waiting-approval'), w('b', 'working'), w('c', 'waiting', 'qa')] }])
    expect(c.working + c.waiting + c.blocked).toBe(c.workers)
  })
  test('a row leads to its card, says "filtered" when the filters hide it, and nothing otherwise', () => {
    const all = joinLive([rec({ key: 'k1' }), rec({ key: 'k2' })], [])
    const shown = all.filter(c => c.d.key === 'k1')
    expect(locateWorker({ cardKey: 'k1' }, shown, all)).toEqual({ kind: 'card', key: 'k1', stage: 'running' })
    expect(locateWorker({ cardKey: 'k2' }, shown, all)).toEqual({ kind: 'filtered' })
    expect(locateWorker({ cardKey: 'zz' }, shown, all)).toEqual({ kind: 'none' })
    expect(locateWorker({}, shown, all)).toEqual({ kind: 'none' })
  })
})

describe('queueLines (FLUXO.ENTREGA-DSL "Na fila")', () => {
  test('pre-dispatch line and slot, nothing guessed', async () => {
    const { queueLines } = await import('./liveCardModel')
    expect(queueLines({ staged: { harness: 'claude', model: 'opus', effort: 'high', account: 'acc_1' }, slot: { ok: true, reason: null, at: '' } }, true, () => 'pessoal'))
      .toEqual({ staged: 'claude · opus · high · conta pessoal', slot: 'vaga: livre agora', slotOk: true, slotRaw: null, wait: null })
    expect(queueLines({ staged: { harness: 'claude', model: null, effort: null, account: null }, slot: null }, false).staged).toBe('claude')
    expect(queueLines({ staged: null, slot: null }, true)).toEqual({ staged: null, slot: null, slotOk: null, slotRaw: null, wait: null })
    // an account nobody can name is left out — the raw `acc_…` id is not something a person reads
    expect(queueLines({ staged: { harness: 'codex', model: 'm', effort: null, account: 'acc_9f3a21' }, slot: null }, true, (_h, a) => a).staged).toBe('codex · m')
  })
  test('a refused slot reads in plain words and keeps the raw gate text only for the tooltip (print c304a58f)', async () => {
    const { queueLines } = await import('./liveCardModel')
    const raw = 'no slot: fresh plan_limits reading for codex:acc_e785a7143614; 79 workers running (machine ceiling 4)'
    const q = queueLines({ staged: { harness: 'codex', model: null, effort: null, account: 'acc_e785a7143614' }, slot: { ok: false, reason: raw, at: '' } }, true, () => 'Principal')
    expect(q.slot).toBe('esperando a leitura dos limites da conta Principal · esperando vaga: 79 de 4 sessões em uso')
    expect(q.slot).not.toMatch(/acc_|plan_limits|machine ceiling|workers running/)
    expect(q.slotRaw).toBe(raw)
  })
})

describe('humanSlotReason — every gate refusal, in pt and en, without ids', () => {
  const acct = (h: string, a: string) => (a === 'acc_1' ? 'Principal' : a)
  test.each([
    ['no slot: 4 workers running (machine ceiling 4)', 'esperando vaga: 4 de 4 sessões em uso', 'waiting for a slot: 4 of 4 sessions in use'],
    ['no slot: 3 claude top-tier workers running (cap 2)', 'esperando vaga: 3 de 2 sessões do modelo mais forte em uso', 'waiting for a slot: 3 of 2 top-model sessions in use'],
    ['no slot: 5 h window at 91% (≥ 85%)', 'esperando a conta liberar (janela de 5 h em 91%)', 'waiting for the account to free up (5 h window at 91%)'],
    ['no slot: week at 97% (≥ 95%)', 'esperando a conta liberar (semana em 97%)', 'waiting for the account to free up (week at 97%)'],
    ['no slot: free memory 1.2 GB (< 3 GB)', 'esperando memória livre', 'waiting for free memory'],
    ['no slot: free memory unknown', 'esperando memória livre', 'waiting for free memory'],
    ['no slot: fresh plan_limits reading for codex:acc_1', 'esperando a leitura dos limites da conta Principal', 'waiting for the limits reading of account Principal'],
  ])('%s', (raw, pt, en) => {
    expect(humanSlotReason(raw, true, acct)).toBe(pt)
    expect(humanSlotReason(raw, false, acct)).toBe(en)
  })
  test('an account with no known name is said generically — the raw id never reaches the card', () => {
    expect(humanSlotReason('no slot: fresh plan_limits reading for codex:acc_9f', true, (_h, a) => a)).toBe('esperando a leitura dos limites da conta')
    expect(humanSlotReason('no slot: fresh plan_limits reading for codex:acc_9f', false)).toBe('waiting for the limits reading of the account')
  })
  test('several reasons are joined once each; an unknown or empty one is generic, never the raw text', () => {
    expect(humanSlotReason('no slot: free memory unknown; free memory 1.0 GB (< 3 GB)', true)).toBe('esperando memória livre')
    expect(humanSlotReason('no slot: something new the gate learned', true)).toBe('esperando vaga')
    expect(humanSlotReason(null, false)).toBe('waiting for a slot')
  })
})

describe('the filter bar choices are saved like the column preferences', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }
  test('defaults: both switches on, highest priority first', () => {
    expect(readViewPrefs(mem())).toEqual({ onlyActive: true, showQueue: true, sort: 'priority' })
  })
  test('round-trips, and junk falls back field by field', () => {
    const s = mem()
    writeViewPrefs({ onlyActive: false, showQueue: true, sort: 'recent' }, s)
    expect(readViewPrefs(s)).toEqual({ onlyActive: false, showQueue: true, sort: 'recent' })
    expect(readViewPrefs({ getItem: () => JSON.stringify({ onlyActive: 'x', showQueue: false, sort: 'nope' }) })).toEqual({ onlyActive: true, showQueue: false, sort: 'priority' })
    expect(readViewPrefs({ getItem: () => 'not json' })).toEqual({ onlyActive: true, showQueue: true, sort: 'priority' })
    expect(readViewPrefs(null)).toEqual({ onlyActive: true, showQueue: true, sort: 'priority' })
  })
})
