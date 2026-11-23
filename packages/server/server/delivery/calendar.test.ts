import { afterAll, describe, expect, test } from 'bun:test'
import { buildCalendar, calendarToIcs, filterCalendar } from '@agentistics/core'
import { answerCalendar, calendarFiltersOf, calendarFrom, releasesFromPieceTags, subtaskInputs } from './calendar'

describe('calendarFiltersOf', () => {
  test('no query = the default: tasks being worked on', () => {
    expect(calendarFiltersOf(new URLSearchParams(''))).toEqual({ tasks: 'active' })
  })
  test('lists, flags and BRT days', () => {
    const f = calendarFiltersOf(new URLSearchParams('task=Esteira&version=2.202.0,2.203.0&stage=qa,nonsense&priority=high&harness=codex&all=1&confirmed=1&from=2026-11-07&to=2026-11-07'))
    expect(f).toMatchObject({ tasks: 'all', task: 'Esteira', versions: ['2.202.0', '2.203.0'], stages: ['qa'], priorities: ['high'], harnesses: ['codex'], confirmedOnly: true })
    // 00:00 BRT = 03:00Z; the end of the day is the last millisecond before the next 00:00 BRT.
    expect(f.fromMs).toBe(Date.parse('2026-11-07T03:00:00.000Z'))
    expect(f.toMs).toBe(Date.parse('2026-11-08T02:59:59.999Z'))
  })
  test('an unparseable instant is dropped, not turned into NaN', () => {
    const f = calendarFiltersOf(new URLSearchParams('from=banana'))
    expect('fromMs' in f).toBe(false)
  })
})

describe('rule 5 through the host builder: a tag-proven published piece leaves leader/ci', () => {
  const NOW = Date.parse('2026-11-17T15:00:00.000Z')
  const started = NOW - 8 * 86_400_000
  const base = {
    nowMs: NOW, resets: [], tasks: [{ id: 't', title: 'Task', status: 'in_progress' }], subtasks: [{ id: 's', taskId: 't', title: 'Piece', status: 'in_review' }],
    lives: [{
      key: 't/s', taskId: 't', taskTitle: 'Task', subtaskId: 's', title: 'Piece', stage: 'ci' as const, startedAtMs: started, stageSinceMs: NOW - 3600_000,
      harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' as const }, stageEta: { kind: 'none' as const }, publishEta: { kind: 'none' as const, reason: 'no-history' }, deliveredAtMs: null,
    }],
    records: [{ subtaskId: 's', taskId: 't', phase: 'ci', versionTarget: '2.230.0' }],
  }
  test('without proof the piece stays in ci; with the tag proof (via releasesFromPieceTags) it is published and leaves the stage', () => {
    const before = calendarFrom(base).pieces[0]!
    expect(before.stage).toBe('ci')
    const tagMs = NOW - 2 * 86_400_000
    const after = calendarFrom({
      ...base, inferredVersions: { 't/s': '2.229.0' },
      releases: releasesFromPieceTags({ 't/s': { version: '2.229.0', publishedAt: tagMs } }),
    })
    expect(after.pieces[0]).toMatchObject({ stage: 'published', version: '2.229.0', active: false, late: false })
    expect(filterCalendar(after, {}).pieces.filter(p => ['leader', 'merge', 'ci'].includes(p.stage))).toHaveLength(0)
    // the same reply feeds the .ics: the event sits on the tag's day
    expect(calendarToIcs(filterCalendar(after, { tasks: 'all' }), NOW)).toContain('20261115')
  })
})

describe('answerCalendar', () => {
  const NOW = Date.parse('2026-11-07T18:00:00.000Z')
  const reply = buildCalendar({
    nowMs: NOW,
    lives: [{
      key: 't/s', taskId: 't', taskTitle: 'Esteira', subtaskId: 's', title: 'Barra', stage: 'qa', startedAtMs: NOW - 3600_000, stageSinceMs: NOW - 1800_000,
      harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
    }],
    records: [{ subtaskId: 's', taskId: 't', phase: 'qa', versionTarget: '2.202.0' }],
    tasks: [{ id: 't', title: 'Esteira', status: 'in_progress', priority: 'high' }], subtasks: [], resets: [],
  })
  test('carries the counts and the filters it applied; a piece with no estimate keeps `kind: none`', () => {
    const a = answerCalendar(reply, { tasks: 'active' })
    expect(a.counts).toEqual({ pieces: 1, versions: 1, marks: 0 })
    expect(a.pieces[0]!.publishEta.kind).toBe('none')
    expect(a.versions[0]).toMatchObject({ version: '2.202.0', basis: 'none', atMs: null })
  })
})

describe('the Cronograma group level (parentGroupId)', () => {
  const NOW = Date.parse('2026-11-14T18:00:00.000Z')
  test('the board\'s parentGroupId reaches the calendar and fills groupId/groupTitle on the piece', () => {
    const subs = subtaskInputs([{ id: 'g', taskId: 't', title: 'Adaptadores' }, { id: 's', taskId: 't', title: 'Leitura', parentGroupId: 'g' }])
    expect(subs.find(s => s.id === 's')!.parentGroupId).toBe('g')
    expect(subs.find(s => s.id === 'g')!.parentGroupId).toBeUndefined()
    const reply = buildCalendar({
      nowMs: NOW,
      lives: [{
        key: 't/s', taskId: 't', taskTitle: 'Engine', subtaskId: 's', title: 'Leitura', stage: 'qa', startedAtMs: NOW - 3600_000, stageSinceMs: NOW - 1800_000,
        harnesses: [], models: [], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
      }],
      records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: subs, resets: [],
    })
    const p = answerCalendar(reply, { tasks: 'active' }).pieces[0]!
    expect(p.groupId).toBe('g')
    expect(p.groupTitle).toBe('Adaptadores')
  })
})

describe('the app\'s own releases are not the user\'s versions', () => {
  // `mock.module` outlives the file: the full run is ONE process, so every later file importing '../version' (version, upgrade,
  // self-guard, restart-pending) would get the stub below. Capture the real module first and put it back when this block ends.
  const realVersion = import('../version').then(m => ({ ...m }))
  afterAll(async () => { const real = await realVersion; const { mock } = await import('bun:test'); mock.module('../version', () => real) })
  const APP_RELEASES = ['2.204.3', '2.205.0', '2.217.1'].map(v => ({ tag: `v${v}`, published_at: '2026-11-10T12:00:00.000Z' }))
  test('readCalendarSources never reads the update feed: app releases available, no records/tags -> 0 versions', async () => {
    const { mock } = await import('bun:test')
    let asked = 0
    mock.module('../version', () => ({ CURRENT_VERSION: '2.217.1', compareVersions: () => 0, getVersionInfo: async () => { asked++; return { current: '2.217.1', latest: '2.217.1', releases: APP_RELEASES } } }))
    const { readCalendarSources, calendarFrom } = await import('./calendar')
    const src = await readCalendarSources()
    expect(asked).toBe(0)
    expect(src.releases).toEqual([]) // only pieces' own tags can date a release
    expect(calendarFrom(src).versions).toEqual([])
  })
  test('a piece whose commit sits in a v1.2.3 tag of its repo, no record → published in 1.2.3 at the tag date; no version without a piece', async () => {
    const { releasesFromPieceTags } = await import('./calendar')
    const NOW = Date.parse('2026-11-16T12:00:00.000Z'), tagAt = Date.parse('2026-11-14T09:00:00.000Z')
    const releases = releasesFromPieceTags({ 't/s': { version: '1.2.3', publishedAt: tagAt } })
    expect(releases).toEqual([{ version: '1.2.3', publishedAt: new Date(tagAt).toISOString() }])
    const reply = buildCalendar({
      nowMs: NOW, releases, inferredVersions: { 't/s': '1.2.3' },
      lives: [{ key: 't/s', taskId: 't', taskTitle: 'T', subtaskId: 's', title: 'P', stage: 'leader', startedAtMs: tagAt - 9e6, stageSinceMs: tagAt - 3e6,
        harnesses: [], models: [], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null }],
      records: [], tasks: [{ id: 't', title: 'T', status: 'in_progress' }], subtasks: [], resets: [],
    })
    expect(reply.pieces[0]).toMatchObject({ stage: 'published', version: '1.2.3' })
    expect(reply.versions).toMatchObject([{ version: '1.2.3', state: 'published', atMs: tagAt, pieceKeys: ['t/s'] }])
  })
  test('a real record tag yields that version only', () => {
    const NOW = Date.parse('2026-11-16T12:00:00.000Z')
    const reply = buildCalendar({
      nowMs: NOW,
      lives: [{ key: 't/s', taskId: 't', taskTitle: 'T', subtaskId: 's', title: 'P', stage: 'published', startedAtMs: NOW - 9e6, stageSinceMs: NOW - 3e6,
        harnesses: [], models: [], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: NOW - 3e6 }],
      records: [{ subtaskId: 's', taskId: 't', phase: 'publicado', versionTarget: '3.1.0', tag: 'v3.1.0', publishedAt: '2026-11-15T12:00:00.000Z' }],
      tasks: [{ id: 't', title: 'T', status: 'in_progress' }], subtasks: [], resets: [],
    })
    expect(reply.versions.map(v => v.version)).toEqual(['3.1.0'])
    expect(reply.pieces).toHaveLength(1)
  })
})

describe('a leader working alone reaches the Calendar (LIVE.EM-ANDAMENTO-E-LIDER)', () => {
  test('the leader piece (task-level, running, on the leader session\'s clock) is a piece of the calendar', () => {
    const NOW = Date.parse('2026-11-09T15:00:00.000Z')
    const reply = buildCalendar({
      nowMs: NOW,
      lives: [{
        key: 't', taskId: 't', taskTitle: 'Engine', subtaskId: null, title: 'Engine', stage: 'running', startedAtMs: NOW - 600_000, stageSinceMs: NOW - 600_000,
        harnesses: ['claude'], models: ['opus'], eta: { kind: 'none' }, stageEta: { kind: 'none' }, publishEta: { kind: 'none', reason: 'no-history' }, deliveredAtMs: null,
      }],
      records: [], tasks: [{ id: 't', title: 'Engine', status: 'in_progress' }], subtasks: [], resets: [],
    })
    const a = answerCalendar(reply, { tasks: 'active' })
    expect(a.pieces.map(p => p.title)).toEqual(['Engine'])
    expect(a.pieces[0]!.publishEta.kind).toBe('none')
  })
})
